import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { NextRequest } from "next/server";

import { hasDb, prepareDb } from "@/test/db";
import { seedScenario, tokenFor, type Scenario } from "@/test/fixtures";
import { db, pool } from "@/db";
import { payees, transactions } from "@/db/schema";
import { eq } from "drizzle-orm";
import { today } from "@/lib/dates";

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

  it("puts a place on an entry that never had one, and refuses a place that is not there", async () => {
    /*
     * The correction is where a place gets put on an entry, because the person
     * remembers afterwards — the service's own comment says so. It has always
     * accepted `payee`; the schema did not declare it, and `rejectUnknownKeys`
     * walks the schema, so no door but the dashboard could ever set one. Eleven
     * entries of a hundred and nine carried a place.
     */
    const { POST } = await import("./transactions/route");
    const created = await POST(
      pide("/api/v1/transactions", {
        method: "POST",
        token,
        body: {
          kind: "expense", amount: "120,00", currency: "VES",
          account: "efectivo", category: "mercado",
          /*
           * Dated TODAY, not `DATE`. The correction window is seven days from
           * now and `DATE` is a fixed day in the past, so an entry stamped with
           * it stops being correctable the moment the calendar walks past it —
           * a test that passes for a week and then breaks at midnight with
           * nothing changed.
           */
          occurred_on: today("America/Caracas"),
          /*
           * `telegram`, because the correction window only reaches what an agent
           * itself recorded — `api` is not in AGENT_EDITABLE_SOURCES. Somebody
           * correcting from a chat is correcting what that chat wrote.
           */
          source: "telegram",
          description: "Compra sin sitio",
        },
      }),
    );
    const { transactionId } = (await created.json()) as { transactionId: string };

    const [place] = await db
      .insert(payees)
      .values({ householdId: e.home.id, name: "Farmatodo", slug: "farmatodo" })
      .returning({ id: payees.id });

    const { PATCH } = await import("./transactions/[id]/route");
    const ok = await PATCH(
      pide(`/api/v1/transactions/${transactionId}`, {
        method: "PATCH", token, body: { payee: "farmatodo" },
      }),
    );
    assert.equal(ok.status, 200, await ok.text());

    const [row] = await db
      .select({ payeeId: transactions.payeeId })
      .from(transactions)
      .where(eq(transactions.id, transactionId));
    assert.equal(row.payeeId, place.id, "the place has to actually land on the entry");

    /*
     * And a name that matches nothing is REFUSED naming it. Leaving the entry as
     * it was would be the door pretending to have understood — the service says
     * exactly that, and this pins that the refusal survives the route.
     */
    const refused = await PATCH(
      pide(`/api/v1/transactions/${transactionId}`, {
        method: "PATCH", token, body: { payee: "una tienda que no existe" },
      }),
    );
    assert.equal(refused.status, 422);
    const body = (await refused.json()) as { error: string; message: string };
    assert.equal(body.error, "payee_not_found");
    assert.match(body.message, /una tienda que no existe/, "the refusal has to name what it looked for");
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

  it("a recurrence that is not there says so, instead of an internal error", async () => {
    // `InvalidRecurrenceError` had no branch in the handler, so every refusal
    // this service words — no days, no name, no such rule — left as a 500 with
    // «Planfly could not complete the request» and nothing to act on.
    const { PATCH } = await import("./recurring/[id]/route");
    const res = await PATCH(
      pide("/api/v1/recurring/00000000-0000-4000-8000-000000000000", {
        method: "PATCH", token, body: { active: false },
      }),
    );

    assert.equal(res.status, 404);
    const body = (await res.json()) as { error: string; message: string };
    assert.equal(body.error, "rule_not_found");
    assert.doesNotMatch(body.message, /no pudo completar/i, "the service's own sentence, not the fallback");
  });

  /**
   * An id from somebody else's household, presented with your own token.
   *
   * The scope checks say what a credential may DO. Nothing in them says what it
   * may do it TO, and every route that takes an opaque id is one `where` clause
   * away from letting a stranger pay your instalment or void your entry. That
   * clause is written by hand in each service, which is exactly the kind of thing
   * that is right in five places and missing in the sixth.
   *
   * The failure would not look like a failure: the id is valid, the token is
   * valid, the row is found, and the answer is 200. It is the shape of mistake
   * this project exists to refuse — nothing breaks, a figure moves.
   *
   * So it is a table, and every route that starts taking an id adds a row to it.
   */
  describe("an id that belongs to another household", { skip: hasDb() ? false : "no Postgres available" }, () => {
    type Ids = { transaction: string; recurrence: string; plan: string; installment: string };
    type Attack = { what: string; call: (ids: Ids) => Promise<Response> };
    let theirs: Ids;

    before(async () => {
      // A whole second household, seeded through the same door as the first: its
      // ids have to be real ones, not strings that were never written anywhere.
      const other = await seedScenario({ date: DATE, bcvRate: "780.0000000000", p2pRate: "900.0000000000" });
      const theirToken = await tokenFor(other.home);

      const tx = await (await import("./transactions/route")).POST(
        pide("/api/v1/transactions", {
          method: "POST", token: theirToken,
          body: { kind: "expense", amount: 50, currency: "VES", account: "efectivo", category: "mercado", occurred_on: DATE },
        }),
      );
      const recurrence = await (await import("./recurring/route")).POST(
        pide("/api/v1/recurring", {
          method: "POST", token: theirToken,
          body: {
            name: "Ajeno", cadence: "custom", days_of_month: [5], kind: "expense",
            amount: "100,00", account: "efectivo", category: "mercado", start_on: DATE,
          },
        }),
      );
      const financed = await (await import("./financing/route")).POST(
        pide("/api/v1/financing", {
          method: "POST", token: theirToken,
          body: {
            financier: "tdc", total: "400,00", down_payment: "0",
            down_payment_account: "efectivo", installments: 2, occurred_on: DATE,
            description: "Ajena a cuotas",
          },
        }),
      );

      // The instalment ids are not in what a purchase returns: they are read
      // back the way the agent reads them, from what is owed.
      const owed = await (await import("./financing/route")).GET(
        pide("/api/v1/financing", { token: theirToken }),
      );

      const txBody = (await tx.json()) as { transactionId?: string };
      const recurrenceBody = (await recurrence.json()) as { id?: string };
      const financedBody = (await financed.json()) as { planId?: string };
      const owedBody = (await owed.json()) as {
        plans?: Array<{ id: string; installments?: Array<{ id: string }> }>;
      };

      theirs = {
        transaction: txBody.transactionId ?? "",
        recurrence: recurrenceBody.id ?? "",
        plan: financedBody.planId ?? "",
        installment: owedBody.plans?.[0]?.installments?.[0]?.id ?? "",
      };

      for (const [name, id] of Object.entries(theirs)) {
        assert.ok(
          typeof id === "string" && id.length > 0,
          `the fixture did not get a real ${name} id, so the attacks below would prove nothing`,
        );
      }
    });

    const attacks = (): Attack[] => [
      {
        what: "correcting their entry",
        call: async (ids) =>
          (await import("./transactions/[id]/route")).PATCH(
            pide(`/api/v1/transactions/${ids.transaction}`, { method: "PATCH", token, body: { amount: "1,00" } }),
          ),
      },
      {
        what: "voiding their entry",
        call: async (ids) =>
          (await import("./transactions/[id]/route")).DELETE(
            pide(`/api/v1/transactions/${ids.transaction}`, { method: "DELETE", token, body: { reason: "no es mía" } }),
          ),
      },
      {
        what: "pausing their recurrence",
        call: async (ids) =>
          (await import("./recurring/[id]/route")).PATCH(
            pide(`/api/v1/recurring/${ids.recurrence}`, { method: "PATCH", token, body: { active: false } }),
          ),
      },
      {
        what: "deleting their recurrence",
        call: async (ids) =>
          (await import("./recurring/[id]/route")).DELETE(
            pide(`/api/v1/recurring/${ids.recurrence}`, { method: "DELETE", token }),
          ),
      },
      {
        what: "paying their instalment",
        call: async (ids) =>
          (await import("./financing/route")).POST(
            pide("/api/v1/financing", {
              method: "POST", token,
              body: { installment_id: ids.installment, from_account: "efectivo", paid_on: DATE },
            }),
          ),
      },
      {
        what: "undoing their instalment",
        call: async (ids) =>
          (await import("./financing/route")).POST(
            pide("/api/v1/financing", {
              method: "POST", token,
              body: { installment_id: ids.installment, undo: true },
            }),
          ),
      },
      {
        what: "voiding their financing plan",
        call: async (ids) =>
          (await import("./financing/route")).POST(
            pide("/api/v1/financing", {
              method: "POST", token,
              body: { plan_id: ids.plan, reason: "no es mío" },
            }),
          ),
      },
    ];

    it("answers exactly as it would for an id that never existed", async () => {
      /*
       * The property is not «it fails»: it is that it fails IDENTICALLY.
       *
       * A refusal that tells «yours but not allowed» apart from «not yours»
       * answers a question the caller was not entitled to ask, and turns every
       * one of these routes into a way of confirming that an id exists
       * somewhere in this installation. So each attack is run twice — once with
       * the neighbour's real id, once with one that was never written anywhere
       * — and the two answers have to match, status and code.
       *
       * That also frees the check from arguing about which number is right: the
       * routes may answer 404 or 422 depending on whether the id came in the
       * path or in the body, and the rule holds either way.
       */
      const invented = "00000000-0000-4000-8000-000000000000";

      for (const attack of attacks()) {
        const real = await attack.call(theirs);
        const realBody = (await real.json()) as { ok?: boolean; error?: string };

        assert.ok(
          !real.ok && realBody.ok !== true,
          `${attack.what} came back ${real.status} ${JSON.stringify(realBody).slice(0, 200)}. ` +
            "A token from one household reached a row in another.",
        );

        const nowhere = await attack.call({
          transaction: invented, recurrence: invented, plan: invented, installment: invented,
        });
        const nowhereBody = (await nowhere.json()) as { error?: string };

        assert.equal(
          `${real.status} ${realBody.error}`,
          `${nowhere.status} ${nowhereBody.error}`,
          `${attack.what} is answered differently for a real id in another household than for ` +
            "one that exists nowhere. That difference is how you find out whose id it is.",
        );
      }
    });
  });
});
