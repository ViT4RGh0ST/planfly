import { and, asc, eq, isNull } from "drizzle-orm";

import { AddBudget } from "@/components/budget-actions";
import { RatePicker } from "@/components/rate-picker";
import { db } from "@/db";
import { categories } from "@/db/schema";
import { requireSession } from "@/lib/session";
import { currentRates } from "@/lib/rates/service";
import { formatAmount } from "@/lib/money";
import { formatDay, today } from "@/lib/dates";
import { budgetUsage, type Valuation } from "@/lib/services/reports";
import { cn } from "@/lib/utils";
import { getTranslations } from "next-intl/server";

export const dynamic = "force-dynamic";

/**
 * What each period is called in its group header.
 *
 * The range is always there, even on the ones computed automatically: "this
 * month" with no dates forces you to remember which day you are living in to
 * know how much is left.
 */
function periodLabel(
  b: { period: string; periodStart: string; periodEnd: string },
  locale: string,
  t: (key: string) => string,
) {
  const from = formatDay(b.periodStart, locale);
  // `periodEnd` is exclusive: the last day included is the one before.
  const to = formatDay(
    new Date(Date.parse(`${b.periodEnd}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10),
    locale,
  );

  if (b.period === "monthly") {
    return { title: t("ui.budgets.period.monthly"), range: `${from} — ${to}` };
  }
  if (b.period === "biweekly") {
    return {
      title:
        Number(b.periodStart.slice(8, 10)) === 1
          ? t("ui.budgets.period.firstFortnight")
          : t("ui.budgets.period.secondFortnight"),
      range: `${from} — ${to}`,
    };
  }
  if (b.period === "yearly") {
    return { title: b.periodStart.slice(0, 4), range: `${from} — ${to}` };
  }
  return { title: t("ui.budgets.period.custom"), range: `${from} — ${to}` };
}

export default async function BudgetsPage({
  searchParams,
}: {
  searchParams: Promise<{ rate?: string }>;
}) {
  const ctx = await requireSession();
  const t = await getTranslations();
  const params = await searchParams;
  const valuation: Valuation = params.rate === "bcv" ? "bcv" : "p2p";

  const date = today(ctx.timezone);

  const [usage, categoryList, rates] = await Promise.all([
    // Everything in force today: each brings its own range and its own rhythm.
    budgetUsage(ctx.householdId, date, valuation),
    db
      .select({ name: categories.name })
      .from(categories)
      .where(
        and(
          eq(categories.householdId, ctx.householdId),
          eq(categories.kind, "expense"),
          isNull(categories.archivedAt),
        ),
      )
      .orderBy(asc(categories.sortOrder)),
    currentRates(date),
  ]);

  // A fortnightly budget and a monthly one are not read together: they go in
  // groups, and each group says from when to when it runs.
  const groups = new Map<string, { label: ReturnType<typeof periodLabel>; items: typeof usage }>();
  for (const b of usage) {
    const key = `${b.period}:${b.periodStart}:${b.periodEnd}`;
    if (!groups.has(key)) groups.set(key, { label: periodLabel(b, ctx.locale, t), items: [] });
    groups.get(key)!.items.push(b);
  }

  return (
    <div className="mx-auto max-w-3xl px-6 py-10">
      <header className="mb-10">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <h1 className="text-lg font-medium tracking-tight">{t("ui.budgets.title")}</h1>
          <div className="flex flex-wrap items-center gap-4">
            <RatePicker rates={rates} />
            <AddBudget
              categories={categoryList.map((c) => c.name)}
              currency={ctx.baseCurrency}
              today={date}
            />
          </div>
        </div>
        <p className="mt-2 max-w-[62ch] text-sm text-muted-foreground">
          {t("ui.budgets.hint", { base: ctx.baseCurrency })}
        </p>
      </header>

      {usage.length === 0 ? (
        <p className="max-w-prose text-sm text-muted-foreground">
          {t("ui.budgets.empty")}
        </p>
      ) : (
        <div className="grid gap-10">
          {[...groups.values()].map((group) => (
            <section key={group.label.title + group.label.range} aria-label={group.label.title}>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">
                  {group.label.title}
                </h2>
                <p className="text-xs text-muted-foreground tabular-nums">
                  {t("ui.budgets.day", {
                    range: group.label.range,
                    elapsed: group.items[0].elapsedDays,
                    total: group.items[0].totalDays,
                  })}
                </p>
              </div>
              <div className="mt-4 grid gap-5">
                {group.items.map((budget) => {
                  const overBudget = budget.remainingMinor < 0;
                  const aheadOfPace = budget.percent > budget.expectedPace + 10;
                  return (
                    <div key={budget.id}>
                      <div className="flex items-baseline justify-between gap-2 text-sm">
                        <span className="flex items-center gap-2">
                          <span
                            className="size-2 rounded-full"
                            style={{ background: budget.color }}
                          />
                          {budget.category}
                        </span>
                        <span className="tabular-nums text-muted-foreground">
                          {t("ui.budgets.spentOf", {
                            spent: formatAmount(budget.spentMinor, budget.currency),
                            budget: formatAmount(budget.budgetMinor, budget.currency),
                          })}
                        </span>
                      </div>

                      {/* The bar is the illustration; the text below it is
                          the datum. Hence `aria-hidden`: a screen reader
                          announcing it would say the same thing twice, and the
                          pace mark has no way of being said out loud. */}
                      <div
                        aria-hidden
                        className="relative mt-2 h-2 overflow-hidden rounded-full bg-secondary"
                      >
                        <div
                          className={cn(
                            "h-full rounded-full transition-all",
                            overBudget ? "bg-negative" : aheadOfPace ? "bg-caution" : "bg-positive",
                          )}
                          style={{ width: `${Math.min(100, Math.max(0, budget.percent))}%` }}
                        />
                        {/* The expected-pace mark: where you ought to be
                            today. It is computed over ITS period — day 12 is
                            39% of a month but 80% of a fortnight. */}
                        <div
                          className="absolute top-0 h-full w-px bg-foreground/40"
                          style={{ left: `${Math.min(100, budget.expectedPace)}%` }}
                        />
                      </div>

                      <p
                        className={cn(
                          "mt-1 text-xs",
                          overBudget
                            ? "text-negative"
                            : aheadOfPace
                              ? "text-caution"
                              : "text-muted-foreground",
                        )}
                      >
                        {overBudget
                          ? t("ui.budgets.over", {
                              amount: formatAmount(-budget.remainingMinor, budget.currency),
                            })
                          : t("ui.budgets.left", {
                              amount: formatAmount(budget.remainingMinor, budget.currency),
                            })}
                        {/* Both percentages together, which is what makes the
                            bar's mark readable without having to remember where
                            it came from: the expected pace used to live in the
                            group's header and the mark said it nowhere. */}
                        {t("ui.budgets.pace", {
                          percent: budget.percent,
                          expected: budget.expectedPace,
                        })}
                        {aheadOfPace && !overBudget && t("ui.budgets.aheadOfPace")}
                      </p>
                    </div>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
