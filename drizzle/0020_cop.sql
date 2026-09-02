-- The Colombian peso, and what deciding a currency actually costs.
--
-- Adding one is a row. But two of its three columns can turn a figure false, and
-- neither would fail:
--
-- `minor_unit` is 2 — which ISO 4217 gives the peso, even though prices are
-- written whole. It matters that it agrees with `MINOR_UNITS` in `money.ts`,
-- which is a SECOND list of the same fact and falls back to 2 for anything it
-- does not know. Storing 0 here while the code assumed 2 would put every peso
-- amount out by a factor of a hundred, silently, in both directions.
--
-- The `symbol` is NOT `$`. The peso's own sign is the dollar's, and this table
-- shows an account's balance beside its equivalent in the base currency: two
-- amounts that are not worth the same would have looked identical. It is the
-- same decision already taken for USDT, and its comment in `money.ts` says why
-- it was taken — there the two indistinguishable balances actually happened.
-- Nothing reads this column today; `formatAmount` falls back to the code, which
-- prints «COP 12.000,00». It is written here so both say the same thing.
--
-- `rate_ages` is true: unlike a stablecoin, the peso moves every day, and a rate
-- from last week has to be flagged as old.
--
-- Only where it is missing, so an installation that already added it keeps
-- whatever it decided.
INSERT INTO "currencies" ("code", "name", "symbol", "minor_unit", "is_crypto", "rate_ages")
SELECT 'COP', 'Peso colombiano', 'COP', 2, false, true
 WHERE NOT EXISTS (SELECT 1 FROM "currencies" WHERE "code" = 'COP');
