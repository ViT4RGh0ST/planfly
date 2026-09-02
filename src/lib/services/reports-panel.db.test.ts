import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { hasDb, prepareDb } from "@/test/db";
import { seedScenario, type Scenario } from "@/test/fixtures";
import { recordTransaction } from "./record-transaction";
import { saveBudget } from "./budgets";
import { recordFinancedPurchase } from "./financing";
import {
  budgetUsage,
  committedInstallments,
  countTransactions,
  filteredTotals,
  pendingReviewCount,
  periodSummary,
  recentTransactions,
  spendingByCategory,
  transactionFacets,
} from "./reports";
import { pool } from "@/db";

/**
 * The figures that show up on screen.
 *
 * Of this file's ten functions, only `netWorth` had a test, and they are exactly
 * the ones feeding the dashboard, the entry list, the budgets and what is
 * committed. Here a mistake breaks nothing: it changes a number and nobody
 * notices until the month does not add up.
 *
 * Everything goes against the database on purpose. The arithmetic lives in SQL —
 * conditional sums, `FILTER`, `DISTINCT ON`, the column choice by valuation —
 * and a pure test would only check that strings get concatenated.
 *
 * The period is asked for as 'YYYY-MM' and not as "month": "month" resolves
 * against TODAY, so the test would expire as the calendar moved.
 */
const DATE = "2026-08-21";
const PERIOD = "2026-08";
const TZ = "America/Caracas";
let e: Scenario;

/** Bs 1.000,00 at 800 (official) and 1.000 (parallel) = $ 1,25 and $ 1,00. */
async function expense(opts: {
  monto: string;
  categoria?: string;
  account?: string;
  date?: string;
  descripcion?: string;
}) {
  return recordTransaction({
    householdId: e.home.id,
    kind: "expense",
    amount: opts.monto,
    currency: "VES",
    account: opts.account ?? "efectivo",
    category: opts.categoria ?? "mercado",
    description: opts.descripcion,
    occurredOn: opts.date ?? DATE,
    source: "form",
   
  });
}

