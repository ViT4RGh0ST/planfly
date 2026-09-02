import { cache } from "react";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";

import { db } from "@/db";
import { householdMembers, households } from "@/db/schema";
import { auth } from "@/lib/auth";
import { normalizeLocale } from "@/i18n/config";
import { getTranslator } from "@/i18n/translator";

/**
 * The context of the person looking at the app.
 *
 * Just as in the API, the household does NOT come from the URL or from a
 * parameter: it is derived from the session. That way a future second user
 * cannot see another household by changing an id by hand.
 */
export type UserContext = {
  userId: string;
  name: string;
  email: string;
  householdId: string;
  householdName: string;
  baseCurrency: string;
  timezone: string;
  defaultRateSource: "official" | "parallel" | "manual";
  /** The interface language. Free text in the column; normalised on the way out. */
  locale: string;
  role: string;
};

/*
 * Wrapped in `cache()` so one render is one query.
 *
 * It was already being called twice on most pages — once by the layout and once
 * by the page — and `getRequestConfig` now makes it three. React's `cache()`
 * deduplicates within a single render pass, which is exactly the scope that
 * needs it, and it removes a query that was already being paid for.
 */
export const currentSession = cache(async (): Promise<UserContext | null> => {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) return null;

  const [row] = await db
    .select({
      householdId: households.id,
      householdName: households.name,
      baseCurrency: households.baseCurrency,
      timezone: households.timezone,
      defaultRateSource: households.defaultRateSource,
      locale: households.locale,
      role: householdMembers.role,
    })
    .from(householdMembers)
    .innerJoin(households, eq(households.id, householdMembers.householdId))
    .where(eq(householdMembers.userId, session.user.id))
    .limit(1);

  if (!row) return null;

  return {
    userId: session.user.id,
    name: session.user.name,
    email: session.user.email,
    ...row,
  };
});

/** For pages: with no session, off to the login. */
export async function requireSession(): Promise<UserContext> {
  const ctx = await currentSession();
  if (!ctx) redirect("/login");
  return ctx;
}

/**
 * Like `requireSession`, but it also demands that the account can write.
 *
 * The `viewer` role existed in the database and in the context from the start,
 * and nobody checked it: `scripts/scan-user.ts` promised in writing that this
 * account «cannot write anything» while it could void entries and delete
 * budgets, with its password stored in plain text in `.env.local`. A permission
 * promise the code does not keep is worse than having no permissions: whoever
 * reads it stops checking.
 *
 * It throws rather than redirecting because this is not a session problem but an
 * authorisation one. The message does NOT reach the screen: the call happens
 * before the `try` in the actions that have one, and several have none, so a
 * viewer reaching here will see Next's opaque error and not this sentence.
 *
 * It is left this way on purpose. This is the net, not the path: a viewer should
 * not be seeing the buttons that lead here. The day the interface is genuinely
 * shared, what has to be fixed is that they don't see them, not the text of this
 * error.
 */
export async function requireWriter(): Promise<UserContext> {
  const ctx = await requireSession();
  if (ctx.role === "viewer") {
    throw new Error(getTranslator(normalizeLocale(ctx.locale))("services.session.readOnly"));
  }
  return ctx;
}

