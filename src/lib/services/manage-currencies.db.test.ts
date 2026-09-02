import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { eq } from "drizzle-orm";

import { db, pool } from "@/db";
import { currencies } from "@/db/schema";
import { hasDb, prepareDb } from "@/test/db";
import { seedScenario, type Scenario } from "@/test/fixtures";
import { createAccount } from "./manage-accounts";
import { createCurrency, listCurrencies, removeCurrency, updateCurrency } from "./manage-currencies";
import { minorUnit } from "@/lib/money";

/**
 * Adding a currency from the app, and the field it refuses to take.
 *
 * The decimals are the one thing here that can turn a figure false. `money.ts`
 * keeps its own map of them and cannot read this table — it is pure and
 * synchronous, a client component formats with it — and the guard that keeps
 * the two honest runs at build time over the declared list, so a row written at
 * runtime never passes through it.
 */
const DATE = "2026-08-21";
const TZ = "America/Caracas";
let e: Scenario;

describe("managing currencies", { skip: hasDb() ? false : "no Postgres available" }, () => {
  before(async () => {
    await prepareDb();
    e = await seedScenario({ date: DATE, bcvRate: "780.0000000000", p2pRate: "900.0000000000" });
  });
  after(() => pool.end());

  it("takes its decimals from money.ts and never from whoever asked", async () => {
    await createCurrency({ locale: "es", code: "pen", name: "Peruvian sol" });

    const [row] = await db.select().from(currencies).where(eq(currencies.code, "PEN"));
    assert.ok(row, "the code is stored upper case, however it was typed");
    assert.equal(
      row.minorUnit,
      minorUnit("PEN"),
      "the two descriptions of a currency's decimals cannot differ: everything " +
        "recorded in it would be out by a power of ten, silently",
    );
    // And its symbol is what the screen will actually print, which for a
    // currency the code does not know is the code itself.
    assert.equal(row.symbol, "PEN");
  });

  it("refuses a symbol that would be stored and never shown", async () => {
    await assert.rejects(
      () => createCurrency({ locale: "es", code: "BRL", name: "Brazilian real", symbol: "R$" }),
      /BRL/,
      "formatAmount reads its own list, so accepting «R$» here would be accepting a lie",
    );
  });

  it("refuses something that is not a currency code", async () => {
    await assert.rejects(() => createCurrency({ locale: "es", code: "pesos!", name: "x" }), /USD/);
  });

  it("will not remove one that has money in it", async () => {
    await createCurrency({ locale: "es", code: "CLP", name: "Chilean peso" });
    await createAccount({
      householdId: e.home.id, locale: "es", timezone: TZ,
      name: "Efectivo Chile", type: "cash", currency: "CLP",
    });

    await assert.rejects(
      () => removeCurrency("CLP", "es"),
      /CLP/,
      // The foreign key refuses it anyway, but with a Postgres error instead of
      // an answer that says what to do about it.
      "an account holds it: the message has to say so",
    );

    const listed = await listCurrencies();
    assert.equal(listed.find((c) => c.code === "CLP")?.accounts, 1);
    // One with nothing in it goes without argument.
    await createCurrency({ locale: "es", code: "GBP", name: "Pound sterling" });
    await removeCurrency("GBP", "es");
    assert.equal((await listCurrencies()).some((c) => c.code === "GBP"), false);
  });

  it("says whether it has an official rate, and that can be corrected", async () => {
    /*
     * It defaults to false, which is the world: almost nowhere publishes an
     * official rate beside the market's. Venezuela is the case this product was
     * written for, not the shape of the rest.
     */
    await createCurrency({ locale: "es", code: "ARS", name: "Argentine peso" });
    assert.equal((await listCurrencies()).find((c) => c.code === "ARS")?.hasOfficial, false);

    await updateCurrency({ locale: "es", code: "ARS", hasOfficial: true });
    assert.equal((await listCurrencies()).find((c) => c.code === "ARS")?.hasOfficial, true);
  });
});
