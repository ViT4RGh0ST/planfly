import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { hasDb, prepareDb } from "@/test/db";
import { seedScenario, userOf, type Scenario } from "@/test/fixtures";
import { commitImport, previewImport, type ColumnMapping } from "./import";
import { accountBalance } from "./balances";
import { pool } from "@/db";

/**
 * Importing a statement, against the database.
 *
 * It is the route that brings in hundreds of rows at once, so a mistake is not
 * seen by reviewing: it is seen weeks later in a balance that does not add up.
 * And deduplication is the only thing between re-uploading the same file and
 * duplicating a whole month.
 */
const DATE = "2026-08-21";
const MAPPING: ColumnMapping = {
  date: "fecha",
  description: "concepto",
  amount: "monto",
  dateFormat: "dd/mm/yyyy",
};
const ROWS = [
  { fecha: "21/08/2026", concepto: "Compra mercado", monto: "-1.500,00" },
  { fecha: "21/08/2026", concepto: "Sueldo", monto: "5.000,00" },
];

let e: Scenario;
let userId: string;

describe("importing a statement", { skip: hasDb() ? false : "no Postgres available" }, () => {
  before(async () => {
    await prepareDb();
    e = await seedScenario({ date: DATE, bcvRate: "780.0000000000", p2pRate: "900.0000000000" });
    userId = await userOf(e.home);
  });
  after(() => pool.end());

  it("the preview reads signs and dates before writing anything", async () => {
    const prior = await previewImport(e.home.id, e.cash.id, "VES", ROWS, MAPPING);
    assert.equal(prior.length, 2);
    assert.equal(prior[0].amountMinor, -150000, "el gasto va en negativo");
    assert.equal(prior[1].amountMinor, 500000, "el ingreso en positivo");
    assert.equal(await accountBalance(e.cash.id), 0, "y previsualizar no escribe");
  });

  it("confirming writes and moves the balance", async () => {
    const prior = await previewImport(e.home.id, e.cash.id, "VES", ROWS, MAPPING);
    const r = await commitImport({
      householdId: e.home.id, userId, accountId: e.cash.id,
      accountName: "Efectivo Bs", currency: "VES", fileName: "extracto.csv",
      mapping: MAPPING, rows: prior, rawRows: ROWS,
    });
    assert.equal(r.imported, 2);
    assert.equal(await accountBalance(e.cash.id), 350000, "5.000 − 1.500");
  });

  it("uploading the same file again duplicates nothing", async () => {
    // It is the real scenario: you upload the monthly statement and the next one
    // brings it back overlapping. Without deduplication a whole month is duplicated.
    const balanceBefore = await accountBalance(e.cash.id);
    const prior = await previewImport(e.home.id, e.cash.id, "VES", ROWS, MAPPING);
    const r = await commitImport({
      householdId: e.home.id, userId, accountId: e.cash.id,
      accountName: "Efectivo Bs", currency: "VES", fileName: "extracto.csv",
      mapping: MAPPING, rows: prior, rawRows: ROWS,
    });
    assert.equal(r.imported, 0, "ninguna nueva");
    assert.equal(r.skipped, 2, "las dos reconocidas como ya importadas");
    assert.equal(await accountBalance(e.cash.id), balanceBefore, "y el saldo no se mueve");
  });

  it("a row with an unreadable date is flagged instead of slipping through", async () => {
    const prior = await previewImport(
      e.home.id, e.cash.id, "VES",
      [{ date: "no es fecha", concepto: "X", monto: "10,00" }],
      MAPPING,
    );
    assert.ok(prior[0].error, "tiene que traer el motivo, no un importe inventado");
  });
});
