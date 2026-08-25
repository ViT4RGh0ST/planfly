import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { LAST_DAY, daysForMonth, nextOccurrence, occurrencesBetween } from "./recurrence";

describe("daysForMonth", () => {
  it("'last day' resolves to each month's own", () => {
    assert.deepEqual(daysForMonth([LAST_DAY], 2026, 2), [28]);
    assert.deepEqual(daysForMonth([LAST_DAY], 2026, 4), [30]);
    assert.deepEqual(daysForMonth([LAST_DAY], 2026, 1), [31]);
  });

  it("a day that doesn't exist is clamped, not skipped", () => {
    // "The 31st" in February is the 28th. Skipping the month would stop charging the bill.
    assert.deepEqual(daysForMonth([31], 2026, 2), [28]);
  });

  it("leaves no duplicates when two days clamp to the same one", () => {
    // [30, 31] in February would clamp both to the 28th: that would be two entries
    // where there was one.
    assert.deepEqual(daysForMonth([30, 31], 2026, 2), [28]);
  });

  it("2028 is a leap year", () => {
    assert.deepEqual(daysForMonth([LAST_DAY], 2028, 2), [29]);
  });
});

describe("nextOccurrence", () => {
  it("today counts if today is the day", () => {
    assert.equal(nextOccurrence([5], "2026-08-05"), "2026-08-05");
  });

  it("if it already passed, next month", () => {
    assert.equal(nextOccurrence([5], "2026-08-06"), "2026-09-05");
  });

  it("biweekly: the 15th and the last day", () => {
    assert.equal(nextOccurrence([15, LAST_DAY], "2026-08-01"), "2026-08-15");
    assert.equal(nextOccurrence([15, LAST_DAY], "2026-08-16"), "2026-08-31");
    assert.equal(nextOccurrence([15, LAST_DAY], "2026-09-01"), "2026-09-15");
  });

  it("crosses the year boundary", () => {
    assert.equal(nextOccurrence([1], "2026-12-02"), "2027-01-01");
  });

  it("with no days there is no next time", () => {
    assert.equal(nextOccurrence([], "2026-08-01"), null);
  });
});

describe("occurrencesBetween", () => {
  it("catches up on what happened while the machine was off", () => {
    // Two weeks without switching on: both fortnights genuinely happened.
    assert.deepEqual(
      occurrencesBetween([15, LAST_DAY], "2026-08-14", "2026-09-02"),
      ["2026-08-15", "2026-08-31"],
    );
  });

  it("a single day of the month yields one per month", () => {
    assert.deepEqual(
      occurrencesBetween([1], "2026-08-01", "2026-10-15"),
      ["2026-08-01", "2026-09-01", "2026-10-01"],
    );
  });

  it("doesn't repeat the last day of the month", () => {
    assert.deepEqual(
      occurrencesBetween([LAST_DAY], "2026-01-31", "2026-03-31"),
      ["2026-01-31", "2026-02-28", "2026-03-31"],
    );
  });

  it("empty when the range reaches none", () => {
    assert.deepEqual(occurrencesBetween([15], "2026-08-16", "2026-08-31"), []);
  });

  it("clamps to the cap instead of generating hundreds", () => {
    // A rule created with an old date by mistake cannot write a year of entries
    // in one go.
    const many = occurrencesBetween([1], "2020-01-01", "2026-08-15", 5);
    assert.equal(many.length, 5);
  });
});
