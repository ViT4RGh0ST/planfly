import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { describeZodIssues, handleError, rejectUnknownKeys, UnknownBodyKeyError } from "./handler";
import { createTransactionSchema } from "../validation";
import type { Locale } from "@/i18n/config";

/** The schema is only used for its `shape`, so the keys are enough. */
const schema = {
  shape: {
    kind: null,
    amount: null,
    currency: null,
    account: null,
    to_account: null,
    category: null,
    occurred_on: null,
  },
};

/** Throws and returns the error, so its suggestion can be inspected. */
function capture(body: unknown): UnknownBodyKeyError {
  try {
    rejectUnknownKeys(body, schema);
  } catch (err) {
    return err as UnknownBodyKeyError;
  }
  throw new Error("a rejection was expected and there was none");
}

describe("rejectUnknownKeys", () => {
  it("lets through a body carrying only known fields", () => {
    assert.doesNotThrow(() =>
      rejectUnknownKeys({ kind: "expense", amount: 500, account: "provincial" }, schema),
    );
  });

  it("rejects the lengthened field and points at the right one", () => {
    // The real case of 17/08/2026: the account travelled as `account_name`, Zod
    // dropped it in silence and the expense ended up in the default account. From
    // "account_name" to "account" is 5 edits, so distance alone did not catch it;
    // what catches it is that the valid one is contained in the one that arrived.
    const err = capture({ amount: 500, account_name: "provincial" });
    assert.equal(err.key, "account_name");
    assert.equal(err.suggestion, "account");
  });

  it("with two valid names contained, the more specific one wins", () => {
    const err = capture({ to_account_id: "zelle" });
    assert.equal(err.suggestion, "to_account");
  });

  it("fixes a typo by edit distance", () => {
    assert.equal(capture({ categoy: "mercado" }).suggestion, "category");
  });

  it("invents no suggestion when nothing is close", () => {
    assert.equal(capture({ zzzz: 1 }).suggestion, null);
  });

  it("the answer lists the valid fields", async () => {
    // It is what lets the caller correct itself on the next attempt instead of
    // trying names one by one, which is how five identical purchases were born.
    //
    // Through `handleError` and not through `err.message`: the error carries the
    // data and the sentence is composed where the language is known, so the list
    // only exists once it has been written out.
    const err = capture({ cuenta: "provincial" });
    for (const locale of ["es", "en"] as const) {
      const body = await handleError(err, locale).json();
      assert.match(body.message, /account/);
      assert.match(body.message, /occurred_on/);
      assert.equal(body.detail.field, "cuenta");
    }
  });

  it("a body that isn't an object doesn't blow up", () => {
    assert.doesNotThrow(() => rejectUnknownKeys(null, schema));
    assert.doesNotThrow(() => rejectUnknownKeys("hola", schema));
  });
});

/**
 * Zod's error, exactly as the model will read it.
 *
 * In Spanish by default because that is what these assertions were written
 * against, and the sentence itself is the product here: it is what the model
 * gets back and what it has to correct itself with. The English side is checked
 * in its own test rather than by rewriting these.
 */
function failure(body: unknown, locale: Locale = "es"): string {
  const r = createTransactionSchema.safeParse(body);
  assert.equal(r.success, false, "it was expected not to validate");
  return describeZodIssues(r.error!, locale);
}

describe("describeZodIssues", () => {
  it("names the missing field instead of saying the body is wrong", () => {
    const msg = failure({ kind: "expense" });
    assert.match(msg, /amount \(falta\)/);
  });

  it("with a bad breakdown, it shows what one line looks like", () => {
    // The real case: a model writes name/price and used to receive "the request
    // body is not the expected shape", which tells it absolutely nothing.
    const msg = failure({ amount: 500, items: [{ name: "PAN", price: 80 }] });
    assert.match(msg, /items\.0\.description \(falta\)/);
    assert.match(msg, /description: "HARINA PAN 1KG", total: 80/);
  });

  it("doesn't dump fifty lines: it cuts and says how many are left", () => {
    const items = Array.from({ length: 10 }, () => ({}));
    const msg = failure({ amount: 500, items });
    assert.match(msg, /y \d+ más/);
  });

  it("says the same thing in English, with the same fields named", () => {
    /*
     * The two sides of the sentence have to carry the same information, and the
     * one that gets lost is never the visible half: it is the field name inside
     * the enumeration. A message that translated «Estos campos están mal» and
     * dropped `items.0.description` still reads like a perfectly good error, and
     * the model on the other end has nothing left to correct.
     */
    const body = { amount: 500, items: [{ name: "PAN", price: 80 }] };
    const en = failure(body, "en");
    assert.match(en, /items\.0\.description \(missing\)/);
    assert.match(en, /description: "HARINA PAN 1KG", total: 80/);
    assert.doesNotMatch(en, /[áéíóúñ¿¡]/);

    // Same fields named in both, whatever the wording around them.
    const fields = (msg: string) => msg.match(/items\.\d+\.\w+/g)?.sort();
    assert.deepEqual(fields(en), fields(failure(body, "es")));
  });
});
