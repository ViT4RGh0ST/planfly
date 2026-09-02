ALTER TABLE "currencies" ADD COLUMN "has_official" boolean DEFAULT true NOT NULL;--> statement-breakpoint

-- Colombia has one market and no official peso rate to ask for. Saying so is
-- what lets the screen show one figure instead of an empty column that reads
-- like a source that failed.
UPDATE "currencies" SET "has_official" = false WHERE "code" = 'COP';--> statement-breakpoint

-- And the ticker instead of «₮», which is what `money.ts` has always printed.
--
-- Nothing reads this column today, so the two were free to disagree and did.
-- They are one list now — `src/lib/currencies.ts` — and a guard refuses to let
-- them drift again, so the row is brought into line with what the screen shows.
UPDATE "currencies" SET "symbol" = 'USDT' WHERE "code" = 'USDT' AND "symbol" = '₮';
