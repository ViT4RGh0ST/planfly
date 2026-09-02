import { and, eq, gt, isNull, lt } from "drizzle-orm";

import { db } from "@/db";
import { mcpPendingOperations } from "@/db/schema";
import type { Principal } from "@/lib/api-token";
import { McpConfirmationError } from "@/lib/mcp/operation";
import { MCP_OPERATIONS } from "@/lib/mcp/operations";
import { mcpTransactionDraftSchema } from "@/lib/validation";
import type { RecordTransactionResult } from "@/lib/services/record-transaction";

const CONFIRMATION_TTL_MS = 15 * 60 * 1_000;

/*
 * The mechanics of the handshake, and nothing about any one operation.
 *
 * Which operations there are lives in `@/lib/mcp/operations`; each supplies its
 * own `run` and its own `fingerprint`. What is here is the part that must never
 * be written twice: stage, expire, compare the fingerprint, claim before
 * writing.
 */
export { McpConfirmationError } from "@/lib/mcp/operation";
export type { McpOperation } from "@/lib/mcp/operation";

/**
 * Stages any confirmable operation. THE only way one is staged.
 *
 * Every tool that needs the gate reached for the table itself and wrote its own
 * insert, its own expiry check and its own claim-before-write. Four copies of
 * «claim before writing» is four chances for one of them to drop the atomic
 * claim or the fingerprint — and the failure that follows is an installment
 * paid twice, or a person approving one figure while another is written. There
 * is one copy.
 */
