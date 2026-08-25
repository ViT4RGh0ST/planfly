/**
 * Revokes an API token.
 *
 *   npm run token:revoke -- <prefix|name>
 *   npm run token:revoke -- --all
 *
 * It exists because `api-token.ts` promised revocation «from the screen» that is
 * nowhere to be found: the only thing that revoked was creating a replacement
 * with the same name, which serves for rotating and not for cutting off. If a
 * token leaks, you need to be able to switch it off without creating another.
 *
 * It does not delete the row: it sets `revoked_at`. A token that existed is
 * information — knowing when it stopped being valid is exactly what you need
 * when investigating something.
 */
import { and, eq, isNull, or } from "drizzle-orm";

import { db, pool } from "../src/db";
import { apiTokens } from "../src/db/schema";

const target = process.argv[2];

async function main() {
  if (!target) {
    const live = await db
      .select({ prefix: apiTokens.prefix, name: apiTokens.name, scopes: apiTokens.scopes })
      .from(apiTokens)
      .where(isNull(apiTokens.revokedAt));

    console.log(
      live.length === 0
        ? "There is no live token."
        : "Live tokens:\n" +
            live
              .map((t) => `  ${t.prefix}…  ${t.name}  [${(t.scopes ?? []).join(", ")}]`)
              .join("\n"),
    );
    console.log("\nTo revoke:  npm run token:revoke -- <prefix|name>");
    console.log("All:        npm run token:revoke -- --all");
    return;
  }

  const where =
    target === "--all"
      ? isNull(apiTokens.revokedAt)
      : and(
          isNull(apiTokens.revokedAt),
          or(eq(apiTokens.prefix, target), eq(apiTokens.name, target)),
        );

  const revoked = await db
    .update(apiTokens)
    .set({ revokedAt: new Date() })
    .where(where)
    .returning({ prefix: apiTokens.prefix, name: apiTokens.name });

  console.log(
    revoked.length === 0
      ? `I found no live token matching "${target}".`
      : `Revoked ${revoked.length}:\n` +
          revoked.map((t) => `  ${t.prefix}…  ${t.name}`).join("\n"),
  );
  console.log("Whoever was using it will get a 401 on the next request.");
}

main()
  .catch((err) => {
    console.error((err as Error).message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
