CREATE TYPE "public"."account_nature" AS ENUM('asset', 'liability');--> statement-breakpoint
CREATE TYPE "public"."account_type" AS ENUM('cash', 'bank', 'crypto', 'investment', 'credit_card', 'loan', 'other');--> statement-breakpoint
CREATE TYPE "public"."budget_period" AS ENUM('monthly', 'yearly');--> statement-breakpoint
CREATE TYPE "public"."category_kind" AS ENUM('expense', 'income');--> statement-breakpoint
CREATE TYPE "public"."entry_source" AS ENUM('telegram', 'form', 'csv', 'ocr', 'api', 'recurring');--> statement-breakpoint
CREATE TYPE "public"."household_role" AS ENUM('owner', 'member', 'viewer');--> statement-breakpoint
CREATE TYPE "public"."import_row_status" AS ENUM('new', 'duplicate', 'imported', 'skipped', 'error');--> statement-breakpoint
CREATE TYPE "public"."import_status" AS ENUM('pending', 'mapped', 'previewed', 'imported', 'failed');--> statement-breakpoint
CREATE TYPE "public"."rate_source" AS ENUM('bcv', 'p2p', 'manual');--> statement-breakpoint
CREATE TYPE "public"."rate_source_used" AS ENUM('bcv', 'p2p', 'manual', 'none');--> statement-breakpoint
CREATE TYPE "public"."rule_field" AS ENUM('description', 'payee', 'amount');--> statement-breakpoint
CREATE TYPE "public"."rule_operator" AS ENUM('contains', 'equals', 'regex');--> statement-breakpoint
CREATE TYPE "public"."transaction_kind" AS ENUM('expense', 'income', 'transfer', 'adjustment');--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"password" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"prefix" text NOT NULL,
	"scopes" text[] DEFAULT ARRAY['transactions:write','transactions:read','reports:read','context:read']::text[] NOT NULL,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"channel" text NOT NULL,
	"external_id" text NOT NULL,
	"display_name" text,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "household_members" (
	"household_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"role" "household_role" DEFAULT 'member' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "household_members_household_id_user_id_pk" PRIMARY KEY("household_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "households" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"base_currency" varchar(10) DEFAULT 'USD' NOT NULL,
	"default_rate_source" "rate_source" DEFAULT 'p2p' NOT NULL,
	"timezone" text DEFAULT 'America/Caracas' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "currencies" (
	"code" varchar(10) PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"symbol" text NOT NULL,
	"minor_unit" smallint DEFAULT 2 NOT NULL,
	"is_crypto" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "exchange_rates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"base_currency" varchar(10) NOT NULL,
	"quote_currency" varchar(10) NOT NULL,
	"source" "rate_source" NOT NULL,
	"variant" text DEFAULT 'default' NOT NULL,
	"rate" numeric(24, 10) NOT NULL,
	"effective_on" date NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"raw" jsonb
);
--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"type" "account_type" NOT NULL,
	"nature" "account_nature" DEFAULT 'asset' NOT NULL,
	"currency" varchar(10) NOT NULL,
	"opening_balance_minor" bigint DEFAULT 0 NOT NULL,
	"opening_date" date NOT NULL,
	"institution" text,
	"aliases" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"include_in_net_worth" boolean DEFAULT true NOT NULL,
	"color" text,
	"icon" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_opening_balance_safe" CHECK (abs("accounts"."opening_balance_minor") < 9007199254740991)
);
--> statement-breakpoint
CREATE TABLE "categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"kind" "category_kind" NOT NULL,
	"parent_id" uuid,
	"color" text DEFAULT '#64748b' NOT NULL,
	"icon" text,
	"aliases" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "categories_not_own_parent" CHECK ("categories"."parent_id" is distinct from "categories"."id")
);
--> statement-breakpoint
CREATE TABLE "payees" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"default_category_id" uuid,
	"aliases" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transaction_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"transaction_id" uuid NOT NULL,
	"household_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"category_id" uuid,
	"amount_minor" bigint NOT NULL,
	"currency" varchar(10) NOT NULL,
	"base_currency" varchar(10) NOT NULL,
	"rate_bcv" numeric(24, 10),
	"rate_p2p" numeric(24, 10),
	"rate_manual" numeric(24, 10),
	"rate_bcv_id" uuid,
	"rate_p2p_id" uuid,
	"rate_source_used" "rate_source_used" DEFAULT 'none' NOT NULL,
	"rate_stale" boolean DEFAULT false NOT NULL,
	"base_amount_bcv_minor" bigint,
	"base_amount_p2p_minor" bigint,
	"base_amount_manual_minor" bigint,
	"memo" text,
	"sort_order" smallint DEFAULT 0 NOT NULL,
	CONSTRAINT "entries_amount_not_zero" CHECK ("transaction_entries"."amount_minor" <> 0),
	CONSTRAINT "entries_amount_safe" CHECK (abs("transaction_entries"."amount_minor") < 9007199254740991)
);
--> statement-breakpoint
CREATE TABLE "transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"kind" "transaction_kind" NOT NULL,
	"occurred_on" date NOT NULL,
	"occurred_at" timestamp with time zone,
	"description" text NOT NULL,
	"notes" text,
	"payee_id" uuid,
	"source" "entry_source" NOT NULL,
	"source_ref" text,
	"created_by_user_id" text,
	"created_via_token_id" uuid,
	"created_by_agent" text,
	"confidence" numeric(4, 3),
	"needs_review" boolean DEFAULT false NOT NULL,
	"reviewed_at" timestamp with time zone,
	"reviewed_by_id" text,
	"raw" jsonb,
	"attachment_path" text,
	"idempotency_key" text,
	"import_batch_id" uuid,
	"voided_at" timestamp with time zone,
	"void_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transactions_confidence_range" CHECK ("transactions"."confidence" is null or ("transactions"."confidence" >= 0 and "transactions"."confidence" <= 1))
);
--> statement-breakpoint
CREATE TABLE "budgets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	"period" "budget_period" DEFAULT 'monthly' NOT NULL,
	"period_start" date NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" varchar(10) NOT NULL,
	"rollover" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "net_worth_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"snapshot_on" date NOT NULL,
	"base_currency" varchar(10) NOT NULL,
	"total_bcv_minor" bigint,
	"total_p2p_minor" bigint,
	"breakdown" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "categorization_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"field" "rule_field" DEFAULT 'description' NOT NULL,
	"operator" "rule_operator" DEFAULT 'contains' NOT NULL,
	"pattern" text NOT NULL,
	"account_id" uuid,
	"set_category_id" uuid,
	"set_payee_id" uuid,
	"is_active" boolean DEFAULT true NOT NULL,
	"hits" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "import_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"file_name" text NOT NULL,
	"file_hash" text NOT NULL,
	"status" "import_status" DEFAULT 'pending' NOT NULL,
	"mapping" jsonb,
	"stats" jsonb,
	"created_by_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "import_rows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"row_index" integer NOT NULL,
	"raw" jsonb NOT NULL,
	"dedupe_hash" text NOT NULL,
	"status" "import_row_status" DEFAULT 'new' NOT NULL,
	"transaction_id" uuid,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "recurring_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"name" text NOT NULL,
	"template" jsonb NOT NULL,
	"cadence" text NOT NULL,
	"day_of_month" integer,
	"next_run_on" text NOT NULL,
	"estimated_amount_minor" bigint,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_identities" ADD CONSTRAINT "channel_identities_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_identities" ADD CONSTRAINT "channel_identities_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "household_members" ADD CONSTRAINT "household_members_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "household_members" ADD CONSTRAINT "household_members_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_currency_currencies_code_fk" FOREIGN KEY ("currency") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_parent_id_categories_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payees" ADD CONSTRAINT "payees_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payees" ADD CONSTRAINT "payees_default_category_id_categories_id_fk" FOREIGN KEY ("default_category_id") REFERENCES "public"."categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_entries" ADD CONSTRAINT "transaction_entries_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_entries" ADD CONSTRAINT "transaction_entries_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_entries" ADD CONSTRAINT "transaction_entries_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_entries" ADD CONSTRAINT "transaction_entries_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_entries" ADD CONSTRAINT "transaction_entries_rate_bcv_id_exchange_rates_id_fk" FOREIGN KEY ("rate_bcv_id") REFERENCES "public"."exchange_rates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_entries" ADD CONSTRAINT "transaction_entries_rate_p2p_id_exchange_rates_id_fk" FOREIGN KEY ("rate_p2p_id") REFERENCES "public"."exchange_rates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_payee_id_payees_id_fk" FOREIGN KEY ("payee_id") REFERENCES "public"."payees"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_created_via_token_id_api_tokens_id_fk" FOREIGN KEY ("created_via_token_id") REFERENCES "public"."api_tokens"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_reviewed_by_id_user_id_fk" FOREIGN KEY ("reviewed_by_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_currency_currencies_code_fk" FOREIGN KEY ("currency") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "net_worth_snapshots" ADD CONSTRAINT "net_worth_snapshots_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "categorization_rules" ADD CONSTRAINT "categorization_rules_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "categorization_rules" ADD CONSTRAINT "categorization_rules_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "categorization_rules" ADD CONSTRAINT "categorization_rules_set_category_id_categories_id_fk" FOREIGN KEY ("set_category_id") REFERENCES "public"."categories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "categorization_rules" ADD CONSTRAINT "categorization_rules_set_payee_id_payees_id_fk" FOREIGN KEY ("set_payee_id") REFERENCES "public"."payees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_created_by_id_user_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_batch_id_import_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."import_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_rules" ADD CONSTRAINT "recurring_rules_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "api_tokens_hash_unique" ON "api_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "api_tokens_household_idx" ON "api_tokens" USING btree ("household_id");--> statement-breakpoint
CREATE UNIQUE INDEX "channel_identities_unique" ON "channel_identities" USING btree ("channel","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "exchange_rates_unique" ON "exchange_rates" USING btree ("base_currency","quote_currency","source","variant","effective_on");--> statement-breakpoint
CREATE INDEX "exchange_rates_lookup_idx" ON "exchange_rates" USING btree ("quote_currency","source","effective_on" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_slug_unique" ON "accounts" USING btree ("household_id","slug");--> statement-breakpoint
CREATE INDEX "accounts_household_idx" ON "accounts" USING btree ("household_id");--> statement-breakpoint
CREATE UNIQUE INDEX "categories_slug_unique" ON "categories" USING btree ("household_id","slug");--> statement-breakpoint
CREATE INDEX "categories_household_idx" ON "categories" USING btree ("household_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payees_slug_unique" ON "payees" USING btree ("household_id","slug");--> statement-breakpoint
CREATE INDEX "entries_transaction_idx" ON "transaction_entries" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "entries_account_idx" ON "transaction_entries" USING btree ("household_id","account_id");--> statement-breakpoint
CREATE INDEX "entries_category_idx" ON "transaction_entries" USING btree ("household_id","category_id");--> statement-breakpoint
CREATE UNIQUE INDEX "transactions_idempotency_unique" ON "transactions" USING btree ("household_id","idempotency_key") WHERE "transactions"."idempotency_key" is not null;--> statement-breakpoint
CREATE INDEX "transactions_household_date_idx" ON "transactions" USING btree ("household_id","occurred_on" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "transactions_needs_review_idx" ON "transactions" USING btree ("household_id") WHERE "transactions"."needs_review" and "transactions"."voided_at" is null;--> statement-breakpoint
CREATE INDEX "transactions_source_idx" ON "transactions" USING btree ("household_id","source");--> statement-breakpoint
CREATE UNIQUE INDEX "budgets_unique" ON "budgets" USING btree ("household_id","category_id","period","period_start");--> statement-breakpoint
CREATE INDEX "budgets_household_idx" ON "budgets" USING btree ("household_id","period_start");--> statement-breakpoint
CREATE UNIQUE INDEX "net_worth_snapshots_unique" ON "net_worth_snapshots" USING btree ("household_id","snapshot_on");--> statement-breakpoint
CREATE INDEX "categorization_rules_household_idx" ON "categorization_rules" USING btree ("household_id","priority");--> statement-breakpoint
CREATE INDEX "import_batches_household_idx" ON "import_batches" USING btree ("household_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "import_rows_batch_index_unique" ON "import_rows" USING btree ("batch_id","row_index");--> statement-breakpoint
CREATE INDEX "import_rows_dedupe_idx" ON "import_rows" USING btree ("dedupe_hash");--> statement-breakpoint
CREATE INDEX "recurring_rules_household_idx" ON "recurring_rules" USING btree ("household_id","is_active");