export async function previewMcpOperation(
  principal: Principal,
  operationName: string,
  input: unknown,
): Promise<{ confirmationId: string; expiresAt: string; preview: Record<string, unknown> }> {
  const operation = MCP_OPERATIONS[operationName];
  if (!operation) {
    throw new McpConfirmationError("Confirmation operation is not supported.", "not_found");
  }

  /*
   * Insert first to obtain the id, which becomes the idempotency key and the
   * audit reference. A simulation that fails is removed, so it can never be
   * confirmed.
   */
  const [pending] = await db
    .insert(mcpPendingOperations)
    .values({
      householdId: principal.householdId,
      userId: principal.userId,
      tokenId: principal.tokenId,
      credentialId: principal.credentialId,
      operation: operationName,
      payload: { input },
      preview: {},
      expiresAt: new Date(Date.now() + CONFIRMATION_TTL_MS),
    })
    .returning({ id: mcpPendingOperations.id, expiresAt: mcpPendingOperations.expiresAt });

  try {
    const preview = await operation.run(principal, input, pending.id, true);
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

/**
 * Staging an entry, which is `previewMcpOperation` with the draft parsed first.
 *
 * It used to be a second copy of the whole thing — its own insert, its own
 * delete-on-failure, its own TTL. Two copies of «write the row, simulate,
 * remove it if the simulation threw» is the arrangement where one of them keeps
 * a row that can still be confirmed after the simulation said no.
 */
export async function previewMcpTransaction(
  principal: Principal,
  rawInput: unknown,
): Promise<{ confirmationId: string; expiresAt: string; preview: RecordTransactionResult }> {
  const input = mcpTransactionDraftSchema.parse(rawInput);
  const staged = await previewMcpOperation(principal, "record_transaction", input);
  return { ...staged, preview: staged.preview as unknown as RecordTransactionResult };
}

/**
 * Confirms any staged operation, whichever it is.
 *
 * Nothing in here is specific to recording an entry: the operation is looked up
 * by the name the confirmation was staged under, and it supplies both its own
 * `run` and its own `fingerprint`. `confirmMcpTransaction` is this function with
 * the return value named.
 */
export async function confirmMcpOperation(
  principal: Principal,
  confirmationId: string,
  /**
   * Which operation(s) the CALLER believes it is confirming — a list, because a
   * tool that stages more than one kind (paying an instalment, recording a
   * financed purchase) confirms an id it staged without knowing which of its own
   * two it was. The property being enforced is that the confirmation belongs to
   * this tool, not that it is one exact operation.
   */
  expectedOperation: string | readonly string[],
): Promise<Record<string, unknown>> {
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
  /*
   * That this confirmation is for the thing being confirmed.
   *
   * The row is found by id and credential alone, and a credential holds several
   * at once: a preview the person turned down is still there, unclaimed, for
   * fifteen minutes. Without this, a tool handed the wrong id runs whatever that
   * id was staged for — its own fingerprint passes, because it is compared
   * against its own preview — and then reports it as its own success. The
   * declined expense gets written and the person is told the products were
   * merged.
   *
   * Each of the tools that hand-rolled this gate carried the check; centralising
   * the gate is what dropped it. It is a required argument and not an optional
   * one so that the next caller cannot omit it by accident.
   *
   * `not_found`, deliberately, and the same sentence: which operation an id was
   * staged for is not something a caller needs told, and answering differently
   * would make the refusal a way to enumerate what else is pending.
   */
  const expected =
    typeof expectedOperation === "string" ? [expectedOperation] : expectedOperation;
  if (!expected.includes(pending.operation)) {
    throw new McpConfirmationError("Confirmation was not found.", "not_found");
  }

  const operation = MCP_OPERATIONS[pending.operation];
  if (!operation) {
    throw new McpConfirmationError("Confirmation operation is not supported.", "not_found");
  }

  const payload = pending.payload as { input: unknown };
  const preview = pending.preview as Record<string, unknown>;
  const refreshed = await operation.run(principal, payload.input, pending.id, true);

  /*
   * A rate, account match or duplicate warning may have changed while the
   * person was reviewing. Store the fresh preview and require another explicit
   * confirmation rather than recording a different financial outcome.
   */
  /*
   * A stored preview this operation can no longer read counts as changed.
   *
   * The shape of a preview is the operation's own, and it moves when the
   * operation is improved — a confirmation staged fifteen minutes before a
   * deploy is read afterwards by the new code. Letting the fingerprint throw
   * turned that into «planfly could not complete the request», against which a
   * model can only retry the identical call. Treating it as changed shows the
   * refreshed figures and asks again, which is what actually happened.
   */
  const readable = (value: Record<string, unknown>): string | null => {
    try {
      return operation.fingerprint(value);
    } catch {
      return null;
    }
  };
  const approved = readable(preview);

  if (approved === null || approved !== operation.fingerprint(refreshed)) {
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
    return await operation.run(principal, payload.input, pending.id, false);
  } catch (error) {
    /*
     * The claim goes back ONLY to an operation that can survive running twice.
     *
     * It used to go back always, on the reasoning that an approval should not be
     * stranded by a write that never reached the database — with «the
     * idempotency key still prevents duplicate ledger rows» as the warrant. Only
     * `record_transaction` has that key.
     *
     * For the others the release was the bug. Recording a financed purchase is
     * three writes and only the third is in a transaction: a failure at the
     * second leaves the first committed, the claim goes back, the next confirm
     * writes that expense again — once per attempt, debt climbing, nothing
     * failing anywhere.
     *
     * So an operation that has not declared itself retryable keeps its
     * confirmation consumed and the person previews afresh. That is the loud
     * failure rather than the quiet one.
     */
    if (operation.retryable) {
      await db
        .update(mcpPendingOperations)
        .set({ confirmedAt: null })
        .where(
          and(
            eq(mcpPendingOperations.id, pending.id),
            eq(mcpPendingOperations.confirmedAt, claimedAt),
          ),
        );
    }
    throw error;
  }
}

/** The same thing, with the shape a transaction confirmation comes back in. */
export async function confirmMcpTransaction(
  principal: Principal,
  confirmationId: string,
): Promise<RecordTransactionResult> {
  return (await confirmMcpOperation(
    principal,
    confirmationId,
    "record_transaction",
  )) as unknown as RecordTransactionResult;
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
