import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { eq } from "drizzle-orm";

import { db, pool } from "@/db";
import { transactions } from "@/db/schema";
import { authenticateToken } from "@/lib/api-token";
import { confirmMcpTransaction, previewMcpTransaction } from "./transactions";
import { hasDb, prepareDb } from "@/test/db";
import { seedScenario, tokenFor, type Scenario } from "@/test/fixtures";

const DATE = "2026-08-21";
let scenario: Scenario;
let token: string;

describe("MCP transaction confirmation against the database", { skip: hasDb() ? false : "no Postgres available" }, () => {
  before(async () => {
    await prepareDb();
    scenario = await seedScenario({ date: DATE, bcvRate: "780.0000000000", p2pRate: "900.0000000000" });
    token = await tokenFor(scenario.home, ["mcp:access", "transactions:write"]);
  });
  after(() => pool.end());

  it("does not write until a draft is explicitly confirmed, then stamps MCP provenance", async () => {
    const principal = await authenticateToken(`Bearer ${token}`);
    assert.ok(principal, "the fixture must create a usable scoped token");

    const draft = await previewMcpTransaction(principal, {
      kind: "expense",
      amount: "780,00",
      currency: "VES",
      account: "efectivo",
      category: "mercado",
      occurred_on: DATE,
    });
    assert.equal(draft.preview.dryRun, true);
    assert.equal(
      (await db.select().from(transactions).where(eq(transactions.householdId, scenario.home.id))).length,
      0,
      "a preview must never touch the ledger",
    );

    const saved = await confirmMcpTransaction(principal, draft.confirmationId);
    assert.equal(saved.dryRun, false);
    assert.ok(saved.transactionId);

    const [entry] = await db
      .select({
        source: transactions.source,
        sourceRef: transactions.sourceRef,
        tokenId: transactions.createdViaTokenId,
        userId: transactions.createdByUserId,
      })
      .from(transactions)
      .where(eq(transactions.id, saved.transactionId!));
    assert.deepEqual(entry, {
      source: "mcp",
      sourceRef: draft.confirmationId,
      tokenId: principal.tokenId,
      userId: principal.userId,
    });
  });
});
