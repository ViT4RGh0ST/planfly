import type { McpOperation } from "@/lib/mcp/operation";
import type { Principal } from "@/lib/api-token";
import type { McpTransactionDraftInput } from "@/lib/validation";
import { recordTransaction, type RecordTransactionResult } from "@/lib/services/record-transaction";

/**
 * Recording an entry: the operation the gate was written for, and the only one
 * whose service can genuinely simulate itself. `recordTransaction` with `dryRun`
 * resolves the account, the category and the day's rates, computes both
 * equivalents, and stores nothing.
 */
export const recordTransactionOperation: McpOperation = {
  run: (principal, input, confirmationId, dryRun) =>
    recordTransaction(
      toRecordInput(principal, confirmationId, input as McpTransactionDraftInput, dryRun),
    ) as Promise<Record<string, unknown>>,
  fingerprint: (preview) => approvalFingerprint(preview as unknown as RecordTransactionResult),
  /*
   * Alone among the operations, and only because of the idempotency key:
   * `toRecordInput` sets `mcp:<confirmation id>`, so a second attempt with the
   * same confirmation lands on the same ledger row rather than a second one.
   * That is what makes handing the claim back on a failed write safe here.
   */
  retryable: true,
};

function toRecordInput(
  principal: Principal,
  confirmationId: string,
  input: McpTransactionDraftInput,
  dryRun: boolean,
) {
  return {
    householdId: principal.householdId,
    kind: input.kind,
    amount: input.amount,
    currency: input.currency,
    account: input.account,
    toAccount: input.to_account,
    toAmount: input.to_amount,
    category: input.category,
    description: input.description,
    occurredOn: input.occurred_on,
    notes: input.notes,
    rate: input.rate,
    rateSource: input.rate_source,
    paymentMethod: input.payment_method,
    confidence: input.confidence,
    attachmentPath: input.attachment_path,
    items: input.items,
    // A conversation must stop on an accidental duplicate and let the person
    // decide whether it truly is another purchase.
    onDuplicate: input.allow_duplicate ? ("warn" as const) : ("reject" as const),
    source: "mcp" as const,
    sourceRef: confirmationId,
    createdByUserId: principal.userId,
    createdViaTokenId: principal.tokenId ?? undefined,
    /*
     * WHICH credential wrote it, not just that MCP did.
     *
     * An OAuth principal is not a row in `api_tokens`, so `created_via_token_id`
     * is null for it and the entry would carry no trace of the client at all.
     * The confirmation row knows, but that one is deliberately transient — see
     * `purgeExpiredConfirmations`. This column is where the durable answer goes.
     */
    createdByAgent: principal.credentialId,
    idempotencyKey: `mcp:${confirmationId}`,
    dryRun,
  };
}

/** Values that can change the financial outcome after a preview. */
function approvalFingerprint(preview: RecordTransactionResult): string {
  const match = (value: RecordTransactionResult["resolved"]["account"]) =>
    value
      ? { id: value.id, name: value.name, currency: value.currency, score: value.score, via: value.via }
      : null;

  return JSON.stringify({
    kind: preview.kind,
    occurredOn: preview.occurredOn,
    description: preview.description,
    amount: { minor: preview.amount.minor, currency: preview.amount.currency },
    base: {
      currency: preview.base.currency,
      officialMinor: preview.base.officialMinor,
      parallelMinor: preview.base.parallelMinor,
      manualMinor: preview.base.manualMinor,
      usedMinor: preview.base.usedMinor,
      sourceUsed: preview.base.sourceUsed,
    },
    rates: {
      official: preview.rates.official,
      parallel: preview.rates.parallel,
      manual: preview.rates.manual,
      effectiveOn: preview.rates.effectiveOn,
      stale: preview.rates.stale,
    },
    // `jsonb` does not preserve object-key order. Pick and order the fields
    // explicitly so the persisted preview compares by value, not serialization.
    resolved: {
      account: match(preview.resolved.account),
      toAccount: match(preview.resolved.toAccount),
      category: preview.resolved.category
        ? {
            id: preview.resolved.category.id,
            name: preview.resolved.category.name,
            score: preview.resolved.category.score,
            via: preview.resolved.category.via,
          }
        : null,
    },
    needsReview: preview.needsReview,
    items: preview.items.map((item) => ({
      product: item.product,
      quantity: item.quantity,
      unit: item.unit,
      total: item.total,
      isNew: item.isNew,
    })),
    unitemizedMinor: preview.unitemizedMinor,
    warnings: preview.warnings,
  });
}