describe("the dashboard figures", { skip: hasDb() ? false : "no Postgres available" }, () => {
  before(async () => {
    await prepareDb();
    // 800 and 1.000 exactly so the expected figures can be written by hand: an
    // expense of Bs 800,00 is worth $ 1,00 official and $ 0,80 parallel.
    e = await seedScenario({ date: DATE, bcvRate: "800.0000000000", p2pRate: "1000.0000000000" });
  });
  after(() => pool.end());

  it("the period summary separates spending from income, and counts each", async () => {
    await expense({ monto: "800,00", descripcion: "uno" });
    await expense({ monto: "1.600,00", descripcion: "dos" });
    await recordTransaction({
      householdId: e.home.id, kind: "income", amount: "4.000,00", currency: "VES",
      account: "efectivo", occurredOn: DATE, source: "form",
    });

    const r = await periodSummary(e.home.id, PERIOD, TZ, "official");
    assert.equal(r.expenseMinor, 300, "Bs 2.400,00 a 800 son $ 3,00");
    assert.equal(r.incomeMinor, 500, "Bs 4.000,00 a 800 son $ 5,00");
    assert.equal(r.expenseCount, 2);
    assert.equal(r.incomeCount, 1);

    // The valuation recalculates nothing: it picks another already-written column.
    const p2p = await periodSummary(e.home.id, PERIOD, TZ, "parallel");
    assert.equal(p2p.expenseMinor, 240, "los mismos Bs 2.400,00 a 1.000 son $ 2,40");
  });

  it("a transfer is neither spending nor income in any total", async () => {
    // Moving money from one of your own accounts to another would inflate the
    // month with money that never left the house. The costliest silent mistake.
    const before = await periodSummary(e.home.id, PERIOD, TZ, "official");
    await recordTransaction({
      householdId: e.home.id, kind: "transfer", amount: "1.000,00", currency: "VES",
      account: "efectivo", toAccount: "tarjeta", occurredOn: DATE, source: "form",
    });
    const after = await periodSummary(e.home.id, PERIOD, TZ, "official");
    assert.deepEqual(
      [after.expenseMinor, after.incomeMinor],
      [before.expenseMinor, before.incomeMinor],
    );

    // The ledger's sign: an expense comes in negative and income positive, so the
    // set total is what was left, not what was spent.
    const totals = await filteredTotals(e.home.id, {});
    assert.equal(totals.officialMinor, 200, "ingresos 5,00 menos gastos 3,00, sin la transferencia");
  });

  it("an entry outside the period stays out, even if it's from yesterday", async () => {
    await expense({ monto: "8.000,00", date: "2026-07-31", descripcion: "de julio" });
    const august = await periodSummary(e.home.id, PERIOD, TZ, "official");
    assert.equal(august.expenseCount, 2, "julio se queda en julio");

    const july = await periodSummary(e.home.id, "2026-07", TZ, "official");
    assert.equal(july.expenseMinor, 1000, "Bs 8.000,00 a 800 son $ 10,00");
  });

  it("spending by category adds up in the base currency, not the account's", async () => {
    const rows = await spendingByCategory(e.home.id, PERIOD, TZ, "official");
    const mercado = rows.categories.find((c) => c.name === "Mercado");
    assert.ok(mercado, "la categoría aparece");
    assert.equal(mercado!.totalMinor, 300, "sus dos gastos, en dólares");
  });

  it("filtering by account changes the total and the count together", async () => {
    // That `countTransactions`, `filteredTotals` and `recentTransactions` share
    // the same `transactionScope` is exactly what has to be checked: if one
    // filters differently, the list says one thing and its total another.
    const filter = { account: e.card.id };
    const n = await countTransactions(e.home.id, filter);
    const rows = await recentTransactions(e.home.id, { ...filter, limit: 50 });
    assert.equal(n, rows.length, "el recuento y la lista ven lo mismo");

    const totals = await filteredTotals(e.home.id, filter);
    assert.equal(totals.officialMinor, 0, "solo tiene la pata de una transferencia, que no cuenta");
  });

  it("the facets go in base currency: mixing them painted bolívares as dollars", async () => {
    const f = await transactionFacets(e.home.id, {}, "official");
    const efectivo = f.accounts.find((a) => a.value === "Efectivo Bs");
    assert.ok(efectivo, "la cuenta con movimientos aparece");
    assert.ok(efectivo!.count > 0, "con su recuento");
    assert.ok(efectivo!.amountMinor !== 0, "y su total, en la misma unidad que las demás");

    // The accounts facet is NOT filtered by the chosen account: if it were,
    // picking one would hide the rest and there would be no way back.
    const withFilter = await transactionFacets(e.home.id, { account: e.cash.id }, "official");
    assert.equal(withFilter.accounts.length, f.accounts.length);
  });

  it("a budget says how much has been spent in whichever valuation you look at", async () => {
    await saveBudget({
      householdId: e.home.id,
      baseCurrency: "USD",
      timezone: TZ,
      locale: "es",
      category: "mercado",
      amount: "10,00",
      today: DATE,
    });

    const bcv = await budgetUsage(e.home.id, DATE, "official");
    const row = bcv.find((b) => b.category === "Mercado");
    assert.ok(row, "el presupuesto aparece");
    assert.equal(row!.budgetMinor, 1000, "el tope, $ 10,00");
    assert.equal(row!.spentMinor, 300, "$ 3,00 gastados a la oficial");
    assert.equal(row!.percent, 30);

    // The expected pace is per budget and not per calendar: day 12 is 39% of a
    // month and 80% of a fortnight, and confusing them turns an alarm into calm.
    // alarma.
    assert.ok(row!.totalDays >= 28, "un mes entero");
    assert.ok(row!.expectedPace > 0 && row!.expectedPace <= 100);

    const p2p = await budgetUsage(e.home.id, DATE, "parallel");
    assert.equal(
      p2p.find((b) => b.category === "Mercado")!.spentMinor,
      240,
      "y $ 2,40 a la paralela: el mismo gasto, otro porcentaje del tope",
    );
  });

  it("what's committed counts the installments coming due, and flags the overdue ones", async () => {
    await recordFinancedPurchase({
      householdId: e.home.id,
      financier: "tdc",
      total: "4.000,00",
      installmentCount: 4,
      frequency: "biweekly",
      firstDueOn: "2026-08-10", // already past: overdue
      occurredOn: DATE,
      source: "form",
    });

    const c = await committedInstallments(e.home.id, DATE, "USD", 30);
    assert.ok(c, "hay algo comprometido");
    assert.ok(c!.count >= 2, "las que caen dentro de los 30 días");
    assert.ok(c!.overdueCount >= 1, "y la del 10 de agosto está vencida");
  });

  it("the review tray counts what the AI wasn't sure about", async () => {
    const before = await pendingReviewCount(e.home.id);
    await recordTransaction({
      householdId: e.home.id, kind: "expense", amount: "500,00", currency: "VES",
      account: "efectivo", occurredOn: DATE, source: "telegram",
      confidence: 0.3,
    });
    assert.equal(await pendingReviewCount(e.home.id), before + 1, "poca confianza va a revisar");
  });

  it("a hand-written rate beats the automatic one in EVERY figure", async () => {
    /*
     * `valued()` is a SQL fragment shared by nine queries. There used to be nine
     * copies, and one forgetting to look at `base_amount_manual_minor` would
     * give a different figure for the same expense depending on the screen. This
     * pins it: it is recorded with a hand-set rate and the summary has to reflect it.
     */
    // The JUMP is measured and not the total: that way the test says what this
    // row contributed without depending on what the previous ones had piled up.
    const beforeBcv = (await periodSummary(e.home.id, PERIOD, TZ, "official")).expenseMinor;
    const beforeP2p = (await periodSummary(e.home.id, PERIOD, TZ, "parallel")).expenseMinor;

    await recordTransaction({
      householdId: e.home.id, kind: "expense", amount: "1.000,00", currency: "VES",
      account: "efectivo", category: "mercado", occurredOn: DATE, source: "form",
      rate: "500", rateSource: "manual",
    });

    const bcv = await periodSummary(e.home.id, PERIOD, TZ, "official");
    assert.equal(bcv.expenseMinor - beforeBcv, 200, "Bs 1.000,00 a la tasa escrita (500) son $ 2,00");

    // The same figure by the other path. If $ 1,00 came out here — the day's —
    // two screens would count the same expense differently, which is exactly
    // what `valued()` exists to prevent.
    const p2p = await periodSummary(e.home.id, PERIOD, TZ, "parallel");
    assert.equal(p2p.expenseMinor - beforeP2p, 200, "la de la fila manda en las dos valuaciones");
  });
});
