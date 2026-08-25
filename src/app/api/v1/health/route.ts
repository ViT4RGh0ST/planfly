import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";

import { db } from "@/db";

export const dynamic = "force-dynamic";

/**
 * Service health. Deliberately unauthenticated: it is what you use to check that
 * an integration reaches the app before getting into debugging tokens.
 *
 * That is why it does NOT return the error: a Postgres message carries the
 * database's user, host and port, and this answers anyone who reaches the port.
 * It goes to the server log, which is where it is needed.
 */
export async function GET() {
  try {
    await db.execute(sql`SELECT 1`);
    return NextResponse.json({
      ok: true,
      service: "planfly",
      database: "connected",
      time: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[health] the database is not answering:", err);
    return NextResponse.json(
      { ok: false, service: "planfly", database: "disconnected" },
      { status: 503 },
    );
  }
}
