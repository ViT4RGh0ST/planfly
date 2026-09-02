import { sql, type SQL } from "drizzle-orm";

import { db } from "@/db";
import { DEFAULT_LOCALE, normalizeLocale } from "@/i18n/config";
import { getTranslator } from "@/i18n/translator";
import { formatAmount } from "@/lib/money";
import { addDays, daysBetween, resolvePeriod } from "@/lib/dates";
import { balanceExpression } from "./balances";

/**
 * Read queries.
 *
 * One key distinction, and it is what makes "store both rates" implementable:
 *
 *   - **Flow** (spending, income, budgets) is valued at the HISTORICAL rate, the
 *     one stamped onto the line. What that arepa cost that day does not change
 *     because the dollar is at another price today.
 *
 *   - **Stock** (net position) is valued at TODAY's rate. Revaluing your current
 *     bolívar balance with March's rate means nothing.
 *
 * That is why net worth does not add up `base_amount_*` but reconverts each
 * account's native balance with the latest known rate.
 */

export type Valuation = "official" | "parallel";

/**
 * Which valuation a screen was asked for, from the URL.
 *
 * Seven screens read the same `?rate=` and each compared it by hand, so when the
 * slots were renamed a bookmark saying `?rate=bcv` stopped matching and fell
 * through to the parallel one — the official column silently replaced by the
 * other, on a link somebody had saved precisely to see the official one.
 *
 * The old spellings are read for good, the way `dates.ts` reads the Spanish
 * period aliases and for the same reason: what is already written down out there
 * does not get to stop meaning what it meant.
 */
export function valuationFrom(param: string | undefined): Valuation {
  return param === "official" || param === "bcv" ? "official" : "parallel";
}

/**
 * The rate in force for each currency and source at a date, for valuing stock.
 *
 * The one with the closest value date is picked, preferring earlier or equal.
 * The forward tie-break exists because the BCV publishes with a future value
 * date — on Friday Monday's is already out — and without it net worth would sit
 * unvalued over the weekend exactly.
 *
 * It goes as a fragment and not as a query of its own because its two uses — net
 * worth and what is already committed to installments — convert inside a larger
 * query, and they are figures subtracted from each other: if one day they
 * diverged on which rate to use, the subtraction would stop meaning anything.
 */
const currentRates = (baseCurrency: string, date: string): SQL => sql`
  SELECT DISTINCT ON (quote_currency, source) quote_currency, source, rate
    FROM (
      SELECT quote_currency,
             rate,
             effective_on,
             variant,
             is_manual,
             -- It comes out already boxed and named 'source' on purpose: that
             -- way the three queries consuming it go on writing
             -- r.source = 'official' and none of them has to be touched.
             slot AS source
        FROM (
          SELECT quote_currency, rate, effective_on, variant,
                 source = 'manual' AS is_manual,
                 CASE WHEN source = 'manual' THEN variant ELSE source::text END AS slot
            FROM exchange_rates
           WHERE base_currency = ${baseCurrency}
             AND (source IN ('official','parallel')
                  OR (source = 'manual' AND variant IN ('official','parallel')))
        ) y
    ) x
   ORDER BY quote_currency, source,
            CASE WHEN effective_on <= ${date} THEN 0 ELSE 1 END,
            abs(effective_on - ${date}::date),
            -- On the same date the hand-written one wins, same as in
            -- rates/service.ts. The two rules HAVE to be the same: if the
            -- automatic one won here, setting the rate by hand would move
            -- /rates and not net worth, which is exactly what it is set for.
            CASE WHEN is_manual THEN 0 ELSE 1 END,
            variant
`;

/**
 * A line's base-currency equivalent, under the rule that rules.
 *
 * The one that rules is `rate_source_used`: the column saying which rate valued
 * THAT line, and the one the history shows on screen. There used to be nine
 * copies of `COALESCE(base_amount_manual_minor, column)` here — «if there is a
 * manual one, it wins» — which is a DIFFERENT rule, and that is why the same
 * screen could show −1,31 USD on the row and add up −2,00 above: it only takes
 * one line with a manual rate stored without being the one used.
 *
 * One function and not nine literals, so that they cannot diverge again.
 */
