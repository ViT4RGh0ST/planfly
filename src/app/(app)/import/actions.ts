"use server";

import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";

import { db } from "@/db";
import { accounts } from "@/db/schema";
import { requireSession, requireWriter } from "@/lib/session";
import { messageForScreen } from "@/lib/user-error";
import {
  commitImport,
  previewImport,
  type ColumnMapping,
  type PreviewRow,
  type RawRow,
} from "@/lib/services/import";
import { normalizeLocale } from "@/i18n/config";
import { getTranslator } from "@/i18n/translator";
import { localeOf } from "@/lib/services/household-locale";

async function loadAccount(householdId: string, accountName: string) {
  const [row] = await db
    .select({ id: accounts.id, name: accounts.name, currency: accounts.currency })
    .from(accounts)
    .where(and(eq(accounts.householdId, householdId), eq(accounts.name, accountName)))
    .limit(1);
  if (!row) {
    throw new Error(
      getTranslator(await localeOf(householdId))("services.actions.accountNotFound", {
        name: accountName,
      }),
    );
  }
  return row;
}

export async function previewImportAction(
  accountName: string,
  rows: RawRow[],
  mapping: ColumnMapping,
): Promise<{ ok: boolean; message?: string; rows?: PreviewRow[] }> {
  const ctx = await requireSession();
  try {
    const account = await loadAccount(ctx.householdId, accountName);
    const preview = await previewImport(
      ctx.householdId,
      account.id,
      account.currency,
      rows,
      mapping,
    );
    return { ok: true, rows: preview };
  } catch (err) {
    return { ok: false, message: messageForScreen(err, ctx.locale) };
  }
}

export async function commitImportAction(
  accountName: string,
  fileName: string,
  rawRows: RawRow[],
  rows: PreviewRow[],
  mapping: ColumnMapping,
): Promise<{ ok: boolean; message: string }> {
  /*
   * The session outside the `try`, the permission inside it.
   *
   * `requireSession` REDIRECTS when there is none, and a redirect in Next is an
   * exception: caught here, it stopped being a redirect and turned into an
   * error message. `requireWriter` only throws, and its throw is worth catching
   * — a read-only account clicking Import should get a toast saying why, not
   * Next's opaque screen.
   */
  const ctx = await requireSession();
  const t = getTranslator(normalizeLocale(ctx.locale));
  try {
    await requireWriter();
    const account = await loadAccount(ctx.householdId, accountName);

    const result = await commitImport({
      householdId: ctx.householdId,
      userId: ctx.userId,
      accountId: account.id,
      accountName: account.name,
      currency: account.currency,
      fileName,
      mapping,
      rows,
      rawRows,
    });

    revalidatePath("/", "layout");
    return {
      ok: true,
      message: t("services.actions.importDone", {
        imported: result.imported,
        skipped: result.skipped,
        errors:
          result.errors > 0 ? t("services.actions.importErrors", { n: result.errors }) : "",
      }),
    };
  } catch (err) {
    return { ok: false, message: messageForScreen(err, ctx.locale) };
  }
}
