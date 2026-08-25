import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CADENCE_DAYS, InvalidRecurrenceError, daysFor } from "./recurring";
import { LAST_DAY } from "@/lib/recurrence";

describe("daysFor", () => {
  it("the presets ignore whatever comes from outside", () => {
    // If the screen sends loose days with the cadence set to «monthly», the
    // preset's rule: two sources for the same datum would end up disagreeing.
    assert.deepEqual(daysFor("monthly", [7, 20], "es"), CADENCE_DAYS.monthly);
    assert.deepEqual(daysFor("biweekly", [7], "es"), CADENCE_DAYS.biweekly);
  });

  it("the fortnight is the 15th and the last day", () => {
    assert.deepEqual(CADENCE_DAYS.biweekly, [15, LAST_DAY]);
  });

  it("your own way: sorts, drops duplicates and discards impossible days", () => {
    assert.deepEqual(daysFor("custom", [20, 5, 20, 0, 32, -4], "es"), [5, 20]);
  });

  it("the last day is kept and sorts first", () => {
    assert.deepEqual(daysFor("custom", [10, LAST_DAY], "es"), [LAST_DAY, 10]);
  });

  it("with no valid day at all, nothing is saved", () => {
    // A rule with no days would never fire, and would sit there pretending it would.
    assert.throws(() => daysFor("custom", [], "es"), InvalidRecurrenceError);
    assert.throws(() => daysFor("custom", [0, 99], "es"), InvalidRecurrenceError);
  });
});