const valued = (column: SQL): SQL => sql`
  CASE WHEN e.rate_source_used = 'manual' THEN e.base_amount_manual_minor
       ELSE e.${column} END
`;

/**
 * How much of net worth could be valued with this rate.
 *
 * A bolívar account with no rate available contributes zero to the total, and
 * zero reads as "I have nothing there" when it actually means "I don't know".
 * Without this count the headline has no way to confess it, and a figure with no
 * visible provenance is worth less than an honest hole.
 */
export type Coverage = {
  /** Accounts with a non-zero balance that could not be converted. */
  unvaluedCount: number;
  /** Accounts with a non-zero balance that did make it into the total. */
  valuedCount: number;
  /** Currencies missing a rate, so we can say which. */
  currencies: string[];
};

export type NetWorth = {
  baseCurrency: string;
  totalOfficialMinor: number;
  totalParallelMinor: number;
  assetsOfficialMinor: number;
  assetsParallelMinor: number;
  liabilitiesOfficialMinor: number;
  liabilitiesParallelMinor: number;
  coverage: { official: Coverage; parallel: Coverage };
  accounts: Array<{
    id: string;
    name: string;
    type: string;
    nature: string;
    currency: string;
    balanceMinor: number;
    balanceText: string;
    baseOfficialMinor: number | null;
    baseParallelMinor: number | null;
  }>;
};

/**
 * Net worth = assets − liabilities, valued at the rate in force.
 *
 * Credit cards and loans are accounts of `liability` nature, and their balance
 * subtracts. Without that the number would be "what I have", not net worth.
 */
export async function netWorth(
  householdId: string,
  date: string,
  baseCurrency: string,
): Promise<NetWorth> {
  const { rows } = await db.execute<{
    id: string;
    name: string;
    type: string;
    nature: string;
    currency: string;
    balance_minor: string;
    base_bcv_minor: string | null;
    base_p2p_minor: string | null;
  }>(sql`
    WITH balances AS (
      SELECT a.id, a.name, a.type::text, a.nature::text, a.currency, a.sort_order,
             ${balanceExpression} AS balance_minor
        FROM accounts a
        LEFT JOIN transaction_entries e ON e.account_id = a.id
        LEFT JOIN transactions t ON t.id = e.transaction_id
       WHERE a.household_id = ${householdId}
         AND a.archived_at IS NULL
         AND a.include_in_net_worth
       GROUP BY a.id
    ),
    rates AS (${currentRates(baseCurrency, date)})
    SELECT b.id, b.name, b.type, b.nature, b.currency,
           b.balance_minor::text,
           CASE WHEN b.currency = ${baseCurrency} THEN b.balance_minor::text
                ELSE (SELECT round(b.balance_minor / r.rate)::text
                        FROM rates r
                       WHERE r.quote_currency = b.currency AND r.source = 'official')
           END AS base_bcv_minor,
           CASE WHEN b.currency = ${baseCurrency} THEN b.balance_minor::text
                ELSE (SELECT round(b.balance_minor / r.rate)::text
                        FROM rates r
                       WHERE r.quote_currency = b.currency AND r.source = 'parallel')
           END AS base_p2p_minor
      FROM balances b
     ORDER BY b.nature, b.sort_order, b.name
  `);

  let assetsBcv = 0,
    assetsP2p = 0,
    liabilitiesBcv = 0,
    liabilitiesP2p = 0;

  const coverage: Record<Valuation, Coverage> = {
    official: { unvaluedCount: 0, valuedCount: 0, currencies: [] },
    parallel: { unvaluedCount: 0, valuedCount: 0, currencies: [] },
  };

  const accountRows = rows.map((r) => {
    const bcv = r.base_bcv_minor == null ? null : Number(r.base_bcv_minor);
    const p2p = r.base_p2p_minor == null ? null : Number(r.base_p2p_minor);

    // An account at zero alters the total neither valued nor unvalued, so
    // warning about it would be noise.
    if (Number(r.balance_minor) !== 0) {
      for (const [valuation, base] of [
        ["official", bcv],
        ["parallel", p2p],
      ] as const) {
        const c = coverage[valuation];
        if (base == null) {
          c.unvaluedCount++;
          if (!c.currencies.includes(r.currency)) c.currencies.push(r.currency);
        } else {
          c.valuedCount++;
        }
      }
    }

    if (r.nature === "liability") {
      // A liability's balance usually arrives negative (you owe money). It is
      // accumulated as-is and added to the total, so a card at zero changes nothing.
      liabilitiesBcv += bcv ?? 0;
      liabilitiesP2p += p2p ?? 0;
    } else {
      assetsBcv += bcv ?? 0;
      assetsP2p += p2p ?? 0;
    }

    return {
      id: r.id,
      name: r.name,
      type: r.type,
      nature: r.nature,
      currency: r.currency,
      balanceMinor: Number(r.balance_minor),
      balanceText: formatAmount(Number(r.balance_minor), r.currency),
      baseOfficialMinor: bcv,
      baseParallelMinor: p2p,
    };
  });

  return {
    baseCurrency,
    totalOfficialMinor: assetsBcv + liabilitiesBcv,
    totalParallelMinor: assetsP2p + liabilitiesP2p,
    assetsOfficialMinor: assetsBcv,
    assetsParallelMinor: assetsP2p,
    liabilitiesOfficialMinor: liabilitiesBcv,
    liabilitiesParallelMinor: liabilitiesP2p,
    coverage,
    accounts: accountRows,
  };
}

