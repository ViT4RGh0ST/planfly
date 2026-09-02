import Link from "next/link";
import { AlertTriangle, ArrowUpRight } from "lucide-react";

import { AccountList } from "@/components/account-list";
import { CategoriesChart } from "@/components/categories-chart";
import { MonthFlow } from "@/components/month-flow";
import { NetWorth } from "@/components/net-worth";
import { RateBadges } from "@/components/rate-badges";
import { TransactionsTable } from "@/components/transactions-table";
import { requireSession } from "@/lib/session";
import { formatAmount, minorUnit } from "@/lib/money";
import { formatLongDay, today } from "@/lib/dates";
import { currentRates } from "@/lib/rates/service";
import {
  committedInstallments,
  netWorth,
  pendingReviewCount,
  periodSummary,
  recentTransactions,
  spendingByCategory,
  type Valuation, valuationFrom,
} from "@/lib/services/reports";
import { getTranslations } from "next-intl/server";

export const dynamic = "force-dynamic";

/**
 * The valuation label accompanying every derived section.
 *
 * Four sections change value when the hero is clicked and none declared it: you
 * had to remember which rate was active in order to read the table. A number
 * with no visible provenance is worth less than an honest hole, and that applies
 * even when the number is right.
 */
function ValuationTag({ valuation, label }: { valuation: Valuation; label: string }) {
  /*
   * The slot, not the institution.
   *
   * It said «BCV» and «P2P», which is right for the bolívar and wrong for every
   * other currency the same dashboard now adds up: a household holding pesos saw
   * its total tagged with the name of Venezuela's central bank. The rates screen
   * still names the institution beside each figure, where it belongs.
   */
  return (
    <span className={valuation === "official" ? "text-official" : "text-parallel"}>
      {" · "}
      {label}
    </span>
  );
}

/**
 * The dashboard.
 *
 * It is opened several times a day from the desktop to answer one question: "how
 * much do I have?". That is why the net position takes the top with no
 * competition — it used to be four cards of the same size and weight, and that
 * grid said all four figures mattered equally.
 *
 * The rest descends in hierarchy: the month's flow, then the balances, and the
 * chart at the end as context.
 */
