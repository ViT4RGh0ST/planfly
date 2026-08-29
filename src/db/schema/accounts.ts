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
    /**
     * The brand this is a branch of. Two levels, like the categories.
     *
     * A chain is not one place: two branches of the same shop can price the same
     * product differently, and folding them into one row makes the price series
     * average two shops and call it one. Splitting them with nothing joining them
     * loses the other question — what the whole chain costs you in a month.
     *
     * The parent is the brand («Farmatodo»), the children are the branches
     * («Farmatodo La Trinidad»). A brand carries no purchases of its own.
     */
    parentId: uuid("parent_id").references((): AnyPgColumn => payees.id, {
      onDelete: "set null",
    }),
    /**
     * The fiscal id, normalised: "J-30012345-6" is stored "J300123456".
     *
     * It identifies the COMPANY, which is not the same as the shop. In a
     * franchise every branch is a different company with its own; in a chain of
     * its own they all share one. So it is not unique by itself — two rows
     * carrying it are flagged when they are written, not forbidden by an index
     * that would refuse a legitimate second branch.
     *
     * It is still the best thing to match a receipt on. The name is printed
     * three ways on three receipts and the address changes when it moves.
     */
    taxId: text("tax_id"),
    /** As the receipt prints it. Text, because an address is not data to compute with. */
    address: text("address"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("payees_slug_unique").on(t.householdId, t.slug),
    index("payees_tax_id_idx").on(t.householdId, t.taxId),
    index("payees_parent_idx").on(t.parentId),
    check("payees_not_own_parent", sql`${t.parentId} is distinct from ${t.id}`),
  ],
);
