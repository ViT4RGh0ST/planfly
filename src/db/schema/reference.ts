import {
  boolean,
  date,
  index,
  jsonb,
  numeric,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { rateSourceEnum } from "./enums";

export const currencies = pgTable("currencies", {
  // varchar(10) and not char(3): "USDT" has four characters.
  code: varchar("code", { length: 10 }).primaryKey(),
  name: text("name").notNull(),
  symbol: text("symbol").notNull(),
  /** Decimals of the minor unit. See src/lib/money.ts. */
  minorUnit: smallint("minor_unit").notNull().default(2),
  isCrypto: boolean("is_crypto").notNull().default(false),
  /**
   * Whether this currency's rate against the base goes out of date.
   *
   * `true` for anything that moves — the bolívar moves every day, which is why
   * the whole product exists. `false` for a currency that is worth what it is
   * worth by construction: a dollar stablecoin against the dollar.
   *
   * It exists so that ONE mechanism keeps answering «what is this worth in the
   * base»: the rate row, with its date and its provenance. Without it the only
   * way out was a second conversion path — a peg written into the code — and two
   * ways of answering the same question end up disagreeing, which here means a
   * false figure.
   *
   * It does not make the rate optional: a currency that does not age still needs
   * its row, written once, and any day can be overridden by hand.
   */
  rateAges: boolean("rate_ages").notNull().default(true),
  /**
   * Whether an official rate exists for it at all.
   *
   * The product's shape is two answers at once — what the state says and what
   * the street says — and that is the shape of Venezuela. Colombia has one
   * market for the peso and no official figure to ask for. Without this the
   * screen shows an empty official column beside the real one, which reads like
   * a source that failed rather than a question that does not exist there.
   *
   * It defaults to true because the bolívar is the case the product was written
   * for, and because assuming a currency has both is the assumption that shows
   * a hole rather than the one that hides a figure.
   */
  hasOfficial: boolean("has_official").notNull().default(true),
});

/**
 * Rate history, one row per (pair, source, day).
 *
 * `rate` is **quoted per base**: how many units of `quoteCurrency` 1 of
 * `baseCurrency` costs. For USD→VES, 859.00 means 859 Bs per dollar. Storing the
 * reciprocal would lose precision, and confusing the direction gives a number
 * ~738,000 times off — there is a test pinning it.
 *
 * NUMERIC(24,10) and not an integer of minor units: a rate is a ratio, not
 * money. The BCV publishes 8 decimals (481,21770000) and there is margin to spare.
 */
export const exchangeRates = pgTable(
  "exchange_rates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    baseCurrency: varchar("base_currency", { length: 10 }).notNull(), // 'USD'
    quoteCurrency: varchar("quote_currency", { length: 10 }).notNull(), // 'VES'
    source: rateSourceEnum("source").notNull(),
    /** Shade of the source: 'median', 'provincial', 'official'… */
    variant: text("variant").notNull().default("default"),
    rate: numeric("rate", { precision: 24, scale: 10 }).notNull(),
    /** Value date: the one the BCV publishes, or the capture day for P2P. */
    effectiveOn: date("effective_on").notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
    /** Raw response from the source, so an odd rate can be audited months later. */
    raw: jsonb("raw"),
  },
  (t) => [
    uniqueIndex("exchange_rates_unique").on(
      t.baseCurrency,
      t.quoteCurrency,
      t.source,
      t.variant,
      t.effectiveOn,
    ),
    index("exchange_rates_lookup_idx").on(t.quoteCurrency, t.source, t.effectiveOn.desc()),
  ],
);
