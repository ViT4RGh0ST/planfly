import { and, arrayOverlaps, asc, eq, isNotNull, isNull, ne, sql } from "drizzle-orm";

import { db } from "@/db";
import { normalizeLocale, type Locale } from "@/i18n/config";
import { getTranslator } from "@/i18n/translator";
import { localeOf } from "./household-locale";
import { budgets, categories } from "@/db/schema";
import { normalize, toSlug } from "./resolve-entities";
import { InvalidTransactionError } from "./record-transaction";

/**
 * The ONE write path into the categories.
 *
 * Same principle as `manage-accounts.ts`: until now a category was only born in
 * `scripts/seed.ts` or invented on the fly when the bot could not match one, so
 * changing anything meant opening psql. With a page writing on its side, the
 * rules that keep the figures honest — the unique slug, the aliases the bot
 * matches on, the kind — would end up written twice and diverging.
 *
 * The hierarchy is two levels and no more: «comida > mercado», never
 * «comida > mercado > verduras». It is not a matter of taste. A budget covers a
 * category AND its children (see `budgetUsage`), and reports group by one level;
 * a third level would either be silently ignored or need every one of those
 * queries to become recursive. Two levels is what the product actually uses and
 * what every figure downstream is written for.
 */

export type CategoryKind = "expense" | "income";

/** "super, mercadito" -> ["super","mercadito"] */
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
    throw new InvalidTransactionError(t("services.manageCategories.missingName"), "missing_name");
  }

  const [clash] = await db
    .select({ id: categories.id, name: categories.name, archivedAt: categories.archivedAt })
    .from(categories)
    .where(and(eq(categories.householdId, householdId), eq(categories.slug, slug)))
    .limit(1);

  if (clash && clash.id !== exceptId) {
    // The unique index would fire anyway, with a Postgres error that says
    // neither which category is in the way nor whether it is archived.
    throw new InvalidTransactionError(
      clash.archivedAt
        ? t("services.manageCategories.duplicateArchived", { name: clash.name })
        : t("services.manageCategories.duplicateName", { name: clash.name }),
      "duplicate_name",
    );
  }
  return slug;
}

/**
 * No two categories may answer to the same alias.
 *
 * This is the rule that protects the figures on this screen. The resolver tries
 * slug, then alias, then similarity, and takes `LIMIT 1 ORDER BY score DESC,
 * name ASC` — so two categories sharing «super» are decided **alphabetically**.
 * Nothing fails, nothing is logged, and from then on those expenses land in
 * whichever of the two happens to sort first.
 *
 * It is checked against the archived ones too: unarchiving would resurrect the
 * ambiguity, and the person who does it would have no way of knowing.
 */
async function assertAliasesFree(
  householdId: string,
  aliases: string[],
  locale: Locale,
  exceptId?: string,
) {
  if (aliases.length === 0) return aliases;

  const rows = await db
    .select({ id: categories.id, name: categories.name, aliases: categories.aliases })
    .from(categories)
    .where(
      and(
        eq(categories.householdId, householdId),
        exceptId ? ne(categories.id, exceptId) : undefined,
        // `&&` written by hand expands the array into one parameter per
        // element, which Postgres then reads as a row and not as an array.
        arrayOverlaps(categories.aliases, aliases),
      ),
    );

  const clash = rows[0];
  if (clash) {
    const shared = clash.aliases.filter((alias) => aliases.includes(alias));
    throw new InvalidTransactionError(
      getTranslator(locale)("services.manageCategories.duplicateAlias", {
        alias: shared.join(", "),
        name: clash.name,
      }),
      "duplicate_alias",
    );
  }
  return aliases;
}

/** How many entries the category carries. Decides whether its kind can still move. */
async function entryCount(categoryId: string): Promise<number> {
  const { rows } = await db.execute<{ n: string }>(sql`
    SELECT count(*)::text AS n FROM transaction_entries WHERE category_id = ${categoryId}
  `);
  return Number(rows[0]?.n ?? 0);
}

