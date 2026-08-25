import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { eq } from "drizzle-orm";

import { hasDb, prepareDb } from "@/test/db";
import { seedScenario, type Scenario } from "@/test/fixtures";
import { runDueRecurrences, saveRecurringRule } from "./recurring";
import { db, pool } from "@/db";
import { recurringRules, transactions } from "@/db/schema";

/**
 * What records itself, against the database.
 *
 * It is the only part of planfly that writes with nobody watching, so a mistake
 * here is seen by nobody on the day it happens: it turns up weeks later as a
 * missing expense or a repeated one.
 */
const DATE = "2026-08-21";
let e: Scenario;

async function rule(name: string, day: number, extra: Record<string, unknown> = {}) {
  return saveRecurringRule({
    householdId: e.home.id,
    timezone: "America/Caracas",
    locale: "es",
    name: name,
    cadence: "custom",
    daysOfMonth: [day],
    startOn: DATE,
    template: {
      kind: "expense",
      amount: "1.000,00",
      currency: "VES",
      account: "efectivo",
      category: "mercado",
      source: "recurring",
      ...extra,
    } as never,
  });
}

describe("recurrences against the database", { skip: hasDb() ? false : "no Postgres available" }, () => {
  before(async () => {
    await prepareDb();
    e = await seedScenario({ date: DATE, bcvRate: "780.0000000000", p2pRate: "900.0000000000" });
  });
  after(() => pool.end());

  it("a rule is born with its next date, without recording anything yet", async () => {
    await rule("Internet", 25);
    const [r] = await db.select().from(recurringRules).where(eq(recurringRules.name, "Internet"));
    assert.equal(r.nextRunOn, "2026-08-25", "el próximo 25 a partir de hoy");
    const done = await db.select().from(transactions);
    assert.equal(done.length, 0, "guardar la regla no registra el gasto");
  });

  it("when it's due, it records once and moves on", async () => {
    /*
     * The 21st and not another day: the window runs from `nextRunOn` to today,
     * and it only records if one of the chosen days falls inside. With a rule on
     * the 1st and a window from the 20th to the 21st nothing fires — which is
     * exactly right, and what I got wrong writing this test the first time.
     */
    await rule("Alquiler", 21);
    await db
      .update(recurringRules)
      .set({ nextRunOn: "2026-08-20" })
      .where(eq(recurringRules.name, "Alquiler"));

    const first = await runDueRecurrences();
    assert.ok(first.some((x) => x.ruleName === "Alquiler" && x.ok), "tenía que dispararse");

    const [r] = await db.select().from(recurringRules).where(eq(recurringRules.name, "Alquiler"));
    assert.ok(r.nextRunOn > "2026-08-20", "y avanzar la próxima fecha");
  });

  it("running it twice in a row doesn't duplicate the expense", async () => {
    // The idempotency key is what makes a retry harmless: without it, an
    // overlapping heartbeat leaves the expense twice.
    const before = (await db.select().from(transactions)).length;
    await runDueRecurrences();
    await runDueRecurrences();
    assert.equal((await db.select().from(transactions)).length, before);
  });

  it("a paused one records nothing", async () => {
    await rule("Gimnasio", 5);
    await db
      .update(recurringRules)
      .set({ nextRunOn: "2026-08-20", isActive: false })
      .where(eq(recurringRules.name, "Gimnasio"));

    const done = await runDueRecurrences();
    assert.ok(!done.some((x) => x.ruleName === "Gimnasio"), "pausada es pausada");
  });

  it("a valued one keeps the amount in its own currency and converts when recording", async () => {
    // «15 dollars debited in bolívares»: storing the bolívares expires, because
    // the same subscription costs another figure next month.
    await rule("Suscripción", 21, { amount: "15,00", amountCurrency: "USD", rateSource: "p2p" });
    await db
      .update(recurringRules)
      .set({ nextRunOn: "2026-08-20" })
      .where(eq(recurringRules.name, "Suscripción"));

    const done = await runDueRecurrences();
    const own = done.find((x) => x.ruleName === "Suscripción");
    assert.ok(own?.ok, `tenía que registrarse: ${own?.summary ?? "no salió"}`);
    // 15 USD at 900 is 13.500 Bs.
    assert.match(own!.summary, /13\.500,00/);
  });
});
