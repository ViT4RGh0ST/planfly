ALTER TABLE "api_tokens" ALTER COLUMN "scopes" SET DEFAULT ARRAY['transactions:write','transactions:read','reports:read','context:read','accounts:write','recurring:write']::text[];--> statement-breakpoint
-- Same as with `accounts:write`: the default above only reaches future tokens.
-- This is what genuinely lets the bot configure recurrences, and it is written
-- here and not by hand in psql because it widens what a token already in
-- circulation can do.
UPDATE "api_tokens"
   SET "scopes" = array_append("scopes", 'recurring:write')
 WHERE NOT ('recurring:write' = ANY("scopes"))
   AND "revoked_at" IS NULL;
