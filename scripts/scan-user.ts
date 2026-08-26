/**
 * Creates (or restores) the user the design scan logs in as.
 *
 *   npm run scan:user
 *
 * It exists because `design-scan.mjs` has to get past the login to reach the
 * screens, and its password ends up written in `.env.local`. Putting the owner's
 * there would mean leaving the household's real credential in a file read in
 * plain text, for a task that only looks at screens.
 *
 * This user logs in as a **viewer**: it sees the household and cannot write
 * anything. That is enforced by `requireWriter()` on every action that writes,
 * with a test that fails if a new one skips the check — it used to be only a
 * promise made by this comment, and the account could void entries and delete
 * budgets with its password stored in plain text in `.env.local`. `SCAN_EMAIL`
 * was already contemplated in `.env.example` for exactly this.
 *
 * The password is generated here and printed once, to be copied into `.env.local`.
 */
import { randomBytes } from "node:crypto";
import { createLocalAccountIssuer } from "@better-auth/core/db";
import { and, eq } from "drizzle-orm";

import { db } from "@/db";
import { householdMembers, households, user } from "@/db/schema";
import { auth } from "@/lib/auth";

const EMAIL = (process.env.SCAN_EMAIL ?? "scan@planfly.local").toLowerCase();
const NAME = "Escaneo de diseño";

/**
 * Creates the account through better-auth's internal path.
 *
 * Not through `signUpEmail`: form sign-up is deliberately closed
 * (`disableSignUp` in src/lib/auth.ts), and it has to stay that way — the seed
 * working cannot cost leaving registration open to anyone who reaches the port.
 * The hash is done by `ctx.password` itself, so the password works for logging
 * in all the same.
 */
async function createUser(email: string, password: string, name: string) {
  const ctx = await auth.$context;
  const created = await ctx.internalAdapter.createUser({
    email,
    name,
    emailVerified: false,
  }, { method: "email-password" });
  await ctx.internalAdapter.linkAccount({
    userId: created.id,
    providerId: "credential",
    issuer: createLocalAccountIssuer("credential"),
    accountId: created.id,
    password: await ctx.password.hash(password),
  });
  return created;
}

async function main() {
  const [household] = await db.select().from(households).limit(1);
  if (!household) {
    throw new Error("There is no household yet. Run `npm run db:seed` first.");
  }

  // Long and random: nobody types it by hand, only the script reads it.
  const password = randomBytes(24).toString("base64url");

  let [account] = await db.select().from(user).where(eq(user.email, EMAIL)).limit(1);

  if (account) {
    // Through better-auth's context, not through SQL: the hash has to be the one
    // the login expects (scrypt, with its salt format).
    const ctx = await auth.$context;
    await ctx.internalAdapter.updatePassword(account.id, await ctx.password.hash(password));
    console.log(`Password restored for ${EMAIL}.`);
  } else {
    await createUser(EMAIL, password, NAME);
    [account] = await db.select().from(user).where(eq(user.email, EMAIL)).limit(1);
    console.log(`User ${EMAIL} created.`);
  }

  const [member] = await db
    .select({ role: householdMembers.role })
    .from(householdMembers)
    .where(
      and(
        eq(householdMembers.householdId, household.id),
        eq(householdMembers.userId, account.id),
      ),
    )
    .limit(1);

  if (!member) {
    await db
      .insert(householdMembers)
      .values({ householdId: household.id, userId: account.id, role: "viewer" })
      .onConflictDoNothing();
    console.log(`Added to "${household.name}" as a viewer.`);
  }

  console.log("\nPut this in .env.local:\n");
  console.log(`SCAN_EMAIL="${EMAIL}"`);
  console.log(`SCAN_PASSWORD="${password}"`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error((err as Error).message);
    process.exit(1);
  });
