import { sql } from "drizzle-orm";

import { db } from "@/db";

/**
 * Fuzzy resolution of accounts and categories.
 *
 * The bot sends **names**, not ids: "gasté 350 en el mercado desde efectivo".
 * That decision is deliberate and has two good consequences:
 *
 *   1. An invented id is impossible. The worst that can happen is a weak match,
 *      which gets flagged for review instead of writing rubbish.
 *   2. The agent needs no prior call to list categories before every expense,
 *      which was a whole round trip per message.
 *
 * The price is that the server has to resolve them, and that is what this file
 * is about.
 */

export type Match = {
  id: string;
  name: string;
  /** 1.0 = exact (slug or alias). Below REVIEW_THRESHOLD it goes to the tray. */
  score: number;
  via: "slug" | "alias" | "similarity";
};

/** Below this we do not trust the match and flag for review. */
export const REVIEW_THRESHOLD = 0.55;
/** Below this we do not even consider it valid. */
const MIN_THRESHOLD = 0.3;

/** lowercase + no accents + no punctuation. "Comida Callejera!" -> "comida callejera" */
export function normalize(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function toSlug(text: string): string {
  return normalize(text).replace(/\s+/g, "-");
}

/**
 * Searches a table having (id, name, slug, aliases[]) within a household.
 *
 * Three passes, most reliable first:
 *   1. exact slug — the "mercado" case when the category is called Mercado.
 *   2. exact alias — "bolos" -> Efectivo Bs, "super" -> Mercado.
 *   3. trigram similarity — copes with typos and plurals ("veterinaria").
 */
export async function resolveIn(
  table: "accounts" | "categories" | "payees" | "products",
  householdId: string,
  input: string,
  extraFilter = sql``,
): Promise<Match | null> {
  const text = normalize(input);
  if (text === "") return null;
  const slug = toSlug(input);

  const tableSql = sql.raw(table);
  // `archived_at` exists on accounts, categories and products; payees lacks it.
  const archivedFilter = table === "payees" ? sql`` : sql`AND archived_at IS NULL`;

  const { rows } = await db.execute<{
    id: string;
    name: string;
    score: number;
    via: string;
  }>(sql`
    SELECT id, name, score, via FROM (
      SELECT id, name, 1.0::float8 AS score, 'slug' AS via
        FROM ${tableSql}
       WHERE household_id = ${householdId} AND slug = ${slug} ${archivedFilter} ${extraFilter}

      UNION ALL

      SELECT id, name, 0.99::float8, 'alias'
        FROM ${tableSql}
       WHERE household_id = ${householdId} ${archivedFilter} ${extraFilter}
         AND EXISTS (
           SELECT 1 FROM unnest(aliases) a
            WHERE lower(unaccent(a)) = ${text}
         )

      UNION ALL

      SELECT id, name,
             similarity(lower(unaccent(name)), ${text})::float8,
             'similarity'
        FROM ${tableSql}
       WHERE household_id = ${householdId} ${archivedFilter} ${extraFilter}
         AND similarity(lower(unaccent(name)), ${text}) > ${MIN_THRESHOLD}
    ) candidates
    ORDER BY score DESC, name ASC
    LIMIT 1
  `);

  const row = rows[0];
  if (!row) return null;

  return {
    id: row.id,
    name: row.name,
    score: Number(row.score),
    via: row.via as Match["via"],
  };
}

/**
 * Resolves an account, optionally biased by the amount's currency.
 *
 * The bias genuinely matters: "efectivo" is ambiguous when you have cash in
 * bolívares and in dollars, and the slug of "Efectivo $" ends up being
 * "efectivo" because the symbol falls away on normalising. If the message says
 * 350 Bs, the bolívar account is the obvious answer — and without this tie-break
 * the expense would be rejected for an incompatible currency instead of going
 * where it belonged.
 */
export async function resolveAccount(
  householdId: string,
  input: string,
  preferredCurrency?: string,
): Promise<Match | null> {
  if (!preferredCurrency) return resolveIn("accounts", householdId, input);

  // First we try among the accounts of that currency only.
  const inCurrency = await resolveIn(
    "accounts",
    householdId,
    input,
    sql`AND currency = ${preferredCurrency.toUpperCase()}`,
  );
  if (inCurrency) return inCurrency;

  // If none fits, it falls back to the general search: the user may well be
  // naming an account in another currency on purpose, and the currency error
  // that fires afterwards is more informative than "I could not find the account".
  return resolveIn("accounts", householdId, input);
}

export function resolveCategory(
  householdId: string,
  input: string,
  kind?: "expense" | "income",
) {
  // Filtering by kind avoids the classic mistake of charging income against a
  // spending category because the name looked alike.
  const filter = kind ? sql`AND kind = ${kind}::category_kind` : sql``;
  return resolveIn("categories", householdId, input, filter);
}

export function resolvePayee(householdId: string, input: string) {
  return resolveIn("payees", householdId, input);
}

