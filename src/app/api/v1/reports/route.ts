import { NextResponse } from "next/server";

import { withToken } from "@/lib/api/handler";
import { reportSchema } from "@/lib/validation";
import { formatAmount } from "@/lib/money";
import { resolvePeriod, today } from "@/lib/dates";
import { normalizeLocale } from "@/i18n/config";
import { periodName } from "@/i18n/periods";
import { getTranslator } from "@/i18n/translator";
import {
  budgetUsage,
  netWorth,
  periodSummary,
  recentTransactions,
  spendingByCategory,
} from "@/lib/services/reports";

export const dynamic = "force-dynamic";

/**
 * Read queries for the agent.
 *
 * Every response carries `summary`: an already formatted block. It is
 * deliberate — it lets a cheap model answer well without doing arithmetic or
 * reformatting figures, which is exactly where small models go wrong.
 */
export const GET = withToken("reports:read", async ({ principal, req }) => {
  const url = new URL(req.url);
  const input = reportSchema.parse({
    report: url.searchParams.get("report") ?? undefined,
    period: url.searchParams.get("period") ?? undefined,
    valuation: url.searchParams.get("valuation") ?? undefined,
    limit: url.searchParams.get("limit") ?? undefined,
  });

  const timezone = principal.timezone;
  const base = principal.baseCurrency;
  const date = today(timezone);
  const valuation = input.valuation ?? "p2p";
  const valuationLabel = valuation === "bcv" ? "BCV" : "P2P";
  // The household's language, not the request's: what comes back from here gets
  // repeated verbatim in a chat that is already happening in one of the two.
  const t = getTranslator(normalizeLocale(principal.locale));

  switch (input.report) {
    case "net_worth":
    case "balances": {
      const position = await netWorth(principal.householdId, date, base);
      const total = valuation === "bcv" ? position.totalBcvMinor : position.totalP2pMinor;

      const lines = position.accounts.map((a) => {
        const inBase = valuation === "bcv" ? a.baseBcvMinor : a.baseP2pMinor;
        return t("api.reports.netWorth.line", {
          account: a.name,
          balance: a.balanceText,
          equivalent:
            a.currency !== base && inBase != null
              ? t("api.reports.netWorth.equivalent", { amount: formatAmount(inBase, base) })
              : "",
        });
      });

      const summary = [
        t("api.reports.netWorth.total", { valuation: valuationLabel, amount: formatAmount(total, base) }),
        t("api.reports.netWorth.assets", {
          amount: formatAmount(
            valuation === "bcv" ? position.assetsBcvMinor : position.assetsP2pMinor,
            base,
          ),
        }),
        t("api.reports.netWorth.liabilities", {
          amount: formatAmount(
            valuation === "bcv" ? position.liabilitiesBcvMinor : position.liabilitiesP2pMinor,
            base,
          ),
        }),
        "",
        ...lines,
        "",
        t("api.reports.netWorth.bothRates", {
          bcv: formatAmount(position.totalBcvMinor, base),
          p2p: formatAmount(position.totalP2pMinor, base),
        }),
      ].join("\n");

      return NextResponse.json({
        ok: true,
        report: input.report,
        valuation,
        data: position,
        summary,
      });
    }

    case "spending_by_category": {
      const spending = await spendingByCategory(
        principal.householdId,
        input.period,
        timezone,
        valuation,
        principal.locale,
      );
      const total = spending.categories.reduce((acc, c) => acc + c.totalMinor, 0);
      const summary = [
        t("api.reports.spending.head", {
          period: periodName(t, spending.periodRef),
          valuation: valuationLabel,
          amount: formatAmount(total, base),
        }),
        ...spending.categories.map((c) =>
          t("api.reports.spending.line", {
            category: c.name,
            amount: formatAmount(c.totalMinor, base),
            percent: total > 0 ? Math.round((c.totalMinor / total) * 100) : 0,
            n: c.transactionCount,
          }),
        ),
      ].join("\n");

      /*
       * `period_key` next to the summary, so the caller can tell WHICH period it
       * got without reading the sentence. It used to be inferable only from the
       * prose, which meant an integration wanting to check it had to parse
       * Spanish; and if an alias ever stopped resolving, the answer would come
       * back 200, perfectly worded, about the current month.
       */
      return NextResponse.json({
        ok: true,
        report: input.report,
        period_key: spending.periodRef.key,
        data: spending,
        summary,
      });
    }

    case "budgets": {
      // Everything in force today, in whatever form: month, fortnight, year or a loose range.
      const usage = await budgetUsage(principal.householdId, date, valuation);
      const summary =
        usage.length === 0
          ? t("api.reports.budgets.none")
          : [
              t("api.reports.budgets.head", { valuation: valuationLabel }),
              ...usage.map((b) =>
                t("api.reports.budgets.line", {
                  category: b.category,
                  spent: formatAmount(b.spentMinor, b.currency),
                  budget: formatAmount(b.budgetMinor, b.currency),
                  percent: b.percent,
                  state:
                    b.remainingMinor < 0
                      ? t("api.reports.budgets.over")
                      : t("api.reports.budgets.left", {
                          amount: formatAmount(b.remainingMinor, b.currency),
                        }),
                }),
              ),
            ].join("\n");

      return NextResponse.json({ ok: true, report: input.report, data: usage, summary });
    }

    case "recent_transactions": {
      const { from, to, ref } = resolvePeriod(input.period, timezone);
      const items = await recentTransactions(principal.householdId, {
        limit: input.limit ?? 10,
        from: input.period ? from : undefined,
        to: input.period ? to : undefined,
        // What the bot recorded without being sure. Without being able to list it, the
        // tray could only be emptied from the web even though approving already existed.
        onlyNeedsReview: new URL(req.url).searchParams.get("review") === "1",
      });
      const summary =
        items.length === 0
          ? t("api.reports.recent.none")
          : items
              .map((row) =>
                t("api.reports.recent.line", {
                  date: row.occurredOn,
                  description: row.description,
                  amount: row.amountText,
                  account: row.account,
                  category: row.category
                    ? t("api.reports.recent.category", { name: row.category })
                    : "",
                }),
              )
              .join("\n");

      return NextResponse.json({
        ok: true,
        report: input.report,
        period_key: ref.key,
        data: items,
        summary,
      });
    }

    case "month_summary":
    default: {
      const totals = await periodSummary(principal.householdId, input.period, timezone, valuation);
      const spending = await spendingByCategory(
        principal.householdId,
        input.period,
        timezone,
        valuation,
        principal.locale,
      );
      const top = spending.categories.slice(0, 5);

      const summary = [
        t("api.reports.month.head", {
          period: periodName(t, totals.periodRef),
          valuation: valuationLabel,
        }),
        t("api.reports.month.income", {
          amount: formatAmount(totals.incomeMinor, base),
          n: totals.incomeCount,
        }),
        t("api.reports.month.expense", {
          amount: formatAmount(totals.expenseMinor, base),
          n: totals.expenseCount,
        }),
        t("api.reports.month.balance", {
          amount: formatAmount(totals.balanceMinor, base, { showPlus: true }),
        }),
        top.length > 0 ? t("api.reports.month.top") : "",
        ...top.map((c) =>
          t("api.reports.month.topLine", {
            category: c.name,
            amount: formatAmount(c.totalMinor, base),
          }),
        ),
      ]
        .filter(Boolean)
        .join("\n");

      return NextResponse.json({
        ok: true,
        report: "month_summary",
        period_key: totals.periodRef.key,
        data: { ...totals, categories: spending.categories },
        summary,
      });
    }
  }
});
