ALTER TYPE "public"."entry_source" ADD VALUE 'mcp' BEFORE 'api';--> statement-breakpoint
CREATE TABLE "mcp_pending_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"token_id" uuid NOT NULL,
	"operation" text NOT NULL,
	"payload" jsonb NOT NULL,
	"preview" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mcp_pending_operations" ADD CONSTRAINT "mcp_pending_operations_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_pending_operations" ADD CONSTRAINT "mcp_pending_operations_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_pending_operations" ADD CONSTRAINT "mcp_pending_operations_token_id_api_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."api_tokens"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mcp_pending_operations_lookup_idx" ON "mcp_pending_operations" USING btree ("id","household_id","user_id","token_id");--> statement-breakpoint
CREATE INDEX "mcp_pending_operations_expiry_idx" ON "mcp_pending_operations" USING btree ("expires_at");