CREATE TYPE "public"."financing_frequency" AS ENUM('biweekly', 'monthly');--> statement-breakpoint
CREATE TABLE "financier_profiles" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"household_id" uuid NOT NULL,
	"down_payment_percent" numeric(5, 2),
	"default_installments" integer,
	"default_frequency" "financing_frequency" DEFAULT 'biweekly' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "financier_profiles_percent_range" CHECK ("financier_profiles"."down_payment_percent" IS NULL OR ("financier_profiles"."down_payment_percent" >= 0 AND "financier_profiles"."down_payment_percent" < 100)),
	CONSTRAINT "financier_profiles_installments_positive" CHECK ("financier_profiles"."default_installments" IS NULL OR "financier_profiles"."default_installments" > 0)
);
--> statement-breakpoint
ALTER TABLE "financier_profiles" ADD CONSTRAINT "financier_profiles_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financier_profiles" ADD CONSTRAINT "financier_profiles_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "financier_profiles_household_idx" ON "financier_profiles" USING btree ("household_id");