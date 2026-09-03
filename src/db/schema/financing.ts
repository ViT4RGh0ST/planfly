import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  date,
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

import { financingFrequencyEnum } from "./enums";
import { households } from "./tenancy";
import { accounts } from "./accounts";
import { currencies } from "./reference";
import { transactions } from "./ledger";

/**
 * Financed purchases: Cashea and anyone else who lends, app or person.
 *
 * In Venezuela an installment purchase is not a rare case, it is routine: you
 * pay a down payment and the rest fortnightly. The ledger on its own already
 * knows how to record it — the whole purchase is charged to the financier's
 * account, which is a liability, and the down payment is a transfer towards it —
 * but that leaves out the only thing you genuinely need to know afterwards:
 * **how much is left and by when**.
 *
 * These two tables store exactly that and not one datum more. They do not repeat
 * amounts the ledger already has: what you owe comes from the account balance,
 * like any other. What lives here is the schedule.
 *
 * The rule that cannot be broken: **an installment is NOT an expense.** The
 * expense was counted on the day of the purchase, at its full value. Paying an
 * installment only moves money from your account to the debt. Counting it again
 * would duplicate the expense across every report — and with a Bs 4.000 purchase
 * in three installments, the month would show Bs 8.000 of spending that never
 * happened.
 */

/**
 * Which account is a financier, and how it finances you.
 *
 * The existence of this row IS the mark: a liability account with a profile
 * shows up in the financier list; without one it is just any debt — a mortgage,
 * what you owe a friend — and has no business being there.
 *
 * It duplicates no balance. What you owe is still the account's balance, which
 * is what already subtracts from net worth; what lives here is only what the
 * account does not know: how many installments and how much down payment it
 * usually finances you with.
 *
 * The down payment is stored as a PERCENTAGE because that is how it works: on
 * Cashea it depends on your tier — 40%, 30%, 20% — and applies to each price. A
 * fixed amount would fit no purchase except one.
 */