export type Committed = {
  /** Unpaid installments falling due within the horizon, overdue ones included. */
  count: number;
  /** Of those, the ones already past their date. */
  overdueCount: number;
  /** The last due date within the horizon. */
  lastDueOn: string;
  officialMinor: number;
  parallelMinor: number;
  /** Installments that could not be converted, and in which currencies. */
  unvalued: { official: number; parallel: number; currencies: string[] };
};

/**
 * How much of net worth is already spoken for in upcoming installments.
 *
 * This is not another way of saying the debt: the debt **already subtracted**
 * from net worth on the day of the purchase, because the financier is a
 * liability account. Repeating it under the total would be counting the same
 * thing twice. What no figure on the screen says is *when*, and that is the
 * difference between having money and being able to spend it.
 *
 * That is why it is valued at TODAY's rate and not at the purchase day's: it is
 * a claim on the stock, and it is compared against a stock valued today. It uses
 * the same rates fragment as net worth so that the subtraction adds up.
 *
 * Overdue ones count. An installment past its date still commits the money —
 * more so, in fact — and leaving it out would show a smaller number exactly when
 * that suits least.
 */
export async function committedInstallments(
  householdId: string,
  date: string,
  baseCurrency: string,
  // One month: it covers two biweekly installments or one monthly, which is the
  // rhythm financing runs at here. Beyond that it stops being "what goes now".
  withinDays = 30,
): Promise<Committed | null> {
  const horizon = addDays(date, withinDays);

  const { rows } = await db.execute<{
    currency: string;
    n: number;
    overdue: number;
    last_due: string;
    base_bcv_minor: string | null;
    base_p2p_minor: string | null;
  }>(sql`
    WITH rates AS (${currentRates(baseCurrency, date)}),
    due AS (
      SELECT p.currency,
             SUM(i.amount_minor) AS amount_minor,
             COUNT(*) AS n,
             COUNT(*) FILTER (WHERE i.due_on < ${date}::date) AS overdue,
             MAX(i.due_on) AS last_due
        FROM installments i
        JOIN financing_plans p ON p.id = i.plan_id
        -- A voided purchase commits nothing, even if its installments stand.
        JOIN transactions t ON t.id = p.purchase_transaction_id
       WHERE i.household_id = ${householdId}
         AND i.paid_at IS NULL
         AND t.voided_at IS NULL
         AND i.due_on <= ${horizon}::date
       GROUP BY p.currency
    )
    SELECT d.currency, d.n::int AS n, d.overdue::int AS overdue, d.last_due::text AS last_due,
           CASE WHEN d.currency = ${baseCurrency} THEN d.amount_minor::text
                ELSE (SELECT round(d.amount_minor / r.rate)::text
                        FROM rates r
                       WHERE r.quote_currency = d.currency AND r.source = 'official')
           END AS base_bcv_minor,
           CASE WHEN d.currency = ${baseCurrency} THEN d.amount_minor::text
                ELSE (SELECT round(d.amount_minor / r.rate)::text
                        FROM rates r
                       WHERE r.quote_currency = d.currency AND r.source = 'parallel')
           END AS base_p2p_minor
      FROM due d
  `);

  if (rows.length === 0) return null;

  const result: Committed = {
    count: 0,
    overdueCount: 0,
    lastDueOn: rows[0].last_due,
    officialMinor: 0,
    parallelMinor: 0,
    unvalued: { official: 0, parallel: 0, currencies: [] },
  };

  for (const r of rows) {
    result.count += r.n;
    result.overdueCount += r.overdue;
    if (r.last_due > result.lastDueOn) result.lastDueOn = r.last_due;

    for (const [valuation, base] of [
      ["official", r.base_bcv_minor],
      ["parallel", r.base_p2p_minor],
    ] as const) {
      if (base == null) {
        result.unvalued[valuation] += r.n;
        if (!result.unvalued.currencies.includes(r.currency)) {
          result.unvalued.currencies.push(r.currency);
        }
      } else if (valuation === "official") result.officialMinor += Number(base);
      else result.parallelMinor += Number(base);
    }
  }

  return result;
}

