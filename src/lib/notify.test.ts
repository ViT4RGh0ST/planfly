import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { notificationsEnabled, notify } from "./notify";

/**
 * The Telegram alert.
 *
 * The only thing that has to be guaranteed here is that it **never takes down
 * whoever called it**. It runs inside the same heartbeat that captures the rates
 * and fires the recurrences, so an exception escaping here takes down things
 * that do write money. It returns a boolean, and that boolean is the whole
 * contract.
 *
 * `fetch` is stubbed and nothing else: delivery is Telegram's, and simulating
 * that whole would only prove the simulation works.
 */
const real = globalThis.fetch;

function withResponse(f: () => Promise<Response>) {
  globalThis.fetch = (async () => f()) as unknown as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = real;
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_CHAT_ID;
  delete process.env.TELEGRAM_HOUSEHOLD_ID;
});

describe("alerting over Telegram", () => {
  it("with no token and no chat, the channel simply doesn't exist", () => {
    assert.equal(notificationsEnabled(), false);
  });

  it("exists only when credentials are bound to a household", () => {
    process.env.TELEGRAM_BOT_TOKEN = "t";
    process.env.TELEGRAM_CHAT_ID = "1";
    assert.equal(notificationsEnabled(), false);

    process.env.TELEGRAM_HOUSEHOLD_ID = "home-a";
    assert.equal(notificationsEnabled(), true);
  });

  it("unconfigured, it tries nothing and reports that it didn't alert", async () => {
    let called = false;
    withResponse(async () => {
      called = true;
      return new Response("{}", { status: 200 });
    });
    assert.equal(await notify("home-a", "hola"), false);
    assert.equal(called, false, "ni siquiera sale a la red");
  });

  it("never delivers one household's alert to another household's chat", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "t";
    process.env.TELEGRAM_CHAT_ID = "1";
    process.env.TELEGRAM_HOUSEHOLD_ID = "home-a";
    let called = false;
    withResponse(async () => {
      called = true;
      return new Response("{}", { status: 200 });
    });

    assert.equal(await notify("home-b", "cuota de mañana"), false);
    assert.equal(called, false);
  });

  it("a delivered alert says so", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "t";
    process.env.TELEGRAM_CHAT_ID = "1";
    process.env.TELEGRAM_HOUSEHOLD_ID = "home-a";
    withResponse(async () => new Response("{}", { status: 200 }));
    assert.equal(await notify("home-a", "cuota de mañana"), true);
  });

  it("Telegram answering 403 is not an exception, it's a false", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "t";
    process.env.TELEGRAM_CHAT_ID = "1";
    process.env.TELEGRAM_HOUSEHOLD_ID = "home-a";
    withResponse(async () => new Response("bot bloqueado", { status: 403 }));
    assert.equal(await notify("home-a", "hola"), false);
  });

  it("and neither is the network going down", async () => {
    // The case that matters: without this catch, a DNS that does not resolve would
    // kill the whole heartbeat and with it the day's recurrences.
    process.env.TELEGRAM_BOT_TOKEN = "t";
    process.env.TELEGRAM_CHAT_ID = "1";
    process.env.TELEGRAM_HOUSEHOLD_ID = "home-a";
    globalThis.fetch = (async () => {
      throw new Error("getaddrinfo ENOTFOUND api.telegram.org");
    }) as unknown as typeof fetch;
    assert.equal(await notify("home-a", "hola"), false);
  });
});