export default async function Dashboard({
  searchParams,
}: {
  searchParams: Promise<{ rate?: string }>;
}) {
  const ctx = await requireSession();
  const t = await getTranslations();
  const params = await searchParams;
  const valuation: Valuation = valuationFrom(params.rate);
  const date = today(ctx.timezone);
  const base = ctx.baseCurrency;

  const [position, committed, summary, spending, transactions, rates, pendingReview] =
    await Promise.all([
      netWorth(ctx.householdId, date, base),
      committedInstallments(ctx.householdId, date, base),
      periodSummary(ctx.householdId, "mes", ctx.timezone, valuation),
      spendingByCategory(ctx.householdId, "month", ctx.timezone, valuation, ctx.locale),
      recentTransactions(ctx.householdId, { limit: 8 }),
      currentRates(date),
      // The real total, not whichever show up among the last 8: if the queue is old,
      // deriving it from the sample made the badge disappear exactly when it mattered.
      pendingReviewCount(ctx.householdId),
    ]);

  const divisor = 10 ** minorUnit(base);

  const TOP_CATEGORIES = 8;
  const topCategories = spending.categories.slice(0, TOP_CATEGORIES);
  const hidden = spending.categories.slice(TOP_CATEGORIES);
  const hiddenCategories = hidden.length;
  const hiddenTotalMinor = hidden.reduce((sum, c) => sum + c.totalMinor, 0);

  const spread =
    rates.official && rates.parallel
      ? (Number(rates.parallel.rate) / Number(rates.official.rate) - 1) * 100
      : null;

  return (
    <div className="mx-auto max-w-5xl px-6 py-10">
      <header className="mb-10 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-medium tracking-tight">{ctx.householdName}</h1>
          <p className="text-sm text-muted-foreground">
            {formatLongDay(date, ctx.locale)}
          </p>
        </div>
        <RateBadges rates={rates} />
      </header>

      <NetWorth
        officialMinor={position.totalOfficialMinor}
        parallelMinor={position.totalParallelMinor}
        assetsOfficialMinor={position.assetsOfficialMinor}
        assetsParallelMinor={position.assetsParallelMinor}
        liabilitiesOfficialMinor={position.liabilitiesOfficialMinor}
        liabilitiesParallelMinor={position.liabilitiesParallelMinor}
        currency={base}
        spreadPercent={spread}
        accountCount={position.accounts.length}
        coverage={position.coverage}
        committed={committed}
      />

      {pendingReview > 0 && (
        <Link
          href="/review"
          className="mt-8 flex items-center gap-3 rounded-lg border border-caution/30 bg-caution/[0.07] px-4 py-3 text-sm text-caution transition-colors hover:bg-caution/[0.12] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          <AlertTriangle className="size-4 shrink-0" />
          <span className="flex-1">
            {t("ui.dashboard.pendingReview", { n: pendingReview })}
          </span>
          <ArrowUpRight className="size-4 shrink-0" />
        </Link>
      )}

      {/* Accounts is the breakdown of the figure above — stock, today's rate —
          so it lives in the same band. It used to sit in the month-flow band,
          which is valued at historical rates: two different regimes presented as
          the same family of data. */}
      <section aria-labelledby="cuentas" className="mt-10">
        <h2
          id="cuentas"
          className="mb-2 text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground"
        >
          {t("ui.dashboard.accounts")}
          <ValuationTag valuation={valuation} label={t(`domain.rateSlotShort.${valuation}`)} />
        </h2>
        <AccountList accounts={position.accounts} baseCurrency={base} valuation={valuation} />
      </section>

      <hr className="my-10 border-border" />

      <section aria-labelledby="mes">
        <h2
          id="mes"
          className="mb-4 text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground"
        >
          {t("ui.dashboard.thisMonth")}
          <ValuationTag valuation={valuation} label={t(`domain.rateSlotShort.${valuation}`)} />
        </h2>
        <MonthFlow
          incomeMinor={summary.incomeMinor}
          expenseMinor={summary.expenseMinor}
          balanceMinor={summary.balanceMinor}
          incomeCount={summary.incomeCount}
          expenseCount={summary.expenseCount}
          currency={base}
          period={t("ui.dashboard.thisMonthPeriod")}
        />

        {/* Subordinate to the month's flow and not its sibling: the breakdown by
            category is context, not the lead. */}
        <h3 className="mb-4 mt-8 text-xs uppercase tracking-[0.12em] text-muted-foreground">
          {t("ui.dashboard.whereItWent")}
        </h3>
        <CategoriesChart
          currency={base}
          data={topCategories.map((c) => ({
            name: c.name,
            color: c.color,
            total: c.totalMinor / divisor,
          }))}
        />
        {hiddenCategories > 0 && (
          // It used to be cut at 8 without saying so, so the bars' sum did not match
          // "Spending" and nothing warned about it.
          <p className="mt-3 text-xs text-muted-foreground">
            {t("ui.dashboard.hiddenCategories", {
              n: hiddenCategories,
              amount: formatAmount(hiddenTotalMinor, base),
            })}
          </p>
        )}
      </section>

      <hr className="my-10 border-border" />

      <section aria-labelledby="ultimos">
        <div className="mb-4 flex items-baseline justify-between gap-4">
          <h2
            id="ultimos"
            className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground"
          >
            {t("ui.dashboard.latest")}
            <ValuationTag valuation={valuation} label={t(`domain.rateSlotShort.${valuation}`)} />
          </h2>
          <Link
            href="/transactions"
            className="text-sm text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            {t("ui.dashboard.seeAll")}
          </Link>
        </div>
        <TransactionsTable
          transactions={transactions}
          baseCurrency={base}
          valuation={valuation}
        />
      </section>
    </div>
  );
}
