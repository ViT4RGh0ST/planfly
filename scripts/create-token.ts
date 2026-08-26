/**
 * Creates or rotates the API token the openclaw plugin uses.
 *
 *   npm run token:create -- "token-name" [scope,scope,...]
 *
 * With no scopes it comes out with ALL of them, which is convenient for your own
 * bot and dangerous for anything else. `docs/api.md` says «ask only for what the
 * integration is going to use», so there has to be a way to ask for it:
 *
 *   npm run token:create -- read-only context:read,reports:read
 *
 * The plain text is shown ONCE only: only the sha256 stays in the database.
 * After rotating it, put it in ~/.openclaw/openclaw.json
 * (plugins.entries.planfly.config.apiToken) and restart the gateway.
 */
import { and, eq, isNull } from "drizzle-orm";

import { db, pool } from "../src/db";
import { apiTokens, householdMembers, households } from "../src/db/schema";
import { generateToken } from "../src/lib/api-token";

const tokenName = process.argv[2] ?? "openclaw-telegram";

/** The scopes the API recognises. If a new route is added, it goes here. */
const SCOPES = [
  "context:read",
  "transactions:read",
  "transactions:write",
  "reports:read",
  "accounts:write",
  "budgets:write",
  "financing:write",
  "recurring:write",
  /** Gates the MCP HTTP endpoint itself; it is not implied by another scope. */
  "mcp:access",
] as const;

function requestedScopes(): string[] {
  const arg = process.argv[3];
  if (!arg) return [...SCOPES];

  const requested = arg.split(",").map((x) => x.trim()).filter(Boolean);
  const bad = requested.filter((x) => !(SCOPES as readonly string[]).includes(x));
  if (bad.length > 0) {
    throw new Error(
      `I do not know ${bad.join(", ")}. The ones there are: ${SCOPES.join(", ")}.`,
    );
  }
  return requested;
}

async function main() {
  const [household] = await db.select().from(households).limit(1);
  if (!household) throw new Error("There is no household. Run `npm run db:seed` first.");

  const [member] = await db
    .select({ userId: householdMembers.userId })
    .from(householdMembers)
    .where(eq(householdMembers.householdId, household.id))
    .limit(1);
  if (!member) throw new Error("The household has no users.");

  // Revoke earlier ones with the same name: two live tokens for the same client
  // is exactly what makes it impossible to know which to revoke when the time comes.
  const revoked = await db
    .update(apiTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(apiTokens.householdId, household.id),
        eq(apiTokens.name, tokenName),
        isNull(apiTokens.revokedAt),
      ),
    )
    .returning({ id: apiTokens.id });

  if (revoked.length > 0) {
    console.log(`Revoked ${revoked.length} earlier token(s) named "${tokenName}".`);
  }

  const scopes = requestedScopes();
  const { plain, hash, prefix } = generateToken();
  await db.insert(apiTokens).values({
    householdId: household.id,
    userId: member.userId,
    name: tokenName,
    tokenHash: hash,
    prefix,
    scopes,
  });

  if (!process.argv[3]) {
    console.log(
      "\nNOTE: with no scopes requested, this token comes out with ALL of them. To narrow it:\n" +
        `  npm run token:create -- "${tokenName}" context:read,transactions:write`,
    );
  }

  console.log("\n┌──────────────────────────────────────────────────────────────");
  console.log(`│ TOKEN "${tokenName}" (shown only now):`);
  console.log(`│ ${plain}`);
  console.log("│");
  console.log("│ Put it in ~/.openclaw/openclaw.json →");
  console.log("│   plugins.entries.planfly.config.apiToken");
  console.log("│ then:");
  console.log("│   docker compose restart openclaw-gateway   (wherever openclaw lives)");
  console.log("└──────────────────────────────────────────────────────────────\n");
}

main()
  .catch((err) => {
    console.error("Failed:", err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
