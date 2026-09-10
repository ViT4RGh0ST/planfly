import { NextResponse } from "next/server";

import { normalizeLocale } from "@/i18n/config";
import { getTranslator } from "@/i18n/translator";
import { withToken, rejectIdentityKeys, rejectUnknownKeys } from "@/lib/api/handler";
import {
  archivePayee,
  archivedPayees,
  createPayee,
  payeeTree,
  unarchivePayee,
  unplacedGroups,
  updatePayee,
  type PayeeNode,
} from "@/lib/services/manage-payees";
import { resolveCategory, resolvePayee } from "@/lib/services/resolve-entities";
import { createPlaceSchema, patchPlaceSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

/**
 * Where things were bought, from outside the dashboard.
 *
 * Eleven of a hundred and nine entries carry a place, and that is not because
 * nobody cares where they shop: it is because the only door that could set one
 * was the desktop. The question the whole feature exists for — what does this
 * product cost, and where — is fed by hand or not at all.
 *
 * Named and never id'd, like accounts: the model sends «Farmatodo» and this
 * resolves it with the same matcher that decides where an expense goes, so it
 * cannot invent a foreign key and the person never sees a uuid.
 */

/** A refusal this route words itself, before any service is reached. */
export class PlaceRefusal extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PlaceRefusal";
  }
}

function refusalResponse(error: unknown): NextResponse | null {
  if (!(error instanceof PlaceRefusal)) return null;
  return NextResponse.json({ ok: false, error: error.code, message: error.message }, { status: 422 });
}

/** A place tree flattened for an agent, which has no use for nesting. */
function flatten(nodes: PayeeNode[], parent: string | null = null): Array<Record<string, unknown>> {
  return nodes.flatMap((node) => [
    {
      name: node.name,
      parent,
      aliases: node.aliases,
      tax_id: node.taxId,
      address: node.address,
      default_category: node.defaultCategory,
      // Both counts, because they are what says whether a place is earning its
      // keep: entries but no items means no receipt was ever photographed
      // there, which is exactly why none of its prices show on the products
      // screen.
      entries: node.entriesInTree,
      items: node.itemsInTree,
    },
    ...flatten(node.branches, node.name),
  ]);
}

export const GET = withToken("context:read", async ({ principal, req }) => {
  const t = getTranslator(normalizeLocale(principal.locale));
  const view = new URL(req.url).searchParams.get("view") ?? "list";

  if (view === "archived") {
    const rows = await archivedPayees(principal.householdId);
    return NextResponse.json({
      ok: true,
      places: rows.map((row) => ({ name: row.name })),
      summary: rows.length
        ? t("api.places.archived", { names: rows.map((row) => row.name).join(", ") })
        : t("api.places.noneArchived"),
    });
  }

  if (view === "unplaced") {
    const { groups, total } = await unplacedGroups(principal.householdId);
    return NextResponse.json({
      ok: true,
      groups: groups.map((group) => ({
        description: group.description,
        entries: group.entries,
        items: group.items,
        first_on: group.firstOn,
        last_on: group.lastOn,
        // A proposal from the same resolver the bot uses, never applied. It is
        // what the place would have matched had it existed at the time.
        suggestion: group.suggestion?.name ?? null,
      })),
      total,
      /*
       * Expenses only, and the summary says so.
       *
       * A salary, a withdrawal, a transfer between your own accounts, an
       * instalment paid to a financier: none of them happens at a shop. Without
       * this sentence a model looking at a short list asks about the salary,
       * and the person learns the tool does not understand what a place is.
       */
      summary: t("api.places.unplaced", { n: total }),
    });
  }

  const tree = await payeeTree(principal.householdId);
  const places = flatten(tree);
  return NextResponse.json({
    ok: true,
    places,
    summary: places.length ? t("api.places.list", { n: places.length }) : t("api.places.none"),
  });
});

/**
 * Resolving the two things a place points at, both by name.
 *
 * A category that is not a spending one is refused here rather than by the
 * service's foreign key: «what these purchases usually are» cannot be a salary,
 * and the sentence saying so is what lets a model fix its own call.
 */
async function pointsAt(
  householdId: string,
  input: { parent?: string; default_category?: string },
  locale: string,
) {
  const t = getTranslator(normalizeLocale(locale));
  let parentId: string | undefined;
  let defaultCategoryId: string | undefined;

  if (input.parent) {
    const match = await resolvePayee(householdId, input.parent);
    if (!match) {
      throw new PlaceRefusal("parent_not_found", t("api.places.parentNotFound", { input: input.parent }));
    }
    parentId = match.id;
  }

  if (input.default_category) {
    const match = await resolveCategory(householdId, input.default_category, "expense");
    if (!match) {
      throw new PlaceRefusal(
        "category_not_found",
        t("api.places.categoryNotFound", { input: input.default_category }),
      );
    }
    defaultCategoryId = match.id;
  }

  return { parentId, defaultCategoryId };
}

export const POST = withToken("catalog:write", async ({ principal, req }) => {
  const body = await req.json();
  rejectIdentityKeys(body);
  rejectUnknownKeys(body, createPlaceSchema);
  const input = createPlaceSchema.parse(body);

  try {
    const { parentId, defaultCategoryId } = await pointsAt(
      principal.householdId,
      input,
      principal.locale,
    );

    const result = await createPayee({
      householdId: principal.householdId,
      locale: principal.locale,
      name: input.name,
      taxId: input.tax_id,
      address: input.address,
      parentId,
      coordinates: input.coordinates,
      defaultCategoryId,
      aliases: input.aliases,
      allowSharedTaxId: input.confirm,
    });
    return NextResponse.json({ ok: true, ...result }, { status: 201 });
  } catch (error) {
    const refusal = refusalResponse(error);
    if (refusal) return refusal;
    throw error;
  }
});

export const PATCH = withToken("catalog:write", async ({ principal, req }) => {
  const t = getTranslator(normalizeLocale(principal.locale));
  const body = await req.json();
  rejectIdentityKeys(body);
  rejectUnknownKeys(body, patchPlaceSchema);
  const input = patchPlaceSchema.parse(body);

  const match = await resolvePayee(principal.householdId, input.place);
  if (!match) {
    return NextResponse.json(
      { ok: false, error: "payee_not_found", message: t("api.places.notFound", { input: input.place }) },
      { status: 404 },
    );
  }

  if (input.action === "archive" || input.action === "unarchive") {
    const result =
      input.action === "archive"
        ? await archivePayee(principal.householdId, match.id)
        : await unarchivePayee(principal.householdId, match.id);
    return NextResponse.json({ ok: true, ...result });
  }

  try {
    const { parentId, defaultCategoryId } = await pointsAt(
      principal.householdId,
      input,
      principal.locale,
    );

    const result = await updatePayee({
      householdId: principal.householdId,
      payeeId: match.id,
      locale: principal.locale,
      name: input.name,
      taxId: input.tax_id,
      address: input.address,
      // Only what arrived: `undefined` leaves it where it is, and lifting a shop
      // out of its brand is `parent: ""`, which resolves to nothing on purpose.
      parentId: input.parent === "" ? null : parentId,
      coordinates: input.coordinates,
      defaultCategoryId: input.default_category === "" ? null : defaultCategoryId,
      aliases: input.aliases,
      allowSharedTaxId: input.confirm,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    const refusal = refusalResponse(error);
    if (refusal) return refusal;
    throw error;
  }
});
