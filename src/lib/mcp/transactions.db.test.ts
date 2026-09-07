import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { eq } from "drizzle-orm";

import { db, pool } from "@/db";
import { mcpPendingOperations, transactions } from "@/db/schema";
import { authenticateToken } from "@/lib/api-token";
import {
  confirmMcpOperation,
  confirmMcpTransaction,
  previewMcpTransaction,
  purgeExpiredConfirmations,
} from "./transactions";
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
        agent: transactions.createdByAgent,
      })
      .from(transactions)
      .where(eq(transactions.id, saved.transactionId!));
    assert.deepEqual(entry, {
      source: "mcp",
      sourceRef: draft.confirmationId,
      tokenId: principal.tokenId,
      userId: principal.userId,
      // Not the string "mcp": WHICH credential. An OAuth client is not a row in
      // `api_tokens`, so without this the entry would name no client at all.
      agent: principal.credentialId,
    });
  });

  it("claims a confirmation before writing so concurrent confirms create one ledger row", async () => {
    const principal = await authenticateToken(`Bearer ${token}`);
    assert.ok(principal, "the fixture must create a usable scoped token");
    const draft = await previewMcpTransaction(principal, {
      kind: "expense",
      amount: "90,00",
      currency: "VES",
      account: "efectivo",
      category: "mercado",
      occurred_on: DATE,
    });

    const attempts = await Promise.allSettled([
      confirmMcpTransaction(principal, draft.confirmationId),
      confirmMcpTransaction(principal, draft.confirmationId),
    ]);
    assert.equal(attempts.filter((attempt) => attempt.status === "fulfilled").length, 1);
    assert.equal(attempts.filter((attempt) => attempt.status === "rejected").length, 1);
    assert.equal(
      (await db.select().from(transactions).where(eq(transactions.sourceRef, draft.confirmationId))).length,
      1,
      "the confirmation id is an idempotency boundary, not merely a UI prompt",
    );
  });

  it("a confirmation can only be used by the credential that created it", async () => {
    /*
     * The confirmation id is a uuid that travels through a model's context, and
     * a model's context is not a secret. What stops it being spent by whoever
     * holds it is that the row is looked up by household, user AND credential at
     * once — so this is the invariant the whole preview/confirm design rests on,
     * and it fails silently if any one of those three drops out of the `where`.
     */
    const mine = await authenticateToken(`Bearer ${token}`);
    assert.ok(mine);

    const draft = await previewMcpTransaction(mine, {
      kind: "expense",
      amount: "50,00",
      currency: "VES",
      account: "efectivo",
      category: "mercado",
      occurred_on: DATE,
    });

    // Another household entirely.
    const stranger = await authenticateToken(
      `Bearer ${await tokenFor((await seedScenario({ date: DATE })).home, ["mcp:access", "transactions:write"])}`,
    );
    assert.ok(stranger);
    await assert.rejects(
      () => confirmMcpTransaction(stranger, draft.confirmationId),
      /not found/i,
      "another household must not be able to spend this confirmation",
    );

    // And a second credential of the SAME household: same money, different key.
    const sibling = await authenticateToken(
      `Bearer ${await tokenFor(scenario.home, ["mcp:access", "transactions:write", "reports:read"])}`,
    );
    assert.ok(sibling);
    assert.equal(sibling.householdId, mine.householdId);
    await assert.rejects(
      () => confirmMcpTransaction(sibling, draft.confirmationId),
      /not found/i,
      "a confirmation is bound to its credential, not merely to the household",
    );

    assert.equal(
      (await db.select().from(transactions).where(eq(transactions.sourceRef, draft.confirmationId))).length,
      0,
      "no refused confirmation may leave a ledger row behind",
    );
  });

  it("will not let one tool confirm another tool's pending operation", async () => {
    /*
     * A credential holds several confirmations at once — a preview the person
     * turned down sits there unclaimed for fifteen minutes — and the row is
     * found by id and credential alone.
     *
     * So a tool handed the wrong id used to run whatever that id was staged for.
     * Its fingerprint passed, because the fingerprint is compared against its
     * own preview; the write went through; and the tool reported it as ITS
     * success. The person declined an expense, said yes to something else, and
     * got the expense written and a sentence about the something else.
     *
     * Every tool that hand-rolled this gate checked the name. Centralising the
     * gate is what dropped it.
     */
    const principal = await authenticateToken(`Bearer ${token}`);
    assert.ok(principal);

    const declined = await previewMcpTransaction(principal, {
      kind: "expense",
      amount: "1.560,00",
      currency: "VES",
      account: "efectivo",
      category: "mercado",
      occurred_on: DATE,
    });

    const before = await db.select().from(transactions);

    await assert.rejects(
      // What planfly_product, planfly_recurring or planfly_financing would send
      // on being handed the id of a transaction preview.
      () => confirmMcpOperation(principal, declined.confirmationId, "merge_products"),
      (error: Error & { code?: string }) => {
        assert.equal(error.code, "not_found");
        // The same sentence as a genuinely missing id: which operation an id was
        // staged for is not something to answer, or the refusal becomes a way to
        // enumerate what else is pending.
        assert.match(error.message, /not found/i);
        return true;
      },
    );

    assert.equal(
      (await db.select().from(transactions)).length,
      before.length,
      "the declined expense was written by a tool asking to confirm something else",
    );

    // And the confirmation is untouched: refused, not consumed.
    const [row] = await db
      .select()
      .from(mcpPendingOperations)
      .where(eq(mcpPendingOperations.id, declined.confirmationId));
    assert.equal(row.confirmedAt, null);

    // Named correctly, it still works.
    const posted = await confirmMcpTransaction(principal, declined.confirmationId);
    assert.equal(posted.dryRun, false);
  });

  it("purges the confirmations that expired and leaves the live one alone", async () => {
    const principal = await authenticateToken(`Bearer ${token}`);
    assert.ok(principal);

    const stale = await previewMcpTransaction(principal, {
      kind: "expense",
      amount: "10,00",
      currency: "VES",
      account: "efectivo",
      category: "mercado",
      occurred_on: DATE,
    });
    const live = await previewMcpTransaction(principal, {
      kind: "expense",
      amount: "11,00",
      currency: "VES",
      account: "efectivo",
      category: "mercado",
      occurred_on: DATE,
    });

    await db
      .update(mcpPendingOperations)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(mcpPendingOperations.id, stale.confirmationId));

    assert.ok((await purgeExpiredConfirmations()) >= 1);

    const left = await db
      .select({ id: mcpPendingOperations.id })
      .from(mcpPendingOperations);
    const ids = left.map((row) => row.id);
    assert.ok(!ids.includes(stale.confirmationId), "the expired one is gone");
    assert.ok(ids.includes(live.confirmationId), "the one still open is untouched");
  });
});
