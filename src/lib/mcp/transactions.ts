import { and, eq, gt, isNull, lt } from "drizzle-orm";

import { db } from "@/db";
import { mcpPendingOperations } from "@/db/schema";
import type { Principal } from "@/lib/api-token";
import {
  mcpTransactionDraftSchema,
  type McpTransactionDraftInput,
} from "@/lib/validation";
import {
  recordTransaction,
  type RecordTransactionResult,
} from "@/lib/services/record-transaction";

const CONFIRMATION_TTL_MS = 15 * 60 * 1_000;

type PendingTransaction = {
  input: McpTransactionDraftInput;
};

export class McpConfirmationError extends Error {
  constructor(
    message: string,
    readonly code: "not_found" | "expired" | "already_confirmed" | "preview_changed",
    readonly preview?: RecordTransactionResult,
  ) {
    super(message);
  }
}

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
      bcvMinor: preview.base.bcvMinor,
      p2pMinor: preview.base.p2pMinor,
      manualMinor: preview.base.manualMinor,
      usedMinor: preview.base.usedMinor,
      sourceUsed: preview.base.sourceUsed,
    },
    rates: {
      bcv: preview.rates.bcv,
      p2p: preview.rates.p2p,
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

export async function previewMcpTransaction(
  principal: Principal,
  rawInput: unknown,
): Promise<{ confirmationId: string; expiresAt: string; preview: RecordTransactionResult }> {
  const input = mcpTransactionDraftSchema.parse(rawInput);

  /*
   * Insert first to obtain the id which becomes the idempotency key and audit
   * reference. A failed simulation is removed so it can never be confirmed.
   */
  const [pending] = await db
    .insert(mcpPendingOperations)
    .values({
      householdId: principal.householdId,
      userId: principal.userId,
      tokenId: principal.tokenId,
      credentialId: principal.credentialId,
      operation: "record_transaction",
      payload: { input } satisfies PendingTransaction,
      preview: {},
      expiresAt: new Date(Date.now() + CONFIRMATION_TTL_MS),
    })
    .returning({ id: mcpPendingOperations.id, expiresAt: mcpPendingOperations.expiresAt });

  try {
    const preview = await recordTransaction(toRecordInput(principal, pending.id, input, true));
    await db
      .update(mcpPendingOperations)
      .set({ preview })
      .where(eq(mcpPendingOperations.id, pending.id));
    return { confirmationId: pending.id, expiresAt: pending.expiresAt.toISOString(), preview };
  } catch (error) {
    await db.delete(mcpPendingOperations).where(eq(mcpPendingOperations.id, pending.id));
    throw error;
  }
}

export async function confirmMcpTransaction(
  principal: Principal,
  confirmationId: string,
): Promise<RecordTransactionResult> {
  const [pending] = await db
    .select()
    .from(mcpPendingOperations)
    .where(
      and(
        eq(mcpPendingOperations.id, confirmationId),
        eq(mcpPendingOperations.householdId, principal.householdId),
        eq(mcpPendingOperations.userId, principal.userId),
        eq(mcpPendingOperations.credentialId, principal.credentialId),
      ),
    )
    .limit(1);

  if (!pending) throw new McpConfirmationError("Confirmation was not found.", "not_found");
  if (pending.confirmedAt) {
    throw new McpConfirmationError("Confirmation was already used.", "already_confirmed");
  }
  if (pending.expiresAt <= new Date()) {
    throw new McpConfirmationError("Confirmation expired. Create a fresh preview.", "expired");
  }
  if (pending.operation !== "record_transaction") {
    throw new McpConfirmationError("Confirmation operation is not supported.", "not_found");
  }

  const payload = pending.payload as PendingTransaction;
  const preview = pending.preview as RecordTransactionResult;
  const refreshed = await recordTransaction(
    toRecordInput(principal, pending.id, payload.input, true),
  );

  /*
   * A rate, account match or duplicate warning may have changed while the
   * person was reviewing. Store the fresh preview and require another explicit
   * confirmation rather than recording a different financial outcome.
   */
  if (approvalFingerprint(preview) !== approvalFingerprint(refreshed)) {
    await db
      .update(mcpPendingOperations)
      .set({ preview: refreshed })
      .where(
        and(
          eq(mcpPendingOperations.id, pending.id),
          isNull(mcpPendingOperations.confirmedAt),
          gt(mcpPendingOperations.expiresAt, new Date()),
        ),
      );
    throw new McpConfirmationError(
      "The preview changed; review the refreshed result and confirm it again.",
      "preview_changed",
      refreshed,
    );
  }

  /*
   * Claim before writing. The previous order wrote first and only then marked
   * the confirmation consumed, which made concurrent confirms race through the
   * ledger path. The conditional update makes one caller the sole writer.
   */
  const claimedAt = new Date();
  const [confirmed] = await db
    .update(mcpPendingOperations)
    .set({ confirmedAt: claimedAt })
    .where(
      and(
        eq(mcpPendingOperations.id, pending.id),
        isNull(mcpPendingOperations.confirmedAt),
        gt(mcpPendingOperations.expiresAt, claimedAt),
      ),
    )
    .returning({ id: mcpPendingOperations.id });

  if (!confirmed) {
    // The idempotency key above guarantees that a racing retry does not create
    // a second ledger entry; it is nevertheless an integration error worth
    // surfacing rather than pretending this caller committed it.
    throw new McpConfirmationError("Confirmation was already used.", "already_confirmed");
  }

  try {
    return await recordTransaction(toRecordInput(principal, pending.id, payload.input, false));
  } catch (error) {
    // Do not strand an approval if the write failed before the service could
    // commit. The idempotency key still prevents duplicate ledger rows.
    await db
      .update(mcpPendingOperations)
      .set({ confirmedAt: null })
      .where(
        and(
          eq(mcpPendingOperations.id, pending.id),
          eq(mcpPendingOperations.confirmedAt, claimedAt),
        ),
      );
    throw error;
  }
}

/**
 * Confirmations are a handshake, not a record.
 *
 * Nothing else deleted them, and a preview is written before EVERY proposed
 * write — including the ones the person turns down. The table would grow with no
 * ceiling, and each row carries the whole draft and the whole preview: amounts,
 * rates, account names, the lines of a receipt. That is the ledger's content
 * again, in a table nobody audits and nothing ages out.
 *
 * Once expired there is nothing left to answer: what became money is in the
 * ledger, with the credential that wrote it in `created_by_agent` and this
 * confirmation's id in `source_ref`. `source_ref` is a reference and not a
 * foreign key, so it stays readable and stays unique after the row is gone.
 */
export async function purgeExpiredConfirmations(): Promise<number> {
  const gone = await db
    .delete(mcpPendingOperations)
    .where(lt(mcpPendingOperations.expiresAt, new Date()))
    .returning({ id: mcpPendingOperations.id });
  return gone.length;
}
