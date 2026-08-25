CREATE TABLE "financing_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"purchase_transaction_id" uuid NOT NULL,
	"financier_account_id" uuid NOT NULL,
	"description" text NOT NULL,
	"total_minor" bigint NOT NULL,
	"down_payment_minor" bigint DEFAULT 0 NOT NULL,
	"currency" varchar(10) NOT NULL,
	"purchased_on" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "financing_plans_total_positive" CHECK ("financing_plans"."total_minor" > 0),
	CONSTRAINT "financing_plans_down_payment_range" CHECK ("financing_plans"."down_payment_minor" >= 0 AND "financing_plans"."down_payment_minor" <= "financing_plans"."total_minor")
);
--> statement-breakpoint
CREATE TABLE "installments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"due_on" date NOT NULL,
	"amount_minor" bigint NOT NULL,
	"paid_transaction_id" uuid,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "installments_amount_positive" CHECK ("installments"."amount_minor" > 0),
	CONSTRAINT "installments_number_positive" CHECK ("installments"."number" > 0),
	CONSTRAINT "installments_paid_consistent" CHECK (("installments"."paid_transaction_id" IS NULL) = ("installments"."paid_at" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "financing_plans" ADD CONSTRAINT "financing_plans_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financing_plans" ADD CONSTRAINT "financing_plans_purchase_transaction_id_transactions_id_fk" FOREIGN KEY ("purchase_transaction_id") REFERENCES "public"."transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financing_plans" ADD CONSTRAINT "financing_plans_financier_account_id_accounts_id_fk" FOREIGN KEY ("financier_account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financing_plans" ADD CONSTRAINT "financing_plans_currency_currencies_code_fk" FOREIGN KEY ("currency") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "installments" ADD CONSTRAINT "installments_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "installments" ADD CONSTRAINT "installments_plan_id_financing_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."financing_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "installments" ADD CONSTRAINT "installments_paid_transaction_id_transactions_id_fk" FOREIGN KEY ("paid_transaction_id") REFERENCES "public"."transactions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "financing_plans_household_idx" ON "financing_plans" USING btree ("household_id");--> statement-breakpoint
CREATE UNIQUE INDEX "financing_plans_purchase_unique" ON "financing_plans" USING btree ("purchase_transaction_id");--> statement-breakpoint
CREATE INDEX "installments_household_idx" ON "installments" USING btree ("household_id");--> statement-breakpoint
CREATE INDEX "installments_due_idx" ON "installments" USING btree ("household_id","due_on") WHERE paid_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "installments_plan_number_unique" ON "installments" USING btree ("plan_id","number");