/**
 * How many entries are awaiting review, across the whole history.
 *
 * It lives here and not in each screen because the dashboard and the navigation
 * have to say the same number: deriving it from the sample of recent entries
 * made the badge disappear exactly when the queue was old.
 */
export async function pendingReviewCount(householdId: string): Promise<number> {
  const { rows } = await db.execute<{ n: string }>(sql`
    SELECT count(*)::text AS n FROM transactions
     WHERE household_id = ${householdId} AND needs_review AND voided_at IS NULL
  `);
  return Number(rows[0]?.n ?? 0);
}

/** Spending by category over a period, at historical rates. */
export async function spendingByCategory(
  householdId: string,
  period: string | undefined,
  timezone: string,
  valuation: Valuation,
  /**
   * For the bucket with no category, which is the only text this query
   * produces. It used to be a `COALESCE(c.name, 'Sin categoría')` inside the
   * SQL — a place where no language can reach.
   */
  locale: string = DEFAULT_LOCALE,
) {
  const { from, to, ref } = resolvePeriod(period, timezone);
  const column = valuation === "official" ? sql`base_amount_official_minor` : sql`base_amount_parallel_minor`;

  const { rows } = await db.execute<{
    id: string | null;
    name: string | null;
    color: string;
    total_minor: string;
    n: string;
  }>(sql`
    SELECT c.id, c.name,
           COALESCE(c.color, '#94a3b8') AS color,
           (-SUM(${valued(column)}))::text AS total_minor,
           count(*)::text AS n
      FROM transaction_entries e
      JOIN transactions t ON t.id = e.transaction_id
      LEFT JOIN categories c ON c.id = e.category_id
     WHERE e.household_id = ${householdId}
       AND t.kind = 'expense' AND t.voided_at IS NULL
       AND t.occurred_on >= ${from} AND t.occurred_on < ${to}
     GROUP BY c.id, c.name, c.color
     HAVING SUM(${valued(column)}) IS NOT NULL
     -- By the SUM, not by column 4: that fourth element of the SELECT is a cast
     -- to text, so it ordered the amounts as strings and "874" came before
     -- "8118" — the panel listed Transporte (8,74) ahead of Mercado (81,18). And
     -- since the same order decides which 8 categories survive the cut, with
     -- more than eight it was the wrong ones that disappeared.
     ORDER BY -SUM(${valued(column)}) DESC
  `);

  return {
    periodRef: ref,
    from,
    to,
    valuation,
    categories: rows.map((r) => ({
      id: r.id,
      name: r.name ?? getTranslator(normalizeLocale(locale))("services.common.noCategory"),
      color: r.color,
      totalMinor: Number(r.total_minor),
      transactionCount: Number(r.n),
    })),
  };
}

