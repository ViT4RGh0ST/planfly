import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, gt, isNull, or } from "drizzle-orm";

import { db } from "@/db";
import { apiTokens, households } from "@/db/schema";

/**
 * Machine credentials: this is how the openclaw plugin authenticates.
 *
 * A token, and not a header with a shared secret, because:
 *   - it is revoked from the UI without touching code,
 *   - it carries scopes (writing entries ≠ reading reports),
 *   - and above all **it binds to a user and a household**, which is where the
 *     identity of every row the AI writes comes from.
 *
 * That last part is not cosmetic: an openclaw tool receives
 * `execute(toolCallId, params)` and cannot know which Telegram user invoked it.
 * If the household arrived as a parameter, the model could write into the wrong
 * one just by hallucinating an id.
 */

const PREFIX = "plfy_";

export type Principal = {
  tokenId: string;
  householdId: string;
  userId: string;
  scopes: string[];
  baseCurrency: string;
  timezone: string;
  /** The household's language. What the bot answers in, taken from the token. */
  locale: string;
};

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Generates a new token. The plain text is returned ONCE only. */
export function generateToken(): { plain: string; hash: string; prefix: string } {
  const plain = PREFIX + randomBytes(32).toString("base64url");
  return { plain, hash: hashToken(plain), prefix: plain.slice(0, 13) };
}

/**
 * Validates the Authorization header and returns the principal, or null.
 *
 * The comparison runs against the hash and uses `timingSafeEqual`: comparing
 * hashes with `===` leaks information through response time.
 */
export async function authenticateToken(header: string | null): Promise<Principal | null> {
  if (!header) return null;

  const [scheme, value] = header.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !value) return null;
  if (!value.startsWith(PREFIX)) return null;

  const hash = hashToken(value);

  const rows = await db
    .select({
      id: apiTokens.id,
      householdId: apiTokens.householdId,
      userId: apiTokens.userId,
      scopes: apiTokens.scopes,
      tokenHash: apiTokens.tokenHash,
      baseCurrency: households.baseCurrency,
      timezone: households.timezone,
      locale: households.locale,
    })
    .from(apiTokens)
    .innerJoin(households, eq(households.id, apiTokens.householdId))
    .where(
      and(
        eq(apiTokens.tokenHash, hash),
        isNull(apiTokens.revokedAt),
        or(isNull(apiTokens.expiresAt), gt(apiTokens.expiresAt, new Date())),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  const a = Buffer.from(row.tokenHash, "hex");
  const b = Buffer.from(hash, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  // Usage mark, useful for spotting a forgotten token. It does not block the response.
  void db
    .update(apiTokens)
    .set({ lastUsedAt: new Date() })
    .where(eq(apiTokens.id, row.id))
    .catch(() => {});

  return {
    tokenId: row.id,
    householdId: row.householdId,
    userId: row.userId,
    scopes: row.scopes,
    baseCurrency: row.baseCurrency,
    timezone: row.timezone,
    locale: row.locale,
  };
}

export function hasScope(principal: Principal, scope: string): boolean {
  return principal.scopes.includes(scope);
}
