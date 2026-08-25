import { eq } from "drizzle-orm";

import { db } from "@/db";
import { households } from "@/db/schema";
import { normalizeLocale, type Locale } from "@/i18n/config";

/**
 * The household's language, for the operations that take no input object.
 *
 * Most services get `locale` handed to them alongside `baseCurrency` and
 * `timezone`, which is the convention: the caller knows whose household this is
 * and passing it makes the language visible in the diff. But several operations
 * are called with positional arguments — `archiveAccount(householdId, id)` — from
 * the actions, from the API and from the tests, and threading a locale through
 * all of them would put the same datum in six places to be got wrong in one.
 *
 * They already make several queries; this one costs a single column of a row
 * that is always there.
 */
export async function localeOf(householdId: string): Promise<Locale> {
  const [row] = await db
    .select({ locale: households.locale })
    .from(households)
    .where(eq(households.id, householdId))
    .limit(1);
  return normalizeLocale(row?.locale);
}
