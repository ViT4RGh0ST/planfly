import { NextResponse } from "next/server";

import { normalizeLocale } from "@/i18n/config";
import { getTranslator } from "@/i18n/translator";
import { withToken, rejectIdentityKeys, rejectUnknownKeys } from "@/lib/api/handler";
import {
  archiveCategory,
  archivedCategories,
  categoryTree,
  createCategory,
  unarchiveCategory,
  updateCategory,
  type CategoryNode,
} from "@/lib/services/manage-categories";
import { REVIEW_THRESHOLD, resolveArchived, resolveCategory } from "@/lib/services/resolve-entities";
import { apiCategoryPatchSchema, apiCategorySchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

/**
 * The categories, from outside the dashboard.
 *
 * The chat has been matching categories since the first entry it recorded and
 * has never been able to add one: an expense that belongs nowhere lands in the
 * review tray or in whatever resembled it, and the person is told to open the
 * web. `/api/v1/context` lists them, flat, which is enough to spend against and
 * not enough to organise.
 *
 * The danger is the same one `/accounts` guards, and it is not the obvious one.
 * A category too many breaks nothing loudly: «Salud» next to «Medicinas» are
 * different slugs, so no unique index sees them clash, and from then on half the
 * spending goes to one and half to the other. Both totals are false, every
 * budget on either is measuring a fraction, and nothing anywhere fails.
 */

/** The tree flattened for an agent, which has no use for nesting. */
function flatten(nodes: CategoryNode[], parent: string | null = null): Array<Record<string, unknown>> {
  return nodes.flatMap((node) => [
    {
      name: node.name,
      kind: node.kind,
      parent,
      aliases: node.aliases,
      // Its own plus its children's, because that is what a budget on it counts
      // and what says whether its kind can still be changed.
      entries: node.entriesInTree,
    },
    ...flatten(node.children, node.name),
  ]);
}

export const GET = withToken("context:read", async ({ principal, req }) => {
  const t = getTranslator(normalizeLocale(principal.locale));
  const view = new URL(req.url).searchParams.get("view") ?? "list";

  if (view === "archived") {
    const rows = await archivedCategories(principal.householdId);
    return NextResponse.json({
      ok: true,
      categories: rows.map((row) => ({ name: row.name, kind: row.kind })),
      summary: rows.length
        ? t("api.categories.archived", { names: rows.map((row) => row.name).join(", ") })
        : t("api.categories.noneArchived"),
    });
  }

  const categories = flatten(await categoryTree(principal.householdId));
  return NextResponse.json({
    ok: true,
    categories,
    summary: categories.length
      ? t("api.categories.list", { n: categories.length })
      : t("api.categories.none"),
  });
});

/** The parent, by name, and never of the other kind. */
async function resolveParent(householdId: string, parent: string, kind?: "expense" | "income") {
  return resolveCategory(householdId, parent, kind);
}

export const POST = withToken("catalog:write", async ({ principal, req }) => {
  const t = getTranslator(normalizeLocale(principal.locale));
  const body = await req.json();
  rejectIdentityKeys(body);
  rejectUnknownKeys(body, apiCategorySchema);
  const input = apiCategorySchema.parse(body);

  if (input.confirm !== true) {
    /*
     * The same question `/accounts` asks, at the same threshold.
     *
     * It only stops on a resemblance worth trusting — the one that decides
     * whether an expense goes to the review tray. Below it, one word in common
     * is enough for two legitimate categories to look alike, and a warning that
     * always fires is one people learn to click through exactly when it matters.
     */
    const existing = await resolveCategory(principal.householdId, input.name, input.kind);
    if (existing && existing.score >= REVIEW_THRESHOLD) {
      const exact = existing.via !== "similarity";
      return NextResponse.json(
        {
          ok: false,
          error: "category_may_exist",
          message: exact
            ? t("api.categories.duplicate", { name: existing.name })
            : t("api.categories.maybeDuplicate", { name: existing.name }),
          existing: { name: existing.name, score: existing.score, via: existing.via },
        },
        { status: 409 },
      );
    }
  }

  let parentId: string | undefined;
  if (input.parent) {
    const parent = await resolveParent(principal.householdId, input.parent, input.kind);
    if (!parent) {
      return NextResponse.json(
        {
          ok: false,
          error: "parent_not_found",
          message: t("api.categories.parentNotFound", { input: input.parent, kind: input.kind }),
        },
        { status: 422 },
      );
    }
    parentId = parent.id;
  }

  const result = await createCategory({
    householdId: principal.householdId,
    locale: principal.locale,
    name: input.name,
    kind: input.kind,
    parentId,
    aliases: input.aliases,
  });
  return NextResponse.json({ ok: true, ...result }, { status: 201 });
});

export const PATCH = withToken("catalog:write", async ({ principal, req }) => {
  const t = getTranslator(normalizeLocale(principal.locale));
  const body = await req.json();
  rejectIdentityKeys(body);
  rejectUnknownKeys(body, apiCategoryPatchSchema);
  const input = apiCategoryPatchSchema.parse(body);

  /*
     * Reinstating looks in the other half of the table.
     *
     * `resolveIn` filters `archived_at IS NULL`, which is right for everything
     * else and makes unarchive-by-name unreachable: the only thing it could
     * match is precisely what it excludes.
     */
  const match =
    input.action === "unarchive"
      ? await resolveArchived("categories", principal.householdId, input.category)
      : await resolveCategory(principal.householdId, input.category);
  if (!match) {
    return NextResponse.json(
      {
        ok: false,
        error: "category_not_found",
        message: t("api.categories.notFound", { input: input.category }),
      },
      { status: 404 },
    );
  }

  if (input.action === "archive" || input.action === "unarchive") {
    const result =
      input.action === "archive"
        ? await archiveCategory(principal.householdId, match.id)
        : await unarchiveCategory(principal.householdId, match.id);
    return NextResponse.json({ ok: true, ...result });
  }

  let parentId: string | null | undefined;
  if (input.parent === "") {
    // Empty is the only way to say «lift it back to the top»: `undefined`
    // already means «leave it where it is» and the two must not collide.
    parentId = null;
  } else if (input.parent) {
    /*
     * Without a kind filter when the call does not name one.
     *
     * `Match` says which category the name found, not what kind it is, and
     * guessing «expense» here would refuse a legitimate income parent with a
     * sentence about spending. The service resolves the parent again against the
     * category's real kind and refuses a mismatch there, which is the answer
     * that can be acted on.
     */
    const parent = await resolveParent(principal.householdId, input.parent, input.kind);
    if (!parent) {
      return NextResponse.json(
        {
          ok: false,
          error: "parent_not_found",
          message: t("api.categories.parentNotFound", { input: input.parent, kind: input.kind ?? "" }),
        },
        { status: 422 },
      );
    }
    parentId = parent.id;
  }

  const result = await updateCategory({
    householdId: principal.householdId,
    categoryId: match.id,
    locale: principal.locale,
    name: input.name,
    kind: input.kind,
    parentId,
    aliases: input.aliases,
  });
  return NextResponse.json({ ok: true, ...result });
});
