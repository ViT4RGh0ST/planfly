export type RateSource = "official" | "parallel" | "manual";
/** `none` is a line already in the household's currency: nothing to convert. */
export type RateSourceUsed = RateSource | "none";

/**
 * Which of the three figures is the true one for this line.
 *
 * Every line stores its equivalent at the official rate, at the parallel one
 * and — if you set it — by hand. `rate_source_used` says which of the three is
 * the one that adds up. Choosing wrong breaks nothing: it just makes the expense
 * worth 14% more or less than it was.
 *
 * It was written twice, in `recordTransaction` and in `updateTransaction`, with
 * the same ladder in a different shape. They agreed, but that is a truce: the
 * day one gains a rung — as just happened with «honour the one the line already
 * had» — recording and correcting would start disagreeing about what the same
 * thing cost, and nothing would fail.
 *
 * The order matters and it is this:
 *
 *   1. If the line is in the household's currency, nothing is converted.
 *   2. What was explicitly asked for, if that figure exists. It is what the
 *      person just did on screen, and it beats any preference.
 *   3. The household's preferred one.
 *   4. Whichever exists. A failing rate never prevents storing; the caller
 *      raises the warning, looking at whether `source` came out `none` with a
 *      foreign currency.
 */
export function chooseRateSource(params: {
  /** Is the line already in the household's currency? */
  isBaseCurrency: boolean;
  /** What was asked: the rate the figure was derived with, or the one the line already had. */
  preferred?: RateSource;
  /** The household's, when none was asked for. */
  fallback: RateSource;
  baseOfficialMinor: number | null;
  baseParallelMinor: number | null;
  baseManualMinor: number | null;
}): { source: RateSourceUsed; baseMinor: number | null } {
  const { baseOfficialMinor: bcv, baseParallelMinor: p2p, baseManualMinor: manual } = params;

  if (params.isBaseCurrency) return { source: "none", baseMinor: null };

  const candidates: Array<[RateSource, number | null]> = [
    ["manual", manual],
    // The parallel one before the official as a last resort: it is the one that
    // genuinely pays, and the one the product puts first everywhere.
    ["parallel", p2p],
    ["official", bcv],
  ];
  const valueOf = (s: RateSource) => candidates.find(([k]) => k === s)?.[1] ?? null;

  for (const wanted of [params.preferred, params.fallback]) {
    if (wanted && valueOf(wanted) != null) {
      return { source: wanted, baseMinor: valueOf(wanted) };
    }
  }

  // A hand-set rate wins by elimination before the automatic ones: if it is
  // there, it is because someone decided it was the truth for this line.
  for (const [source, value] of candidates) {
    if (value != null) return { source, baseMinor: value };
  }

  return { source: "none", baseMinor: null };
}
