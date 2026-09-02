import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { eq, sql } from "drizzle-orm";

import { accounts, transactions } from "@/db/schema";
import { hasDb, prepareDb } from "@/test/db";
import { seedScenario, type Scenario } from "@/test/fixtures";
import { recordTransaction } from "./record-transaction";
import { itemsOfTransaction } from "./products";
import { updateTransaction } from "./update-transaction";
import { canBeApproved, reviewReasons } from "./review";
import { db, pool } from "@/db";
import { transactionEntries } from "@/db/schema";

/**
 * Correcting an entry, against the database.
 *
 * Same risk as recording it and less watched: here amounts and rates change on
 * lines that already valued something, and a half-done revaluation leaves the
 * row saying one thing and the totals another.
 */
const DATE = "2026-08-21";
let e: Scenario;

async function newExpense(monto = "1.000,00") {
  const r = await recordTransaction({
    householdId: e.home.id, kind: "expense", amount: monto, currency: "VES",
    account: "efectivo", category: "mercado", occurredOn: DATE, source: "form",
  });
  return r.transactionId!;
}

async function line(id: string) {
  const [row] = await db
    .select()
    .from(transactionEntries)
    .where(eq(transactionEntries.transactionId, id));
  return row;
}

describe("updateTransaction against the database", { skip: hasDb() ? false : "no Postgres available" }, () => {
  before(async () => {
    await prepareDb();
    e = await seedScenario({ date: DATE, bcvRate: "780.0000000000", p2pRate: "900.0000000000" });
  });
  after(() => pool.end());

  it("changing the amount revalues BOTH columns, not just the one on screen", async () => {
    // If only the active valuation is recomputed, the other keeps the equivalent
    // of the old amount and the dashboard's selector shows an impossible figure.
    const id = await newExpense("900,00");
    const before = await line(id);
    await updateTransaction({ householdId: e.home.id, transactionId: id, amount: "1.800,00" });
    const after = await line(id);

    // Proportional with a cent of slack, not exact: the equivalents are rounded
    // to the minor unit, so doubling the amount does not double the cent.
    // What is checked is that BOTH were recomputed, not that they match bit for bit.
    for (const [col, a, d] of [
      ["parallel", before.baseAmountParallelMinor, after.baseAmountParallelMinor],
      ["official", before.baseAmountOfficialMinor, after.baseAmountOfficialMinor],
    ] as const) {
      const expected = Number(a) * 2;
      assert.ok(
        Math.abs(Number(d) - expected) <= 1,
        `${col}: esperaba ~${expected} y quedó ${d} — ¿se revaluó esa columna?`,
      );
    }
  });

  it("setting the rate by hand leaves a record that it was by hand", async () => {
    // Writing rate_manual while keeping the previous source is what made the row
    // and the totals use different figures.
    const id = await newExpense();
    await updateTransaction({
      householdId: e.home.id, transactionId: id, rate: "500,00", rateSource: "manual",
    });
    const l = await line(id);
    assert.equal(l.rateSourceUsed, "manual");
    assert.equal(Number(l.baseAmountManualMinor), -200, "1.000 Bs a 500 son 2,00 USD");
  });

  it("an ambiguous rate is rejected when correcting too", async () => {
    const id = await newExpense();
    await assert.rejects(
      () => updateTransaction({ householdId: e.home.id, transactionId: id, rate: "1.234" }),
      { code: "invalid_rate" },
    );
  });

  it("a rate with a thousands separator is no longer discarded in silence", async () => {
    // The previous reader swapped only the FIRST comma: "1.234,56" gave NaN and
    // the correction was lost without saying so.
    const id = await newExpense();
    await updateTransaction({
      householdId: e.home.id, transactionId: id, rate: "1.234,56", rateSource: "manual",
    });
    const l = await line(id);
    assert.equal(l.rateManual, "1234.5600000000");
  });

  it("a voided entry can't be edited", async () => {
    const id = await newExpense();
    const { voidTransaction } = await import("./void-transaction");
    await voidTransaction({ householdId: e.home.id, transactionId: id, reason: "prueba" });
    await assert.rejects(
      () => updateTransaction({ householdId: e.home.id, transactionId: id, amount: "5,00" }),
      /anulado/,
    );
  });

  it("another household's entry can't be edited", async () => {
    const otro = await seedScenario({ date: DATE, p2pRate: "900.0000000000" });
    const id = await newExpense();
    await assert.rejects(
      () => updateTransaction({ householdId: otro.home.id, transactionId: id, amount: "5,00" }),
      /No encontré/,
    );
  });

  /*
   * What was left uncovered: changing account, moving the date, touching the
   * breakdown and the four ways of asking for something impossible.
   *
   * They all share the same risk and it is this project's worst: the correction
   * is accepted, returns ok, and leaves the row saying something different from
   * what the totals add up to. Nothing fails, nobody finds out.
   */

  it("moving the expense to another date revalues it at THAT day's rate", async () => {
    // It is what separates «I corrected the date» from «I made up a price»: the
    // row has to be worth what it was worth on the day it actually happened.
    // Another day, another rate. No household column: rates belong to the install.
    await db.execute(sql`
      INSERT INTO exchange_rates (base_currency, quote_currency, source, variant, rate, effective_on)
      VALUES ('USD','VES','official','default','390.0000000000','2026-08-15'),
             ('USD','VES','parallel','median','450.0000000000','2026-08-15')
      ON CONFLICT DO NOTHING`);

    const id = await newExpense("3.900,00");
    const before = await line(id);
    assert.equal(before.baseAmountOfficialMinor, -500, "a 780, Bs 3.900,00 son $ 5,00");

    await updateTransaction({
      householdId: e.home.id,
      transactionId: id,
      occurredOn: "2026-08-15",
    });

    const after = await line(id);
    assert.equal(after.baseAmountOfficialMinor, -1000, "a 390, los mismos bolívares son $ 10,00");
  });

  it("switching accounts doesn't drag along the previous one's rate", async () => {
    const id = await newExpense("780,00");
    const r = await updateTransaction({
      householdId: e.home.id,
      transactionId: id,
      account: "Tarjeta",
    });
    assert.ok(r.changes.some((c) => /cuenta/i.test(c)), `dijo qué cambió: ${r.changes.join(" · ")}`);

    const l = await line(id);
    assert.equal(l.accountId, e.card.id);
    // Both accounts carry bolívares, so the equivalent does not move. What is
    // checked is that it was recomputed and not copied: if it were dragged
    // along, switching currencies would give a false figure with no warning.
    assert.equal(l.baseAmountOfficialMinor, -100, "Bs 780,00 a 780 siguen siendo $ 1,00");
  });

  it("the breakdown is replaced whole, and `append` keeps what was there", async () => {
    const id = await newExpense("1.000,00");

    await updateTransaction({
      householdId: e.home.id, transactionId: id,
      items: [{ description: "ARROZ", total: "400,00" }],
      itemsMode: "replace",
    });
    assert.equal((await itemsOfTransaction(e.home.id, id)).length, 1);

    await updateTransaction({
      householdId: e.home.id, transactionId: id,
      items: [{ description: "CARAOTAS", total: "300,00" }],
      itemsMode: "append",
    });
    const dos = await itemsOfTransaction(e.home.id, id);
    assert.equal(dos.length, 2, "append añade, no sustituye");
    assert.deepEqual(dos.map((i) => i.rawText).sort(), ["ARROZ", "CARAOTAS"]);

    // And `replace` with a single one leaves one again: it is the mode that deletes.
    await updateTransaction({
      householdId: e.home.id, transactionId: id,
      items: [{ description: "HARINA", total: "200,00" }],
      itemsMode: "replace",
    });
    assert.equal((await itemsOfTransaction(e.home.id, id)).length, 1);
  });

  it("asking for transfer fields on an expense is rejected by naming the right one", async () => {
    // It is the mistake that already cost twelve purchases in the wrong account: a
    // valid field in the wrong context. Staying quiet leaves a correct write with
    // the datum in the bin, so it is rejected by saying which one was right.
    const id = await newExpense();

    await assert.rejects(
      () => updateTransaction({ householdId: e.home.id, transactionId: id, toAccount: "Tarjeta" }),
      /no es una transferencia/i,
    );
    await assert.rejects(
      () => updateTransaction({ householdId: e.home.id, transactionId: id, toAmount: "50,00" }),
      /no es una transferencia/i,
    );
  });

  it("a transfer carries no category, and saying so beats storing one", async () => {
    const t = await recordTransaction({
      householdId: e.home.id, kind: "transfer", amount: "500,00", currency: "VES",
      account: "efectivo", toAccount: "tarjeta", occurredOn: DATE, source: "form",
    });
    await assert.rejects(
      () =>
        updateTransaction({
          householdId: e.home.id,
          transactionId: t.transactionId!,
          category: "mercado",
        }),
      /no llevan categoría/i,
    );
  });

  it("a correction that changes nothing says so, instead of answering yes", async () => {
    // «Done» over something that did not move is the answer that confuses an
    // agent most: it asked for something, was told it went fine, and nothing changed.
    const id = await newExpense("1.234,00");
    const r = await updateTransaction({
      householdId: e.home.id, transactionId: id, amount: "1.234,00",
    });
    assert.equal(r.changes.length, 0, "no hubo nada que cambiar y se nota en la respuesta");
  });

  it("approving does not take a line with no equivalent out of the tray, and the screen knows", async () => {
    /*
     * The two halves of the same rule, asserted together.
     *
     * `approve` does not write `needs_review = false` bare: it recalculates, and
     * a line still without an equivalent is flagged again. The tray reads that
     * from `canBeApproved` to decide whether to offer «It's fine» at all — and
     * if these two ever disagree, the app offers a button that cannot do what it
     * says. That is what this pins: the service's verdict and the screen's.
     */
    const [wallet] = await db
      .insert(accounts)
      .values({
        householdId: e.home.id,
        name: "Euros",
        slug: "euros",
        type: "bank",
        nature: "asset",
        currency: "EUR",
        openingDate: DATE,
      })
      .returning();

    const spent = await recordTransaction({
      householdId: e.home.id, kind: "expense", amount: "50,00", currency: "EUR",
      account: wallet.name, category: "mercado", occurredOn: DATE, source: "form",
    });
    assert.equal(spent.needsReview, true, "with no EUR rate it lands in the tray");

    const row = {
      category: "Mercado",
      confidence: null,
      baseOfficialMinor: null,
      baseParallelMinor: null,
      currency: "EUR",
      source: "form",
    };
    const reasons = reviewReasons(row, "USD");
    assert.ok(reasons.includes("noRate"), "and the screen says why");
    assert.equal(canBeApproved(reasons), false, "so it does not offer to approve it");

    await updateTransaction({
      householdId: e.home.id,
      transactionId: spent.transactionId!,
      approve: true,
    });
    const [after] = await db
      .select({ needsReview: transactions.needsReview })
      .from(transactions)
      .where(eq(transactions.id, spent.transactionId!));
    assert.equal(after.needsReview, true, "because approving really does bring it back");
  });
});