async function childCount(categoryId: string, onlyActive = true): Promise<number> {
  const [row] = await db
    .select({ n: sql<string>`count(*)::text` })
    .from(categories)
    .where(
      and(
        eq(categories.parentId, categoryId),
        onlyActive ? isNull(categories.archivedAt) : undefined,
      ),
    );
  return Number(row?.n ?? 0);
}

async function loadCategory(householdId: string, categoryId: string, locale: Locale) {
  const [row] = await db
    .select()
    .from(categories)
    .where(and(eq(categories.id, categoryId), eq(categories.householdId, householdId)))
    .limit(1);

  if (!row) {
    throw new InvalidTransactionError(
      getTranslator(locale)("services.manageCategories.categoryNotFound"),
      "category_not_found",
    );
  }
  return row;
}

/**
 * The parent, checked to the letter.
 *
 * Three rules, and each one exists because breaking it produces a figure rather
 * than an error: a parent of another kind would put income under a spending
 * total; a parent that is itself a child would make a third level that the
 * budget query does not walk; and a category that already has children cannot
 * become a child without taking that third level with it.
 */
async function resolveParent(
  householdId: string,
  parentId: string | null,
  kind: CategoryKind,
  locale: Locale,
  selfId?: string,
) {
  if (!parentId) return null;
  const t = getTranslator(locale);

  if (selfId && parentId === selfId) {
    throw new InvalidTransactionError(t("services.manageCategories.ownParent"), "own_parent");
  }

  const parent = await loadCategory(householdId, parentId, locale);

  if (parent.kind !== kind) {
    throw new InvalidTransactionError(
      t("services.manageCategories.parentOtherKind", {
        parent: parent.name,
        kind: t(`domain.entryKind.${parent.kind}`),
      }),
      "parent_other_kind",
    );
  }

  if (parent.parentId) {
    throw new InvalidTransactionError(
      t("services.manageCategories.parentIsChild", { parent: parent.name }),
      "parent_is_child",
    );
  }

  if (parent.archivedAt) {
    throw new InvalidTransactionError(
      t("services.manageCategories.parentArchived", { parent: parent.name }),
      "parent_archived",
    );
  }

  if (selfId && (await childCount(selfId, false)) > 0) {
    throw new InvalidTransactionError(
      t("services.manageCategories.hasChildren", { name: (await loadCategory(householdId, selfId, locale)).name }),
      "has_children",
    );
  }

  return parent;
}

export type CreateCategoryInput = {
  householdId: string;
  /** The household's language. It travels with the timezone: both shape what is said. */
  locale: string;
  name: string;
  kind: CategoryKind;
  parentId?: string | null;
  color?: string;
  aliases?: string;
};

export async function createCategory(input: CreateCategoryInput) {
  const locale = normalizeLocale(input.locale);
  const t = getTranslator(locale);
  const name = input.name.trim();
  const slug = await assertNameFree(input.householdId, name, locale);
  const aliases = await assertAliasesFree(input.householdId, parseAliases(input.aliases), locale);
  const parent = await resolveParent(input.householdId, input.parentId ?? null, input.kind, locale);

  // At the end of its level: the order is the person's, not the insert's luck.
  const [last] = await db
    .select({ sortOrder: categories.sortOrder })
    .from(categories)
    .where(eq(categories.householdId, input.householdId))
    .orderBy(sql`sort_order DESC`)
    .limit(1);

  const [row] = await db
    .insert(categories)
    .values({
      householdId: input.householdId,
      name,
      slug,
      kind: input.kind,
      parentId: parent?.id ?? null,
      // The column carries its own default; sending undefined would override it
      // with null on a NOT NULL column.
      ...(input.color?.trim() ? { color: input.color.trim() } : {}),
      aliases,
      sortOrder: (last?.sortOrder ?? 0) + 1,
    })
    .returning({ id: categories.id, name: categories.name });

  return {
    id: row.id,
    summary: parent
      ? t("services.manageCategories.createdUnder", { name: row.name, parent: parent.name })
      : t("services.manageCategories.created", { name: row.name }),
  };
}

