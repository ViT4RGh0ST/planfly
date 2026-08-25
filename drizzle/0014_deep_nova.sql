ALTER TABLE "api_tokens" ALTER COLUMN "scopes" SET DEFAULT ARRAY['transactions:write','transactions:read','reports:read','context:read','accounts:write','recurring:write','financing:write','budgets:write']::text[];--> statement-breakpoint
-- Last of the series: with this the bot's token covers everything the screen
-- can do. It is written here, like the earlier ones, because it widens a token
-- already in circulation and that has to show up in the diff.
UPDATE "api_tokens"
   SET "scopes" = array_append("scopes", 'budgets:write')
 WHERE NOT ('budgets:write' = ANY("scopes"))
   AND "revoked_at" IS NULL;
