import { createHash } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";

import { db } from "@/db";
import { getTranslator } from "@/i18n/translator";
import { localeOf } from "./household-locale";
import { importBatches, importRows } from "@/db/schema";
import { minorToDecimalString, parseAmountToMinor } from "@/lib/money";
import { normalize } from "./resolve-entities";
import { recordTransaction } from "./record-transaction";

/**
 * Statement import.
 *
 * Every row ends up going through `recordTransaction()`, just like Telegram and
 * the form: that guarantees both rates get stamped and the ledger's invariants
 * hold without duplicating logic here.
 */

export type ColumnMapping = {
  date: string;
  description: string;
  /** A single signed column, or two separate columns (debit/credit). */
  amount?: string;
  debit?: string;
  credit?: string;
  dateFormat?: "dd/mm/yyyy" | "yyyy-mm-dd" | "mm/dd/yyyy";
};

export type RawRow = Record<string, string>;

export type PreviewRow = {
  index: number;
  date: string;
  description: string;
  amountMinor: number;
  dedupeHash: string;
  status: "new" | "duplicate" | "error";
  error?: string;
};

/** Normalises the date according to the bank's format. Venezuelan statements
 *  usually come as dd/mm/yyyy, which `new Date()` reads the other way round. */
function parseDate(value: string, format: ColumnMapping["dateFormat"] = "dd/mm/yyyy"): string | null {
  const cleaned = value.trim().replace(/[-.]/g, "/");
  const parts = cleaned.split("/");
  if (parts.length !== 3) {
    // Already ISO?
    if (/^\d{4}-\d{2}-\d{2}/.test(value.trim())) return value.trim().slice(0, 10);
    return null;
  }

  const [p0, p1, p2] = parts;
  if (format === "yyyy-mm-dd") return `${p0}-${p1.padStart(2, "0")}-${p2.padStart(2, "0")}`;
  // mm/dd/yyyy: day and month are swapped relative to the dd/mm assumed below.
  const [day, month] = format === "mm/dd/yyyy" ? [p1, p0] : [p0, p1];

  const year = p2.length === 2 ? `20${p2}` : p2;
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

/**
 * Fingerprint for spotting a row already imported.
 *
 * The description is normalised because banks change spaces and case between
 * downloads of the same period, and without that the monthly overlap — which is
 * the real case when downloading a statement — would generate duplicates on
 * every import.
 */
export function rowHash(
  accountId: string,
  date: string,
  amountMinor: number,
  description: string,
): string {
  return createHash("sha256")
    .update(`${accountId}|${date}|${amountMinor}|${normalize(description)}`)
    .digest("hex");
}

export async function previewImport(
  householdId: string,
  accountId: string,
  currency: string,
  rows: RawRow[],
  mapping: ColumnMapping,
): Promise<PreviewRow[]> {
  const t = getTranslator(await localeOf(householdId));
  const prepared: PreviewRow[] = rows.map((row, index) => {
    try {
      const date = parseDate(row[mapping.date] ?? "", mapping.dateFormat);
      if (!date) {
        throw new Error(
          t("services.import.unreadableDate", { value: row[mapping.date] ?? "" }),
        );
      }

      // Written to the row: frozen in the household's language, like every
      // other text that ends up stored.
      const description =
        (row[mapping.description] ?? "").trim() || t("services.common.noDescription");

      let amountMinor: number;
      if (mapping.amount) {
        amountMinor = parseAmountToMinor(row[mapping.amount] ?? "0", currency);
      } else {
        // Two columns: the debit leaves the account, the credit enters.
        const debit = row[mapping.debit ?? ""]?.trim();
        const credit = row[mapping.credit ?? ""]?.trim();
        const d = debit ? Math.abs(parseAmountToMinor(debit, currency)) : 0;
        const c = credit ? Math.abs(parseAmountToMinor(credit, currency)) : 0;
        amountMinor = c - d;
      }

      if (amountMinor === 0) throw new Error(t("services.import.zeroAmount"));

      return {
        index,
        date,
        description,
        amountMinor,
        dedupeHash: rowHash(accountId, date, amountMinor, description),
        status: "new" as const,
      };
    } catch (err) {
      return {
        index,
        date: "",
        description: "",
        amountMinor: 0,
        dedupeHash: "",
        status: "error" as const,
        error: (err as Error).message,
      };
    }
  });

  // Rows that already exist are flagged, comparing against ALL the household's
  // imports and not just this batch: the real case is downloading the monthly
  // statement when the fortnightly one has already been downloaded.
  const hashes = prepared.filter((r) => r.dedupeHash).map((r) => r.dedupeHash);
  if (hashes.length > 0) {
    /*
     * With the constructor and not with a hand-written `= ANY(${hashes})` in SQL.
     *
     * That version interpolated the array as ONE text parameter and Postgres
     * rejected it — «malformed array literal» — so `previewImport` threw on any
     * file: statement import did not work at all, and nobody had noticed because
     * there was no test exercising it. The first one found it.
     */
    const existing = await db
      .selectDistinct({ dedupeHash: importRows.dedupeHash })
      .from(importRows)
      .innerJoin(importBatches, eq(importBatches.id, importRows.batchId))
      .where(
        and(
          eq(importBatches.householdId, householdId),
          eq(importRows.status, "imported"),
          inArray(importRows.dedupeHash, hashes as string[]),
        ),
      );
    const alreadyImported = new Set(existing.map((r) => r.dedupeHash));
    for (const r of prepared) {
      if (r.status === "new" && alreadyImported.has(r.dedupeHash)) r.status = "duplicate";
    }
  }

  // Duplicates within the file itself.
  const seen = new Set<string>();
  for (const r of prepared) {
    if (r.status !== "new") continue;
    if (seen.has(r.dedupeHash)) r.status = "duplicate";
    else seen.add(r.dedupeHash);
  }

  return prepared;
}

export async function commitImport(params: {
  householdId: string;
  userId: string;
  accountId: string;
  accountName: string;
  currency: string;
  fileName: string;
  mapping: ColumnMapping;
  rows: PreviewRow[];
  rawRows: RawRow[];
}): Promise<{ imported: number; skipped: number; errors: number; categorized: number }> {
  const fileHash = createHash("sha256").update(JSON.stringify(params.rawRows)).digest("hex");

  const [batch] = await db
    .insert(importBatches)
    .values({
      householdId: params.householdId,
      accountId: params.accountId,
      fileName: params.fileName,
      fileHash,
      status: "imported",
      mapping: params.mapping,
      createdById: params.userId,
    })
    .returning({ id: importBatches.id });

  let imported = 0;
  let skipped = 0;
  let errors = 0;

  for (const row of params.rows) {
    if (row.status !== "new") {
      skipped++;
      await db.insert(importRows).values({
        batchId: batch.id,
        rowIndex: row.index,
        raw: params.rawRows[row.index] ?? {},
        dedupeHash: row.dedupeHash || `error-${row.index}`,
        status: row.status === "error" ? "error" : "duplicate",
        error: row.error ?? null,
      });
      if (row.status === "error") errors++;
      continue;
    }

    try {
      const result = await recordTransaction({
        householdId: params.householdId,
        kind: row.amountMinor < 0 ? "expense" : "income",
        // As a decimal string, not by dividing by 100: the minor unit depends on
        // the currency and an intermediate float is exactly what this system avoids.
        amount: minorToDecimalString(Math.abs(row.amountMinor), params.currency),
        currency: params.currency,
        account: params.accountName,
        description: row.description,
        occurredOn: row.date,
        source: "csv",
        sourceRef: `${params.fileName}#${row.index}`,
        createdByUserId: params.userId,
        importBatchId: batch.id,
        raw: params.rawRows[row.index],
      });

      await db.insert(importRows).values({
        batchId: batch.id,
        rowIndex: row.index,
        raw: params.rawRows[row.index] ?? {},
        dedupeHash: row.dedupeHash,
        status: "imported",
        transactionId: result.transactionId,
      });
      imported++;
    } catch (err) {
      errors++;
      await db.insert(importRows).values({
        batchId: batch.id,
        rowIndex: row.index,
        raw: params.rawRows[row.index] ?? {},
        dedupeHash: row.dedupeHash,
        status: "error",
        error: (err as Error).message,
      });
    }
  }

  await db
    .update(importBatches)
    .set({ stats: { total: params.rows.length, imported, skipped, errors } })
    .where(eq(importBatches.id, batch.id));

  /*
   * Categorising is part of importing, not a separate button.
   *
   * The function existed and nobody called it: you imported the statement and
   * all two hundred rows were left uncategorised, which is precisely the work
   * rules came to save. It goes last and outside the write transaction on
   * purpose: if a rule were badly written, what was imported is already safe and
   * the only thing missing is the category.
   */
  let categorized = 0;
  try {
    categorized = await applyRules(params.householdId);
  } catch (err) {
    console.error("[import] the rules failed, the rows stay uncategorised:", err);
  }

  return { imported, skipped, errors, categorized };
}

/**
 * Puts a category on entries that have none, according to the household's rules.
 *
 * It is what keeps importing a two-hundred-row statement from being two hundred
 * clicks. It only touches what is UNcategorised: a new rule never rewrites
 * something already decided by hand.
 *
 * It compares against the field the rule names. It used to always compare
 * against the description, so a rule about the payee categorised by the text —
 * another thing entirely — without warning. The `amount` field exists in the
 * enum and is NOT implemented: it is deliberately ignored rather than pretending
 * to work, and the rules screen does not offer it.
 */
export async function applyRules(householdId: string): Promise<number> {
  const { rows } = await db.execute<{ n: string }>(sql`
    WITH candidates AS (
      SELECT e.id AS entry_id, r.set_category_id, r.priority
        FROM transaction_entries e
        JOIN transactions t ON t.id = e.transaction_id
        LEFT JOIN payees p ON p.id = t.payee_id
        JOIN categorization_rules r
          ON r.household_id = ${householdId} AND r.is_active
         AND (r.account_id IS NULL OR r.account_id = e.account_id)
         AND (
           (r.field = 'description' AND (
                (r.operator = 'contains' AND lower(unaccent(t.description)) LIKE '%' || lower(unaccent(r.pattern)) || '%')
             OR (r.operator = 'equals'   AND lower(unaccent(t.description)) = lower(unaccent(r.pattern)))
             OR (r.operator = 'regex'    AND t.description ~* r.pattern)
           ))
        OR (r.field = 'payee' AND p.name IS NOT NULL AND (
                (r.operator = 'contains' AND lower(unaccent(p.name)) LIKE '%' || lower(unaccent(r.pattern)) || '%')
             OR (r.operator = 'equals'   AND lower(unaccent(p.name)) = lower(unaccent(r.pattern)))
             OR (r.operator = 'regex'    AND p.name ~* r.pattern)
           ))
         )
       WHERE e.household_id = ${householdId}
         AND e.category_id IS NULL
         AND t.kind IN ('expense','income')
         AND t.voided_at IS NULL
         AND r.set_category_id IS NOT NULL
    ),
    -- One rule per line only: the one with the LOWEST priority number, which is
    -- the one that rules. The ORDER BY goes in here and not in the CTE above:
    -- DISTINCT ON does not inherit a subquery's order, so without this Postgres
    -- kept whichever of the two it liked and the priority was decorative.
    chosen AS (
      SELECT DISTINCT ON (entry_id) entry_id, set_category_id
        FROM candidates
       ORDER BY entry_id, priority ASC
    ),
    applied AS (
      UPDATE transaction_entries e
         SET category_id = c.set_category_id
        FROM chosen c
       WHERE e.id = c.entry_id
      RETURNING e.id
    )
    SELECT count(*)::text AS n FROM applied
  `);

  return Number(rows[0]?.n ?? 0);
}
