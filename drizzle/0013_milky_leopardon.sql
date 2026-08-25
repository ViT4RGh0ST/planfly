ALTER TABLE "api_tokens" ALTER COLUMN "scopes" SET DEFAULT ARRAY['transactions:write','transactions:read','reports:read','context:read','accounts:write','recurring:write','financing:write']::text[];--> statement-breakpoint
-- Same as with `accounts:write` and `recurring:write`: the default only reaches
-- future tokens. This lets the bot record installment purchases and pay them,
-- and it is written here because it widens a token in circulation.
UPDATE "api_tokens"
   SET "scopes" = array_append("scopes", 'financing:write')
 WHERE NOT ('financing:write' = ANY("scopes"))
   AND "revoked_at" IS NULL;
