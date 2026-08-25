import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { NextRequest } from "next/server";

import { hasDb, prepareDb } from "@/test/db";
import { seedScenario, tokenFor, type Scenario } from "@/test/fixtures";
import { pool } from "@/db";

/**
 * The public contract, against the database.
 *
 * It is what whoever connects a bot is going to use, and until now it was only
 * checked with `curl` by hand: every time a scope or an error message changed
 * you had to remember to go through it all again.
 *
 * The handlers are called directly, without starting a server: a Next route is a
 * function from Request to Response, and standing up a server would only add
 * ports and waits to something already callable.
 */
const DATE = "2026-08-21";
let e: Scenario;
let token: string;
let readOnly: string;

function pide(
  url: string,
  init: { method?: string; body?: string; token?: string } = {},
): NextRequest {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (init.token) headers.Authorization = `Bearer ${init.token}`;

  return new NextRequest(`http://planfly.test${url}`, {
    method: init.method,
    body: init.body,
    headers,
  });
}

describe("the v1 API against the database", { skip: hasDb() ? false : "no Postgres available" }, () => {
  before(async () => {
    await prepareDb();
    e = await seedScenario({ date: DATE, bcvRate: "780.0000000000", p2pRate: "900.0000000000" });
    token = await tokenFor(e.home);
    readOnly = await tokenFor(e.home, ["context:read"]);
  });
  after(() => pool.end());

  it("no token, no entry", async () => {
    const { GET } = await import("./context/route");
    const res = await GET(pide("/api/v1/context"));
    assert.equal(res.status, 401);
  });

  it("a token without the scope gets 403, not 401", async () => {
    // The difference matters: 401 sends you to check the token, 403 to check the
    // permissions. Confusing them is half an hour looking in the wrong place.
    const { POST } = await import("./transactions/route");
    const res = await POST(
      pide("/api/v1/transactions", {
        method: "POST",
        token: readOnly,
        body: JSON.stringify({ kind: "expense", amount: 100, account: "efectivo" }),
      }),
    );
    assert.equal(res.status, 403);
    assert.match((await res.json()).message, /permiso/);
  });

  it("context says what exists, so nobody invents names", async () => {
    const { GET } = await import("./context/route");
    const res = await GET(pide("/api/v1/context", { token }));
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.ok(body.accounts.some((a: { name: string }) => a.name === "Efectivo Bs"));
    assert.ok(body.categories.length > 0, "y las categorías, para lo mismo");
  });

  it("recording returns a summary ready to be repeated", async () => {
    const { POST } = await import("./transactions/route");
    const res = await POST(
      pide("/api/v1/transactions", {
        method: "POST",
        token,
        body: JSON.stringify({
          kind: "expense", amount: 7800, currency: "VES",
          account: "efectivo", category: "mercado", occurred_on: DATE,
        }),
      }),
    );
    const body = await res.json();
    assert.equal(res.status, 201);
    assert.match(body.summary, /Bs\. 7\.800,00/, "el resumen viene formateado del servidor");
    assert.equal(body.base.bcvMinor, -1000);
  });

  it("an identity id in the body is rejected", async () => {
    // It is what makes it impossible for an integration to write into another household.
    const { POST } = await import("./transactions/route");
    const res = await POST(
      pide("/api/v1/transactions", {
        method: "POST",
        token,
        body: JSON.stringify({ kind: "expense", amount: 1, account: "efectivo", household_id: "x" }),
      }),
    );
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, "forbidden_field");
  });

  it("an unknown field is rejected by naming the right one", async () => {
    const { POST } = await import("./transactions/route");
    const res = await POST(
      pide("/api/v1/transactions", {
        method: "POST",
        token,
        body: JSON.stringify({ kind: "expense", amount: 1, account_name: "efectivo" }),
      }),
    );
    const body = await res.json();
    assert.equal(body.error, "unknown_field");
    assert.match(body.message, /"account"/);
  });

  it("to_account on an expense comes back as 422 naming the right field, not as 500", async () => {
    const { POST } = await import("./transactions/route");
    const res = await POST(
      pide("/api/v1/transactions", {
        method: "POST",
        token,
        body: JSON.stringify({ kind: "expense", amount: 1, to_account: "efectivo" }),
      }),
    );
    assert.equal(res.status, 422);
    assert.equal((await res.json()).error, "to_account_not_transfer");
  });

  it("a breakdown with made-up names is told what the shape is", async () => {
    const { POST } = await import("./transactions/route");
    const res = await POST(
      pide("/api/v1/transactions", {
        method: "POST",
        token,
        body: JSON.stringify({
          kind: "expense", amount: 100, account: "efectivo",
          items: [{ name: "PAN", price: 80 }],
        }),
      }),
    );
    const body = await res.json();
    assert.equal(res.status, 422);
    assert.match(body.message, /items\.0\.description/);
    assert.match(body.message, /HARINA PAN/, "y enseña una línea entera de ejemplo");
  });

  it("health answers without a token and without saying too much", async () => {
    const { GET } = await import("./health/route");
    const res = await GET();
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.error, undefined, "un mensaje de Postgres lleva usuario y host");
  });
});
