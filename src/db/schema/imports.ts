import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import {
  importRowStatusEnum,
  importStatusEnum,
  recurrenceCadenceEnum,
  ruleFieldEnum,
  ruleOperatorEnum,
} from "./enums";
import { households } from "./tenancy";
import { accounts, categories, payees } from "./accounts";
import { transactions } from "./ledger";
import { user } from "./auth";

export const importBatches = pgTable(
  "import_batches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    householdId: uuid("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    fileName: text("file_name").notNull(),
    fileHash: text("file_hash").notNull(),
    status: importStatusEnum("status").notNull().default("pending"),
    /** Column mapping, remembered PER ACCOUNT: Provincial's CSV does not have the
     *  same layout as Banesco's, and reconfiguring it every time is unacceptable. */
    mapping: jsonb("mapping"),
    stats: jsonb("stats"),
    createdById: text("created_by_id").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("import_batches_household_idx").on(t.householdId, t.createdAt.desc())],
);

export const importRows = pgTable(
  "import_rows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    batchId: uuid("batch_id")
      .notNull()
      .references(() => importBatches.id, { onDelete: "cascade" }),
    rowIndex: integer("row_index").notNull(),
    raw: jsonb("raw").notNull(),
    /** sha256(account|date|amount|normalised description). Spots the row already
     *  imported in an earlier batch, which is the real case when downloading the
     *  monthly statement with overlap. */
    dedupeHash: text("dedupe_hash").notNull(),
    status: importRowStatusEnum("status").notNull().default("new"),
    transactionId: uuid("transaction_id").references(() => transactions.id, {
      onDelete: "set null",
    }),
    error: text("error"),
  },
  (t) => [
    uniqueIndex("import_rows_batch_index_unique").on(t.batchId, t.rowIndex),
    index("import_rows_dedupe_idx").on(t.dedupeHash),
  ],
);

/** Auto-categorisation. Applied on import and also when the bot is unsure,
 *  before sending the row to the review tray. */
export const categorizationRules = pgTable(
  "categorization_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    householdId: uuid("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    priority: integer("priority").notNull().default(100),
    field: ruleFieldEnum("field").notNull().default("description"),
    operator: ruleOperatorEnum("operator").notNull().default("contains"),
    pattern: text("pattern").notNull(),
    /** Limits the rule to one specific account (optional). */
    accountId: uuid("account_id").references(() => accounts.id, { onDelete: "cascade" }),
    setCategoryId: uuid("set_category_id").references(() => categories.id, {
      onDelete: "cascade",
    }),
    setPayeeId: uuid("set_payee_id").references(() => payees.id, { onDelete: "cascade" }),
    isActive: boolean("is_active").notNull().default(true),
    hits: integer("hits").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("categorization_rules_household_idx").on(t.householdId, t.priority)],
);

/**
 * Operations that repeat: rent, utilities, subscriptions, the fortnightly pay.
 *
 * The template is the same payload `recordTransaction` accepts, stored as-is.
 * That way a recurrence is not a separate write path: when its turn comes, it is
 * handed to the same place everything else goes through, with `source:
 * "recurring"`. A second path writing into the ledger on its own would end up
 * diverging from the first on the rules that matter — the rates, the transfer
 * invariant — and nobody would notice until an odd figure showed up.
 */
export const recurringRules = pgTable(
  "recurring_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    householdId: uuid("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** Payload identical to what recordTransaction() accepts, minus identity. */
    template: jsonb("template").notNull(),
    /** Only to know which preset to show: the real rhythm is the days. */
    cadence: recurrenceCadenceEnum("cadence").notNull().default("monthly"),
    /**
     * The days of the month it is due. `-1` is the last, be it 28, 30 or 31.
     *
     * Monthly is `{1}`, fortnightly `{15,-1}`, and your own way whatever you
     * choose. One model for all three rhythms: «every N days» was discarded
     * because it is not how people get paid here — the rent is due on the 5th,
     * not every 30 days — and after three months it would have drifted off the
     * calendar.
     */
    daysOfMonth: integer("days_of_month").array().notNull(),
    /** The next time it is due. It is the clock: the heartbeat looks at this, not the time. */
    nextRunOn: date("next_run_on").notNull(),
    /** The last one actually recorded. Null while none has run. */
    lastRunOn: date("last_run_on"),
    /** So we can say what is coming without having recorded it yet. */
    estimatedAmountMinor: bigint("estimated_amount_minor", { mode: "number" }),
    /** Paused, not deleted: the history of what it already recorded still makes sense. */
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("recurring_rules_household_idx").on(t.householdId, t.isActive),
    // The heartbeat always asks the same thing: which ones are already due.
    index("recurring_rules_due_idx").on(t.nextRunOn),
    check("recurring_rules_days_not_empty", sql`array_length(${t.daysOfMonth}, 1) >= 1`),
  ],
);
