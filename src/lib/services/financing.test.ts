import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { splitInstallments } from "./financing";

/**
 * Splitting installments is where money is lost without anything failing:
 * dividing and rounding each installment separately leaves cents hanging that do
 * not match the debt, and nobody notices until the last installment fails to
 * settle the plan.
 */
describe("splitInstallments", () => {
  it("splits exactly when it divides evenly", () => {
    assert.deepEqual(splitInstallments(240000, 3), [80000, 80000, 80000]);
  });

  it("the sum is ALWAYS what's owed, even when it doesn't divide", () => {
    for (const total of [240001, 100, 7, 999999, 1234567]) {
      for (const count of [1, 2, 3, 4, 5, 6, 12]) {
        const parts = splitInstallments(total, count);
        assert.equal(
          parts.reduce((a, b) => a + b, 0),
          total,
          `${total} en ${count} cuotas no suma`,
        );
        assert.equal(parts.length, count);
      }
    }
  });

  it("the remainder goes to the first ones, the way any financier does it", () => {
    // 2.400,01 over 3: two of 800,01 and one of 800,00 — never 800,33 × 3.
    assert.deepEqual(splitInstallments(240002, 3), [80001, 80001, 80000]);
  });

  it("no installment is left at zero while there's anything to spread", () => {
    const parts = splitInstallments(5, 5);
    assert.deepEqual(parts, [1, 1, 1, 1, 1]);
  });

  it("a single installment takes it all", () => {
    assert.deepEqual(splitInstallments(123456, 1), [123456]);
  });
});
