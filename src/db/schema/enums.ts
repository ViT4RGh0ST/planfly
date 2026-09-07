import { pgEnum } from "drizzle-orm/pg-core";

/** Source of an exchange rate. `manual` is the one the user writes by hand. */
export const rateSourceEnum = pgEnum("rate_source", ["official", "parallel", "manual"]);

/** Which of the stamped rates valued this line. `none` = the line is already
 *  in the base currency, or there was no rate when it was recorded. */
export const rateSourceUsedEnum = pgEnum("rate_source_used", ["official", "parallel", "manual", "none"]);

export const householdRoleEnum = pgEnum("household_role", ["owner", "member", "viewer"]);

export const accountTypeEnum = pgEnum("account_type", [
  "cash",
  "bank",
  "crypto",
  "investment",
  "credit_card",
  /**
   * Prepaid: it is loaded before you spend, so it is an ASSET.
   *
   * It is not a `credit_card` under another name: that one is debt and subtracts
   * from net worth. Here the money already left another account of yours and is
   * waiting on the card, just like in a wallet. Putting it under `credit_card`
   * subtracted the same thing twice; putting it under `bank` worked, but lost
   * the distinction needed to know how much you have loaded.
   */
  "prepaid",
  "loan",
  "other",
]);

/** `asset` adds to the net position; `liability` subtracts. It is what turns
 *  the total into net worth and not "the money I have". */
export const accountNatureEnum = pgEnum("account_nature", ["asset", "liability"]);

/** How often an installment falls due. Cashea runs biweekly; a loan, monthly. */
export const financingFrequencyEnum = pgEnum("financing_frequency", ["biweekly", "monthly"]);

/**
 * The unit a product's price is compared in.
 *
 * Three and no more: weight, volume and count. Whatever is sold by the gram or
 * the millilitre is carried to kilo and litre on the way in, because a price
 * series mixing units compares nothing.
 */
export const productBaseUnitEnum = pgEnum("product_base_unit", ["kg", "l", "unit"]);

/**
 * How it was paid, which is NOT the same as where it came from.
 *
 * Mobile payment is not an account: it is a rail. The money leaves the same bank
 * account whether you pay by card, by transfer or by mobile payment, and
 * modelling it as an account would leave the bank balance missing what you paid
 * that way. But knowing which rail it went by is useful, and that is this column.
 *
 * `zelle` goes separately from `transfer` because here it is spoken of as a
 * different thing, not as "one more transfer".
 */
export const paymentMethodEnum = pgEnum("payment_method", [
  "cash",
  "card",
  "mobile_payment",
  "transfer",
  "zelle",
  "crypto",
  "other",
]);

export const categoryKindEnum = pgEnum("category_kind", ["expense", "income"]);

export const transactionKindEnum = pgEnum("transaction_kind", [
  "expense",
  "income",
  "transfer",
  "adjustment",
]);

/** Which way the entry came in. It is half of the audit trail. */
export const entrySourceEnum = pgEnum("entry_source", [
  "telegram",
  "form",
  "csv",
  "ocr",
  "mcp",
  "api",
  "recurring",
]);

/**
 * `biweekly` is the Venezuelan fortnight — the 1st to the 15th and the 16th to
 * month end — which is the real rhythm at which people get paid and spend here.
 * `custom` is any other range: a trip, some building work, two weeks of holiday.
 */
export const budgetPeriodEnum = pgEnum("budget_period", [
  "monthly",
  "biweekly",
  "yearly",
  "custom",
]);

export const importStatusEnum = pgEnum("import_status", [
  "pending",
  "mapped",
  "previewed",
  "imported",
  "failed",
]);

export const importRowStatusEnum = pgEnum("import_row_status", [
  "new",
  "duplicate",
  "imported",
  "skipped",
  "error",
]);

export const ruleFieldEnum = pgEnum("rule_field", ["description", "payee", "amount"]);
export const ruleOperatorEnum = pgEnum("rule_operator", ["contains", "equals", "regex"]);

/**
 * A recurring operation's rhythm.
 *
 * All three are stored the same way — a list of days of the month — and this
 * only says which words it was thought of in, so the screen offers the right
 * preset and so we can say «fortnightly» instead of «on the 15th and the last».
 */
export const recurrenceCadenceEnum = pgEnum("recurrence_cadence", [
  "monthly",
  "biweekly",
  "custom",
]);
