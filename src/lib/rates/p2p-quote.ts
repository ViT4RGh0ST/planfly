import type { P2pResult } from "./binance-p2p";
import type { RateQuote } from "./provider";

/**
 * How many bolívares you get for a USDT, from the ads surviving the filter.
 *
 * The FIRST is taken, not the median. The median was there against the
 * unrealisable ad — sky-high minimum, merchant who never answers — but the
 * filters already exclude that one: minimum order count, completion rate and
 * verified status. With those in place the difference between the first and the
 * median is around 0,3%, and the first is what you will genuinely be paid if you
 * sell right now.
 *
 * And the top five are stored so they can be shown: a rate with no visible
 * provenance is worth less than one you can check.
 */
export const TOP = 5;

export type P2pTop = {
  rate: number;
  orders: number;
  nick: string;
};

export function topAds(result: P2pResult): P2pTop[] {
  return result.sample.slice(0, TOP).map((a) => ({
    rate: a.rate,
    orders: a.orders,
    nick: a.nick,
  }));
}

export function quoteFromP2p(
  result: P2pResult,
  pair: { base: string; quote: string },
  date: string,
): RateQuote {
  const top = topAds(result);
  if (top.length === 0) {
    throw new Error("No ad passed the filter; there is no rate to store.");
  }
  return {
    base: pair.base,
    quote: pair.quote,
    // The first on the list, which already comes sorted by who pays you most.
    value: top[0].rate,
    effectiveOn: date,
    variant: "best",
  };
}
