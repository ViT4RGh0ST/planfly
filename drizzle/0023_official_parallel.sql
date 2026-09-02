-- The two rates stop being named after Venezuelan institutions.
--
-- `bcv` is a central bank and `p2p` is a way of trading; what they MEAN is the
-- official rate and the street's, and that pair is the shape of every dual-rate
-- economy — which is what this product is for, not one country. A household in
-- Colombia had columns called `base_amount_bcv_minor` holding pesos valued at a
-- market that has nothing to do with Venezuela's central bank.
--
-- The interface has said «Oficial» and «Paralela» from the first day: the
-- catalogue keys were already `official` and `parallel`. This brings the schema
-- to where the words already were.
--
-- Not numbers — `1` and `2` were considered and refused. What the code decides
-- on is the MEANING: a hand-written rate anchors to one slot or the other, the
-- screen labels them differently, and the API names them. Numbering would make
-- which is which a convention nobody can see, which is the same reason this
-- codebase binds ICU arguments by name and never by position.
--
-- Every statement here is a rename or an in-place update: no table is rewritten
-- and no amount is recomputed. What a row means does not change — only what it
-- is called.

-- The enum, in place. `manual` keeps its name: it is not a market, it is the
-- fact that somebody typed it.
ALTER TYPE "public"."rate_source" RENAME VALUE 'bcv' TO 'official';--> statement-breakpoint
ALTER TYPE "public"."rate_source" RENAME VALUE 'p2p' TO 'parallel';--> statement-breakpoint

-- And the second enum, which says which of the two actually valued each line.
-- It was nearly missed: renaming one and not the other would have left the code
-- with a type saying `official` and another saying `bcv` for the same fact —
-- exactly the divergence this rename exists to remove. `none` stays: it is not
-- a market either, it is the honest hole.
ALTER TYPE "public"."rate_source_used" RENAME VALUE 'bcv' TO 'official';--> statement-breakpoint
ALTER TYPE "public"."rate_source_used" RENAME VALUE 'p2p' TO 'parallel';--> statement-breakpoint

-- The variant column is text, so it does not follow the enum. It is the anchor
-- that says WHICH slot a hand-written rate fills, so leaving it behind would
-- orphan every manual rate: the screen would stop finding them and the day they
-- covered would silently fall back to the automatic figure.
UPDATE "exchange_rates" SET "variant" = 'official' WHERE "variant" = 'bcv';--> statement-breakpoint
UPDATE "exchange_rates" SET "variant" = 'parallel' WHERE "variant" = 'p2p';--> statement-breakpoint

-- The stamped equivalents on every line. Two per entry and two per item, which
-- is the product's thesis made into columns: both answers stored, and the
-- dashboard selector only chooses which one to add up.
ALTER TABLE "transaction_entries" RENAME COLUMN "base_amount_bcv_minor" TO "base_amount_official_minor";--> statement-breakpoint
ALTER TABLE "transaction_entries" RENAME COLUMN "base_amount_p2p_minor" TO "base_amount_parallel_minor";--> statement-breakpoint
ALTER TABLE "transaction_entries" RENAME COLUMN "rate_bcv" TO "rate_official";--> statement-breakpoint
ALTER TABLE "transaction_entries" RENAME COLUMN "rate_p2p" TO "rate_parallel";--> statement-breakpoint
ALTER TABLE "transaction_entries" RENAME COLUMN "rate_bcv_id" TO "rate_official_id";--> statement-breakpoint
ALTER TABLE "transaction_entries" RENAME COLUMN "rate_p2p_id" TO "rate_parallel_id";--> statement-breakpoint

ALTER TABLE "transaction_items" RENAME COLUMN "base_amount_bcv_minor" TO "base_amount_official_minor";--> statement-breakpoint
ALTER TABLE "transaction_items" RENAME COLUMN "base_amount_p2p_minor" TO "base_amount_parallel_minor";--> statement-breakpoint

ALTER TABLE "net_worth_snapshots" RENAME COLUMN "total_bcv_minor" TO "total_official_minor";--> statement-breakpoint
ALTER TABLE "net_worth_snapshots" RENAME COLUMN "total_p2p_minor" TO "total_parallel_minor";
