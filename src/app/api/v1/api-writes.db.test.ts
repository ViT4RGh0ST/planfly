import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { NextRequest } from "next/server";

import { hasDb, prepareDb } from "@/test/db";
import { seedScenario, tokenFor, type Scenario } from "@/test/fixtures";
import { pool } from "@/db";

/**
 * The routes that write, against the database.
 *
 * Each opens a whole capability of the product — opening accounts, setting caps,
 * buying in installments, scheduling what repeats — and they are all debuted
 * from a bot, which is what gets the body wrong most often.
 */
const DATE = "2026-08-21";
let e: Scenario;
let token: string;

function pide(url: string, init: { method?: string; body?: unknown; token?: string } = {}) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (init.token) headers.Authorization = `Bearer ${init.token}`;
  return new NextRequest(`http://planfly.test${url}`, {
    method: init.method,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    headers,
  });
}

describe("the routes that write", { skip: hasDb() ? false : "no Postgres available" }, () => {
  before(async () => {
    await prepareDb();
    e = await seedScenario({ date: DATE, bcvRate: "780.0000000000", p2pRate: "900.0000000000" });
    token = await tokenFor(e.home);
  });
  after(() => pool.end());

  it("opening an account makes it reachable by name", async () => {
    const { POST } = await import("./accounts/route");
    const res = await POST(
      pide("/api/v1/accounts", {
        method: "POST",
        token,
        body: { name: "Banco Nuevo", type: "bank", currency: "VES", aliases: "nuevo, banconuevo" },
      }),
    );
    assert.equal(res.status, 201);

    // And the bot finds it by alias without knowing its id, which is the whole point.
    const { POST: registrar } = await import("./transactions/route");
    const r = await registrar(
      pide("/api/v1/transactions", {
        method: "POST", token,
        body: { kind: "expense", amount: 100, currency: "VES", account: "nuevo", occurred_on: DATE },
      }),
    );
    assert.equal((await r.json()).resolved.account.name, "Banco Nuevo");
  });

  it("a duplicate account is rejected by naming the one that already exists", async () => {
    const { POST } = await import("./accounts/route");
    const res = await POST(
      pide("/api/v1/accounts", {
        method: "POST", token,
        body: { name: "Banco Nuevo", type: "bank", currency: "VES" },
      }),
    );
    assert.notEqual(res.status, 201);
    assert.match((await res.json()).message, /Banco Nuevo/);
  });

  it("what the 409 tells the bot to do next is a thing the API accepts", async () => {
    /*
     * The two calls have to be walked together, because each one passed on its
     * own and the pair did not.
     *
     * The 409 says «call again with confirm=true». `confirm` was not declared in
     * the schema, and `rejectUnknownKeys` walks the schema — so the second call
     * came back 400, «I do not know the field confirm». The agent did exactly as
     * it was told, was refused for doing it, and tried again: a closed loop in
     * which the account could never be opened, and nothing in either answer said
     * why. It sat there for days.
     */
    const { POST } = await import("./accounts/route");

    const warned = await POST(
      pide("/api/v1/accounts", {
        method: "POST", token,
        body: { name: "Efectivo COP", type: "cash", currency: "VES" },
      }),
    );
    assert.equal(warned.status, 409);
    const advice = await warned.json();
    assert.match(advice.message, /confirm/, "the 409 has to name the way through");

    const created = await POST(
      pide("/api/v1/accounts", {
        method: "POST", token,
        body: { name: "Efectivo COP", type: "cash", currency: "VES", confirm: true },
      }),
    );
    assert.equal(created.status, 201, "and taking that way through has to work");
  });

  it("a currency this planfly does not have is refused by naming the ones it has", async () => {
    /*
     * The failure this replaces was not a refusal, it was a substitution.
     *
     * The bot carried its own list of currencies in its tool schema, said pesos
     * were unsupported, and then opened the account in bolívares — and when told
     * again, in dollars — suggesting the amounts be converted by hand. An
     * account whose currency is not the money inside it makes every figure it
     * touches false, and nothing downstream notices.
     *
     * Nothing checked the code against the table either, so what came back was a
     * foreign-key error with no answer inside it.
     */
    const { POST } = await import("./accounts/route");
    const res = await POST(
      pide("/api/v1/accounts", {
        method: "POST", token,
        body: { name: "Efectivo Yenes", type: "cash", currency: "JPY", confirm: true },
      }),
    );
    assert.equal(res.status, 422);
    const body = await res.json();
    assert.match(body.message, /JPY/, "it has to name the one it does not know");
    assert.match(body.message, /USD/, "and the ones it does, so the caller can choose");
  });

  it("a made-up account type is rejected", async () => {
    const { POST } = await import("./accounts/route");
    const res = await POST(
      pide("/api/v1/accounts", {
        method: "POST", token,
        body: { name: "Rara", type: "cuenta_magica", currency: "VES" },
      }),
    );
    assert.equal(res.status, 422);
  });

  it("a budget can be set and read back", async () => {
    const { POST, GET } = await import("./budgets/route");
    const res = await POST(
      pide("/api/v1/budgets", {
        method: "POST", token,
        body: { category: "mercado", amount: "250,00", period: "monthly" },
      }),
    );
    assert.equal((await res.json()).ok, true);

    const list = await GET(pide("/api/v1/budgets", { token }));
    const body = await list.json();
    assert.ok(body.budgets.some((b: { category: string }) => b.category === "Mercado"));
  });

  it("a financed purchase returns its schedule", async () => {
    const { POST } = await import("./financing/route");
    const res = await POST(
      pide("/api/v1/financing", {
        method: "POST", token,
        body: {
          financier: "tdc", total: "1.200,00", down_payment: "200,00",
          down_payment_account: "efectivo", installments: 4, occurred_on: DATE,
          description: "Prueba a cuotas",
        },
      }),
    );
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.match(body.summary, /1\.200,00/);
    assert.match(body.summary, /4 cuotas|cuota/);
  });

  it("a recurrence is scheduled without recording anything yet", async () => {
    const { POST } = await import("./recurring/route");
    const res = await POST(
      pide("/api/v1/recurring", {
        method: "POST", token,
        body: {
          name: "Internet", cadence: "custom", days_of_month: [25],
          kind: "expense", amount: "500,00", account: "efectivo", category: "mercado",
          start_on: DATE,
        },
      }),
    );
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.match(body.summary, /Internet/);
  });

  it("reports answer in whichever valuation is asked for", async () => {
    const { GET } = await import("./reports/route");
    const bcv = await (await GET(pide("/api/v1/reports?report=net_worth&valuation=bcv", { token }))).json();
    const p2p = await (await GET(pide("/api/v1/reports?report=net_worth&valuation=p2p", { token }))).json();
    assert.equal(bcv.ok, true);
    assert.notDeepEqual(bcv, p2p, "las dos valuaciones no pueden dar lo mismo");
  });

  it("a report that doesn't exist is rejected instead of coming back empty", async () => {
    const { GET } = await import("./reports/route");
    const res = await GET(pide("/api/v1/reports?report=inventado", { token }));
    assert.equal(res.status, 422);
  });

  it("splitting through the API pulls a line item out of the product it landed in", async () => {
    // Both sides of fuzzy matching live in the same POST, told apart by
    // `raw_text`. It is worth testing from here and not only in the service:
    // whoever splits is usually a bot, and what sends the body is a model.
    const { POST: registrar } = await import("./transactions/route");
    const purchases = [
      ["NECTAR DE MANZANA", "60,00", 743],
      ["NECTAR DE PERA", "65,00", 891],
    ] as const;
    for (const [text, total, monto] of purchases) {
      const rr = await registrar(
        pide("/api/v1/transactions", {
          method: "POST", token,
          body: {
            kind: "expense", amount: monto, currency: "VES", account: "efectivo",
            category: "mercado", occurred_on: DATE, source: "ocr", description: text,
            items: [{ description: text, total }],
          },
        }),
      );
      assert.equal(rr.status, 201, "la compra con desglose entra");
    }

    const { GET, POST } = await import("./products/route");
    const before = await (await GET(pide("/api/v1/products", { token }))).json();
    assert.equal(
      before.products.filter((p: { name: string }) => /NECTAR/i.test(p.name)).length,
      1,
      "los dos néctares cayeron en uno solo",
    );

    // This is where the caller gets the literal text it has to send. Without it
    // it can only invent one, and an invented text splits nothing.
    const detail = await (await GET(pide("/api/v1/products?product=NECTAR DE MANZANA", { token }))).json();
    assert.deepEqual(
      detail.raw_texts.map((r: { text: string }) => r.text).sort(),
      ["NECTAR DE MANZANA", "NECTAR DE PERA"],
    );

    const res = await POST(
      pide("/api/v1/products", {
        method: "POST", token,
        body: { product: "NECTAR DE MANZANA", raw_text: "NECTAR DE PERA" },
      }),
    );
    assert.equal(res.status, 200);
    assert.equal((await res.json()).moved, 1);

    const after = await (await GET(pide("/api/v1/products", { token }))).json();
    assert.equal(
      after.products.filter((p: { name: string }) => /NECTAR/i.test(p.name)).length,
      2,
      "y ahora son dos, cada uno con su serie",
    );

    // And splitting is no longer offered where there is nothing to split.
    const solo = await (await GET(pide("/api/v1/products?product=NECTAR DE PERA", { token }))).json();
    assert.equal(solo.raw_texts, undefined);
  });

  it("splitting a line that isn't there returns the sentence, not a 500", async () => {
    // `InvalidProductError` is worded to be repeated in the chat. Without its
    // branch in `handleError` it would leave through the generic 500 and the bot
    // would have nothing to tell anyone.
    const { POST } = await import("./products/route");
    const res = await POST(
      pide("/api/v1/products", {
        method: "POST", token,
        body: { product: "NECTAR DE MANZANA", raw_text: "PAPEL HIGIENICO" },
      }),
    );
    assert.equal(res.status, 422);
    const body = await res.json();
    assert.equal(body.error, "invalid_product");
    assert.match(body.message, /ninguna línea/i);
  });

  it("a made-up field in split names the right one instead of swallowing it", async () => {
    const { POST } = await import("./products/route");
    const res = await POST(
      pide("/api/v1/products", {
        method: "POST", token,
        body: { product_name: "NECTAR DE MANZANA", raw_text: "NECTAR DE PERA" },
      }),
    );
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.detail.suggestion, "product");
  });
});
