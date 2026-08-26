import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { user } from "./auth";
import { apiTokens, households } from "./tenancy";

/**
 * A confirmation is data, not a sentence in an agent prompt. MCP requests are
 * stateless, so a draft must survive retries, a process replacement, and a
 * hand-off between compatible MCP clients.
 */
export const mcpPendingOperations = pgTable(
  "mcp_pending_operations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    householdId: uuid("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    tokenId: uuid("token_id")
      .references(() => apiTokens.id, { onDelete: "cascade" }),
    /**
     * Binds a confirmation to its credential, including OAuth clients which
     * are not rows in api_tokens. It is server-derived, never tool input.
     */
    credentialId: text("credential_id").notNull(),
    /** Kept as text so future confirmation-gated operations do not need a migration. */
    operation: text("operation").notNull(),
    /** The validated input, never untrusted wire data. */
    payload: jsonb("payload").notNull(),
    /** The preview that the person approved; used to detect a changed outcome. */
    preview: jsonb("preview").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("mcp_pending_operations_lookup_idx").on(
      t.id,
      t.householdId,
      t.userId,
      t.credentialId,
    ),
    index("mcp_pending_operations_expiry_idx").on(t.expiresAt),
  ],
);
