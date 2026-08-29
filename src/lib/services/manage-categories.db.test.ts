import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { eq } from "drizzle-orm";

import { db, pool } from "@/db";
import { categories } from "@/db/schema";
import { hasDb, prepareDb } from "@/test/db";
import { seedScenario, type Scenario } from "@/test/fixtures";
import {
  archiveCategory,
  categoryTree,
  createCategory,
  unarchiveCategory,
  updateCategory,
} from "./manage-categories";
import { saveBudget } from "./budgets";
import { recordTransaction } from "./record-transaction";
import { budgetUsage } from "./reports";

/**
 * The categories, against the database.
 *
 * What is decided on this screen never fails loudly. An alias shared with
 * another category sends expenses somewhere else; a kind changed after the fact
 * takes a month of spending out of its own total; a parent nobody looks at makes
 * a budget read zero. All four are figures, not errors.
 */
const DATE = "2026-08-21";
const TZ = "America/Caracas";
let e: Scenario;

async function parentOf(id: string): Promise<string | null> {
  const [row] = await db.select({ parentId: categories.parentId }).from(categories).where(eq(categories.id, id));
  return row.parentId;
}

describe("managing categories", { skip: hasDb() ? false : "no Postgres available" }, () => {
  before(async () => {
    await prepareDb();
    e = await seedScenario({ date: DATE, bcvRate: "780.0000000000", p2pRate: "900.0000000000" });
  });
  after(() => pool.end());

  it("two categories may not answer to the same other name", async () => {
    /*
     * The resolver takes `LIMIT 1 ORDER BY score DESC, name ASC`, so two
     * categories sharing «super» are decided alphabetically. Nothing fails: the
     * expenses simply start landing in the other one.
     */
    // The scenario's Mercado already answers to «super».
    await assert.rejects(
      () =>
        createCategory({
          householdId: e.home.id, locale: "es",
          name: "Bodegón", kind: "expense", aliases: "bodegon, super",
        }),
      /Mercado/,
      "the message has to name the category that already answers to it",
    );

    // With a free one it goes through, and it is stored normalised.
    const ok = await createCategory({
      householdId: e.home.id, locale: "es",
      name: "Bodegón", kind: "expense", aliases: "bodegón, Licorería",
    });
    const [saved] = await db.select({ aliases: categories.aliases }).from(categories).where(eq(categories.id, ok.id));
    assert.deepEqual(saved.aliases, ["bodegon", "licoreria"]);
  });

  it("a category with entries can no longer change its kind", async () => {
    const cat = await createCategory({
      householdId: e.home.id, locale: "es", name: "Peluquería", kind: "expense",
    });
    await recordTransaction({
      householdId: e.home.id, kind: "expense", amount: "100,00", currency: "VES",
      account: "efectivo", category: "peluqueria", occurredOn: DATE, source: "form",
    });

    await assert.rejects(
      () =>
        updateCategory({
          householdId: e.home.id, categoryId: cat.id, locale: "es", kind: "income",
        }),
      /Peluquería/,
      // Turning it into income takes every entry it carries out of the month's
      // spending, with nothing on screen to say where they went.
      "the kind is locked once it carries entries",
    );
  });

  it("the hierarchy is two levels deep and no more", async () => {
    const food = await createCategory({
      householdId: e.home.id, locale: "es", name: "Comida", kind: "expense",
    });
    const street = await createCategory({
      householdId: e.home.id, locale: "es", name: "Comida callejera", kind: "expense",
      parentId: food.id,
    });
    assert.equal(await parentOf(street.id), food.id);

    // A third level would be silently ignored by the budget query, which looks
    // exactly one step down.
    await assert.rejects(
      () =>
        createCategory({
          householdId: e.home.id, locale: "es", name: "Empanadas", kind: "expense",
          parentId: street.id,
        }),
      /Comida callejera/,
    );

    // And a parent of the other kind would add income into a spending total.
    const salary = await createCategory({
      householdId: e.home.id, locale: "es", name: "Sueldo", kind: "income",
    });
    await assert.rejects(
      () =>
        updateCategory({
          householdId: e.home.id, categoryId: street.id, locale: "es", parentId: salary.id,
        }),
      /Sueldo/,
    );
  });

  it("a budget on a category counts what its children spend", async () => {
    /*
     * The one that was wrong before this screen existed.
     *
     * Every expense lands on a child — that is what the children are for — so a
     * cap set on the parent counted nothing at all and read 0% used for the
     * whole month. Not an error: a calm figure saying the opposite of the truth.
     */
    const home = (await seedScenario({ date: DATE, bcvRate: "780.0000000000", p2pRate: "900.0000000000" })).home;
    const transport = await createCategory({
      householdId: home.id, locale: "es", name: "Transporte", kind: "expense",
    });
    await createCategory({
      householdId: home.id, locale: "es", name: "Gasolina", kind: "expense",
      parentId: transport.id, aliases: "bomba",
    });

    await recordTransaction({
      householdId: home.id, kind: "expense", amount: "900,00", currency: "VES",
      account: "efectivo", category: "gasolina", occurredOn: DATE, source: "form",
    });
    await saveBudget({
      householdId: home.id, baseCurrency: "USD", timezone: TZ, locale: "es",
      category: "transporte", amount: "1.000,00", period: "monthly", today: DATE,
    });

    const [row] = (await budgetUsage(home.id, DATE, "p2p")).filter(
      (b) => b.category === "Transporte",
    );
    assert.ok(row, "the budget on the parent must be in force");
    // In the base currency, like every figure a budget compares: Bs 900 at the
    // P2P rate of 900 is exactly one dollar. What matters is that it is not 0.
    assert.equal(row.spentMinor, 100, "what the child spent counts against the parent's cap");
  });

  it("archiving is refused while something still hangs on it", async () => {
    const home = (await seedScenario({ date: DATE })).home;
    const health = await createCategory({
      householdId: home.id, locale: "es", name: "Salud", kind: "expense",
    });
    const pharmacy = await createCategory({
      householdId: home.id, locale: "es", name: "Farmacia", kind: "expense", parentId: health.id,
    });

    await assert.rejects(
      () => archiveCategory(home.id, health.id),
      /Salud/,
      "a child would be left hanging off something that is not on the list",
    );

    // The child on its own archives cleanly, and comes back.
    await archiveCategory(home.id, pharmacy.id);
    assert.equal((await categoryTree(home.id)).find((c) => c.id === health.id)?.children.length, 0);
    await unarchiveCategory(home.id, pharmacy.id);
    assert.equal((await categoryTree(home.id)).find((c) => c.id === health.id)?.children.length, 1);
  });

  it("archiving is refused while a budget is counting against it", async () => {
    const home = (await seedScenario({ date: DATE, bcvRate: "780.0000000000", p2pRate: "900.0000000000" })).home;
    const cat = await createCategory({
      householdId: home.id, locale: "es", name: "Suscripciones", kind: "expense",
    });
    await saveBudget({
      householdId: home.id, baseCurrency: "USD", timezone: TZ, locale: "es",
      category: "suscripciones", amount: "500,00", period: "monthly", today: DATE,
    });

    await assert.rejects(
      () => archiveCategory(home.id, cat.id),
      /Suscripciones/,
      "the cap would go on counting against a category nobody can see",
    );
  });
});
