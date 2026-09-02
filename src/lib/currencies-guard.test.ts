import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CURRENCIES } from "./currencies";
import { MINOR_UNITS, SYMBOLS, minorUnit } from "./money";

/**
 * That the two places a currency is described never disagree.
 *
 * `money.ts` carries the decimals and the symbol of each currency, and so does
 * the declared list. They cannot be collapsed into one: that file is pure and
 * synchronous — a client component formats amounts with it — and making it read
 * anything asynchronous would drag a database connection into the browser.
 *
 * So there are two, and this is what stops them drifting.
 *
 * **It compares the declared list and NOT the table.** The first version asked
 * the test database, which after `prepareDb()` had exactly one currency in it:
 * the guard passed by comparing one row against itself, which is worse than not
 * existing — it is the same fault `actions-guard` was written about, a test that
 * only looks where something is already known to be.
 */
describe("the currencies", () => {
  it("are described the same way in the list and in money.ts", () => {
    /*
     * The decimals are the half that lies.
     *
     * `minorUnit()` falls back to 2 for a currency it does not know, so one
     * written with zero — the Chilean peso, the yen, the Icelandic króna — would
     * be stored and read with two everywhere while the list said none: every
     * amount out by a factor of a hundred, in both directions, with nothing
     * failing and nothing logged.
     */
    const decimals = CURRENCIES.filter((c) => minorUnit(c.code) !== c.minorUnit).map(
      (c) => `${c.code}: the list says ${c.minorUnit}, money.ts uses ${minorUnit(c.code)}`,
    );
    assert.deepEqual(
      decimals,
      [],
      "add it to MINOR_UNITS in money.ts, or correct the list. A currency whose " +
        "decimals differ between the two is out by a power of ten everywhere, silently.",
    );

    /*
     * The symbol does not lie today — `formatAmount` reads this file's map and
     * nothing reads the column — but two descriptions of one thing that are
     * allowed to differ will differ, and then whoever wires the column up gets a
     * screen that disagrees with itself.
     *
     * The fallback is the code, which is what makes «COP 12.000,00» right with
     * no entry of its own: a currency with no symbol prints its ticker.
     */
    const symbols = CURRENCIES.filter((c) => (SYMBOLS[c.code] ?? c.code) !== c.symbol).map(
      (c) => `${c.code}: the list says «${c.symbol}», money.ts prints «${SYMBOLS[c.code] ?? c.code}»`,
    );
    assert.deepEqual(symbols, [], "the two descriptions of a currency's symbol have to match");
  });

  it("carry nothing in money.ts for a currency that does not exist", () => {
    // The other direction: an entry left behind for a currency never added, or
    // one removed. Harmless in itself — nothing formats a currency no account
    // can be opened in — but it later reads as «this one is supported».
    const declared = new Set(CURRENCIES.map((c) => c.code));
    const orphans = [...new Set([...Object.keys(MINOR_UNITS), ...Object.keys(SYMBOLS)])].filter(
      (code) => !declared.has(code),
    );
    assert.deepEqual(orphans, [], "money.ts describes a currency that is not in the list");
  });

  it("say whether they have an official rate, and only where that is a real question", () => {
    /*
     * `hasOfficial: false` is a claim about a country, not a gap.
     *
     * It says «there is no second rate to look for here», which is what lets the
     * screen show one figure instead of an empty column that reads like a source
     * that failed. Left off, a currency is assumed to have both — which is true
     * of the bolívar and of nothing else so far.
     */
    const base = CURRENCIES.find((c) => c.code === "USD");
    assert.ok(base, "the base currency of the originating case has to be in the list");
    assert.equal(
      CURRENCIES.find((c) => c.code === "COP")?.hasOfficial,
      false,
      "Colombia has one market and no official peso rate to ask for",
    );
  });
});
