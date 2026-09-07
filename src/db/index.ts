import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { lazy } from "@/lib/lazy";
import * as schema from "./schema";

/**
 * Postgres connection.
 *
 * Both the pool and the Drizzle client are created **lazily**, on first use, not
 * on importing the module. That is deliberate: `next build` imports every route
 * to collect its data, and during the Docker image build there is no
 * `DATABASE_URL` — nor should there be, because baking credentials into an image
 * is precisely what one does not do. With validation at import time, the build
 * blew up on the first route touching the database.
 *
 * In development Next reloads modules on every change, so without the global
 * cache each save would leave an orphaned pool until the connections ran out.
 */
type PlanflyDb = NodePgDatabase<typeof schema>;

const globalRef = globalThis as unknown as {
  __planflyPool?: Pool;
  __planflyDb?: PlanflyDb;
};

function getPool(): Pool {
  if (globalRef.__planflyPool) return globalRef.__planflyPool;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is missing. Copy .env.example to .env.local (and bring the database up with `docker compose up -d`).",
    );
  }

  // `pg` returns NUMERIC as a string by default and that is how it stays:
  // converting to float would lose precision on exchange rates, where it hurts most.
  globalRef.__planflyPool = new Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
  });
  return globalRef.__planflyPool;
}

function getDb(): PlanflyDb {
  if (!globalRef.__planflyDb) {
    globalRef.__planflyDb = drizzle(getPool(), { schema, casing: "snake_case" });
  }
  return globalRef.__planflyDb;
}

export const pool = lazy(getPool);
export const db = lazy(getDb);

export type DB = PlanflyDb;
export { schema };
