import { z } from "zod";

/**
 * The contract of a rate source.
 *
 * planfly does not know where a rate comes from: it knows someone hands it over
 * in this shape. Each installation plugs in its own — its country's central
 * bank, a third-party API, a file it updates by hand — without touching anything
 * else.
 *
 * With no source connected at all planfly is still usable: the day's rate is
 * written by hand in /rates. That is what keeps the project from depending on an
 * integrator existing for a particular country.
 */

/**
 * The product's two rate slots: the official one and the parallel market's.
 *
 * A slot is NOT a source. It is a hole filled with whatever there is: an
 * external module, the built-in reader, or a figure written by hand. That is why
 * the database's `source` column still says where the number came from while the
 * slot says what it is for — and why there is no need to touch the Postgres
 * enum, nor the four `transaction_entries` columns, nor the selector.
 */
export const RATE_SLOTS = ["official", "parallel"] as const;
export type RateSlot = (typeof RATE_SLOTS)[number];


export type RateProviderContext = {
  /** The currency being quoted: "USD" in «859,00 Bs per dollar». */
  base: string;
  /** The currency the price is expressed in: "VES". */
  quote: string;
  /** The household's day, YYYY-MM-DD. */
  date: string;
  /** Time budget. Whoever implements a source must abort when it runs out. */
  timeoutMs: number;
};

const quoteSchema = z.object({
  base: z.string().min(2).max(10),
  quote: z.string().min(2).max(10),
  /** Positive and finite: a zero or a NaN would value an entire net worth at nothing. */
  value: z.number().finite().positive(),
  effectiveOn: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullish(),
  /**
   * Distinguishes two quotes of the same pair, same source and same day: the
   * median and the best price, the buy and the sell. Defaults to "default".
   */
  variant: z.string().min(1).max(40).optional(),
  /**
   * Which of your variants counts for valuing entries. Only needed if you send
   * several of the same pair: without it the first on the list wins.
   *
   * It is not chosen by name on purpose — between "buy" and "sell" there is no
   * answer the application can guess for you.
   */
  preferred: z.boolean().optional(),
});

const readingSchema = z.object({
  capturedAt: z.string().optional(),
  quotes: z.array(z.unknown()),
  raw: z.unknown().optional(),
});

export type RateQuote = z.infer<typeof quoteSchema>;
export type RateReading = { capturedAt?: string; quotes: RateQuote[]; raw?: unknown };

/** What an external module exports, as `default` or as `read`. */
export type RateReader = (
  ctx: RateProviderContext,
) => Promise<RateReading> | RateReading;

export type RateProvider = { id: string; read: RateReader };

/** Already validated. `value` travels as text: never a float into a NUMERIC(24,10). */
export type NormalizedQuote = {
  base: string;
  quote: string;
  value: string;
  effectiveOn: string;
  variant: string;
  preferred: boolean;
};

export class InvalidReadingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidReadingError";
  }
}

/**
 * The trust boundary.
 *
 * What a foreign module returns cannot reach the database raw: this is where an
 * impossible figure is kept out. A bad quote discards itself without taking the
 * others down — if the source publishes five currencies and one comes broken,
 * the other four are good — and it only throws when none is left, because then
 * there is no reading to store.
 */
export function normalizeReading(
  raw: unknown,
  ctx: RateProviderContext,
): NormalizedQuote[] {
  const parsed = readingSchema.safeParse(raw);
  if (!parsed.success) {
    throw new InvalidReadingError(
      "The source did not return { quotes: [...] }. Check that it exports the contract's shape.",
    );
  }

  const good: NormalizedQuote[] = [];
  const bad: string[] = [];

  for (const [i, candidate] of parsed.data.quotes.entries()) {
    const q = quoteSchema.safeParse(candidate);
    if (!q.success) {
      bad.push(`#${i}: ${q.error.issues.map((x) => x.path.join(".") || "?").join(", ")}`);
      continue;
    }
    good.push({
      base: q.data.base.toUpperCase(),
      quote: q.data.quote.toUpperCase(),
      // 10 decimals is the column's scale. Rounding here and not on write leaves
      // the stored value identical to the one that was validated.
      value: q.data.value.toFixed(10),
      effectiveOn: q.data.effectiveOn ?? ctx.date,
      variant: q.data.variant ?? "default",
      preferred: q.data.preferred ?? false,
    });
  }

  if (bad.length > 0) {
    console.warn(`[rates] discarded ${bad.length} invalid quote(s): ${bad.join(" · ")}`);
  }
  if (good.length === 0) {
    throw new InvalidReadingError("The source returned no usable quote.");
  }
  return good;
}
