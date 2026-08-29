import { and, arrayOverlaps, asc, eq, isNotNull, isNull, ne, sql } from "drizzle-orm";

import { db } from "@/db";
import { normalizeLocale, type Locale } from "@/i18n/config";
import { getTranslator } from "@/i18n/translator";
import { localeOf } from "./household-locale";
import { categories, payees } from "@/db/schema";
import { normalize, toSlug } from "./resolve-entities";
import { normalizeTaxId } from "@/lib/tax-id";
import { parseCoordinates } from "@/lib/coordinates";
import { InvalidTransactionError } from "./record-transaction";

/**
 * The ONE write path into the places you buy from.
 *
 * `payees` was born as a side effect: the bot created a row the first time it
 * read «Central Madeirense» off a receipt, and nothing could be corrected
 * afterwards. Giving it a screen is what turns it from a label into the thing
 * that answers where a product is cheaper — because `transaction_items` already
 * hangs off a transaction that already has a `payee_id`.
 *
 * A payee is a merchant OR a person: the plumber, a friend you paid back. The
 * fiscal id and the address are only ever filled for the first kind, and that
 * is why both are nullable and neither is asked for.
 */

/**
 * The point, or nothing at all.
 *
 * Unparseable input clears it rather than being refused: what arrives here is
 * pasted from a map, and half-pasting a URL is not a mistake worth stopping a
 * whole form for. A place with no point simply does not appear on the map.
 */
function coordinatesOf(input: string | undefined): { lat: string | null; lon: string | null } {
  const point = parseCoordinates(input);
  return { lat: point?.lat ?? null, lon: point?.lon ?? null };
}

/** "central madeirense, madeirense" -> ["central madeirense","madeirense"] */
export function parseAliases(input: string | undefined): string[] {
  if (!input) return [];
  const seen = new Set<string>();
  for (const piece of input.split(",")) {
    const alias = normalize(piece);
    if (alias) seen.add(alias);
  }
  return [...seen];
}

async function assertNameFree(
  householdId: string,
  name: string,
  locale: Locale,
  exceptId?: string,
) {
  const t = getTranslator(locale);
  const slug = toSlug(name);
  if (!slug) {
    throw new InvalidTransactionError(t("services.managePayees.missingName"), "missing_name");
  }

  const [clash] = await db
    .select({ id: payees.id, name: payees.name, archivedAt: payees.archivedAt })
    .from(payees)
    .where(and(eq(payees.householdId, householdId), eq(payees.slug, slug)))
    .limit(1);

  if (clash && clash.id !== exceptId) {
    throw new InvalidTransactionError(
      clash.archivedAt
        ? t("services.managePayees.duplicateArchived", { name: clash.name })
        : t("services.managePayees.duplicateName", { name: clash.name }),
      "duplicate_name",
    );
  }
  return slug;
}

/**
 * No two places may answer to the same alias.
 *
 * The same rule as the categories, for the same reason: `resolveIn` takes
 * `LIMIT 1 ORDER BY score DESC, name ASC`, so two places sharing «madeirense»
 * are decided alphabetically. Here it costs more than a misfiled expense — it
 * splits one shop's price history between two rows, and then neither of them
 * tells you what anything costs.
 */
async function assertAliasesFree(
  householdId: string,
  aliases: string[],
  locale: Locale,
  exceptId?: string,
) {
  if (aliases.length === 0) return aliases;

  const [clash] = await db
    .select({ name: payees.name, aliases: payees.aliases })
    .from(payees)
    .where(
      and(
        eq(payees.householdId, householdId),
        exceptId ? ne(payees.id, exceptId) : undefined,
        arrayOverlaps(payees.aliases, aliases),
      ),
    )
    .limit(1);

  if (clash) {
    throw new InvalidTransactionError(
      getTranslator(locale)("services.managePayees.duplicateAlias", {
        alias: clash.aliases.filter((a) => aliases.includes(a)).join(", "),
        name: clash.name,
      }),
      "duplicate_alias",
    );
  }
  return aliases;
}

/**
 * A repeated fiscal id is stopped, and can be overridden.
 *
 * It is NOT a uniqueness rule, and an index would have been the wrong tool. A
 * franchise gives every branch its own company and its own fiscal id; a chain of
 * its own gives all of them the same one. So a repeat means one of two things —
 * «this is the shop you already have, written twice», which silently splits its
 * price history in two, or «this is another branch of that company», which is
 * legitimate — and only the person knows which.
 *
 * So it stops by default and names the row in the way, and `allowSharedTaxId`
 * lets it through. It is the shape `recordTransaction` already uses for a
 * suspected duplicate entry, for the same reason: the machine can see the
 * coincidence and cannot see the intent.
 */
