import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { natureOf, parseAliases, storedBalance } from "./manage-accounts";

/**
 * A liability's sign is this screen's silent bug: if a card is stored positive,
 * the debt ADDS to net worth and nothing fails — it just gives a cheerful
 * figure. That is why it is tested here and not only against the database.
 */

describe("natureOf — the type decides whether it adds or subtracts", () => {
  it("a credit card and a loan are liabilities", () => {
    assert.equal(natureOf("credit_card"), "liability");
    assert.equal(natureOf("loan"), "liability");
  });

  it("everything else is an asset", () => {
    for (const type of ["cash", "bank", "crypto", "investment", "other"] as const) {
      assert.equal(natureOf(type), "asset");
    }
  });
});

describe("storedBalance — debt is stored negative", () => {
  it("what you owe on a card is stored negative", () => {
    // The interface asks "how much do you owe?" and 3.000 is typed positive.
    assert.equal(storedBalance(300000, "credit_card"), -300000);
    assert.equal(storedBalance(300000, "loan"), -300000);
  });

  it("writing it already negative makes no difference: it's still debt", () => {
    assert.equal(storedBalance(-300000, "credit_card"), -300000);
  });

  it("an asset is stored as-is, even when overdrawn", () => {
    assert.equal(storedBalance(500000, "bank"), 500000);
    assert.equal(storedBalance(-1059798, "cash"), -1059798);
  });

  it("zero has no sign", () => {
    assert.equal(storedBalance(0, "credit_card"), 0);
    assert.equal(storedBalance(0, "bank"), 0);
  });

  it("flipping the sign would move net worth by twice the debt", () => {
    // Net worth adds assets and liabilities as-is, so storing +3.000 instead of
    // -3.000 does not give an error: it gives a 6.000 difference in the total.
    const debt = 300000;
    assert.equal(storedBalance(debt, "credit_card") - debt, -2 * debt);
  });
});

describe("parseAliases — the hints the bot finds the account by", () => {
  it("splits on commas and normalises", () => {
    assert.deepEqual(parseAliases("Provincial, BBVA, Pago Móvil"), [
      "provincial",
      "bbva",
      "pago movil",
    ]);
  });

  it("drops empties and duplicates", () => {
    assert.deepEqual(parseAliases("zelle, , zelle,  ZELLE "), ["zelle"]);
  });

  it("with no aliases it returns an empty list, not null", () => {
    assert.deepEqual(parseAliases(undefined), []);
    assert.deepEqual(parseAliases("   "), []);
  });
});

describe("natureOf · prepaid", () => {
  it("a prepaid card is an ASSET, not debt", () => {
    // It is the mistake that costs dearly: putting it in with the credit ones
    // would subtract from net worth money that is already loaded and is yours.
    assert.equal(natureOf("prepaid"), "asset");
    assert.equal(natureOf("credit_card"), "liability");
  });

  it("its balance is stored as-is, without flipping the sign", () => {
    assert.equal(storedBalance(150_000, "prepaid"), 150_000);
    assert.equal(storedBalance(150_000, "credit_card"), -150_000);
  });
})
