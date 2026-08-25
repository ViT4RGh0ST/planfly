import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { P2pResult } from "./binance-p2p";
import { quoteFromP2p, topAds } from "./p2p-quote";

const anuncio = (rate: number, orders = 500) => ({
  nick: `m${rate}`,
  rate,
  orders,
  finishRate: 0.99,
});

const resultado = (rates: number[]): P2pResult => ({
  median: rates[Math.floor(rates.length / 2)],
  best: Math.max(...rates),
  worst: Math.min(...rates),
  adCount: rates.length,
  capturedAt: "2026-08-22T10:00:00.000Z",
  sample: rates.map((r) => anuncio(r)),
});

describe("the rate you'd actually be paid to sell", () => {
  it("uses the first ad, not the median", () => {
    // The filters — minimum orders, completion rate, verified — already excluded
    // the unrealisable ad, which was the reason for using the median.
    const q = quoteFromP2p(resultado([917.01, 916.1, 916, 915, 914]), { base: "USDT", quote: "VES" }, "2026-08-22");
    assert.equal(q.value, 917.01);
    assert.equal(q.variant, "best");
  });

  it("shows five sellers at most", () => {
    const top = topAds(resultado([9, 8, 7, 6, 5, 4, 3, 2, 1]));
    assert.equal(top.length, 5);
    assert.equal(top[0].rate, 9, "and in the order they arrive, which is by what they pay most");
  });

  it("with fewer than five, whatever there is", () => {
    assert.equal(topAds(resultado([9, 8])).length, 2);
  });

  it("with no ads at all it invents no rate", () => {
    // We prefer the honest hole: a figure invented here values the
    // entire net worth.
    assert.throws(
      () => quoteFromP2p(resultado([]), { base: "USDT", quote: "VES" }, "2026-08-22"),
      /No ad passed the filter/,
    );
  });
});