async function assertTaxIdFree(
  householdId: string,
  taxId: string | null,
  address: string | null,
  locale: Locale,
  opts: { exceptId?: string; allowShared?: boolean } = {},
) {
  if (!taxId || opts.allowShared) return taxId;

  const rows = await db
    .select({
      id: payees.id,
      name: payees.name,
      address: payees.address,
      archivedAt: payees.archivedAt,
    })
    .from(payees)
    .where(and(eq(payees.householdId, householdId), eq(payees.taxId, taxId)));

  const others = rows.filter((row) => row.id !== opts.exceptId);
  if (others.length === 0) return taxId;

  /*
   * What tells the two cases apart is the address.
   *
   * A branch IS a location: two shops of one company at one address are the
   * same shop written twice, and two at different addresses are two branches.
   * So the message says which of the two this looks like rather than asking the
   * same vague question for both — and it is compared normalised, because
   * «Av. Ppal Santa Fe» and «av ppal santa fe» are one place.
   */
  const here = normalize(address ?? "");
  const sameSpot = others.find((row) => normalize(row.address ?? "") === here);
  const clash = sameSpot ?? others[0];

  const t = getTranslator(locale);
  throw new InvalidTransactionError(
    clash.archivedAt
      ? t("services.managePayees.taxIdArchived", { name: clash.name, taxId })
      : sameSpot
        ? t("services.managePayees.taxIdSameSpot", { name: clash.name, taxId })
        : t("services.managePayees.taxIdOtherSpot", { name: clash.name, taxId }),
    "duplicate_tax_id",
  );
}

/**
 * The brand a branch hangs off, checked the way a category's parent is.
 *
 * Two levels: a branch cannot have branches. Every query that groups a chain
 * looks exactly one step down, and a third level would be counted by none of
 * them — the total of «Farmatodo» would quietly stop including a shop.
 */
async function resolveParent(
  householdId: string,
  parentId: string | null,
  locale: Locale,
  selfId?: string,
) {
  if (!parentId) return null;
  const t = getTranslator(locale);

  if (selfId && parentId === selfId) {
    throw new InvalidTransactionError(t("services.managePayees.ownParent"), "own_parent");
  }

  const parent = await loadPayee(householdId, parentId, locale);

  if (parent.parentId) {
    throw new InvalidTransactionError(
      t("services.managePayees.parentIsBranch", { parent: parent.name }),
      "parent_is_branch",
    );
  }

  if (parent.archivedAt) {
    throw new InvalidTransactionError(
      t("services.managePayees.parentArchived", { parent: parent.name }),
      "parent_archived",
    );
  }

  if (selfId) {
    const [child] = await db
      .select({ id: payees.id })
      .from(payees)
      .where(eq(payees.parentId, selfId))
      .limit(1);
    if (child) {
      throw new InvalidTransactionError(
        t("services.managePayees.hasBranches", { name: (await loadPayee(householdId, selfId, locale)).name }),
        "has_branches",
      );
    }
  }

  return parent;
}

async function loadPayee(householdId: string, payeeId: string, locale: Locale) {
  const [row] = await db
    .select()
    .from(payees)
    .where(and(eq(payees.id, payeeId), eq(payees.householdId, householdId)))
    .limit(1);

  if (!row) {
    throw new InvalidTransactionError(
      getTranslator(locale)("services.managePayees.payeeNotFound"),
      "payee_not_found",
    );
  }
  return row;
}

/** The default category has to exist, belong to the household and be a spending one. */
async function resolveDefaultCategory(
  householdId: string,
  categoryId: string | null,
  locale: Locale,
) {
  if (!categoryId) return null;

  const [category] = await db
    .select({ id: categories.id, name: categories.name, kind: categories.kind })
    .from(categories)
    .where(
      and(
        eq(categories.id, categoryId),
        eq(categories.householdId, householdId),
        isNull(categories.archivedAt),
      ),
    )
    .limit(1);

  if (!category) {
    throw new InvalidTransactionError(
      getTranslator(locale)("services.managePayees.categoryNotFound"),
      "category_not_found",
    );
  }
  return category;
}

export type CreatePayeeInput = {
  householdId: string;
  /** The household's language. It travels with the timezone: both shape what is said. */
  locale: string;
  name: string;
  taxId?: string;
  address?: string;
  /** The brand this is a branch of. A shop that is nobody's branch has none. */
  parentId?: string | null;
  /** A pasted pair of numbers or a map URL; anything else is ignored, not rejected. */
  coordinates?: string;
  defaultCategoryId?: string | null;
  aliases?: string;
  /** «Yes, it really is another branch of that same company.» */
  allowSharedTaxId?: boolean;
};

