CREATE TYPE "public"."recurrence_cadence" AS ENUM('monthly', 'biweekly', 'custom');--> statement-breakpoint
ALTER TABLE "recurring_rules" ALTER COLUMN "cadence" SET DEFAULT 'monthly'::"public"."recurrence_cadence";--> statement-breakpoint
ALTER TABLE "recurring_rules" ALTER COLUMN "cadence" SET DATA TYPE "public"."recurrence_cadence" USING "cadence"::"public"."recurrence_cadence";--> statement-breakpoint
ALTER TABLE "recurring_rules" ALTER COLUMN "next_run_on" SET DATA TYPE date USING "next_run_on"::date;--> statement-breakpoint
ALTER TABLE "recurring_rules" ADD COLUMN "days_of_month" integer[] NOT NULL;--> statement-breakpoint
ALTER TABLE "recurring_rules" ADD COLUMN "last_run_on" date;--> statement-breakpoint
CREATE INDEX "recurring_rules_due_idx" ON "recurring_rules" USING btree ("next_run_on");--> statement-breakpoint
ALTER TABLE "recurring_rules" DROP COLUMN "day_of_month";--> statement-breakpoint
ALTER TABLE "recurring_rules" ADD CONSTRAINT "recurring_rules_days_not_empty" CHECK (array_length("recurring_rules"."days_of_month", 1) >= 1);