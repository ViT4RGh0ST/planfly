import { and, asc, eq } from "drizzle-orm";

import { db } from "@/db";
import { categories, categorizationRules } from "@/db/schema";
import { InvalidTransactionError } from "./record-transaction";
import { resolveCategory } from "./resolve-entities";
import { normalizeLocale } from "@/i18n/config";
import { getTranslator } from "@/i18n/translator";

/**
 * The rules that categorise only what is imported.
 *
 * The only place `categorization_rules` is written, for the same reason as the
 * rest: a badly stored rule does not fail, it miscategorises two hundred rows at
 * once and has to be undone by hand.
 *
 * `amount` is not offered even though the enum has it: it is not implemented in
 * `applyRules`, and a rule that does nothing is worse than not being able to
 * create one.
 */
export type RuleField = "description" | "payee";
export type RuleOperator = "contains" | "equals" | "regex";

export type SaveRuleInput = {
  householdId: string;
  id?: string;
  /** The text being searched for. In the words of whoever writes it. */
  pattern: string;
  field?: RuleField;
  operator?: RuleOperator;
  /** Category name; resolved fuzzily, as everywhere else. */
  category: string;
  /** Lower number, rules first. Defaults to 100. */
  priority?: number;
  /** The household's language. */
  locale: string;
};

export async function saveRule(input: SaveRuleInput) {
  const t = getTranslator(normalizeLocale(input.locale));
  const pattern = input.pattern.trim();
  if (!pattern) {
    throw new InvalidTransactionError(t("services.rules.missingPattern"), "missing_pattern");
  }

  const category = await resolveCategory(input.householdId, input.category, "expense");
  if (!category) {
    throw new InvalidTransactionError(
      t("services.rules.categoryNotFound", { input: input.category }),
      "category_not_found",
    );
  }

  const values = {
    householdId: input.householdId,
    pattern,
    field: input.field ?? ("description" as const),
    operator: input.operator ?? ("contains" as const),
    setCategoryId: category.id,
    priority: input.priority ?? 100,
    isActive: true,
  };

  if (input.id) {
    await db
      .update(categorizationRules)
      .set(values)
      .where(
        and(
          eq(categorizationRules.id, input.id),
          eq(categorizationRules.householdId, input.householdId),
        ),
      );
    return {
      id: input.id,
      summary: t("services.rules.updated", { pattern, category: category.name }),
    };
  }

  const [row] = await db.insert(categorizationRules).values(values).returning({
    id: categorizationRules.id,
  });
  return {
    id: row.id,
    summary: t("services.rules.saved", { pattern, category: category.name }),
  };
}

export async function removeRule(householdId: string, id: string): Promise<boolean> {
  // It is genuinely deleted, not deactivated: a rule is not a historical datum,
  // it is a preference. What it already categorised stays as it is.
  const rows = await db
    .delete(categorizationRules)
    .where(
      and(eq(categorizationRules.id, id), eq(categorizationRules.householdId, householdId)),
    )
    .returning({ id: categorizationRules.id });
  return rows.length > 0;
}

export async function listRules(householdId: string) {
  return db
    .select({
      id: categorizationRules.id,
      pattern: categorizationRules.pattern,
      field: categorizationRules.field,
      operator: categorizationRules.operator,
      priority: categorizationRules.priority,
      isActive: categorizationRules.isActive,
      category: categories.name,
    })
    .from(categorizationRules)
    .leftJoin(categories, eq(categories.id, categorizationRules.setCategoryId))
    .where(eq(categorizationRules.householdId, householdId))
    .orderBy(asc(categorizationRules.priority), asc(categorizationRules.pattern));
}