export const financierProfiles = pgTable(
  "financier_profiles",
  {
    accountId: uuid("account_id")
      .primaryKey()
      .references(() => accounts.id, { onDelete: "cascade" }),
    householdId: uuid("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    /** 40 = they ask for 40% up front. Null = no fixed custom. */
    downPaymentPercent: numeric("down_payment_percent", { precision: 5, scale: 2 }),
    defaultInstallments: integer("default_installments"),
    defaultFrequency: financingFrequencyEnum("default_frequency").notNull().default("biweekly"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("financier_profiles_household_idx").on(t.householdId),
    check(
      "financier_profiles_percent_range",
      sql`${t.downPaymentPercent} IS NULL OR (${t.downPaymentPercent} >= 0 AND ${t.downPaymentPercent} < 100)`,
    ),
    check(
      "financier_profiles_installments_positive",
      sql`${t.defaultInstallments} IS NULL OR ${t.defaultInstallments} > 0`,
    ),
  ],
);

export const financingPlans = pgTable(
  "financing_plans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    householdId: uuid("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    /** The expense that started it all. If voided, the plan loses its reason to be. */
    purchaseTransactionId: uuid("purchase_transaction_id")
      .notNull()
      .references(() => transactions.id, { onDelete: "cascade" }),
    /** The financier's liability account: "Cashea", "My brother". */
    financierAccountId: uuid("financier_account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "restrict" }),
    /** A copy of the purchase text, to avoid joining tables when listing. */
    description: text("description").notNull(),
    totalMinor: bigint("total_minor", { mode: "number" }).notNull(),
    /** What was paid up front. Informational: the entry is already in the ledger. */
    downPaymentMinor: bigint("down_payment_minor", { mode: "number" }).notNull().default(0),
    /**
     * The transfer that paid the down payment.
     *
     * It is stored so the whole purchase can be voided in one go. Finding it by
     * description would be guessing, and voiding a purchase halfway — the
     * expense yes, the down payment no — leaves the financier's balance worse
     * than before.
     */
    downPaymentTransactionId: uuid("down_payment_transaction_id").references(
      () => transactions.id,
      { onDelete: "set null" },
    ),
    currency: varchar("currency", { length: 10 })
      .notNull()
      .references(() => currencies.code),
    purchasedOn: date("purchased_on").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("financing_plans_household_idx").on(t.householdId),
    uniqueIndex("financing_plans_purchase_unique").on(t.purchaseTransactionId),
    check("financing_plans_total_positive", sql`${t.totalMinor} > 0`),
    check(
      "financing_plans_down_payment_range",
      sql`${t.downPaymentMinor} >= 0 AND ${t.downPaymentMinor} <= ${t.totalMinor}`,
    ),
  ],
);

export const installments = pgTable(
  "installments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    householdId: uuid("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    planId: uuid("plan_id")
      .notNull()
      .references(() => financingPlans.id, { onDelete: "cascade" }),
    /** 1, 2, 3… The order they fall due in, and how they get named in speech. */
    number: integer("number").notNull(),
    dueOn: date("due_on").notNull(),
    /** What leaves the account on the day: principal plus interest. */
    amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
    /**
     * How much of `amount_minor` is interest, and therefore is NOT a movement.
     *
     * The distinction is the whole reason this column exists. Paying an
     * instalment with no interest moves money from your account to the debt and
     * nothing is spent — the expense was counted on the day of the purchase.
     * Interest is not that: it is money that leaves and reduces no debt, so it
     * is a cost, and recording the whole payment as a transfer would pay down
     * the debt by more than was paid and hide the cost from every report.
     *
     * It defaults to zero, which is what every instalment written before this
     * column existed genuinely was: all principal.
     */
    interestMinor: bigint("interest_minor", { mode: "number" }).notNull().default(0),
    /**
     * The transfer that paid it. Null while it is pending.
     *
     * `set null` and not `cascade`: if the entry is voided, the installment goes
     * back to pending, which is exactly what actually happened. Deleting the
     * installment would leave the plan with an unexplainable hole.
     */
    paidTransactionId: uuid("paid_transaction_id").references(() => transactions.id, {
      onDelete: "set null",
    }),
    /**
     * The expense that paid the interest, when there was any.
     *
     * A payment with interest is two entries — the principal moves, the interest
     * is spent — and undoing has to reach both. Stored for the reason
     * `down_payment_transaction_id` is stored: finding it by description would
     * be guessing, and undoing halfway leaves the money out of the account with
     * the debt standing again, which is a false figure arrived at by pressing a
     * button that says «Undo».
     */
    interestTransactionId: uuid("interest_transaction_id").references(() => transactions.id, {
      onDelete: "set null",
    }),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    /**
     * Which day this installment was reminded about over Telegram.
     *
     * It is what makes the reminder idempotent: the heartbeat passes every
     * quarter of an hour and without this mark it would send the same reminder
     * four times an hour. A date is stored rather than a boolean because an
     * overdue installment is reminded about every day until it is paid.
     */
    remindedOn: date("reminded_on"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("installments_household_idx").on(t.householdId),
    // The index serving the question asked every day: what is falling due soon
    // and is still unpaid.
    index("installments_due_idx")
      .on(t.householdId, t.dueOn)
      .where(sql`paid_at IS NULL`),
    uniqueIndex("installments_plan_number_unique").on(t.planId, t.number),
    check("installments_amount_positive", sql`${t.amountMinor} > 0`),
    // Interest is a PART of the payment, never more than it. Above the payment
    // it would make the principal negative and the debt grow on being paid.
    check(
      "installments_interest_within_amount",
      sql`${t.interestMinor} >= 0 AND ${t.interestMinor} <= ${t.amountMinor}`,
    ),
    check("installments_number_positive", sql`${t.number} > 0`),
    // Paid means having both or neither: an installment with a payment date but
    // no entry would be money that left without being recorded anywhere.
    check(
      "installments_paid_consistent",
      sql`(${t.paidTransactionId} IS NULL) = (${t.paidAt} IS NULL)`,
    ),
  ],
);
