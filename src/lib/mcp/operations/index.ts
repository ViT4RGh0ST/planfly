import type { McpOperation } from "@/lib/mcp/operation";
import { recordTransactionOperation } from "./record-transaction";

/**
 * Everything a confirmation can hold, in one place.
 *
 * `mcp_pending_operations.operation` is text and not an enum precisely so this
 * list can grow without a migration; what may not grow is the number of places
 * that decide whether a confirmation is valid. A tool that needs a second step
 * adds a line here and calls `previewMcpOperation` — it does not go near the
 * table, and `operations-guard.test.ts` refuses one that does.
 */
export const MCP_OPERATIONS: Record<string, McpOperation> = {
  record_transaction: recordTransactionOperation,
};
