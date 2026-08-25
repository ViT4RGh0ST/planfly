import { execFileSync } from "node:child_process";
import { Client, Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

/**
 * The test bench against a real Postgres.
 *
 * It exists because pure tests do not cover where this project's most expensive
 * mistakes have shown up: nine copies of a rule in SQL that diverged, a
 * duplicated alias TypeScript compiled without a murmur, a rate stored a
 * thousand times too large. None of them is visible without running the query.
 *
 * Two guarantees, and the first rules over everything else:
 *
 * 1. **It never touches the real database.** The URL is pinned here and
 *    overrides the environment's: even if someone runs the tests with
 *    DATABASE_URL pointing at production, they write to `planfly_test`. The name
 *    is checked before anything is dropped.
 * 2. **With no Postgres, the tests skip.** A freshly cloned repo runs `npm test`
 *    without starting anything and sees no red failures for something it has not
 *    configured.
 */

/**
 * One database per test file, derived from its name.
 *
 * Node's runner launches one process per file and runs them in parallel. With a
 * single shared database, the second file dropped it while the first was writing
 * to it: the tests hung and the reason showed up nowhere. One database each and
 * parallelism stops mattering.
 */
function dbName(): string {
  const entry = process.argv[1] ?? "suelta";
  const slug = entry
    .split("/")
    .pop()!
    .replace(/\.db\.test\.tsx?$/, "")
    .replace(/[^a-z0-9]+/gi, "_")
    .toLowerCase()
    .slice(0, 40);
  return `planfly_test_${slug || "suelta"}`;
}

const TEST_DB = dbName();

function urlFor(base: string, database: string): string {
  const u = new URL(base);
  u.pathname = `/${database}`;
  return u.toString();
}

const BASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://planfly:planfly@127.0.0.1:5433/planfly";

export const TEST_URL = urlFor(BASE_URL, TEST_DB);

// BEFORE anyone imports `@/db`: its pool is lazy and reads this variable the
// first time it is used, so setting it here redirects the whole tree.
process.env.DATABASE_URL = TEST_URL;

let ready: boolean | null = null;

/**
 * Is there a Postgres to connect to?
 *
 * Synchronous on purpose, even though connecting is not: Node's runner decides
 * whether to skip a suite from a value, not from a promise, and `tsx` compiles
 * to CJS, where there is no top-level `await`. You pay for one child process
 * once and the problem is over.
 */
export function hasDb(): boolean {
  if (ready !== null) return ready;
  try {
    execFileSync(
      process.execPath,
      [
        "-e",
        "const{Client}=require('pg');" +
          "const c=new Client({connectionString:process.argv[1]});" +
          "c.connect().then(()=>c.end()).then(()=>process.exit(0)).catch(()=>process.exit(1));",
        urlFor(BASE_URL, "postgres"),
      ],
      { stdio: "ignore", timeout: 10_000 },
    );
    ready = true;
  } catch {
    ready = false;
  }
  return ready;
}

/**
 * Leaves the test database freshly created and migrated.
 *
 * It is recreated whole rather than cleaned table by table: that way the schema
 * being tested is exactly the one the versioned migrations produce, which is
 * what will run for whoever clones this. A "cleaned" database drags along what
 * an old migration left half done and hides precisely the failure that matters.
 */
export async function prepareDb(): Promise<void> {
  const admin = new Client({ connectionString: urlFor(BASE_URL, "postgres") });
  await admin.connect();
  await admin.query(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
      WHERE datname = $1 AND pid <> pg_backend_pid()`,
    [TEST_DB],
  );
  // The name is checked here and not in the caller: it is the last line between
  // a test and somebody's accounting. By prefix and not by suffix — each file
  // carries its own behind — but just as strict: bare `planfly` does not pass,
  // and that is exactly the one to protect.
  if (!/^planfly_test(_[a-z0-9_]+)?$/.test(TEST_DB)) {
    throw new Error(`I refuse to drop "${TEST_DB}": a test database starts with planfly_test`);
  }
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
  await admin.query(`CREATE DATABASE ${TEST_DB}`);
  await admin.end();

  /*
   * The programmatic migrator and not `npx drizzle-kit`: the runner launches one
   * process per test file and two concurrent `npx` calls hung fighting each
   * other, without saying why. This runs in the same process, takes milliseconds
   * and applies exactly the versioned migrations.
   */
  const migrator = new Pool({ connectionString: TEST_URL, max: 1 });
  try {
    await migrate(drizzle(migrator), { migrationsFolder: "drizzle" });
  } finally {
    await migrator.end();
  }
}
