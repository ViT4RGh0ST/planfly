-- Which currencies have a rate that goes out of date, and which do not.
--
-- `STALE_TOLERANCE_DAYS` was a single constant for every pair, calibrated for
-- the bolívar — a currency that moves every day, which is the reason this whole
-- product exists. Applied to a dollar stablecoin against the dollar it called
-- «old» a rate that cannot age, so every USDT entry landed in the review tray
-- asking to be given, by hand, a number that is always the same one.
--
-- The alternative was a peg written into the code: a SECOND way of answering
-- «what is this worth in the base», beside the rate table that already answers
-- it. Two mechanisms for one question end up disagreeing, and here disagreeing
-- means a false figure. So there is still one mechanism — the rate row, with its
-- date and its provenance — and what this column changes is only whether that
-- row expires.
ALTER TABLE "currencies" ADD COLUMN "rate_ages" boolean DEFAULT true NOT NULL;--> statement-breakpoint

UPDATE "currencies" SET "rate_ages" = false WHERE "code" = 'USDT';--> statement-breakpoint

/*
 * And the row that says why.
 *
 * A currency that does not age still needs its rate: the flag says the figure
 * does not expire, not that it can be left out. Writing it here is not inventing
 * a market price — it is recording the definition that justifies the flag, as
 * `manual`, so it shows its provenance on screen and any day can be overridden
 * by hand if USDT ever comes off its peg.
 *
 * Two rows because a slot is filled per variant: the official and the parallel
 * reading of a stablecoin are the same number, and the interface paints both.
 * Dated far back so it covers the history that is already recorded.
 *
 * Only where there is nothing at all for the pair: an installation that already
 * wrote its own rates keeps them untouched.
 */
INSERT INTO "exchange_rates" ("base_currency", "quote_currency", "source", "variant", "rate", "effective_on", "raw")
SELECT h."base_currency", c."code", 'manual', v.variant, 1, DATE '2000-01-01',
       '{"typedBy":"migration","note":"pegged: a stablecoin against its own currency"}'::jsonb
  FROM "currencies" c
  CROSS JOIN (VALUES ('bcv'), ('p2p')) AS v(variant)
  CROSS JOIN (SELECT DISTINCT "base_currency" FROM "households") h
 WHERE c."rate_ages" = false
   AND c."code" <> h."base_currency"
   AND NOT EXISTS (
     SELECT 1 FROM "exchange_rates" e
      WHERE e."base_currency" = h."base_currency" AND e."quote_currency" = c."code"
   );