export async function createPayee(input: CreatePayeeInput) {
  const locale = normalizeLocale(input.locale);
  const t = getTranslator(locale);
  const name = input.name.trim();
  const slug = await assertNameFree(input.householdId, name, locale);
  const aliases = await assertAliasesFree(input.householdId, parseAliases(input.aliases), locale);
  const address = input.address?.trim() || null;
  const taxId = await assertTaxIdFree(
    input.householdId,
    normalizeTaxId(input.taxId),
    address,
    locale,
    { allowShared: input.allowSharedTaxId },
  );
  const parent = await resolveParent(input.householdId, input.parentId ?? null, locale);
  const category = await resolveDefaultCategory(
    input.householdId,
    input.defaultCategoryId ?? null,
    locale,
  );

  const [row] = await db
    .insert(payees)
    .values({
      householdId: input.householdId,
      name,
      slug,
      taxId,
      address,
      parentId: parent?.id ?? null,
      ...coordinatesOf(input.coordinates),
      defaultCategoryId: category?.id ?? null,
      aliases,
    })
    .returning({ id: payees.id, name: payees.name });

  return {
    id: row.id,
    summary: parent
      ? t("services.managePayees.createdBranch", { name: row.name, parent: parent.name })
      : category
        ? t("services.managePayees.createdWithCategory", { name: row.name, category: category.name })
        : t("services.managePayees.created", { name: row.name }),
  };
}

export type UpdatePayeeInput = {
  householdId: string;
  payeeId: string;
  /** The household's language. */
  locale: string;
  name?: string;
  taxId?: string;
  address?: string;
  /** `null` lifts it out of its brand; `undefined` leaves it where it is. */
  parentId?: string | null;
  /** Empty clears the point; `undefined` leaves it alone. */
  coordinates?: string;
  /** `null` clears it; `undefined` leaves it alone. */
  defaultCategoryId?: string | null;
  aliases?: string;
  allowSharedTaxId?: boolean;
};

export async function updatePayee(input: UpdatePayeeInput) {
  const locale = normalizeLocale(input.locale);
  const t = getTranslator(locale);
  const payee = await loadPayee(input.householdId, input.payeeId, locale);
  const changes: string[] = [];
  const patch: Record<string, unknown> = {};

  if (input.name != null && input.name.trim() && input.name.trim() !== payee.name) {
    patch.slug = await assertNameFree(input.householdId, input.name, locale, payee.id);
    patch.name = input.name.trim();
    changes.push(t("services.managePayees.change.name"));
  }

  // The address is read first: it is what tells «the same shop twice» from
  // «another branch», so the fiscal id has to be judged against the new one.
  const address = input.address != null ? input.address.trim() || null : payee.address;
  if (input.address != null && address !== payee.address) {
    patch.address = address;
    changes.push(t("services.managePayees.change.address"));
  }

  if (input.taxId != null) {
    const taxId = normalizeTaxId(input.taxId);
    if (taxId !== payee.taxId) {
      patch.taxId = await assertTaxIdFree(input.householdId, taxId, address, locale, {
        exceptId: payee.id,
        allowShared: input.allowSharedTaxId,
      });
      changes.push(t("services.managePayees.change.taxId"));
    }
  }

  if (input.parentId !== undefined && (input.parentId || null) !== payee.parentId) {
    const parent = await resolveParent(input.householdId, input.parentId, locale, payee.id);
    patch.parentId = parent?.id ?? null;
    changes.push(
      parent
        ? t("services.managePayees.change.parent", { parent: parent.name })
        : t("services.managePayees.change.noParent"),
    );
  }

  if (input.defaultCategoryId !== undefined) {
    const category = await resolveDefaultCategory(
      input.householdId,
      input.defaultCategoryId,
      locale,
    );
    if ((category?.id ?? null) !== payee.defaultCategoryId) {
      patch.defaultCategoryId = category?.id ?? null;
      changes.push(
        category
          ? t("services.managePayees.change.category", { category: category.name })
          : t("services.managePayees.change.noCategory"),
      );
    }
  }

  if (input.coordinates !== undefined) {
    const point = coordinatesOf(input.coordinates);
    if (point.lat !== payee.lat || point.lon !== payee.lon) {
      Object.assign(patch, point);
      changes.push(
        point.lat
          ? t("services.managePayees.change.coordinates")
          : t("services.managePayees.change.noCoordinates"),
      );
    }
  }

  if (input.aliases != null) {
    const aliases = parseAliases(input.aliases);
    if (aliases.join("|") !== payee.aliases.join("|")) {
      patch.aliases = await assertAliasesFree(input.householdId, aliases, locale, payee.id);
      changes.push(t("services.managePayees.change.aliases"));
    }
  }

  if (changes.length === 0) {
    return { id: payee.id, changes, summary: t("services.managePayees.nothingToChange") };
  }

  await db.update(payees).set(patch).where(eq(payees.id, payee.id));

  return {
    id: payee.id,
    changes,
    summary: t("services.managePayees.done", { changes: changes.join(", ") }),
  };
}

