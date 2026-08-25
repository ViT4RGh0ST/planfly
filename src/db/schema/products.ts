import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { productBaseUnitEnum } from "./enums";
import { households } from "./tenancy";
import { categories } from "./accounts";
import { currencies } from "./reference";
import { transactions } from "./ledger";

/**
 * Products and the breakdown of what you bought.
 *
 * A grocery invoice is not a Bs 340 expense: it is fourteen things, and what you
 * genuinely want to know afterwards is **whether flour went up**. In a country
 * with inflation and a rate moving every day, that question is not answered by
 * looking at the receipt total.
 *
 * Two rules holding up the rest:
 *
 * 1. **The total rules, the breakdown informs.** The lines do NOT have to add up
 *    to the entry total: an invoice carries VAT, discounts and lines the OCR
 *    could not read. The entry is worth what the receipt says and the difference
 *    is shown rather than hidden or used to block the record.
 *
 * 2. **The price is stored in both currencies**, with the dollar equivalent at
 *    THAT DAY's rate. "Flour: Bs 40 → Bs 55" does not say whether it went up or
 *    the rate merely moved; in dollars it does. Same double valuation as the rest.
 */

export const products = pgTable(
  "products",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    householdId: uuid("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    /**
     * Other ways it shows up on receipts: "H.PAN 1KG", "harina pan". It is what
     * makes two different purchases land in the same price series, with the same
     * machinery that already resolves accounts and categories.
     */
    aliases: text("aliases").array().notNull().default(sql`ARRAY[]::text[]`),
    /**
     * The unit its price is compared in. A product that sometimes comes by the
     * kilo and sometimes in a 500 g pack can only be tracked if both purchases
     * are carried to the same base.
     */
    baseUnit: productBaseUnitEnum("base_unit").notNull().default("unit"),
    /** Optional: which spending category it usually goes to. Saves typing it. */
    categoryId: uuid("category_id").references(() => categories.id, {
      onDelete: "set null",
    }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("products_slug_unique").on(t.householdId, t.slug),
    index("products_household_idx").on(t.householdId),
  ],
);

export const transactionItems = pgTable(
  "transaction_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    householdId: uuid("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    transactionId: uuid("transaction_id")
      .notNull()
      .references(() => transactions.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    /**
     * What the receipt said, word for word.
     *
     * It is provenance, not decoration: when matching gets it wrong — and with a
     * blurry thermal receipt it will — this is the only thing that lets you see
     * what it actually read and fix it without digging out the photo again.
     */
    rawText: text("raw_text"),
    /** Quantity exactly as it came: 2, 0.5, 750. */
    quantity: numeric("quantity", { precision: 14, scale: 4 }).notNull(),
    /** Unit exactly as it came: "kg", "g", "und", "l". Untranslated. */
    unit: text("unit"),
    /**
     * The same quantity carried to the product's base unit.
     *
     * 750 g of a product tracked by the kilo is 0.75. It is what lets you
     * compare "500 g at Bs 150" with "1 kg at Bs 280" without the chart lying.
     */
    baseQuantity: numeric("base_quantity", { precision: 14, scale: 4 }).notNull(),
    /** What the whole line cost, in the entry's currency. */
    totalMinor: bigint("total_minor", { mode: "number" }).notNull(),
    currency: varchar("currency", { length: 10 })
      .notNull()
      .references(() => currencies.code),
    /**
     * The base-currency equivalent at THAT day's rate, from both sources.
     *
     * Precomputed just like the ledger lines: the price chart adds up a column
     * instead of reconverting fourteen rows per purchase.
     */
    baseAmountBcvMinor: bigint("base_amount_bcv_minor", { mode: "number" }),
    baseAmountP2pMinor: bigint("base_amount_p2p_minor", { mode: "number" }),
    /** How sure the match was. Below the threshold, off to review. */
    confidence: numeric("confidence", { precision: 4, scale: 3 }),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("transaction_items_transaction_idx").on(t.transactionId),
    // The index for the question actually asked: how this product's price has
    // moved over time.
    index("transaction_items_product_idx").on(t.householdId, t.productId),
    check("transaction_items_quantity_positive", sql`${t.quantity} > 0`),
    check("transaction_items_base_quantity_positive", sql`${t.baseQuantity} > 0`),
    // A zero line says nothing about any price, and dividing by it to get the
    // unit price would give infinity.
    check("transaction_items_total_positive", sql`${t.totalMinor} > 0`),
  ],
);
