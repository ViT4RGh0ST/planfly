ALTER TABLE "api_tokens" ALTER COLUMN "scopes" SET DEFAULT ARRAY['transactions:write','transactions:read','reports:read','context:read','accounts:write']::text[];--> statement-breakpoint
-- The default above only reaches tokens created from now on. This is the
-- permission that genuinely lets the Telegram bot open accounts, and it is
-- written here — not by hand in psql — so that it stays in the diff: it widens
-- what a token already in circulation can do.
UPDATE "api_tokens"
   SET "scopes" = array_append("scopes", 'accounts:write')
 WHERE NOT ('accounts:write' = ANY("scopes"))
   AND "revoked_at" IS NULL;