/** A period's spending and income totals. */
export async function periodSummary(
  householdId: string,
  period: string | undefined,
  timezone: string,
  valuation: Valuation,
) {
  const { from, to, ref } = resolvePeriod(period, timezone);
  const column = valuation === "official" ? sql`base_amount_official_minor` : sql`base_amount_parallel_minor`;

  const { rows } = await db.execute<{ kind: string; total_minor: string; n: string }>(sql`
    SELECT t.kind::text,
           SUM(${valued(column)})::text AS total_minor,
           count(*)::text AS n
      FROM transaction_entries e
      JOIN transactions t ON t.id = e.transaction_id
     WHERE e.household_id = ${householdId}
       AND t.voided_at IS NULL
       AND t.kind IN ('expense','income')
       AND t.occurred_on >= ${from} AND t.occurred_on < ${to}
     GROUP BY t.kind
  `);

  let expenseMinor = 0,
    incomeMinor = 0,
    expenseCount = 0,
    incomeCount = 0;
  for (const r of rows) {
    const total = r.total_minor == null ? 0 : Number(r.total_minor);
    if (r.kind === "expense") {
      expenseMinor = -total;
      expenseCount = Number(r.n);
    } else {
      incomeMinor = total;
      incomeCount = Number(r.n);
    }
  }

  return {
    periodRef: ref,
    from,
    to,
    valuation,
    expenseMinor,
    incomeMinor,
    balanceMinor: incomeMinor - expenseMinor,
    expenseCount,
    incomeCount,
  };
}

export type TransactionFilters = {
  onlyNeedsReview?: boolean;
  from?: string;
  to?: string;
  /** The exact account name, as it appears in the selector. */
  account?: string;
  category?: string;
  /** A slice of the description, case-insensitive. */
  search?: string;
  /** Voided ones are out by default: they still exist, but they do not add. */
  includeVoided?: boolean;
};

/**
 * The WHERE shared by the listing and by its count.
 *
 * It lives in one place because if the two diverge, the screen says "43 entries"
 * and shows different ones: worse than saying nothing.
 */
function transactionScope(householdId: string, f: TransactionFilters) {
  return sql`
    t.household_id = ${householdId}
    ${f.includeVoided ? sql`` : sql`AND t.voided_at IS NULL`}
    ${f.onlyNeedsReview ? sql`AND t.needs_review` : sql``}
    ${f.from ? sql`AND t.occurred_on >= ${f.from}` : sql``}
    ${f.to ? sql`AND t.occurred_on < ${f.to}` : sql``}
    ${f.account ? sql`AND a.name = ${f.account}` : sql``}
    ${f.category ? sql`AND c.name = ${f.category}` : sql``}
    ${f.search ? sql`AND t.description ILIKE ${"%" + f.search + "%"}` : sql``}
  `;
}

