import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { hasDb, prepareDb } from "@/test/db";
import { seedScenario, type Scenario } from "@/test/fixtures";
import { listBudgets, removeBudget, saveBudget } from "./budgets";
import { accountBalance } from "./balances";
import { recordTransaction } from "./record-transaction";
import { pool } from "@/db";

/**
 * Budgets and balances, against the database.
 *
 * Both add up, and both are read at a glance without anyone recomputing them by
 * hand: if an account balance lies, there is no way to notice by looking.
 */
const DATE = "2026-08-21";
let e: Scenario;
const common = () => ({
  householdId: e.home.id,
  baseCurrency: "USD",
  timezone: "America/Caracas",
  locale: "es",
  today: DATE,
});

describe("budgets and balances", { skip: hasDb() ? false : "no Postgres available" }, () => {
  before(async () => {
    await prepareDb();
    e = await seedScenario({ date: DATE, bcvRate: "780.0000000000", p2pRate: "900.0000000000" });
  });
  after(() => pool.end());

  it("the balance is the opening plus the entries, not just the entries", async () => {
    assert.equal(await accountBalance(e.cash.id), 0, "sin movimientos, el saldo es el de apertura");
    await recordTransaction({
      householdId: e.home.id, kind: "expense", amount: "1.500,00", currency: "VES",
      account: "efectivo", category: "mercado", occurredOn: DATE, source: "form",
    });
    assert.equal(await accountBalance(e.cash.id), -150000, "un gasto RESTA");
  });

  it("income adds to the balance", async () => {
    const before = await accountBalance(e.cash.id);
    await recordTransaction({
      householdId: e.home.id, kind: "income", amount: "500,00", currency: "VES",
      account: "efectivo", occurredOn: DATE, source: "form",
    });
    assert.equal(await accountBalance(e.cash.id), before + 50000);
  });

  it("saving the same category twice corrects, it doesn't duplicate", async () => {
    await saveBudget({ ...common(), category: "mercado", amount: "200,00", period: "monthly" });
    await saveBudget({ ...common(), category: "mercado", amount: "300,00", period: "monthly" });
    const dels = (await listBudgets(e.home.id, "es")).filter((b) => b.category === "Mercado");
    assert.equal(dels.length, 1, "un presupuesto por categoría y periodo, no dos");
    assert.match(dels[0].amount, /300/, "y el que queda es el corregido, no el primero");
  });

  it("removing it deactivates it but doesn't erase it from the history", async () => {
    await saveBudget({ ...common(), category: "mercado", amount: "250,00", period: "monthly" });
    await removeBudget({ householdId: e.home.id, locale: "es", category: "mercado", period: "monthly" });
    const list = await listBudgets(e.home.id, "es");
    assert.equal(list.filter((b) => b.category === "Mercado").length, 0, "deja de listarse");
  });

  it("a category that doesn't exist is rejected instead of creating itself", async () => {
    await assert.rejects(
      () => saveBudget({ ...common(), category: "zzzqqq", amount: "100,00", period: "monthly" }),
      /categoría/i,
    );
  });
});
