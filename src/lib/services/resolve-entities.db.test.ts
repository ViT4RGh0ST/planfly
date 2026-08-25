import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { hasDb, prepareDb } from "@/test/db";
import { seedScenario, type Scenario } from "@/test/fixtures";
import { resolveAccount, resolveCategory, REVIEW_THRESHOLD } from "./resolve-entities";
import { pool } from "@/db";

/**
 * Which account and which category the user's words go to.
 *
 * It lives off `pg_trgm` and `unaccent`, meaning its behaviour is in the
 * database and not in TypeScript: a pure test would say nothing. And it is the
 * field that decides which balance moves, so getting it wrong here does not
 * fail, it moves the money somewhere else.
 */
const DATE = "2026-08-21";
let e: Scenario;

describe("resolving accounts and categories", { skip: hasDb() ? false : "no Postgres available" }, () => {
  before(async () => {
    await prepareDb();
    e = await seedScenario({ date: DATE, p2pRate: "900.0000000000" });
  });
  after(() => pool.end());

  it("the exact name matches with certainty", async () => {
    const m = await resolveAccount(e.home.id, "Efectivo Bs");
    assert.equal(m?.id, e.cash.id);
    assert.ok(m!.score >= 0.99, `un nombre exacto no puede dudar, dio ${m!.score}`);
  });

  it("an alias counts as much as the name", async () => {
    // Aliases are what let the bot understand «bolos» without asking.
    const m = await resolveAccount(e.home.id, "bolos");
    assert.equal(m?.id, e.cash.id);
    assert.ok(m!.score >= 0.99);
  });

  it("accentless and uppercase matches just the same", async () => {
    const m = await resolveCategory(e.home.id, "MERCADO", "expense");
    assert.equal(m?.id, e.groceries.id);
  });

  it("a weak resemblance matches but admits it", async () => {
    // The threshold exists so the app can say «I think it is this one». If the
    // resemblance stopped being reported, the review flag would switch itself off.
    const m = await resolveAccount(e.home.id, "efectiv");
    assert.equal(m?.id, e.cash.id);
    assert.ok(m!.score < REVIEW_THRESHOLD, `tenía que quedar por debajo del listón, dio ${m!.score}`);
  });

  it("what resembles nothing returns nothing, not the first one on the list", async () => {
    assert.equal(await resolveAccount(e.home.id, "zzzqqq"), null);
    assert.equal(await resolveCategory(e.home.id, "zzzqqq", "expense"), null);
  });

  it("it finds no accounts from another household", async () => {
    const otro = await seedScenario({ date: DATE });
    const m = await resolveAccount(otro.home.id, "Efectivo Bs");
    assert.notEqual(m?.id, e.cash.id, "cada hogar resuelve contra las suyas");
  });

  it("the amount's currency breaks the tie between similar accounts", async () => {
    // «efectivo» with 350 Bs has to land on the bolívar one, not another.
    const m = await resolveAccount(e.home.id, "efectivo", "VES");
    assert.equal(m?.id, e.cash.id);
  });
});
