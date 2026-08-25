ALTER TYPE "public"."budget_period" ADD VALUE 'biweekly' BEFORE 'yearly';--> statement-breakpoint
ALTER TYPE "public"."budget_period" ADD VALUE 'custom';--> statement-breakpoint
-- In three steps and not one: `ADD COLUMN ... NOT NULL` with no default blows up
-- if the table already has rows. It is added permissive, filled by deriving the
-- end from the period type each budget already had, and only then enforced.
ALTER TABLE "budgets" ADD COLUMN "period_end" date;--> statement-breakpoint
UPDATE "budgets"
   SET "period_end" = CASE
     WHEN "period" = 'yearly' THEN ("period_start" + INTERVAL '1 year')::date
     ELSE ("period_start" + INTERVAL '1 month')::date
   END
 WHERE "period_end" IS NULL;--> statement-breakpoint
ALTER TABLE "budgets" ALTER COLUMN "period_end" SET NOT NULL;
