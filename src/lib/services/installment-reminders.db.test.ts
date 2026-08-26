import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { hasDb, prepareDb } from "@/test/db";
import { seedScenario, type Scenario } from "@/test/fixtures";
import { sendDueInstallmentReminders } from "./installment-reminders";
import { recordFinancedPurchase } from "./financing";
import { addDays, today } from "@/lib/dates";
import { pool } from "@/db";

/**
 * Installment reminders, against the database.
 *
 * They run on the heartbeat, without anyone asking. What has to be guaranteed
 * here is not that they arrive — that depends on an outside service — but that
 * they **neither fall over nor block the heartbeat**: the recurrences and the
 * rate capture run on the same tick, so an exception here takes down things that
 * do write money.
 */
const DATE = "2026-08-21";
let e: Scenario;

describe("installment reminders", { skip: hasDb() ? false : "no Postgres available" }, () => {
  before(async () => {
    await prepareDb();
    e = await seedScenario({ date: DATE, p2pRate: "900.0000000000" });
  });
  after(() => pool.end());

  it("with no channel configured it sends nothing and doesn't complain", async () => {
    // It is any installation's default case: nobody has set up a bot.
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;
    delete process.env.TELEGRAM_HOUSEHOLD_ID;
    assert.equal(await sendDueInstallmentReminders(), 0);
  });

  it("with installments pending it still doesn't break the heartbeat", async () => {
    await recordFinancedPurchase({
      householdId: e.home.id, financier: "tdc",
      total: "1.000,00", installmentCount: 3, occurredOn: DATE,
      description: "Con avisos", source: "form",
    });
    // Still no channel: what is checked is that walking real installments does
    // not throw. If it did, the tick would die before the recurrences.
    assert.equal(await sendDueInstallmentReminders(), 0);
  });

  /*
   * With a channel configured, stubbing ONLY the `fetch`.
   *
   * What is tested is the selection and the idempotency, which are ours; that
   * Telegram delivers the message is not, and a test simulating that whole would
   * only prove the simulation works.
   *
   * Idempotency is what genuinely has to be pinned: the heartbeat passes several
   * times a day, and without `reminded_on` the same installment would warn on
   * every pass.
   */
  async function withChannel(fn: () => Promise<number>) {
    const fetchReal = globalThis.fetch;
    const sent: string[] = [];
    process.env.TELEGRAM_BOT_TOKEN = "prueba:token";
    process.env.TELEGRAM_CHAT_ID = "1";
    process.env.TELEGRAM_HOUSEHOLD_ID = e.home.id;
    globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
      sent.push(JSON.parse(init?.body ?? "{}").text ?? "");
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    try {
      return { n: await fn(), sent };
    } finally {
      globalThis.fetch = fetchReal;
      delete process.env.TELEGRAM_BOT_TOKEN;
      delete process.env.TELEGRAM_CHAT_ID;
      delete process.env.TELEGRAM_HOUSEHOLD_ID;
    }
  }

  it("warns the day BEFORE it's due, and only once even if the heartbeat repeats", async () => {
    // One day's notice is just enough to move money. Warning on the day is too
    // late for that, and warning earlier gets forgotten.
    const tomorrow = addDays(today("America/Caracas"), 1);
    await recordFinancedPurchase({
      householdId: e.home.id, financier: "tdc",
      total: "600,00", installmentCount: 1, firstDueOn: tomorrow,
      occurredOn: DATE, description: "Vence mañana", source: "form",
    });

    const first = await withChannel(() => sendDueInstallmentReminders());
    assert.equal(first.n, 1, "sale un aviso");
    assert.match(first.sent[0], /Vence mañana/, "y nombra la compra");

    // The heartbeat passes again on the same day: it cannot warn twice.
    const second = await withChannel(() => sendDueInstallmentReminders());
    assert.equal(second.n, 0, "idempotente por día: `reminded_on` ya está puesto");
  });

  it("an installment due in a week isn't warned about yet", async () => {
    const far = addDays(today("America/Caracas"), 7);
    await recordFinancedPurchase({
      householdId: e.home.id, financier: "tdc",
      total: "900,00", installmentCount: 1, firstDueOn: far,
      occurredOn: DATE, description: "Vence la semana que viene", source: "form",
    });
    const r = await withChannel(() => sendDueInstallmentReminders());
    assert.equal(r.n, 0, "avisar con una semana de antelación es ruido, no aviso");
  });
});
