import type { Principal } from "@/lib/api-token";

/**
 * What a confirmable operation has to be able to do.
 *
 * The gate was written for one operation and hard-coded its name, so the four
 * other writes that need it — correcting an entry, paying an installment,
 * merging two products, catching a recurrence up — each arrived wanting to
 * widen the same `if`. Four widenings of one check is four chances for one of
 * them to skip the fingerprint, which is the part that stops a person approving
 * one figure and a different one being written.
 *
 * `run` with `dryRun` computes without storing. Not every service can do that —
 * `recordTransaction` is the only one that simulates itself — so an operation
 * that cannot must return, instead, a description of what it is about to
 * change, built from the state it depends on. The fingerprint is then over THAT
 * state: if the installment's amount or the account's balance moved between the
 * preview and the yes, the yes was for something else.
 *
 * This type and the error live apart from both the gate and the entries so that
 * the entries can import it without importing the gate, and the gate can import
 * the entries. A cycle between those two is a module that is half-initialised
 * the first time somebody reaches it.
 */
export type McpOperation = {
  run(
    principal: Principal,
    input: unknown,
    confirmationId: string,
    dryRun: boolean,
  ): Promise<Record<string, unknown>>;
  /** The values that, if they changed, mean the person approved something else. */
  fingerprint(preview: Record<string, unknown>): string;
};

export class McpConfirmationError extends Error {
  constructor(
    message: string,
    readonly code: "not_found" | "expired" | "already_confirmed" | "preview_changed",
    /** The refreshed preview, whatever shape that operation's previews have. */
    readonly preview?: Record<string, unknown>,
  ) {
    super(message);
  }
}
