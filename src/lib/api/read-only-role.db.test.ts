import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { NextRequest } from "next/server";

import { db, pool } from "@/db";
import { apiTokens, householdMembers, transactions, user } from "@/db/schema";
import { generateToken } from "@/lib/api-token";
import { hasDb, prepareDb } from "@/test/db";
import { seedScenario, type Scenario } from "@/test/fixtures";

/**
 * That a read-only member stays read-only through every door.
 *
 * `requireWriter()` has always refused a viewer on the web. The token path asked
 * a different question — «does the token carry the scope» — and never «may this
 * person write at all», because `authenticateToken` joined `households` and not
 * `household_members`. A token bound to a viewer posted an expense and answered
 * 201.
 *
 * It was latent rather than exploitable: tokens are minted from the terminal by
 * whoever administers the machine. But the roles exist, one door enforced them
 * and the other did not, and the fixtures only ever created owners, so nothing
 * looked.
 */
const DATE = "2026-08-21";
let e: Scenario;

describe("a read-only member, through the token door", { skip: hasDb() ? false : "no Postgres available" }, () => {
  before(async () => {
    await prepareDb();
    e = await seedScenario({ date: DATE, p2pRate: "900.0000000000" });
  });
  after(() => pool.end());

  /** A token bound to a member with the given role, carrying whatever scopes. */
  async function tokenAs(role: "owner" | "viewer", scopes: string[]) {
    const id = `u-${role}-${Math.floor(Math.random() * 1e9)}`;
    await db.insert(user).values({
      id, name: role, email: `${id}@planfly.test`, emailVerified: false,
    });
    await db.insert(householdMembers).values({ householdId: e.home.id, userId: id, role });

    const { plain, hash, prefix } = generateToken();
    await db.insert(apiTokens).values({
      householdId: e.home.id, userId: id, name: id, tokenHash: hash, prefix, scopes,
    });
    return plain;
  }

  function spend(token: string) {
    return new NextRequest("http://planfly.test/api/v1/transactions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        kind: "expense", amount: "100,00", currency: "VES",
        account: "efectivo", category: "mercado", occurred_on: DATE,
      }),
    });
  }

  it("cannot write, however wide the token it was given", async () => {
    const { POST } = await import("@/app/api/v1/transactions/route");
    const before = (await db.select({ id: transactions.id }).from(transactions)).length;

    // The token plainly carries transactions:write. The person may not.
    const response = await POST(spend(await tokenAs("viewer", ["transactions:write"])));

    assert.equal(response.status, 403, "a viewer's token wrote the ledger");
    const body = (await response.json()) as { message: string };
    /*
     * And it says WHICH refusal this is. «You lack transactions:write» about a
     * token that carries it sends whoever reads it to mint a wider one, which
     * would be refused too: the recovery is a different one.
     */
    assert.match(body.message, /solo lectura|read-only/i, `unhelpful refusal: ${body.message}`);

    assert.equal(
      (await db.select({ id: transactions.id }).from(transactions)).length,
      before,
      "nothing may have been written",
    );
  });

  it("still reads everything its scopes allow", async () => {
    // The point is not to lock a viewer out. It is that they look and do not touch.
    const { GET } = await import("@/app/api/v1/context/route");
    const token = await tokenAs("viewer", ["context:read"]);
    const response = await GET(
      new NextRequest("http://planfly.test/api/v1/context", {
        headers: { Authorization: `Bearer ${token}` },
      }),
    );
    assert.equal(response.status, 200, "a viewer must still be able to look");
  });

  it("lets a member who may write, write", async () => {
    // Or the guard above would pass by refusing everybody.
    const { POST } = await import("@/app/api/v1/transactions/route");
    const response = await POST(spend(await tokenAs("owner", ["transactions:write"])));
    assert.equal(response.status, 201);
  });
});
