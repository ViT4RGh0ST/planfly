import { and, asc, eq, isNull } from "drizzle-orm";

import { FinancingForm } from "@/components/financing-form";
import { RatePicker } from "@/components/rate-picker";
import { BothRates } from "@/components/rate-line";
import { FinancierList } from "@/components/financier-list";
import { InstallmentList } from "@/components/installment-list";
import { db } from "@/db";
import { accounts, categories, currencies as currenciesTable } from "@/db/schema";
import { requireSession } from "@/lib/session";
import { formatDay, today } from "@/lib/dates";
import { convertToBase, formatAmount } from "@/lib/money";
import { currentRates } from "@/lib/rates/service";
import {
  financiersView,
  financingPlansView,
  upcomingInstallments,
} from "@/lib/services/financing";
import { valuationFrom, type Valuation } from "@/lib/services/reports";
import { getTranslations } from "next-intl/server";

export const dynamic = "force-dynamic";

/**
 * Installment purchases.
 *
 * Buying on finance is routine here, not a rare case, and the ledger on its own
 * does not answer the one thing you need to know afterwards: **how much is left
 * and by when**. What you owe already lives on the account of whoever finances
 * you, like any other liability; this screen is the schedule.
 */
export default async function FinancingPage({
  searchParams,
}: {
  searchParams: Promise<{ rate?: string }>;
}) {
  const ctx = await requireSession();
  const t = await getTranslations();
  const params = await searchParams;
  const valuation: Valuation = valuationFrom(params.rate);
  const date = today(ctx.timezone);

  const [plans, financiers, upcoming, accountList, categoryList, rates, currencyList] =
    await Promise.all([
    financingPlansView(ctx.householdId),
      financiersView(ctx.householdId),
    upcomingInstallments(ctx.householdId, 7),
    db
      .select({
        name: accounts.name,
        currency: accounts.currency,
        nature: accounts.nature,
      })
      .from(accounts)
      .where(and(eq(accounts.householdId, ctx.householdId), isNull(accounts.archivedAt)))
      .orderBy(asc(accounts.sortOrder)),
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
    db
      .select({ code: currenciesTable.code })
      .from(currenciesTable)
      .orderBy(asc(currenciesTable.code)),
  ]);

  const currencyCodes = currencyList.map((c) => c.code);

  // `currentRates` only resolves USD/VES: offering conversion on a USDT account
  // would promise something that afterwards does not happen.
  const ratedCurrencies = rates.official || rates.parallel ? ["VES"] : [];

  const payFrom = accountList.filter((a) => a.nature === "asset");

  return (
    <div className="mx-auto max-w-3xl px-6 py-10">
      {/* Two rows, not one. The title with its description measured 394px and
          the action group 340: in 720px of usable width the row wrapped ALWAYS,
          even at 1440, and the button landed inside the rates row as if it were
          a third option of the selector. */}
      <header className="mb-8">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <h1 className="text-lg font-medium tracking-tight">{t("ui.financing.title")}</h1>
          <div className="flex flex-wrap items-center gap-4">
        <RatePicker rates={rates} />
        <FinancingForm
          // Every liability account, not only the marked ones: buying in installments
          // should not require having configured beforehand who fronts you the money.
          financiers={accountList.filter((a) => a.nature === "liability")}
          rulesByAccount={Object.fromEntries(
            financiers.map((f) => [
              f.name,
              {
                downPaymentPercent: f.downPaymentPercent,
                defaultInstallments: f.defaultInstallments,
                defaultFrequency: f.defaultFrequency,
              },
            ]),
          )}
          accounts={payFrom}
          categories={categoryList.map((c) => c.name)}
          todayDate={date}
          rates={rates}
          baseCurrency={ctx.baseCurrency}
          ratedCurrencies={ratedCurrencies}
          currencies={currencyCodes}
          defaultCurrency={financiers[0]?.currency ?? "VES"}
        />
          </div>
        </div>
        <p className="mt-2 max-w-[62ch] text-sm text-muted-foreground">
          {t("ui.financing.hint")}
        </p>
      </header>

      {/* Who you owe, ahead of the detail of each purchase: it is the question
          asked first. */}
      <FinancierList
        financiers={financiers}
        currencies={currencyCodes}
        baseCurrency={ctx.baseCurrency}
        todayDate={date}
        valuation={valuation}
        rates={rates}
      />

      {upcoming.length > 0 && (
        <section
          aria-labelledby="proximas"
          className="mb-8 rounded-lg border border-caution/40 bg-caution/5 p-4"
        >
          <h2
            id="proximas"
            className="text-xs font-medium uppercase tracking-[0.12em] text-caution"
          >
            {t("ui.financing.thisWeek")}
          </h2>
          <ul className="mt-2 grid gap-1 text-sm">
            {upcoming.map((installment) => (
              <li key={installment.id} className="flex flex-wrap justify-between gap-x-4">
                <span>
                  {t("ui.financing.installmentNumber", {
                    description: installment.description,
                    number: installment.number,
                  })}
                  <span className="text-muted-foreground"> · {installment.financier}</span>
                </span>
                <span className="flex items-baseline gap-2 tabular-nums">
                  <span>{formatAmount(installment.amountMinor, installment.currency)}</span>
                  <BothRates
                    officialMinor={convertToBase(installment.amountMinor, installment.currency, ctx.baseCurrency, rates.official?.rate)}
                    parallelMinor={convertToBase(installment.amountMinor, installment.currency, ctx.baseCurrency, rates.parallel?.rate)}
                    baseCurrency={ctx.baseCurrency}
                    valuation={valuation}
                  />
                  <span className="text-muted-foreground">{formatDay(installment.dueOn, ctx.locale)}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {plans.length === 0 ? (
        // The empty state explains: at the start this screen is nearly always empty.
        <p className="max-w-prose py-8 text-sm text-muted-foreground">
          {t("ui.financing.empty")}
        </p>
      ) : (
        <section aria-labelledby="planes">
          <h2
            id="planes"
            className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground"
          >
            {t("ui.financing.whatYouOwe")}
          </h2>
          {plans.map((plan) => (
            <InstallmentList
              key={plan.id}
              plan={plan}
              accounts={payFrom}
              todayDate={date}
              baseCurrency={ctx.baseCurrency}
              valuation={valuation}
              rates={rates}
            />
          ))}
        </section>
      )}
    </div>
  );
}
