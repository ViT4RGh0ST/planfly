import { NextResponse } from "next/server";

import { withToken, rejectIdentityKeys, rejectUnknownKeys } from "@/lib/api/handler";
import { createTransactionSchema } from "@/lib/validation";
import { recordTransaction } from "@/lib/services/record-transaction";
import { recentTransactions } from "@/lib/services/reports";
import { resolvePayee } from "@/lib/services/resolve-entities";

export const dynamic = "force-dynamic";

/**
 * Creating entries. It is the route the openclaw plugin calls.
 *
 * The idempotency key travels in the `X-Planfly-Idempotency-Key` header, not in
 * the body: exposing it to the model would invite reusing or inventing it.
 */
export const POST = withToken("transactions:write", async ({ principal, req }) => {
  const body = await req.json();
  rejectIdentityKeys(body);
  rejectUnknownKeys(body, createTransactionSchema);
  const input = createTransactionSchema.parse(body);

  const idempotencyKey = req.headers.get("x-planfly-idempotency-key") ?? undefined;

  const payee = input.payee ? await resolvePayee(principal.householdId, input.payee) : null;

  const result = await recordTransaction({
    householdId: principal.householdId,
    kind: input.kind,
    amount: input.amount,
    currency: input.currency,
    account: input.account,
    toAccount: input.to_account,
    toAmount: input.to_amount,
    category: input.category,
    description: input.description,
    payeeId: payee?.id,
    occurredOn: input.occurred_on,
    notes: input.notes,
    rate: input.rate,
    rateSource: input.rate_source,
    paymentMethod: input.payment_method,
    source: input.source,
    sourceRef: input.source_ref,
    createdByUserId: principal.userId,
    createdViaTokenId: principal.tokenId,
    createdByAgent: input.agent,
    confidence: input.confidence,
    idempotencyKey,
    raw: body,
    attachmentPath: input.attachment_path,
    dryRun: input.dry_run,
    // Through the API it is rejected; through the form and the CSV it is flagged
    // and that is that. Whoever calls here is a model that cannot see the history.
    onDuplicate: input.allow_duplicate ? "warn" : "reject",
    // The breakdown amounts travel exactly as they came: converting them here
    // would require guessing the currency, only known after resolving the account.
    items: input.items,
  });

  // 200 and not 409 on a retry: a 409 makes the agent "help" by retrying with
  // other values, and there you really do end up with two different expenses.
  return NextResponse.json(result, {
    status: result.duplicate || result.dryRun ? 200 : 201,
  });
});

export const GET = withToken("transactions:read", async ({ principal, req }) => {
  const url = new URL(req.url);
  const limit = Math.min(100, Number(url.searchParams.get("limit") ?? 20));
  const onlyNeedsReview = url.searchParams.get("review") === "1";

  const items = await recentTransactions(principal.householdId, { limit, onlyNeedsReview });
  return NextResponse.json({ ok: true, transactions: items });
});
