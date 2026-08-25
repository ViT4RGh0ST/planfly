import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  date,
  index,
  jsonb,
  numeric,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import {
  entrySourceEnum,
  paymentMethodEnum,
  rateSourceUsedEnum,
  transactionKindEnum,
} from "./enums";
import { apiTokens, households } from "./tenancy";
import { accounts, categories, payees } from "./accounts";
import { exchangeRates } from "./reference";
import { user } from "./auth";

/**
 * Entry header.
 *
 * The ledger is **header + lines**, not loose signed rows nor full double-entry.
 * The deciding reason is the cross-currency transfer: taking 100 USD out of
 * Zelle and putting 85.900 Bs into Provincial are two different amounts, each
 * with its own currency and rate. A single row with a single amount would have
 * to lie about one of the two sides.
 */
export const transactions = pgTable(
  "transactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    householdId: uuid("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    kind: transactionKindEnum("kind").notNull(),
    /** DATE in the household's timezone, not a timestamp: "today's spending"
     *  queried in UTC drifts 4 hours every night in Caracas. */
    occurredOn: date("occurred_on").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }),
    description: text("description").notNull(),
    notes: text("notes"),
    /**
     * Which rail the money left by. Null = it wasn't said.
     *
     * It is inferred on its own when the account leaves no doubt — cash is paid
     * from in cash, crypto in crypto — and stays null when it does: a bank
     * account is paid from by card, by mobile payment or by transfer, and
     * guessing there would invent the datum we wanted to measure.
     */
    paymentMethod: paymentMethodEnum("payment_method"),
    payeeId: uuid("payee_id").references(() => payees.id, { onDelete: "set null" }),

    // ── Provenance: the audit trail lives on the row, with no separate table ──
    source: entrySourceEnum("source").notNull(),
    /** Telegram message id, CSV row number, etc. */
    sourceRef: text("source_ref"),
    createdByUserId: text("created_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    createdViaTokenId: uuid("created_via_token_id").references(() => apiTokens.id, {
      onDelete: "set null",
    }),
    /** The model that generated it, when it came from the AI. */
    createdByAgent: text("created_by_agent"),
    /** The model's self-assessment, 0..1. NULL when a person wrote it. */
    confidence: numeric("confidence", { precision: 4, scale: 3 }),
    needsReview: boolean("needs_review").notNull().default(false),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewedById: text("reviewed_by_id").references(() => user.id, { onDelete: "set null" }),
    /** The exact parameters the tool sent / the raw CSV row / the OCR's JSON.
     *  Lets any odd row be explained months later. */
    raw: jsonb("raw"),
    attachmentPath: text("attachment_path"),

    /**
     * Idempotency. Protects against the client retrying: two POSTs with the same
     * key return the same row instead of duplicating the expense.
     */
    idempotencyKey: text("idempotency_key"),

    importBatchId: uuid("import_batch_id"),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidReason: text("void_reason"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // PARTIAL unique index: it only applies when there is a key. It is what
    // Prisma cannot express and why this project uses Drizzle.
    uniqueIndex("transactions_idempotency_unique")
      .on(t.householdId, t.idempotencyKey)
      .where(sql`${t.idempotencyKey} is not null`),
    index("transactions_household_date_idx").on(t.householdId, t.occurredOn.desc()),
    index("transactions_needs_review_idx")
      .on(t.householdId)
      .where(sql`${t.needsReview} and ${t.voidedAt} is null`),
    index("transactions_source_idx").on(t.householdId, t.source),
    check(
      "transactions_confidence_range",
      sql`${t.confidence} is null or (${t.confidence} >= 0 and ${t.confidence} <= 1)`,
    ),
  ],
);

/**
 * The entry's legs. One for expense/income/adjustment, two for transfer.
 *
 * Each line stores **both rates of the day** (BCV and P2P) and both amounts
 * already converted to the base currency. That way valuing the whole portfolio
 * with one source or the other is adding up a different column, with no joins
 * and no recomputation — which is exactly what the dashboard's BCV/P2P selector
 * asks for.
 */
export const transactionEntries = pgTable(
  "transaction_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    transactionId: uuid("transaction_id")
      .notNull()
      .references(() => transactions.id, { onDelete: "cascade" }),
    /** Denormalised on purpose: nearly every aggregation filters by household and
     *  this saves joining with the header. */
    householdId: uuid("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "restrict" }),
    /** NULL on a transfer's legs: moving money between your own accounts is not
     *  an expense and counting it as one would inflate the reports. */
    categoryId: uuid("category_id").references(() => categories.id, { onDelete: "set null" }),

    /** Signed, in the ACCOUNT's currency. Negative = leaves the account. */
    amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
    currency: varchar("currency", { length: 10 }).notNull(),

    // ── Double rate snapshot (NULL when the line is already in base currency) ──
    baseCurrency: varchar("base_currency", { length: 10 }).notNull(),
    rateBcv: numeric("rate_bcv", { precision: 24, scale: 10 }),
    rateP2p: numeric("rate_p2p", { precision: 24, scale: 10 }),
    rateManual: numeric("rate_manual", { precision: 24, scale: 10 }),
    rateBcvId: uuid("rate_bcv_id").references(() => exchangeRates.id, { onDelete: "set null" }),
    rateP2pId: uuid("rate_p2p_id").references(() => exchangeRates.id, { onDelete: "set null" }),
    rateSourceUsed: rateSourceUsedEnum("rate_source_used").notNull().default("none"),
    /** The rate applied is not from the entry's date (none was available). */
    rateStale: boolean("rate_stale").notNull().default(false),

    /** Amounts already converted, immutable: it is what it cost THAT day.
     *  Revaluing the net position at today's rate is a different query (see reports). */
    baseAmountBcvMinor: bigint("base_amount_bcv_minor", { mode: "number" }),
    baseAmountP2pMinor: bigint("base_amount_p2p_minor", { mode: "number" }),
    baseAmountManualMinor: bigint("base_amount_manual_minor", { mode: "number" }),

    memo: text("memo"),
    sortOrder: smallint("sort_order").notNull().default(0),
  },
  (t) => [
    index("entries_transaction_idx").on(t.transactionId),
    index("entries_account_idx").on(t.householdId, t.accountId),
    index("entries_category_idx").on(t.householdId, t.categoryId),
    check("entries_amount_not_zero", sql`${t.amountMinor} <> 0`),
    // The ceiling that makes reading as a `number` instead of a `bigint` safe.
    check("entries_amount_safe", sql`abs(${t.amountMinor}) < 9007199254740991`),
  ],
);
