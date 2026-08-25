import { NextResponse } from "next/server";
import { and, desc, eq, gte, inArray, isNull } from "drizzle-orm";

import { db } from "@/db";
import { transactions } from "@/db/schema";
import { withToken, rejectIdentityKeys, rejectUnknownKeys, idFromUrl } from "@/lib/api/handler";
import { updateTransactionSchema } from "@/lib/validation";
import { addDays, today } from "@/lib/dates";
import { InvalidTransactionError } from "@/lib/services/record-transaction";
import {
  AGENT_EDITABLE_DAYS,
  AGENT_EDITABLE_SOURCES,
  updateTransaction,
} from "@/lib/services/update-transaction";
import { voidTransaction } from "@/lib/services/void-transaction";
import { normalizeLocale } from "@/i18n/config";
import { getTranslator } from "@/i18n/translator";

export const dynamic = "force-dynamic";

/**
 * Correcting an already recorded entry.
 *
 * All the logic lives in `updateTransaction()`, shared with the dashboard form.
 * It used to be written here and half-duplicated in the dashboard actions, with
 * the absurd result that over Telegram you could correct more fields than with a
 * mouse.
 *
 * The only thing specific to this route is the bounding: the agent only touches
 * rows it created itself (telegram or ocr origin) and from the last 7 days. A
 * conversational correction must never be able to silently rewrite an imported
 * statement.
 */

/** Resolves "last" and checks the agent window in the same query. */
async function resolveTarget(
  householdId: string,
  id: string,
  timezone: string,
): Promise<string | null> {
  const since = addDays(today(timezone), -AGENT_EDITABLE_DAYS);

  const baseWhere = and(
    eq(transactions.householdId, householdId),
    isNull(transactions.voidedAt),
    inArray(transactions.source, [...AGENT_EDITABLE_SOURCES]),
    gte(transactions.occurredOn, since),
  );

  if (id === "last") {
    const [row] = await db
      .select({ id: transactions.id })
      .from(transactions)
      .where(baseWhere)
      .orderBy(desc(transactions.createdAt))
      .limit(1);
    return row?.id ?? null;
  }

  const [row] = await db
    .select({ id: transactions.id })
    .from(transactions)
    .where(and(eq(transactions.id, id), baseWhere))
    .limit(1);
  return row?.id ?? null;
}

/**
 * The shape, not the sentence.
 *
 * The wording depends on the household's language, which is only known once the
 * token has been read, so the message is filled in at each use.
 */
const NOT_EDITABLE = { ok: false, error: "not_editable" } as const;

export const PATCH = withToken("transactions:write", async ({ principal, req }) => {
  const t = getTranslator(normalizeLocale(principal.locale));
  const rawId = idFromUrl(req.url);

  const body = await req.json();
  rejectIdentityKeys(body);
  rejectUnknownKeys(body, updateTransactionSchema);
  const input = updateTransactionSchema.parse(body);

  const id = await resolveTarget(principal.householdId, rawId, principal.timezone);
  if (!id) {
    return NextResponse.json(
      { ...NOT_EDITABLE, message: t("api.transactions.notEditable") },
      { status: 404 },
    );
  }

  try {
    const result = await updateTransaction({
      householdId: principal.householdId,
      transactionId: id,
      amount: input.amount,
      toAmount: input.to_amount,
      account: input.account,
      toAccount: input.to_account,
      category: input.category,
      description: input.description,
      occurredOn: input.occurred_on,
      notes: input.notes,
      rate: input.rate,
      toRate: input.to_rate,
      rateSource: input.rate_source,
      toRateSource: input.to_rate_source,
      items: input.items,
      itemsMode: input.items_mode,
      approve: input.approve,
      agentWindow: true,
    });

    /*
     * "There was nothing to change" with ok:true is the answer that confuses an
     * agent most: it asked for something, was told it went fine, and nothing
     * changed. On 17/08/2026 it ended up telling the user the tool was broken.
     * If nothing moved, it is a failure and it is said as one.
     */
    // `approve` produces no "changes" and still does something: it takes the row
    // out of the tray. It is only a no-op when it was not approving either.
    if (result.changes.length === 0 && !input.approve) {
      return NextResponse.json(
        {
          ok: false,
          error: "no_changes",
          message: t("api.transactions.noChanges"),
          transaction_id: result.transactionId,
        },
        { status: 422 },
      );
    }

    return NextResponse.json({
      ok: true,
      transaction_id: result.transactionId,
      changes: result.changes,
      warnings: result.warnings,
      summary: result.summary,
    });
  } catch (err) {
    if (err instanceof InvalidTransactionError) {
      // 422 and not 500: the message is written for the agent to repeat verbatim
      // in the chat. A 500 only tells it "something failed", and it retries blind.
      const status = err.code === "not_found" || err.code === "not_editable" ? 404 : 422;
      return NextResponse.json(
        { ok: false, error: err.code, message: err.message },
        { status },
      );
    }
    throw err;
  }
});

/** Voiding. It is never deleted: an expense that existed is information, and
 *  deleting it would leave an unexplainable hole in the account's history. */
export const DELETE = withToken("transactions:write", async ({ principal, req }) => {
  const t = getTranslator(normalizeLocale(principal.locale));
  const rawId = idFromUrl(req.url);

  const id = await resolveTarget(principal.householdId, rawId, principal.timezone);
  if (!id) {
    return NextResponse.json(
      { ...NOT_EDITABLE, message: t("api.transactions.notVoidable") },
      { status: 404 },
    );
  }

  const result = await voidTransaction({
    householdId: principal.householdId,
    transactionId: id,
    // Frozen in the household's language: it is written to `void_reason`.
    reason: t("api.transactions.voidReason"),
  });

  return NextResponse.json(result);
});
