import {
  bigint,
  boolean,
  date,
  index,
  jsonb,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { budgetPeriodEnum } from "./enums";
import { households } from "./tenancy";
import { categories } from "./accounts";
import { currencies } from "./reference";

export const budgets = pgTable(
  "budgets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    householdId: uuid("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    categoryId: uuid("category_id")
      .notNull()
      .references(() => categories.id, { onDelete: "cascade" }),
    period: budgetPeriodEnum("period").notNull().default("monthly"),
    /** First day of the period: 2026-08-01 for August, 2026-01-01 for the year. */
    periodStart: date("period_start").notNull(),
    /**
     * First day OUTSIDE the period, like every other range in the app: August is
     * [08-01, 09-01). Storing it rather than deriving it from `period` is what
     * lets ranges exist that are neither month nor year — a fortnight, a ten-day
     * trip — without every query having to know how to compute them.
     */
    periodEnd: date("period_end").notNull(),
    amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
    /** Normally the household's base currency: budgeting in bolívares with
     *  Venezuela's inflation forces rewriting the number every month. */
    currency: varchar("currency", { length: 10 })
      .notNull()
      .references(() => currencies.code),
    /** What went unspent carries over to the next period. */
    rollover: boolean("rollover").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("budgets_unique").on(t.householdId, t.categoryId, t.period, t.periodStart),
    index("budgets_household_idx").on(t.householdId, t.periodStart),
  ],
);

/** A snapshot of net worth at a date, with both valuations. It feeds the
 *  evolution chart without recomputing the whole history on every load. */
export const netWorthSnapshots = pgTable(
  "net_worth_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    householdId: uuid("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    snapshotOn: date("snapshot_on").notNull(),
    baseCurrency: varchar("base_currency", { length: 10 }).notNull(),
    totalOfficialMinor: bigint("total_official_minor", { mode: "number" }),
    totalParallelMinor: bigint("total_parallel_minor", { mode: "number" }),
    /** Per-account breakdown, so a jump in the curve can be explained. */
    breakdown: jsonb("breakdown"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("net_worth_snapshots_unique").on(t.householdId, t.snapshotOn)],
);
