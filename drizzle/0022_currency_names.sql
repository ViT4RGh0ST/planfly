-- The currency names, in English like the rest of the code.
--
-- They lived in the seed, where Spanish is allowed because the sample accounts
-- and categories are a household's own words. A currency's name is not: it is a
-- standard label, nothing displays it — the screen prints the code beside the
-- balance and the symbol comes from `money.ts` — and the literals guard was
-- right to stop it the moment it moved into `src/`.
--
-- Brought into line so the declared list and the table keep saying the same
-- thing, which is the entire point of there being one list.
UPDATE "currencies" SET "name" = 'US dollar' WHERE "code" = 'USD' AND "name" = 'Dólar estadounidense';--> statement-breakpoint
UPDATE "currencies" SET "name" = 'Venezuelan bolívar' WHERE "code" = 'VES' AND "name" = 'Bolívar';--> statement-breakpoint
UPDATE "currencies" SET "name" = 'Colombian peso' WHERE "code" = 'COP' AND "name" = 'Peso colombiano';
