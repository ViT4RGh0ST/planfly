import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { eq } from "drizzle-orm";

import { hasDb, prepareDb } from "@/test/db";
import { seedScenario, userOf, type Scenario } from "@/test/fixtures";
import { applyRules, commitImport, previewImport, type ColumnMapping } from "./import";
import { db, pool } from "@/db";
import { categories, categorizationRules, transactionEntries } from "@/db/schema";

/**
 * Categorising only what is imported, against the database.
 *
 * It is what keeps importing a 200-row statement from being 200 clicks. All the
 * logic lives in a query with CTEs, so its behaviour — which rule wins, which
 * field it compares on — is not visible in TypeScript.
 */
const DATE = "2026-08-22";
const MAPPING: ColumnMapping = {
  date: "fecha", description: "concepto", amount: "monto", dateFormat: "dd/mm/yyyy",
};
let e: Scenario;
let userId: string;
let health: string;

async function doImport(descriptions: string[]) {
  const rows = descriptions.map((c) => ({ fecha: "22/08/2026", concepto: c, monto: "-100,00" }));
  const prior = await previewImport(e.home.id, e.cash.id, "VES", rows, MAPPING);
  return commitImport({
    householdId: e.home.id, userId, accountId: e.cash.id, accountName: "Efectivo Bs",
    currency: "VES", fileName: `${descriptions.join("-")}.csv`, mapping: MAPPING,
    rows: prior, rawRows: rows,
  });
}


describe("categorisation rules", { skip: hasDb() ? false : "no Postgres available" }, () => {
  before(async () => {
    await prepareDb();
    e = await seedScenario({ date: DATE, p2pRate: "900.0000000000" });
    userId = await userOf(e.home);
    const [c] = await db
      .insert(categories)
      .values({ householdId: e.home.id, name: "Salud", slug: "salud", kind: "expense" })
      .returning();
    health = c.id;
  });
  beforeEach(async () => {
    await db.delete(categorizationRules).where(eq(categorizationRules.householdId, e.home.id));
  });
  after(() => pool.end());

  it("with no rules it categorises nothing", async () => {
    assert.equal(await applyRules(e.home.id), 0);
  });

  it("a 'contains' rule categorises what you import", async () => {
    await db.insert(categorizationRules).values({
      householdId: e.home.id, pattern: "farmatodo", operator: "contains",
      field: "description", setCategoryId: health, priority: 100,
    });
    // The import's own result is what is looked at: since categorising became
    // part of importing, calling applyRules afterwards finds nothing to do.
    const r = await doImport(["PAGO MOVIL FARMATODO CA"]);
    assert.equal(r.categorized, 1);
  });

  it("it tells neither accents nor case apart", async () => {
    await db.insert(categorizationRules).values({
      householdId: e.home.id, pattern: "CLINICA", operator: "contains",
      field: "description", setCategoryId: health,
    });
    const r = await doImport(["consulta clínica del este"]);
    assert.equal(r.categorized, 1);
  });

  it("with two rules matching, the higher-priority one wins", async () => {
    /*
     * The query did `DISTINCT ON (entry_id)` WITHOUT an ORDER BY of its own: the
     * order of the CTE above is not inherited, so Postgres could keep either of
     * the two. A priority rule that is not honoured is worse than having no
     * priorities: it looks like you decide and you do not.
     */
    const [other] = await db
      .insert(categories)
      .values({ householdId: e.home.id, name: "Otra", slug: "otra", kind: "expense" })
      .returning();

    await db.insert(categorizationRules).values([
      { householdId: e.home.id, pattern: "super", operator: "contains", field: "description", setCategoryId: other.id, priority: 900 },
      { householdId: e.home.id, pattern: "super", operator: "contains", field: "description", setCategoryId: health, priority: 1 },
    ]);
    await doImport(["COMPRA SUPER 24"]);
    await applyRules(e.home.id);

    const rows = await db
      .select({ categoryId: transactionEntries.categoryId })
      .from(transactionEntries)
      .where(eq(transactionEntries.householdId, e.home.id));
    const withHealth = rows.filter((f) => f.categoryId === health).length;
    assert.ok(withHealth >= 1, "tenía que ganar la de prioridad 1, no la de 900");
  });

  it("a rule about another field doesn't apply to the description", async () => {
    // The query compared ALWAYS against the description, ignoring `field`: a rule
    // about the amount categorised by the text, which is another thing entirely.
    await db.insert(categorizationRules).values({
      householdId: e.home.id, pattern: "farmacia", operator: "contains",
      field: "amount", setCategoryId: health,
    });
    const r = await doImport(["COMPRA EN FARMACIA"]);
    assert.equal(r.categorized, 0, "el campo de la regla tiene que respetarse");
  });

  it("importing categorises on its own, without asking for a separate button", async () => {
    // The end that was missing: the function existed and nobody called it, so you
    // imported the statement and all two hundred rows were left uncategorised.
    await db.insert(categorizationRules).values({
      householdId: e.home.id, pattern: "odontolog", operator: "contains",
      field: "description", setCategoryId: health,
    });
    const r = await doImport(["PAGO ODONTOLOGO"]);
    assert.equal(r.imported, 1);
    assert.equal(r.categorized, 1, "y sale categorizado del propio importar");
  });

  it("a disabled rule does nothing", async () => {
    await db.insert(categorizationRules).values({
      householdId: e.home.id, pattern: "gasolina", operator: "contains",
      field: "description", setCategoryId: health, isActive: false,
    });
    const r = await doImport(["PAGO GASOLINA"]);
    assert.equal(r.categorized, 0);
  });
});
