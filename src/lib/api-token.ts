import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, gt, isNull, or } from "drizzle-orm";

import { db } from "@/db";
import { apiTokens, householdMembers, households } from "@/db/schema";

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
  /** A revocable machine-token id. OAuth principals intentionally have none. */
  tokenId: string | null;
  /** Stable credential binding for confirmation-gated MCP operations. */
  credentialId: string;
  householdId: string;
  userId: string;
  scopes: string[];
  baseCurrency: string;
  timezone: string;
  /** The household's language. What the bot answers in, taken from the token. */
  locale: string;
  /**
   * What this person may do in the household, which is NOT what the token says.
   *
   * A scope answers «what may this credential do»; the role answers «may this
   * person do it at all». The web has always asked both — `requireWriter()`
   * refuses a viewer — and this path asked only the first, so a token minted for
   * a read-only member wrote the ledger and answered 201. The two doors now
   * agree.
   */
  role: HouseholdRole;
};

export type HouseholdRole = "owner" | "member" | "viewer";

/**
 * The scopes a read-only member may never exercise, whatever the token carries.
 *
 * By suffix rather than by list: the next `something:write` is covered the day
 * it is invented, and a scope that has to be exempted has to be named. A list
 * would silently omit it.
 */
export function isWriteScope(scope: string): boolean {
  return scope.endsWith(":write");
}

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
      role: householdMembers.role,
    })
    .from(apiTokens)
    .innerJoin(households, eq(households.id, apiTokens.householdId))
    /*
     * INNER, so a token whose user is no longer a member of the household stops
     * authenticating at all. Left outer would leave the role null and turn
     * «they were removed» into a question every caller has to remember to ask.
     */
    .innerJoin(
      householdMembers,
      and(
        eq(householdMembers.householdId, apiTokens.householdId),
        eq(householdMembers.userId, apiTokens.userId),
      ),
    )
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
    credentialId: `token:${row.id}`,
    householdId: row.householdId,
    userId: row.userId,
    scopes: row.scopes,
    baseCurrency: row.baseCurrency,
    timezone: row.timezone,
    locale: row.locale,
    role: row.role,
  };
}

/**
 * Whether this principal may exercise a scope — token AND role.
 *
 * The role check lives here, in the one funnel every route and every MCP tool
 * already passes through, and not in each of them: a check repeated per caller
 * is one the next caller forgets, and what it guards is writing to somebody's
 * ledger. A viewer holding `transactions:write` on a token genuinely does not
 * have it, so answering false is the honest answer and not a special case.
 */
export function hasScope(principal: Principal, scope: string): boolean {
  if (!principal.scopes.includes(scope)) return false;
  return !(principal.role === "viewer" && isWriteScope(scope));
}