export type UpdateCategoryInput = {
  householdId: string;
  categoryId: string;
  /** The household's language. */
  locale: string;
  name?: string;
  kind?: CategoryKind;
  /** `null` lifts it back to the top level; `undefined` leaves it where it is. */
  parentId?: string | null;
  color?: string;
  aliases?: string;
};

export async function updateCategory(input: UpdateCategoryInput) {
  const locale = normalizeLocale(input.locale);
  const t = getTranslator(locale);
  const category = await loadCategory(input.householdId, input.categoryId, locale);
  const changes: string[] = [];
  const patch: Record<string, unknown> = {};

  if (input.name != null && input.name.trim() && input.name.trim() !== category.name) {
    patch.slug = await assertNameFree(input.householdId, input.name, locale, category.id);
    patch.name = input.name.trim();
    changes.push(t("services.manageCategories.change.name"));
  }

  const kind = (input.kind ?? category.kind) as CategoryKind;
  if (input.kind && input.kind !== category.kind) {
    /*
     * The kind is locked once it has history.
     *
     * `spendingByCategory` only adds up expenses and `resolveCategory` filters
     * by kind: turning a spending category into an income one takes every entry
     * it carries out of the month's total at a stroke, with nothing on screen to
     * say where they went.
     */
    const n = await entryCount(category.id);
    if (n > 0) {
      throw new InvalidTransactionError(
        t("services.manageCategories.kindLocked", {
          name: category.name,
          n,
          kind: t(`domain.entryKind.${category.kind}`),
        }),
        "kind_locked",
      );
    }
    patch.kind = input.kind;
    changes.push(t("services.manageCategories.change.kind"));
  }

  if (input.parentId !== undefined && (input.parentId || null) !== category.parentId) {
    const parent = await resolveParent(
      input.householdId,
      input.parentId,
      kind,
      locale,
      category.id,
    );
    patch.parentId = parent?.id ?? null;
    changes.push(
      parent
        ? t("services.manageCategories.change.parent", { parent: parent.name })
        : t("services.manageCategories.change.noParent"),
    );
  }

  if (input.color != null && input.color.trim() && input.color.trim() !== category.color) {
    patch.color = input.color.trim();
    changes.push(t("services.manageCategories.change.color"));
  }

  if (input.aliases != null) {
    const aliases = parseAliases(input.aliases);
    if (aliases.join("|") !== category.aliases.join("|")) {
      patch.aliases = await assertAliasesFree(input.householdId, aliases, locale, category.id);
      changes.push(t("services.manageCategories.change.aliases"));
    }
  }

  if (changes.length === 0) {
    return { id: category.id, changes, summary: t("services.manageCategories.nothingToChange") };
  }

  await db.update(categories).set(patch).where(eq(categories.id, category.id));

  return {
    id: category.id,
    changes,
    summary: t("services.manageCategories.done", { changes: changes.join(", ") }),
  };
}

/**
 * Archiving. It never deletes: the entries keep pointing at their category, and
 * deleting it would leave a month of spending with no name on the chart.
 *
 * Unlike an account, a category with history CAN be archived — no total moves,
 * because nothing is added up from the category itself. What it may not leave
 * behind is a budget still counting against something invisible, or children
 * hanging from a parent that is no longer on the list.
 */
export async function archiveCategory(householdId: string, categoryId: string) {
  const locale = await localeOf(householdId);
  const t = getTranslator(locale);
  const category = await loadCategory(householdId, categoryId, locale);
  if (category.archivedAt) {
    return { id: category.id, summary: t("services.manageCategories.alreadyArchived", { name: category.name }) };
  }

  const children = await childCount(category.id);
  if (children > 0) {
    throw new InvalidTransactionError(
      t("services.manageCategories.hasActiveChildren", { name: category.name, n: children }),
      "has_active_children",
    );
  }

  const [budget] = await db
    .select({ id: budgets.id })
    .from(budgets)
    .where(
      and(
        eq(budgets.householdId, householdId),
        eq(budgets.categoryId, category.id),
        eq(budgets.isActive, true),
      ),
    )
    .limit(1);

  if (budget) {
    throw new InvalidTransactionError(
      t("services.manageCategories.hasBudget", { name: category.name }),
      "category_has_budget",
    );
  }

  await db
    .update(categories)
    .set({ archivedAt: new Date() })
    .where(eq(categories.id, category.id));

  return { id: category.id, summary: t("services.manageCategories.archived", { name: category.name }) };
}

