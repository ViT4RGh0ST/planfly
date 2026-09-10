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
 * After rotating it, put it in ~/.openclaw/openclaw.json as the Authorization
 * header of the `planfly` MCP server, and restart the gateway.
 */
import { and, eq, isNull } from "drizzle-orm";

import { db, pool } from "../src/db";
import { apiTokens, householdMembers, households } from "../src/db/schema";
import { generateToken } from "../src/lib/api-token";

const tokenName = process.argv[2] ?? "openclaw-telegram";

/**
 * What each scope actually reaches, in the words of somebody about to grant it.
 *
 * Printed beside the token. A scope name says what a developer means; this says
 * what is being handed over.
 */
const WHAT_A_SCOPE_REACHES: Record<string, string> = {
  "context:read": "see your accounts, categories and the day's rates",
  "transactions:read": "read what you have recorded",
  "transactions:write": "record and correct entries",
  "reports:read": "read your balances, spending and net worth",
  "accounts:write": "open, rename and archive accounts",
  "budgets:write": "set and remove spending caps",
  "financing:write": "record instalment purchases and pay them",
  "recurring:write": "set up entries that record themselves",
  "rates:write": "add currencies and write rates by hand, for everyone on this planfly",
  "mcp:access": "enter the MCP endpoint at all",
};

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
  /*
   * Reference data, and the only scope here that is not scoped to a household.
   *
   * `currencies` and `exchange_rates` have no household column: they belong to
   * the installation. Granting this is granting «decide with what this planfly
   * values everything», which is why it is its own scope and not folded into
   * accounts:write.
   */
  "rates:write",
  /*
   * Entering /api/mcp at all.
   *
   * `npm run mcp:token` asked for it and this list refused it, so the script
   * that exists to mint an MCP credential could not mint one: «I do not know
   * mcp:access». Nothing caught it because the tests build their tokens through
   * the fixture, which inserts the row directly and never asks this allowlist.
   */
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

  /*
   * Which member the token speaks as, and whether that member may write.
   *
   * It took the first row the database happened to return, with no order and no
   * regard for the role. In a household of two where one is read-only, that could
   * bind a token carrying `transactions:write` to the member who is not allowed
   * to write — and until the role was checked at authentication, it wrote.
   *
   * Now it prefers somebody who can write, and refuses to mint a write scope for
   * a read-only member instead of leaving the failure for later, at a moment when
   * whoever reads it will be looking at a bot and not at this.
   */
  const scopes = requestedScopes();

  const members = await db
    .select({ userId: householdMembers.userId, role: householdMembers.role })
    .from(householdMembers)
    .where(eq(householdMembers.householdId, household.id))
    .orderBy(householdMembers.role);
  if (members.length === 0) throw new Error("The household has no users.");

  const member = members.find((m) => m.role !== "viewer") ?? members[0];
  const writes = scopes.filter((scope) => scope.endsWith(":write"));
  if (member.role === "viewer" && writes.length > 0) {
    throw new Error(
      `Everybody in this household is read-only, so ${writes.join(", ")} would be ` +
        "refused on every call. Mint a reading token instead:\n" +
        `  npm run token:create -- "${tokenName}" "${scopes.filter((s) => !s.endsWith(":write")).join(",")}"`,
    );
  }

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
  console.log('│   mcp.servers.planfly.headers.Authorization = "Bearer <this>"');
  console.log("│ then:");
  console.log("│   docker compose restart openclaw-gateway   (wherever openclaw lives)");
  console.log("└──────────────────────────────────────────────────────────────\n");

  /*
   * What this credential can reach, and what leaves the machine — here, and not
   * only in the README.
   *
   * This is the moment somebody decides: the token is on screen and about to be
   * pasted into an agent's configuration. Nobody re-reads documentation at that
   * moment, and everybody reads this. The scopes are printed from the token
   * actually being minted rather than from a list written here, so a narrowed
   * token says so and a list cannot drift from what was granted.
   */
  console.log(`This credential speaks as a household ${member.role}.`);
  console.log("It can:");
  for (const scope of scopes) {
    console.log(`  ${scope.padEnd(20)} ${WHAT_A_SCOPE_REACHES[scope] ?? ""}`);
  }
  console.log(
    "\nWhoever holds it reads and writes THIS household's ledger. If you paste it\n" +
      "into an agent that runs in somebody else's cloud, what you ask and what\n" +
      "planfly answers — amounts, account names, the text of a receipt — go to that\n" +
      "provider. That is the trade, and it is worth making on purpose.\n\n" +
      "It is revocable: `npm run token:revoke` ends it without touching anything it\n" +
      "recorded, and every entry it wrote keeps its name.\n",
  );
}

main()
  .catch((err) => {
    console.error("Failed:", err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
