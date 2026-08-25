CREATE TYPE "public"."product_base_unit" AS ENUM('kg', 'l', 'unit');--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"aliases" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"base_unit" "product_base_unit" DEFAULT 'unit' NOT NULL,
	"category_id" uuid,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transaction_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"transaction_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"raw_text" text,
	"quantity" numeric(14, 4) NOT NULL,
	"unit" text,
	"base_quantity" numeric(14, 4) NOT NULL,
	"total_minor" bigint NOT NULL,
	"currency" varchar(10) NOT NULL,
	"base_amount_bcv_minor" bigint,
	"base_amount_p2p_minor" bigint,
	"confidence" numeric(4, 3),
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transaction_items_quantity_positive" CHECK ("transaction_items"."quantity" > 0),
	CONSTRAINT "transaction_items_base_quantity_positive" CHECK ("transaction_items"."base_quantity" > 0),
	CONSTRAINT "transaction_items_total_positive" CHECK ("transaction_items"."total_minor" > 0)
);
--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_items" ADD CONSTRAINT "transaction_items_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_items" ADD CONSTRAINT "transaction_items_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_items" ADD CONSTRAINT "transaction_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_items" ADD CONSTRAINT "transaction_items_currency_currencies_code_fk" FOREIGN KEY ("currency") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "products_slug_unique" ON "products" USING btree ("household_id","slug");--> statement-breakpoint
CREATE INDEX "products_household_idx" ON "products" USING btree ("household_id");--> statement-breakpoint
CREATE INDEX "transaction_items_transaction_idx" ON "transaction_items" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "transaction_items_product_idx" ON "transaction_items" USING btree ("household_id","product_id");