/** Returns an archived category to the list. */
export async function unarchiveCategory(householdId: string, categoryId: string) {
  const locale = await localeOf(householdId);
  const category = await loadCategory(householdId, categoryId, locale);

  // Its aliases were free while it was out of sight; another category may have
  // taken one in the meantime, and bringing it back would make the resolver
  // choose between the two alphabetically.
  await assertAliasesFree(householdId, category.aliases, locale, category.id);

  // A parent archived in the meantime would leave it hanging off a category
  // that is not on the list.
  if (category.parentId) {
    const parent = await loadCategory(householdId, category.parentId, locale);
    if (parent.archivedAt) {
      throw new InvalidTransactionError(
        getTranslator(locale)("services.manageCategories.parentArchived", { parent: parent.name }),
        "parent_archived",
      );
    }
  }

  await db.update(categories).set({ archivedAt: null }).where(eq(categories.id, category.id));
  return {
    id: category.id,
    summary: getTranslator(locale)("services.manageCategories.unarchived", { name: category.name }),
  };
}

export type CategoryNode = {
  id: string;
  name: string;
  kind: CategoryKind;
  color: string;
  aliases: string[];
  parentId: string | null;
  /** How many entries carry it. What tells you whether its kind can still change. */
  entries: number;
  /**
   * Its own plus its children's.
   *
   * It is what the screen shows, because it is what a budget on it counts. A
   * parent almost never carries entries directly — that is what the children are
   * for — so `entries` alone paints every parent as unused next to children with
   * six each.
   */
  entriesInTree: number;
  children: CategoryNode[];
};

/**
 * The tree, in one query.
 *
 * The count of entries comes with it because the screen needs it for every row:
 * asking for it per category would be one query per line, and it is the datum
 * that explains why a kind cannot be changed before the person tries.
 */
export async function categoryTree(householdId: string): Promise<CategoryNode[]> {
  const { rows } = await db.execute<{
    id: string;
    name: string;
    kind: CategoryKind;
    color: string;
    aliases: string[];
    parent_id: string | null;
    entries: string;
  }>(sql`
    SELECT c.id, c.name, c.kind::text AS kind, c.color, c.aliases, c.parent_id,
           (SELECT count(*)::text FROM transaction_entries e WHERE e.category_id = c.id) AS entries
      FROM categories c
     WHERE c.household_id = ${householdId} AND c.archived_at IS NULL
     ORDER BY c.sort_order, c.name
  `);

  const nodes = new Map<string, CategoryNode>();
  for (const row of rows) {
    nodes.set(row.id, {
      id: row.id,
      name: row.name,
      kind: row.kind,
      color: row.color,
      aliases: row.aliases,
      parentId: row.parent_id,
      entries: Number(row.entries),
      entriesInTree: Number(row.entries),
      children: [],
    });
  }

  const roots: CategoryNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.parentId ? nodes.get(node.parentId) : undefined;
    if (parent) {
      parent.children.push(node);
      parent.entriesInTree += node.entries;
    } else {
      roots.push(node);
    }
  }
  return roots;
}

/** The archived ones, so a category archived by mistake is not a psql job. */
export async function archivedCategories(householdId: string) {
  return db
    .select({ id: categories.id, name: categories.name, kind: categories.kind })
    .from(categories)
    .where(and(eq(categories.householdId, householdId), isNotNull(categories.archivedAt)))
    .orderBy(asc(categories.name));
}
