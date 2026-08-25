import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { InvalidAmountError } from "./money";
import { InvalidTransactionError } from "./services/record-transaction";
import { isOwnError, messageForScreen } from "./user-error";

describe("which error a person gets shown", () => {
  it("ours are repeated word for word", () => {
    // They are written to be read: they say what happened and what to do.
    const err = new InvalidTransactionError("No encontré esa cuenta", "account_not_found");
    assert.equal(messageForScreen(err, "es"), "No encontré esa cuenta");
    assert.equal(isOwnError(err), true);
  });

  it("the amount ones are written out from their code", () => {
    /*
     * With a reason that is a real key, not free text.
     *
     * This test used to pass `"es ambiguo"` — a sentence, from before `money.ts`
     * started throwing codes. It is not a key, so `t()` echoed it back as
     * `services.amount.es ambiguo`, the assertion matched on that, and the test
     * would have kept passing with every amount message deleted.
     */
    const err = new InvalidAmountError("1.234", "rateAmbiguous", { suggestion: "1,234" });

    const es = messageForScreen(err, "es");
    assert.match(es, /miles o decimales/);
    assert.match(es, /1,234/, "the suggestion travels");

    const en = messageForScreen(err, "en");
    assert.match(en, /thousands or decimals/);
    assert.doesNotMatch(en, /[áéíóúñ¿¡]/, en);

    // The head says WHICH reading failed: a rate, not an amount.
    assert.match(es, /la tasa/);
    assert.match(en, /the rate/);
  });

  it("a database error is NOT shown", () => {
    /*
     * The case this exists to prevent: a Drizzle failure carries half a kilobyte
     * of SQL with the parameters inside — tables, identifiers and the amounts of
     * the row being written. Whoever reads it can do nothing with that, and it
     * publishes the shape of the database to whoever looks at the screen.
     */
    const drizzle = new Error(
      'Failed query: insert into "transaction_entries" ("id", "amount_minor") values ($1, $2)',
    );
    const seen = messageForScreen(drizzle, "es");
    assert.doesNotMatch(seen, /insert into|transaction_entries|\$1/);
    assert.match(seen, /registro del servidor/);
  });

  it("and neither is something that isn't even an Error", () => {
    assert.match(messageForScreen("algo raro", "es"), /registro del servidor/);
    assert.match(messageForScreen(undefined, "es"), /registro del servidor/);
  });

  it("the fallback is said in the household's language", () => {
    // The only sentence worded here: the rest arrive already written by whoever
    // threw them, in the language they were handed. If this one did not follow
    // the household, an unforeseen failure would answer in English inside a
    // Spanish screen — and it is precisely the sentence nobody tests by hand.
    const drizzle = new Error("Failed query: insert into ...");
    assert.match(messageForScreen(drizzle, "en"), /server log/);
    assert.doesNotMatch(messageForScreen(drizzle, "en"), /[áéíóúñ]/);

    // An unknown language is not an error: it falls back to the default one.
    assert.equal(messageForScreen(drizzle, "pt"), messageForScreen(drizzle, "en"));
  });
});