/** How many entries match these filters, beyond the `limit` being painted. */
export async function countTransactions(
  householdId: string,
  filters: TransactionFilters = {},
): Promise<number> {
  const { rows } = await db.execute<{ n: string }>(sql`
    SELECT count(*)::text AS n
      FROM transactions t
      JOIN transaction_entries e ON e.transaction_id = t.id AND e.sort_order = 0
      JOIN accounts a ON a.id = e.account_id
      LEFT JOIN categories c ON c.id = e.category_id
     WHERE ${transactionScope(householdId, filters)}
  `);
  return Number(rows[0]?.n ?? 0);
}

/**
 * The filtered set's total, in BOTH valuations.
 *
 * "How much did I spend on groceries in July?" is answered with a figure, not
 * with a list: without this the screen forces you to add up in your head what
 * the database already added. And both are given because the same expense is
 * worth 13% more or less depending on the rate — giving only one here would be
 * the same half-truth the product refuses to tell about net worth.
 *
 * Transfers stay out: moving money from one of your own accounts to another is
 * neither spending nor income, and putting it in the total would inflate it with
 * money that never left the house.
 */
export async function filteredTotals(
  householdId: string,
  filters: TransactionFilters = {},
): Promise<{ officialMinor: number; parallelMinor: number; unvalued: number }> {
  const { rows } = await db.execute<{
    official: string | null;
    parallel: string | null;
    unvalued: string;
  }>(sql`
    SELECT SUM(${valued(sql`base_amount_official_minor`)})::text AS official,
           SUM(${valued(sql`base_amount_parallel_minor`)})::text AS parallel,
           count(*) FILTER (
             WHERE ${valued(sql`base_amount_parallel_minor`)} IS NULL
           )::text AS unvalued
      FROM transactions t
      JOIN transaction_entries e ON e.transaction_id = t.id AND e.sort_order = 0
      JOIN accounts a ON a.id = e.account_id
      LEFT JOIN categories c ON c.id = e.category_id
     WHERE ${transactionScope(householdId, filters)}
       AND t.kind <> 'transfer'
  `);

  const r = rows[0];
  return {
    officialMinor: r?.official == null ? 0 : Number(r.official),
    parallelMinor: r?.parallel == null ? 0 : Number(r.parallel),
    unvalued: Number(r?.unvalued ?? 0),
  };
}

export type Facet = {
  value: string;
  count: number;
  amountMinor: number;
  /** How many of its entries could not be valued. */
  unvalued: number;
};

/**
 * How much sits behind each filter option, and for how much.
 *
 * The rail is not a list of options: it is the map of where the money is. Seeing
 * "Groceries 12 · Bs 340.000" before clicking answers half the question without
 * navigating, which is exactly what this screen is visited for.
 *
 * Each facet is counted with ALL the filters except its own. Counting it with
 * its own included would make every other category read zero once you picked
 * "Groceries", and there would be no way to know where to jump next.
 */
export async function transactionFacets(
  householdId: string,
  filters: TransactionFilters = {},
  valuation: Valuation = "parallel",
): Promise<{ accounts: Facet[]; categories: Facet[] }> {
  const byAccount = { ...filters, account: undefined };
  const byCategory = { ...filters, category: undefined };

  // In BASE currency, not each account's native one. Adding `amount_minor` raw
  // mixed bolívares with USDT in the same column and painted them as if they
  // were the same thing: "Provincial −24.534,44" (Bs) next to "Binance −15,00"
  // (USDT), both formatted as dollars. Here the facets are compared against
  // each other, so they have to be in the same unit.
  // Without the `e.` alias: `valued()` adds it, and it decides which column counts.
  const column =
    valuation === "official" ? sql`base_amount_official_minor` : sql`base_amount_parallel_minor`;

  const query = (scope: ReturnType<typeof transactionScope>, column2: SQL) => sql`
    SELECT ${column2} AS value, count(*)::text AS n,
           COALESCE(SUM(${valued(column)}), 0)::text AS total,
           count(*) FILTER (
             WHERE ${valued(column)} IS NULL
           )::text AS unvalued
      FROM transactions t
      JOIN transaction_entries e ON e.transaction_id = t.id AND e.sort_order = 0
      JOIN accounts a ON a.id = e.account_id
      LEFT JOIN categories c ON c.id = e.category_id
     WHERE ${scope} AND ${column2} IS NOT NULL
     GROUP BY ${column2}
     ORDER BY count(*) DESC, ${column2} ASC
  `;

  const [accounts, categories] = await Promise.all([
    db.execute<{ value: string; n: string; total: string; unvalued: string }>(
      query(transactionScope(householdId, byAccount), sql`a.name`),
    ),
    db.execute<{ value: string; n: string; total: string; unvalued: string }>(
      query(transactionScope(householdId, byCategory), sql`c.name`),
    ),
  ]);

  const shape = (
    rows: { value: string; n: string; total: string; unvalued: string }[],
  ): Facet[] =>
    rows.map((r) => ({
      value: r.value,
      count: Number(r.n),
      amountMinor: Number(r.total),
      unvalued: Number(r.unvalued),
    }));

  return { accounts: shape(accounts.rows), categories: shape(categories.rows) };
}

