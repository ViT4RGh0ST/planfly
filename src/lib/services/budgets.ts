import { and, asc, desc, eq } from "drizzle-orm";

import { db } from "@/db";
import { budgets, categories } from "@/db/schema";
import type { BudgetPeriod } from "@/lib/dates";
import { addDays, budgetPeriod, formatDay } from "@/lib/dates";
import { formatAmount, parseAmountToMinor } from "@/lib/money";
import { InvalidTransactionError } from "./record-transaction";
import { resolveCategory } from "./resolve-entities";
import { normalizeLocale } from "@/i18n/config";
import { getTranslator } from "@/i18n/translator";

/**
 * Spending caps by category and period.
 *
 * It lived entirely inside a server action, so it only existed for the screen:
 * the bot could neither set a cap nor remove one. Here it stays as a service so
 * both surfaces write through the same place, just as happens with entries and
 * with accounts.
 *
 * **Removing is deactivating, not deleting.** The period that has passed did
 * have a cap, and deleting it would rewrite backwards what was compared against
 * what. `budgetUsage` already filters by `is_active`, so deactivating takes it
 * off the screen without touching the history.
 */

export type SaveBudgetInput = {
  householdId: string;
  baseCurrency: string;
  timezone: string;
  /** The household's language: the summary is worded here and repeated verbatim. */
  locale: string;
  /** In the words of whoever asks; resolved fuzzily. */
  category: string;
  /** MAJOR units: "250,00". */
  amount: string | number;
  period?: BudgetPeriod;
  /** Only with `custom`: first day and LAST day included. */
  periodStart?: string;
  periodEnd?: string;
  today: string;
};

export async function saveBudget(input: SaveBudgetInput) {
  const t = getTranslator(normalizeLocale(input.locale));
  const category = await resolveCategory(input.householdId, input.category, "expense");
  if (!category) {
    throw new InvalidTransactionError(
      t("services.budgets.categoryNotFound", { input: input.category }),
      "category_not_found",
    );
  }

  const period = (input.period ?? "monthly") as BudgetPeriod;
  if (!["monthly", "biweekly", "yearly", "custom"].includes(period)) {
    throw new InvalidTransactionError(t("services.budgets.unknownPeriod"), "invalid_period");
  }

  let periodStart: string;
  let periodEnd: string;

  if (period === "custom") {
    // The one case where the dates are not derived: whoever asks sets them, so
    // they have to be checked rather than trusted.
    periodStart = input.periodStart ?? "";
    periodEnd = input.periodEnd ?? "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(periodStart) || !/^\d{4}-\d{2}-\d{2}$/.test(periodEnd)) {
      throw new InvalidTransactionError(t("services.budgets.missingRange"), "missing_range");
    }
    if (periodEnd < periodStart) {
      throw new InvalidTransactionError(t("services.budgets.endBeforeStart"), "inverted_range");
    }
    // The last day INCLUDED is what is asked for, which is how people say it;
    // inside it is stored half-open, like every range in the app.
    periodEnd = addDays(periodEnd, 1);
  } else {
    const range = budgetPeriod(period, input.today);
    periodStart = range.from;
    periodEnd = range.to;
  }

  const amountMinor = parseAmountToMinor(input.amount, input.baseCurrency);

  /*
   * What was there before, so it can be said.
   *
   * Creation is an upsert over (household, category, period, start), so setting
   * a cap on Groceries again REPLACES it. That is fine — it is how you change it
   * — but staying quiet is not: «saved» over a change from 250 to 150 hides
   * exactly what needed confirming.
   */
  const [previous] = await db
    .select({ amountMinor: budgets.amountMinor, isActive: budgets.isActive })
    .from(budgets)
    .where(
      and(
        eq(budgets.householdId, input.householdId),
        eq(budgets.categoryId, category.id),
        eq(budgets.period, period),
        eq(budgets.periodStart, periodStart),
      ),
    )
    .limit(1);

  await db
    .insert(budgets)
    .values({
      householdId: input.householdId,
      categoryId: category.id,
      period,
      periodStart,
      periodEnd,
      amountMinor,
      currency: input.baseCurrency,
    })
    .onConflictDoUpdate({
      target: [budgets.householdId, budgets.categoryId, budgets.period, budgets.periodStart],
      set: { amountMinor, periodEnd, isActive: true },
    });

  return {
    categoryId: category.id,
    summary: t("services.budgets.saved", {
      category: category.name,
      amount: formatAmount(amountMinor, input.baseCurrency),
      period: t(`domain.budgetPeriod.${period}`),
      change:
        previous && previous.isActive && previous.amountMinor !== amountMinor
          ? t("services.budgets.changedFrom", {
              amount: formatAmount(previous.amountMinor, input.baseCurrency),
            })
          : "",
    }),
  };
}

/** Removes a cap. Deactivates, does not delete: the past period did have one. */
export async function removeBudget(params: {
  householdId: string;
  category: string;
  period?: BudgetPeriod;
  /** The household's language. */
  locale: string;
}) {
  const t = getTranslator(normalizeLocale(params.locale));
  const category = await resolveCategory(params.householdId, params.category, "expense");
  if (!category) {
    throw new InvalidTransactionError(
      t("services.budgets.categoryNotFound", { input: params.category }),
      "category_not_found",
    );
  }

  const where = params.period
    ? and(
        eq(budgets.householdId, params.householdId),
        eq(budgets.categoryId, category.id),
        eq(budgets.period, params.period),
        eq(budgets.isActive, true),
      )
    : and(
        eq(budgets.householdId, params.householdId),
        eq(budgets.categoryId, category.id),
        eq(budgets.isActive, true),
      );

  const gone = await db
    .update(budgets)
    .set({ isActive: false })
    .where(where)
    .returning({ id: budgets.id });

  if (gone.length === 0) {
    throw new InvalidTransactionError(
      t("services.budgets.noneActive", { category: category.name }),
      "budget_not_found",
    );
  }

  return {
    summary: t("services.budgets.removed", { n: gone.length, category: category.name }),
  };
}

/** The caps in force, with their category. So the agent invents none. */
export async function listBudgets(householdId: string, locale: string) {
  const t = getTranslator(normalizeLocale(locale));
  const rows = await db
    .select({
      id: budgets.id,
      category: categories.name,
      period: budgets.period,
      periodStart: budgets.periodStart,
      periodEnd: budgets.periodEnd,
      amountMinor: budgets.amountMinor,
      currency: budgets.currency,
    })
    .from(budgets)
    .innerJoin(categories, eq(categories.id, budgets.categoryId))
    .where(and(eq(budgets.householdId, householdId), eq(budgets.isActive, true)))
    .orderBy(asc(categories.name), desc(budgets.periodStart));

  return rows.map((b) => ({
    ...b,
    amount: formatAmount(b.amountMinor, b.currency),
    periodName: t(`domain.budgetPeriod.${b.period}`),
    // The last day INCLUDED, which is the one a person understands.
    rangeText: `${formatDay(b.periodStart, locale)} — ${formatDay(addDays(b.periodEnd, -1), locale)}`,
  }));
}
