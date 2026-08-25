import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { installmentSchedule, splitInstallments } from "./installments";

describe("splitInstallments", () => {
  it("loses no cent when it doesn't divide evenly", () => {
    const parts = splitInstallments(240_100, 3);
    assert.deepEqual(parts, [80_034, 80_033, 80_033]);
    assert.equal(parts.reduce((a, b) => a + b, 0), 240_100);
  });

  it("spreads the remainder across the first ones, not onto the last", () => {
    assert.deepEqual(splitInstallments(10, 4), [3, 3, 2, 2]);
  });
});

describe("installmentSchedule", () => {
  it("biweekly: the first one 14 days after the purchase", () => {
    const s = installmentSchedule({
      remainingMinor: 300,
      count: 3,
      frequency: "biweekly",
      purchasedOn: "2026-08-13",
    });
    assert.deepEqual(
      s.map((c) => c.dueOn),
      ["2026-08-27", "2026-09-10", "2026-09-24"],
    );
  });

  it("monthly: 30 days between installments", () => {
    const s = installmentSchedule({
      remainingMinor: 200,
      count: 2,
      frequency: "monthly",
      purchasedOn: "2026-08-13",
    });
    assert.deepEqual(
      s.map((c) => c.dueOn),
      ["2026-09-12", "2026-10-12"],
    );
  });

  it("honours a given first due date", () => {
    const s = installmentSchedule({
      remainingMinor: 100,
      count: 1,
      frequency: "biweekly",
      purchasedOn: "2026-08-13",
      firstDueOn: "2026-08-20",
    });
    assert.equal(s[0].dueOn, "2026-08-20");
  });
});