/** Recent entries, with what is needed to paint them without more queries. */
export async function recentTransactions(
  householdId: string,
  options: TransactionFilters & { limit?: number } = {},
) {
  const { limit = 20, ...filters } = options;

  const { rows } = await db.execute<{
    id: string;
    kind: string;
    occurred_on: string;
    description: string;
    source: string;
    needs_review: boolean;
    confidence: string | null;
    amount_minor: string;
    currency: string;
    base_amount_official_minor: string | null;
    base_amount_parallel_minor: string | null;
    base_amount_manual_minor: string | null;
    rate_source_used: string;
    account_name: string;
    category_name: string | null;
    category_color: string | null;
    to_account_name: string | null;
    to_amount_minor: string | null;
    to_currency: string | null;
    voided_at: string | null;
    void_reason: string | null;
  }>(sql`
    SELECT t.id, t.kind::text, t.occurred_on, t.description, t.source::text,
           t.needs_review, t.confidence, t.voided_at::text, t.void_reason,
           e.amount_minor::text, e.currency,
           e.base_amount_official_minor::text, e.base_amount_parallel_minor::text,
           -- The rate the user set by hand rules over both automatic ones, same
           -- as in the other queries in this file. Without this, a correction
           -- made in /review was never visible in the history.
           e.base_amount_manual_minor::text,
           e.rate_source_used::text,
           a.name AS account_name,
           c.name AS category_name, c.color AS category_color,
           -- The other leg. It only exists on transfers, and without it the row
           -- came out as an expense with no destination: the ledger keeps both
           -- sides precisely so as not to lie about either.
           ta.name AS to_account_name,
           te.amount_minor::text AS to_amount_minor,
           te.currency AS to_currency
      FROM transactions t
      JOIN transaction_entries e ON e.transaction_id = t.id AND e.sort_order = 0
      JOIN accounts a ON a.id = e.account_id
      LEFT JOIN categories c ON c.id = e.category_id
      LEFT JOIN transaction_entries te ON te.transaction_id = t.id AND te.sort_order = 1
      LEFT JOIN accounts ta ON ta.id = te.account_id
     WHERE ${transactionScope(householdId, filters)}
     ORDER BY t.occurred_on DESC, t.created_at DESC
     LIMIT ${limit}
  `);

  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    occurredOn: r.occurred_on,
    description: r.description,
    source: r.source,
    needsReview: r.needs_review,
    confidence: r.confidence == null ? null : Number(r.confidence),
    amountMinor: Number(r.amount_minor),
    currency: r.currency,
    amountText: formatAmount(Number(r.amount_minor), r.currency, { showPlus: true }),
    baseOfficialMinor: r.base_amount_official_minor == null ? null : Number(r.base_amount_official_minor),
    baseParallelMinor: r.base_amount_parallel_minor == null ? null : Number(r.base_amount_parallel_minor),
    baseManualMinor:
      r.base_amount_manual_minor == null ? null : Number(r.base_amount_manual_minor),
    rateSourceUsed: r.rate_source_used,
    account: r.account_name,
    category: r.category_name,
    categoryColor: r.category_color,
    toAccount: r.to_account_name,
    toAmountMinor: r.to_amount_minor == null ? null : Number(r.to_amount_minor),
    toCurrency: r.to_currency,
    toAmountText:
      r.to_amount_minor == null || r.to_currency == null
        ? null
        : formatAmount(Number(r.to_amount_minor), r.to_currency),
    voided: r.voided_at != null,
    voidReason: r.void_reason,
  }));
}

