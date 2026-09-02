import { and, asc, eq, isNull } from "drizzle-orm";
import { getTranslations } from "next-intl/server";

import { RatePicker } from "@/components/rate-picker";
import { RegisterTransaction } from "@/components/register-transaction";
import { ResultSummary } from "@/components/result-summary";
import { TransactionFacets } from "@/components/transaction-facets";
import { TransactionsTable } from "@/components/transactions-table";
import { db } from "@/db";
import { accounts, categories, payees } from "@/db/schema";
import { requireSession } from "@/lib/session";
import { canonicalPeriod, resolvePeriod, today } from "@/lib/dates";
import { periodName } from "@/i18n/periods";
import { currentRates } from "@/lib/rates/service";
import {
  countTransactions,
  filteredTotals,
  recentTransactions,
  transactionFacets,
  type Valuation, valuationFrom,
} from "@/lib/services/reports";

export const dynamic = "force-dynamic";

/**
 * Entries.
 *
 * THESIS: this screen is opened to LOOK for something specific, so the query is
 * the tool and the result is a figure, not a list. It refuses the category's
 * default arrangement — a filter bar on top of a table that only knows how to
 * enumerate.
 *
 * WORLD: the one already established; none is invented here. Dark background,
 * Archivo, the project's tokens, and the bcv/p2p pair as the only two colour
 * voices carrying meaning.
 *
 * FORM: a facet rail with counts (4th on the list ordered by resonance; run key
 * fe757787). The left third does not disappear: it changes trade. It stops being
 * the recording form — barely used from the desktop, because expenses come in
 * over Telegram — and becomes the map of where the money is, with its count and
 * its amount on every option.
 *
 * FIRST GLANCE: a header with the two rates of the day, which double as the
 * selector for which one rules, and the record button. Below, the query rail on
 * the left; on the right the filtered set's subtotal in BOTH valuations and,
 * under it, the rows at full width.
 *
 * STORY: you arrive with a question («how much did I spend on groceries this
 * month?»), assemble it in the rail while seeing where the volume is along the
 * way, and the answer is waiting above the listing in the two currencies that
 * coexist here.
 */

/** How many rows are painted at once. The rest is announced, not hidden. */
const PAGE_SIZE = 100;

