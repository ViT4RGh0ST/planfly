-- better-auth 1.7 scopes an account's identity by issuer.
--
-- The upgrade arrived with the MCP work, because @better-auth/mcp requires 1.7,
-- and 1.7 resolves an account by `issuer` + `account_id` instead of by provider.
-- The Drizzle schema did not declare the column, so the adapter refused every
-- write to the table: `npm run db:seed` died on «the field "issuer" does not
-- exist in the "account" Drizzle schema». A fresh installation could not create
-- its first user, and nothing in the test suite goes near the seed.
--
-- Nullable, then backfilled, then NOT NULL. drizzle-kit generated this as a
-- single `ADD COLUMN "issuer" text NOT NULL`, which is correct for an empty
-- table and fails on every installation that has ever logged in.
ALTER TABLE "account" ADD COLUMN "issuer" text;--> statement-breakpoint

-- `local:<provider>` is the synthetic issuer better-auth builds for a provider
-- that has none of its own, so email and password is `local:credential`. Derived
-- from provider_id rather than written out, so an installation carrying another
-- local provider is backfilled correctly too.
UPDATE "account" SET "issuer" = 'local:' || "provider_id" WHERE "issuer" IS NULL;--> statement-breakpoint

ALTER TABLE "account" ALTER COLUMN "issuer" SET NOT NULL;--> statement-breakpoint

-- The pair 1.7 resolves an identity by. Two rows claiming the same identity
-- would make a login answer with whichever one the planner happened to pick.
CREATE UNIQUE INDEX "account_issuer_account_id_key" ON "account" USING btree ("issuer","account_id");
