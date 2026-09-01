ALTER TABLE "payees" ADD COLUMN "parent_id" uuid;--> statement-breakpoint
ALTER TABLE "payees" ADD COLUMN "tax_id" text;--> statement-breakpoint
ALTER TABLE "payees" ADD COLUMN "address" text;--> statement-breakpoint
ALTER TABLE "payees" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payees" ADD CONSTRAINT "payees_parent_id_payees_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."payees"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payees_tax_id_idx" ON "payees" USING btree ("household_id","tax_id");--> statement-breakpoint
CREATE INDEX "payees_parent_idx" ON "payees" USING btree ("parent_id");--> statement-breakpoint
ALTER TABLE "payees" ADD CONSTRAINT "payees_not_own_parent" CHECK ("payees"."parent_id" is distinct from "payees"."id");