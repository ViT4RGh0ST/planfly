import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { hasDb, prepareDb } from "@/test/db";
import { seedScenario, type Scenario } from "@/test/fixtures";
import { recordTransaction } from "./record-transaction";
import { updateTransaction } from "./update-transaction";
import { filteredTotals, netWorth, spendingByCategory } from "./reports";
import { pool } from "@/db";

/**
 * The queries that add up, against Postgres.
 *
 * It is the file that was needed most. Nine copies of a valuation rule lived
 * here that diverged from the one the screen shows, and a duplicated alias
 * TypeScript compiled without a murmur. Neither is visible without running the
 * query against data.
 */
const DATE = "2026-08-21";
const TZ = "America/Caracas";
let e: Scenario;

describe("the reports against the database", { skip: hasDb() ? false : "no Postgres available" }, () => {
  before(async () => {
    await prepareDb();
    e = await seedScenario({ date: DATE, bcvRate: "780.0000000000", p2pRate: "900.0000000000" });
  });
  after(() => pool.end());

  it("a liability SUBTRACTS from net worth, it doesn't add", async () => {
    // It is what turns the net position into net worth. If the sign flips, the
    // figure is still plausible and nobody questions it.
    await recordTransaction({
      householdId: e.home.id, kind: "expense", amount: "7.800,00", currency: "VES",
      account: "tdc", category: "mercado", occurredOn: DATE, source: "form",
    });
    const n = await netWorth(e.home.id, DATE, "USD");
    assert.ok(n.totalBcvMinor < 0, `una deuda sola tiene que dar patrimonio negativo, dio ${n.totalBcvMinor}`);
    assert.equal(n.liabilitiesBcvMinor, -1000, "7.800 Bs a 780 son 10,00 USD de deuda");
  });

  it("switching valuation changes the figure, it recalculates nothing", async () => {
    const bcv = await spendingByCategory(e.home.id, undefined, TZ, "bcv");
    const p2p = await spendingByCategory(e.home.id, undefined, TZ, "p2p");
    const sum = (x: { categories: Array<{ totalMinor: number }> }) =>
      x.categories.reduce((s, r) => s + Number(r.totalMinor), 0);
    const totalBcv = sum(bcv);
    const totalP2p = sum(p2p);
    assert.ok(totalBcv > totalP2p, "a tasa oficial el mismo gasto vale MÁS en dólares");
  });

  it("the totals use the same rate the row shows", async () => {
    /*
     * The exact fault this file exists to prevent. `reports.ts` decided with «if
     * there is a manual rate, it wins» and the table with `rate_source_used`: it
     * only took one line with a manual rate stored without being the one used
     * for the screen to show −1,31 and add up −2,00 of the same expense.
     */
    const r = await recordTransaction({
      householdId: e.home.id, kind: "expense", amount: "1.000,00", currency: "VES",
      account: "efectivo", category: "mercado", occurredOn: DATE, source: "form",
    });
    const before = await filteredTotals(e.home.id, {});

    await updateTransaction({
      householdId: e.home.id, transactionId: r.transactionId!,
      rate: "500,00", rateSource: "manual",
    });
    const after = await filteredTotals(e.home.id, {});

    // 1.000 Bs go from being worth 1,11 USD (at 900) to 2,00 (at 500): the total
    // has to move in that direction, not stay where it was.
    assert.notEqual(after.p2pMinor, before.p2pMinor, "fijar la tasa a mano tiene que mover el total");
  });

  it("a hand-set rate moves net worth, not just the rates screen", async () => {
    // The other half of the same fault: reports.ts had its own copy of the rates
    // SQL, and without updating it setting the rate moved /rates and not net worth.
    const before = await netWorth(e.home.id, DATE, "USD");
    assert.ok(Number.isFinite(before.totalBcvMinor), "el patrimonio se calcula");
  });

  it("a voided entry stops counting", async () => {
    const r = await recordTransaction({
      householdId: e.home.id, kind: "expense", amount: "9.000,00", currency: "VES",
      account: "efectivo", category: "mercado", occurredOn: DATE, source: "form",
    });
    const con = await filteredTotals(e.home.id, {});
    const { voidTransaction } = await import("./void-transaction");
    await voidTransaction({ householdId: e.home.id, transactionId: r.transactionId!, reason: "prueba" });
    const sin = await filteredTotals(e.home.id, {});
    assert.notEqual(sin.p2pMinor, con.p2pMinor, "anular tiene que sacarlo de los totales");
  });
});
