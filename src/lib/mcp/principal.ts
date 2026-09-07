import { and, eq } from "drizzle-orm";
import type { JWTPayload } from "jose";

import { db } from "@/db";
import { householdMembers, households } from "@/db/schema";
import type { Principal } from "@/lib/api-token";

export class McpPrincipalError extends Error {
  constructor(readonly code: "not_member" | "ambiguous_household" | "invalid_token") {
    super(code === "ambiguous_household"
      ? "This account belongs to more than one household; select a household in Planfly before connecting MCP."
      : "This OAuth token is not authorized for a Planfly household.");
  }
}

function scopeList(value: unknown): string[] {
  return typeof value === "string" ? value.split(" ").filter(Boolean) : [];
}

/**
 * OAuth identifies a person and client, but Planfly's authorization boundary is
 * a household. Refuse ambiguous memberships rather than silently picking one.
 * Household selection can later become an explicit OAuth authorization detail.
 */
export async function oauthPrincipal(claims: JWTPayload): Promise<Principal> {
  if (typeof claims.sub !== "string" || !claims.sub) throw new McpPrincipalError("invalid_token");
  if (typeof claims.azp !== "string" || !claims.azp) {
    throw new McpPrincipalError("invalid_token");
  }

  const memberships = await db
    .select({
      householdId: households.id,
      baseCurrency: households.baseCurrency,
      timezone: households.timezone,
      locale: households.locale,
    })
    .from(householdMembers)
    .innerJoin(households, eq(households.id, householdMembers.householdId))
    .where(and(eq(householdMembers.userId, claims.sub)))
    .limit(2);

  if (memberships.length === 0) throw new McpPrincipalError("not_member");
  if (memberships.length > 1) throw new McpPrincipalError("ambiguous_household");

  const membership = memberships[0];
  return {
    tokenId: null,
    credentialId: `oauth:${claims.sub}:${claims.azp}`,
    householdId: membership.householdId,
    userId: claims.sub,
    scopes: scopeList(claims.scope),
    baseCurrency: membership.baseCurrency,
    timezone: membership.timezone,
    locale: membership.locale,
  };
}