/**
 * Archiving. It never deletes: the entries keep pointing at their place, and the
 * price history of every product bought there is hanging off them.
 *
 * There is nothing to refuse here — no total moves and nothing counts against a
 * place — so unlike an account or a category it always goes through. What it
 * does is take it out of the resolver, so the bot stops offering a shop that
 * closed.
 */
export async function archivePayee(householdId: string, payeeId: string) {
  const locale = await localeOf(householdId);
  const t = getTranslator(locale);
  const payee = await loadPayee(householdId, payeeId, locale);
  if (payee.archivedAt) {
    return { id: payee.id, summary: t("services.managePayees.alreadyArchived", { name: payee.name }) };
  }

  await db.update(payees).set({ archivedAt: new Date() }).where(eq(payees.id, payee.id));
  return { id: payee.id, summary: t("services.managePayees.archived", { name: payee.name }) };
}

/** Returns an archived place to the list. */
export async function unarchivePayee(householdId: string, payeeId: string) {
  const locale = await localeOf(householdId);
  const payee = await loadPayee(householdId, payeeId, locale);

  // Its aliases and its fiscal id were free while it was out of sight; another
  // place may have taken one, and bringing it back would make the resolver
  // choose between the two alphabetically.
  await assertAliasesFree(householdId, payee.aliases, locale, payee.id);
  await assertTaxIdFree(householdId, payee.taxId, payee.address, locale, { exceptId: payee.id });

  await db.update(payees).set({ archivedAt: null }).where(eq(payees.id, payee.id));
  return {
    id: payee.id,
    summary: getTranslator(locale)("services.managePayees.unarchived", { name: payee.name }),
  };
}

export type PayeeNode = {
  id: string;
  name: string;
  taxId: string | null;
  address: string | null;
  aliases: string[];
  parentId: string | null;
  lat: string | null;
  lon: string | null;
  defaultCategory: string | null;
  /** How many entries were bought there. */
  entries: number;
  /** Its own plus its branches': what a chain's total actually is. */
  entriesInTree: number;
  /** Priced line items, which is what puts a place on the products screen. */
  items: number;
  itemsInTree: number;
  branches: PayeeNode[];
};

/**
 * The places, as the tree they are, with what makes each one worth having.
 *
 * The two counts come with the list because they are what the screen is for: a
 * place with entries but no items is one you have never photographed a receipt
 * at, and that is exactly why none of its prices show up on the products screen.
 * Saying it here is what makes somebody take the photo next time.
 */
export async function payeeTree(householdId: string): Promise<PayeeNode[]> {
  const { rows } = await db.execute<{
    id: string;
    name: string;
    tax_id: string | null;
    address: string | null;
    aliases: string[];
    parent_id: string | null;
    lat: string | null;
    lon: string | null;
    category: string | null;
    entries: string;
    items: string;
  }>(sql`
    SELECT p.id, p.name, p.tax_id, p.address, p.aliases, p.parent_id, p.lat, p.lon,
           c.name AS category,
           (SELECT count(*) FROM transactions t
             WHERE t.payee_id = p.id AND t.voided_at IS NULL)::text AS entries,
           (SELECT count(*) FROM transaction_items i
              JOIN transactions t ON t.id = i.transaction_id
             WHERE t.payee_id = p.id AND t.voided_at IS NULL)::text AS items
      FROM payees p
      LEFT JOIN categories c ON c.id = p.default_category_id
     WHERE p.household_id = ${householdId} AND p.archived_at IS NULL
     ORDER BY p.name
  `);

  const nodes = new Map<string, PayeeNode>();
  for (const r of rows) {
    const entries = Number(r.entries);
    const items = Number(r.items);
    nodes.set(r.id, {
      id: r.id,
      name: r.name,
      taxId: r.tax_id,
      address: r.address,
      aliases: r.aliases,
      parentId: r.parent_id,
      lat: r.lat,
      lon: r.lon,
      defaultCategory: r.category,
      entries,
      entriesInTree: entries,
      items,
      itemsInTree: items,
      branches: [],
    });
  }

  const roots: PayeeNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.parentId ? nodes.get(node.parentId) : undefined;
    if (parent) {
      parent.branches.push(node);
      parent.entriesInTree += node.entries;
      parent.itemsInTree += node.items;
    } else {
      roots.push(node);
    }
  }
  return roots;
}

/** The archived ones, so a place archived by mistake is not a psql job. */
export async function archivedPayees(householdId: string) {
  return db
    .select({ id: payees.id, name: payees.name })
    .from(payees)
    .where(and(eq(payees.householdId, householdId), isNotNull(payees.archivedAt)))
    .orderBy(asc(payees.name));
}
