import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

import { accountNatureEnum, accountTypeEnum, categoryKindEnum } from "./enums";
import { households } from "./tenancy";
import { currencies } from "./reference";

/**
 * The chart of real accounts. Categories are NOT accounts here (that would be
 * full double-entry); they are a dimension of the line. See ledger.ts.
 */
export const accounts = pgTable(
  "accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    householdId: uuid("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    type: accountTypeEnum("type").notNull(),
    /** `asset` adds to the net position, `liability` subtracts. Cards and loans
     *  are liabilities, and that is why the total is net worth and not "what I have". */
    nature: accountNatureEnum("nature").notNull().default("asset"),
    currency: varchar("currency", { length: 10 })
      .notNull()
      .references(() => currencies.code),
    openingBalanceMinor: bigint("opening_balance_minor", { mode: "number" }).notNull().default(0),
    openingDate: date("opening_date").notNull(),
    institution: text("institution"),
    /** Hints for the bot's fuzzy matching: ["efectivo","cash","bolos"]. */
    aliases: text("aliases").array().notNull().default(sql`ARRAY[]::text[]`),
    includeInNetWorth: boolean("include_in_net_worth").notNull().default(true),
    color: text("color"),
    icon: text("icon"),
    sortOrder: integer("sort_order").notNull().default(0),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("accounts_slug_unique").on(t.householdId, t.slug),
    index("accounts_household_idx").on(t.householdId),
    check(
      "accounts_opening_balance_safe",
      sql`abs(${t.openingBalanceMinor}) < 9007199254740991`,
    ),
  ],
);

export const categories = pgTable(
  "categories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    householdId: uuid("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    kind: categoryKindEnum("kind").notNull(),
    /** Self-referencing hierarchy. In practice the real depth is 2
     *  (comida > mercado, comida > comida callejera). */
    parentId: uuid("parent_id").references((): AnyPgColumn => categories.id, {
      onDelete: "set null",
    }),
    color: text("color").notNull().default("#64748b"),
    icon: text("icon"),
    aliases: text("aliases").array().notNull().default(sql`ARRAY[]::text[]`),
    sortOrder: integer("sort_order").notNull().default(0),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("categories_slug_unique").on(t.householdId, t.slug),
    index("categories_household_idx").on(t.householdId),
    check("categories_not_own_parent", sql`${t.parentId} is distinct from ${t.id}`),
  ],
);

/** Merchants and people. Learning that "Central Madeirense" is Mercado saves
 *  correcting the category every time. */
export const payees = pgTable(
  "payees",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    householdId: uuid("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    defaultCategoryId: uuid("default_category_id").references(() => categories.id, {
      onDelete: "set null",
    }),
    aliases: text("aliases").array().notNull().default(sql`ARRAY[]::text[]`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("payees_slug_unique").on(t.householdId, t.slug)],
);