export default async function TransactionsPage({
  searchParams,
}: {
  searchParams: Promise<{
    rate?: string;
    periodo?: string;
    account?: string;
    categoria?: string;
    q?: string;
    anulados?: string;
  }>;
}) {
  const ctx = await requireSession();
  const t = await getTranslations();
  const params = await searchParams;
  const valuation: Valuation = valuationFrom(params.rate);
  const date = today(ctx.timezone);

  // "all" is the one thing `resolvePeriod` cannot interpret, because it is not
  // a range: it is the absence of one. Through `canonicalPeriod` so that the
  // Spanish spelling still in old bookmarks compares the same as the new one.
  const period = canonicalPeriod(params.periodo);
  const range = period === "all" ? null : resolvePeriod(period, ctx.timezone);

  const filters = {
    from: range?.from,
    to: range?.to,
    account: params.account || undefined,
    category: params.categoria || undefined,
    search: params.q || undefined,
    includeVoided: params.anulados === "1",
  };

  const [accountList, categoryList, placeList, transactions, total, totals, facets, rates] =
    await Promise.all([
      db
        .select({ name: accounts.name, currency: accounts.currency })
        .from(accounts)
        .where(and(eq(accounts.householdId, ctx.householdId), isNull(accounts.archivedAt)))
        .orderBy(asc(accounts.sortOrder)),
      db
        .select({ name: categories.name, kind: categories.kind })
        .from(categories)
        .where(and(eq(categories.householdId, ctx.householdId), isNull(categories.archivedAt)))
        .orderBy(asc(categories.sortOrder)),
      // The shops, so a correction can put one on an entry that never had it.
      db
        .select({ name: payees.name })
        .from(payees)
        .where(and(eq(payees.householdId, ctx.householdId), isNull(payees.archivedAt)))
        .orderBy(asc(payees.name)),
      recentTransactions(ctx.householdId, { limit: PAGE_SIZE, ...filters }),
      countTransactions(ctx.householdId, filters),
      filteredTotals(ctx.householdId, filters),
      transactionFacets(ctx.householdId, filters, valuation),
      currentRates(date),
    ]);

  // The rate the server will use if the field is left empty is the one the
  // household sets, not always P2P.
  const defaultRate = rates[ctx.defaultRateSource] ?? rates.parallel ?? rates.official ?? null;
  const suggestedRate = defaultRate
    ? new Intl.NumberFormat("es-VE", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(Number(defaultRate.rate))
    : null;
  const suggestedRateStale = defaultRate?.stale ? defaultRate.effectiveOn : null;

  // `currentRates` only resolves USD/VES. Promising a rate to a USDT account
  // made the form offer to convert and the row come out afterwards saying
  // "no rate".
  const ratedCurrencies = rates.official || rates.parallel ? ["VES"] : [];

  const transfers = transactions.filter((t) => t.kind === "transfer").length;
  const filtered = Boolean(params.q || params.account || params.categoria || params.anulados);

  return (
    <div className="mx-auto max-w-7xl px-6 py-10">
      <header className="mb-8 flex flex-wrap items-start justify-between gap-6">
        {/* The action sits next to the title, which is where it is looked
            for. The rates are left alone on the other side: they are reference
            and selector, not an action, and mixing them with the button made
            them look like the same thing. */}
        <div className="flex flex-wrap items-center gap-4">
          <h1 className="text-lg font-medium tracking-tight">{t("ui.transactions.title")}</h1>
          <RegisterTransaction
            accounts={accountList}
            expenseCategories={categoryList.filter((c) => c.kind === "expense")}
            incomeCategories={categoryList.filter((c) => c.kind === "income")}
            todayDate={date}
            suggestedRate={suggestedRate}
            suggestedRateStale={suggestedRateStale}
            rates={rates}
            baseCurrency={ctx.baseCurrency}
            ratedCurrencies={ratedCurrencies}
          />
        </div>
        {/* The rates and the choice of which one rules are a single piece:
            they were two controls saying the same thing, and since every row
            shows both valuations the loose switch had no visible effect left. */}
        <RatePicker rates={rates} />
      </header>

      {/* The grid breaks at `md`, not at `lg`, because that is where the
          navigation already breaks: between 768 and 1024 there was a band in
          which the rail stacked its 17 filter options ABOVE the results, and you
          had to scroll some 800px to see the first entry. This screen is opened
          for a glance; there was no glance there. */}
      <div className="grid gap-8 md:grid-cols-[15rem_minmax(0,1fr)] md:gap-10 lg:gap-12">
        <aside aria-labelledby="consulta" className="md:sticky md:top-10 md:self-start">
          {/* The rail comes before the results in the DOM, so its groups
              (h3) followed the h1 with no h2 in between: for a screen reader
              the outline skipped a level. */}
          <h2 id="consulta" className="sr-only">
            {t("ui.transactions.query")}
          </h2>
          <TransactionFacets
            accounts={facets.accounts}
            categories={facets.categories}
            currency={ctx.baseCurrency}
          />
        </aside>

        <section aria-labelledby="resultados" className="min-w-0">
          <h2 id="resultados" className="sr-only">
            Resultados
          </h2>
          <ResultSummary
            count={total}
            shown={transactions.length}
            periodLabel={periodName(t, range?.ref ?? { key: "all" })}
            officialMinor={totals.officialMinor}
            parallelMinor={totals.parallelMinor}
            unvalued={totals.unvalued}
            currency={ctx.baseCurrency}
            valuation={valuation}
            transfersExcluded={transfers}
          />

          <div className="mt-6">
            <TransactionsTable
              transactions={transactions}
              baseCurrency={ctx.baseCurrency}
              valuation={valuation}
              categories={categoryList.map((c) => c.name)}
              places={placeList.map((p) => p.name)}
              accounts={accountList}
              todayDate={date}
              filtered={filtered}
            />
          </div>
        </section>
      </div>
    </div>
  );
}
