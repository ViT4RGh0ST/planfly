import { and, eq, gt, isNull } from "drizzle-orm";

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
    createdViaTokenId: principal.tokenId,
    createdByAgent: "mcp",
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
        eq(mcpPendingOperations.tokenId, principal.tokenId),
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

  const result = await recordTransaction(toRecordInput(principal, pending.id, payload.input, false));
  const [confirmed] = await db
    .update(mcpPendingOperations)
    .set({ confirmedAt: new Date() })
    .where(
      and(eq(mcpPendingOperations.id, pending.id), isNull(mcpPendingOperations.confirmedAt)),
    )
    .returning({ id: mcpPendingOperations.id });

  if (!confirmed) {
    // The idempotency key above guarantees that a racing retry does not create
    // a second ledger entry; it is nevertheless an integration error worth
    // surfacing rather than pretending this caller committed it.
    throw new McpConfirmationError("Confirmation was already used.", "already_confirmed");
  }

  return result;
}
