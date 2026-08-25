/**
 * Resets a user's password. Local use, with access to the machine: there is no
 * recovery email because there is no mail server.
 *
 *   RESET_PASSWORD='…' npm run auth:reset
 *
 * It goes through better-auth's context and not through direct SQL, so the hash
 * is exactly the one the login expects (scrypt, with its salt format).
 */
import { eq } from "drizzle-orm";

import { db } from "@/db";
import { user } from "@/db/schema";
import { auth } from "@/lib/auth";

function required(name: string, what: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is missing. ${what}\n` +
        `  Put it in .env.local or in front of the command: ${name}="..." npm run ...`,
    );
  }
  return value;
}

const EMAIL = required("RESET_EMAIL", "It is the email of the account to reset.").toLowerCase();
const PASSWORD = process.env.RESET_PASSWORD;

async function main() {
  if (!PASSWORD) {
    throw new Error("RESET_PASSWORD is missing. Usage: RESET_PASSWORD='…' npm run auth:reset");
  }

  const [account] = await db.select().from(user).where(eq(user.email, EMAIL)).limit(1);
  if (!account) {
    throw new Error(`There is no user with ${EMAIL}.`);
  }

  const ctx = await auth.$context;
  await ctx.internalAdapter.updatePassword(account.id, await ctx.password.hash(PASSWORD));

  console.log(`Password reset for ${EMAIL}.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error((err as Error).message);
    process.exit(1);
  });
