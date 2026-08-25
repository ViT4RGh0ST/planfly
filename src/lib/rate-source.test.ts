import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { chooseRateSource } from "./rate-source";

const base = { baseBcvMinor: 417, baseP2pMinor: 363, baseManualMinor: null, fallback: "p2p" as const };

describe("chooseRateSource", () => {
  it("doesn't convert a line already in the household's currency", () => {
    const r = chooseRateSource({ ...base, isBaseCurrency: true });
    assert.deepEqual(r, { source: "none", baseMinor: null });
  });

  it("what was asked for beats the household's preference", () => {
    // It is the fault this came to fix: you typed $40 and converted at BCV, and
    // the history gave you back the figure at P2P.
    const r = chooseRateSource({ ...base, isBaseCurrency: false, preferred: "bcv" });
    assert.deepEqual(r, { source: "bcv", baseMinor: 417 });
  });

  it("with nothing asked for, the household's preference", () => {
    const r = chooseRateSource({ ...base, isBaseCurrency: false });
    assert.deepEqual(r, { source: "p2p", baseMinor: 363 });
  });

  it("a hand-set rate wins when it's asked for", () => {
    const r = chooseRateSource({
      ...base,
      isBaseCurrency: false,
      baseManualMinor: 500,
      preferred: "manual",
    });
    assert.deepEqual(r, { source: "manual", baseMinor: 500 });
  });

  it("falls back to whichever exists when the requested one has no figure", () => {
    const r = chooseRateSource({
      isBaseCurrency: false,
      preferred: "bcv",
      fallback: "bcv",
      baseBcvMinor: null,
      baseP2pMinor: 363,
      baseManualMinor: null,
    });
    assert.deepEqual(r, { source: "p2p", baseMinor: 363 });
  });

  it("with no figure at all it stays unvalued, not zero", () => {
    // A zero would read as "it cost nothing"; `none` is "I don't know", which is
    // different and is what leaves the row flagged for review.
    const r = chooseRateSource({
      isBaseCurrency: false,
      fallback: "p2p",
      baseBcvMinor: null,
      baseP2pMinor: null,
      baseManualMinor: null,
    });
    assert.deepEqual(r, { source: "none", baseMinor: null });
  });

  it("as a last resort it prefers the parallel rate over the official one", () => {
    const r = chooseRateSource({
      isBaseCurrency: false,
      preferred: "manual",
      fallback: "manual",
      baseBcvMinor: 417,
      baseP2pMinor: 363,
      baseManualMinor: null,
    });
    assert.deepEqual(r, { source: "p2p", baseMinor: 363 });
  });
});

describe("chooseRateSource · setting the rate by hand", () => {
  it("asking for 'manual' wins even with automatic rates available", () => {
    // It is what the «Set the rate» button does: whoever presses it is saying the
    // figure for this line is the one they type, not the day's.
    const r = chooseRateSource({
      ...base,
      isBaseCurrency: false,
      preferred: "manual",
      baseManualMinor: 500,
    });
    assert.deepEqual(r, { source: "manual", baseMinor: 500 });
  });

  it("unasked, the inherited one rules even when a manual rate exists", () => {
    /*
     * Documents the behaviour, which is not obvious and was the cause of a real
     * divergence: the row showed one figure and the totals added up another.
     *
     * `preferred` is what the line already carried. If `rate_manual` is written
     * without also saying `rateSource: "manual"`, the inherited source still
     * rules and `rate_source_used` does not change — while the report queries
     * doing COALESCE over the manual column did use it. Whoever sets a rate by
     * hand has to say so explicitly; that is why `overrideRate` sends it.
     */
    const r = chooseRateSource({
      ...base,
      isBaseCurrency: false,
      preferred: "p2p",
      baseManualMinor: 500,
    });
    assert.equal(r.source, "p2p");
  });
});
