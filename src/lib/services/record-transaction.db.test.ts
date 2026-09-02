import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { hasDb, prepareDb } from "@/test/db";
import { seedScenario, type Scenario } from "@/test/fixtures";
import { recordTransaction } from "./record-transaction";
import { db, pool } from "@/db";
import { accounts, exchangeRates, households } from "@/db/schema";
import { eq } from "drizzle-orm";

/**
 * The one write path, against a real Postgres.
 *
 * This is where a mistake does not fail: it stores a false figure. Every test in
 * this file corresponds to a fault that genuinely happened or that would have
 * gone unnoticed — not to a code branch picked for coverage.
 */
const DATE = "2026-08-21";
let e: Scenario;

describe("recordTransaction against the database", { skip: hasDb() ? false : "no Postgres available" }, () => {
  before(async () => {
    await prepareDb();
    e = await seedScenario({ date: DATE, bcvRate: "780.0000000000", p2pRate: "900.0000000000" });
  });
  after(() => pool.end());

  it("stamps BOTH valuations onto the same line", async () => {
    // It is the whole product: the question «how much do I have?» has two
    // legitimate answers and both are stored already computed, not recomputed on looking.
    const r = await recordTransaction({
      householdId: e.home.id, kind: "expense", amount: "7.800,00", currency: "VES",
      account: "efectivo", category: "mercado", occurredOn: DATE, source: "form",
    });
    assert.equal(r.base.officialMinor, -1000, "7.800 Bs a 780 son 10,00 USD");
    assert.equal(r.base.parallelMinor, -867, "los mismos 7.800 a 900 son 8,67 USD");
    assert.equal(r.base.sourceUsed, "parallel", "el hogar prefiere la paralela");
  });

  it("an ambiguous rate is rejected instead of storing a figure a thousand times larger", async () => {
    // "1.234" reached a NUMERIC raw and Postgres read it as one point two three
    // four: a Bs. 350 expense ended up valued at $283,63 with no warning.
    await assert.rejects(
      () => recordTransaction({
        householdId: e.home.id, kind: "expense", amount: "350,00", currency: "VES",
        account: "efectivo", category: "mercado", occurredOn: DATE, source: "form",
        rate: "1.234",
      }),
      { reason: "rateAmbiguous" },
    );
  });

  it("accepts the rate in the format the field itself shows", async () => {
    // "859,00" blew up the whole INSERT with a raw Postgres error.
    const r = await recordTransaction({
      householdId: e.home.id, kind: "expense", amount: "859,00", currency: "VES",
      account: "efectivo", category: "mercado", occurredOn: DATE, source: "form",
      rate: "859,00",
    });
    assert.equal(r.base.manualMinor, -100, "859 Bs a 859 es 1,00 USD");
  });

  it("to_account on an expense is rejected by naming the right field", async () => {
    // Twelve purchases ended up in the default account because this field, valid
    // but from another context, was ignored in silence and returned 201.
    await assert.rejects(
      () => recordTransaction({
        householdId: e.home.id, kind: "expense", amount: "100,00", currency: "VES",
        toAccount: "efectivo", occurredOn: DATE, source: "form",
      }),
      /"account"/,
    );
  });

  it("a liability stores the expense negative, like everything else", async () => {
    const r = await recordTransaction({
      householdId: e.home.id, kind: "expense", amount: "500,00", currency: "VES",
      account: "tdc", category: "mercado", occurredOn: DATE, source: "form",
    });
    assert.equal(r.amount.minor, -50000);
    assert.equal(r.resolved.account?.name, "Tarjeta");
  });

  it("an account matched with low confidence flags for review", async () => {
    const r = await recordTransaction({
      householdId: e.home.id, kind: "expense", amount: "123,00", currency: "VES",
      account: "efectiv", category: "mercado", occurredOn: DATE, source: "form",
    });
    assert.ok(r.resolved.account!.score < 0.55, "el escenario tiene que ser dudoso");
    assert.equal(r.needsReview, true);
    assert.match(r.warnings.join(" "), /no estoy seguro/);
  });

  it("the same expense twice in a row is rejected when the caller can't see the history", async () => {
    const args = {
      householdId: e.home.id, kind: "expense" as const, amount: "4.321,00", currency: "VES",
      account: "efectivo", category: "mercado", occurredOn: DATE, source: "telegram" as const,
      onDuplicate: "reject" as const,
    };
    await recordTransaction(args);
    await assert.rejects(() => recordTransaction(args), /ya está registrado/);
    // And one more cent does not dodge it either: that was the trick that left five purchases.
    await assert.rejects(
      () => recordTransaction({ ...args, amount: "4.321,01" }),
      /ya está registrado/,
    );
  });

  it("the same expense says the same figures in the other language", async () => {
    /*
     * The one thing that has to survive translation: the figure.
     *
     * A message whose English lost its `{amount}` still renders — a grammatical,
     * safe, figure-less sentence that the bot repeats with confidence. Here the
     * same movement is recorded twice, with the household switched over in
     * between, and both summaries are required to carry the same numbers.
     *
     * The numbers themselves do not change with the language: `money.ts` writes
     * es-VE in both, because the figure gets compared against a Venezuelan bank
     * statement and the screen has to say it the way the paper does.
     */
    const move = () =>
      recordTransaction({
        householdId: e.home.id, kind: "expense", amount: "7.800,00", currency: "VES",
        account: "efectivo", category: "mercado", occurredOn: DATE, source: "form",
        dryRun: true,
      });

    const es = await move();
    await db.update(households).set({ locale: "en" }).where(eq(households.id, e.home.id));
    const en = await move();
    await db.update(households).set({ locale: "es" }).where(eq(households.id, e.home.id));

    const figures = (text: string) => text.match(/[\d.]+,\d{2}/g);
    assert.deepEqual(figures(en.summary), figures(es.summary));
    assert.match(en.summary, /Bs\. 7\.800,00/);
    assert.doesNotMatch(en.summary, /[áéíóúñ¿¡]/, en.summary);
    assert.match(es.summary, /Gasto/);
    assert.match(en.summary, /Expense/);
  });

  it("an expense in a currency that does not move is valued without writing a rate", async () => {
    /*
     * The case this exists for: a dollar stablecoin against the dollar.
     *
     * Its rate does not go out of date, so the row written once covers every
     * entry from then on. Before this, `STALE_TOLERANCE_DAYS` — calibrated for
     * the bolívar, which moves every day — called that row old, the entry was
     * stored with no equivalent and landed in the review tray asking by hand
     * for a number that is always the same one.
     */
    await db
      .insert(exchangeRates)
      .values(
        ["official", "parallel"].map((variant) => ({
          baseCurrency: "USD",
          quoteCurrency: "USDT",
          source: "manual" as const,
          variant,
          rate: "1",
          effectiveOn: "2000-01-01",
        })),
      )
      .onConflictDoNothing();

    const [wallet] = await db
      .insert(accounts)
      .values({
        householdId: e.home.id,
        name: "Binance",
        slug: "binance",
        type: "crypto",
        nature: "asset",
        currency: "USDT",
        openingDate: DATE,
      })
      .returning();

    const r = await recordTransaction({
      householdId: e.home.id, kind: "expense", amount: "31,00", currency: "USDT",
      account: wallet.name, category: "mercado", occurredOn: DATE, source: "form",
    });

    assert.equal(r.base.parallelMinor, -3100, "31 USDT are 31,00 USD");
    assert.equal(r.needsReview, false, "and it does not go to the tray for a rate it has");
    assert.deepEqual(r.warnings, [], "nor is anything said about a missing or stale rate");
  });
});
