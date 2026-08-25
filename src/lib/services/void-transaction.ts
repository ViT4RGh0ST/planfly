import { and, eq } from "drizzle-orm";

import { db } from "@/db";
import { transactions } from "@/db/schema";
import { InvalidTransactionError } from "./record-transaction";
import { getTranslator } from "@/i18n/translator";
import { localeOf } from "./household-locale";

/**
 * The ONE path for voiding an entry.
 *
 * It existed written four times over — two of them outside the services, in a
 * server action and in an API route — against the rule CONTRIBUTING itself
 * declares non-negotiable. Being repeated already had a cost: the API's copy did
 * not check whether the entry belonged to an installment plan, so voiding the
 * purchase through there would have left the schedule standing, pointing at an
 * expense that no longer exists.
 *
 * It never deletes. An expense that existed is information, and deleting it
 * would leave an unexplainable hole in the account's balance; it is marked and
 * stays in the history.
 */
export async function voidTransaction(params: {
  householdId: string;
  transactionId: string;
  reason: string;
}): Promise<{ ok: true; transactionId: string; summary: string }> {
  const [row] = await db
    .update(transactions)
    .set({
      voidedAt: new Date(),
      voidReason: params.reason,
      needsReview: false,
    })
    .where(
      and(
        eq(transactions.id, params.transactionId),
        eq(transactions.householdId, params.householdId),
      ),
    )
    .returning({ id: transactions.id });

  const t = getTranslator(await localeOf(params.householdId));
  if (!row) {
    throw new InvalidTransactionError(t("services.common.entryNotFound"), "not_found");
  }

  return { ok: true, transactionId: row.id, summary: t("services.voidTransaction.done") };
}
