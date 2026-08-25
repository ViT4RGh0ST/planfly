import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

/**
 * That a rate typed by a person is ALWAYS read by the same reader.
 *
 * It is a static test, and that is on purpose. There were three readers for the
 * same figure: `parseRate` on the day's rate, a raw `String()` when recording
 * and a `Number(replace(",", "."))` when correcting. The last two failed in
 * silence — "1.234" valued a Bs. 350 expense at $283,63 with no warning, and
 * "859,00" blew up the whole INSERT — and no unit test saw it, because each
 * reader on its own did what its code said.
 *
 * What has to be guaranteed is not that `parseRate` works — money.test.ts covers
 * that — but that nobody writes a fourth reader.
 */
/** The three places where a person types a rate and planfly stores it. */
const PATHS = [
  "src/lib/services/record-transaction.ts",
  "src/lib/services/update-transaction.ts",
  "src/app/(app)/actions.ts",
];

/**
 * Ledger write services only: there the ONLY figure read from a free field is
 * the rate, so a hand-rolled conversion can only be that.
 *
 * `actions.ts` is deliberately out of this second check: it also converts
 * product quantities and financier fields, which are not rates and do not go
 * through the NUMERIC(24,10) column.
 */
const NO_MANUAL_CONVERSIONS = PATHS.slice(0, 2);

describe("the typed-in rate has exactly one reader", () => {
  for (const file of PATHS) {
    const source = readFileSync(file, "utf8");

    it(`${file} usa parseRate`, () => {
      assert.match(source, /parseRate\(/, `${file} lee una tasa sin parseRate`);
    });

    if (!NO_MANUAL_CONVERSIONS.includes(file)) continue;

    it(`${file} no convierte tasas a mano`, () => {
      // The exact pattern that was there: swap the comma for a dot and trust
      // Number(). With a thousands separator it returns NaN and the correction is lost.
      assert.doesNotMatch(
        source,
        /Number\([^)]*replace\(\s*["'],["']/,
        `${file} vuelve a convertir una cifra a mano en vez de usar parseRate`,
      );
    });
  }
});

/**
 * That nobody hard-wires `isToday` to a fixed value again.
 *
 * `resolveRates` only goes out for the day's rate when `isToday` is true. With a
 * hard-wired `false`, a recurrence due today was valued with yesterday's rate,
 * and if none was stored it threw — and since the error handler advances
 * `next_run_on` anyway, that occurrence was lost forever with no retry.
 */
describe("isToday is computed, never hard-wired", () => {
  const PATHS = [
    "src/lib/services/record-transaction.ts",
    "src/lib/services/update-transaction.ts",
    "src/lib/services/recurring.ts",
    "src/lib/services/financing.ts",
  ];

  for (const file of PATHS) {
    it(`${file} no fija isToday a una constante`, () => {
      const source = readFileSync(file, "utf8");
      assert.doesNotMatch(
        source,
        /isToday:\s*(true|false)\s*,/,
        `${file} cablea isToday en vez de compararlo con el día del hogar`,
      );
    });
  }
});