/** How much of a period's active budgets has been used. */
/**
 * The budgets in force today, each measured against ITS period.
 *
 * It used to be given a month range and filtered by exact `period_start`, so
 * only monthly budgets existed. Now each row carries its own [start, end) —
 * month, fortnight, year or the range the user chose — and spending is counted
 * inside that range, not inside the current month. A biweekly budget against a
 * whole month's spending would say nothing.
 */
export async function budgetUsage(householdId: string, date: string, valuation: Valuation) {
  const column = valuation === "official" ? sql`base_amount_official_minor` : sql`base_amount_parallel_minor`;

  const { rows } = await db.execute<{
    id: string;
    category_id: string;
    category_name: string;
    color: string;
    budget_minor: string;
    currency: string;
    period: string;
    period_start: string;
    period_end: string;
    spent_minor: string | null;
  }>(sql`
    SELECT b.id, b.category_id, c.name AS category_name, c.color,
           b.amount_minor::text AS budget_minor, b.currency,
           b.period::text, b.period_start::text, b.period_end::text,
           (SELECT (-SUM(${valued(column)}))::text
              FROM transaction_entries e
              JOIN transactions t ON t.id = e.transaction_id
             -- A budget covers the category AND its children. Setting one on
             -- «Comida» while every expense lands on «Mercado» or «Comida
             -- callejera» read 0% used for the whole month: not an error, a
             -- calm figure saying the opposite of the truth. The hierarchy is
             -- two levels deep by construction (see manage-categories.ts),
             -- so one step down is the whole tree.
             WHERE (e.category_id = b.category_id
                    OR e.category_id IN (SELECT id FROM categories
                                          WHERE parent_id = b.category_id))
               AND t.household_id = ${householdId} AND t.kind = 'expense' AND t.voided_at IS NULL
               AND t.occurred_on >= b.period_start AND t.occurred_on < b.period_end
           ) AS spent_minor
      FROM budgets b
      JOIN categories c ON c.id = b.category_id
     WHERE b.household_id = ${householdId} AND b.is_active
       -- In force = today falls inside its range, whatever shape that range has.
       AND b.period_start <= ${date} AND b.period_end > ${date}
     ORDER BY b.period_end, c.name
  `);

  return rows.map((r) => {
    const budget = Number(r.budget_minor);
    const spent = r.spent_minor == null ? 0 : Number(r.spent_minor);
    // The expected pace is per budget: day 12 is 39% of a month but 80% of a
    // fortnight, and confusing them turns an alarm into calm.
    const totalDays = daysBetween(r.period_start, r.period_end);
    const elapsedDays = daysBetween(r.period_start, date) + 1;
    return {
      id: r.id,
      categoryId: r.category_id,
      category: r.category_name,
      color: r.color,
      currency: r.currency,
      period: r.period as "monthly" | "biweekly" | "yearly" | "custom",
      periodStart: r.period_start,
      periodEnd: r.period_end,
      totalDays,
      elapsedDays,
      expectedPace: totalDays > 0 ? Math.round((elapsedDays / totalDays) * 100) : 0,
      budgetMinor: budget,
      spentMinor: spent,
      remainingMinor: budget - spent,
      percent: budget > 0 ? Math.round((spent / budget) * 100) : 0,
    };
  });
}
