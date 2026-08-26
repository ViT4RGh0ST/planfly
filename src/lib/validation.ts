import { z } from "zod";

/**
 * Schemas shared between the API routes and the forms.
 *
 * Note what is NOT here: `householdId`, `userId` or any internal account or
 * category id. The client sends names; the server resolves. It is what makes it
 * impossible for the model to invent a foreign key or write into another household.
 */

export const amountSchema = z.union([z.string().min(1), z.number()]);

export const transactionKindSchema = z.enum(["expense", "income", "transfer", "adjustment"]);
export const entrySourceSchema = z.enum(["telegram", "form", "csv", "ocr", "mcp", "api", "recurring"]);
export const paymentMethodSchema = z.enum([
  "cash",
  "card",
  "mobile_payment",
  "transfer",
  "zelle",
  "crypto",
  "other",
]);

export const rateSourceSchema = z.enum(["bcv", "p2p", "manual"]);
export const valuationSchema = z.enum(["bcv", "p2p"]);

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "the date has to be YYYY-MM-DD");

/** An invoice's line items. Shared by creation and correction. */
export const itemsSchema = z
  .array(
    z.object({
      description: z.string().min(1).max(200),
      quantity: z.number().positive().optional(),
      unit: z.string().max(20).optional(),
      /** What the line cost, in MAJOR units: "1.234,56". */
      total: amountSchema,
    }),
  )
  .max(200)
  .optional();

export const createTransactionSchema = z.object({
  kind: transactionKindSchema.default("expense"),
  amount: amountSchema,
  currency: z.string().min(2).max(10).toUpperCase().optional(),
  account: z.string().min(1).optional(),
  to_account: z.string().min(1).optional(),
  to_amount: amountSchema.optional(),
  category: z.string().min(1).optional(),
  description: z.string().max(500).optional(),
  payee: z.string().max(200).optional(),
  occurred_on: isoDate.optional(),
  notes: z.string().max(2000).optional(),
  rate: z.union([z.string(), z.number()]).optional(),
  rate_source: rateSourceSchema.optional(),
  /** Which rail it left by: not the account, the how. */
  payment_method: paymentMethodSchema.optional(),
  source: entrySourceSchema.default("api"),
  source_ref: z.string().max(200).optional(),
  agent: z.string().max(200).optional(),
  confidence: z.number().min(0).max(1).optional(),
  attachment_path: z.string().max(500).optional(),
  dry_run: z.boolean().optional(),
  /**
   * "Yes, I know there is an identical one; this is another."
   *
   * Only whoever already got the `possible_duplicate` rejection sends it. It is
   * not a field to set out of habit: always setting it returns the system to
   * when five retries left five purchases.
   */
  allow_duplicate: z.boolean().optional(),
  /**
   * The invoice breakdown, if it was read from a photo.
   *
   * It does NOT have to add up to the total: a receipt carries VAT, discounts
   * and lines the OCR could not read. The entry is worth what the receipt says.
   */
  items: itemsSchema,
});

export type CreateTransactionInput = z.infer<typeof createTransactionSchema>;

/**
 * The agent supplies financial facts, never audit provenance. The MCP adapter
 * stamps source, token, user and confirmation id after this schema validates.
 */
export const mcpTransactionDraftSchema = createTransactionSchema
  .omit({ source: true, source_ref: true, agent: true, dry_run: true })
  .strict();

export type McpTransactionDraftInput = z.infer<typeof mcpTransactionDraftSchema>;

export const updateTransactionSchema = z.object({
  amount: amountSchema.optional(),
  category: z.string().min(1).optional(),
  account: z.string().min(1).optional(),
  description: z.string().max(500).optional(),
  occurred_on: isoDate.optional(),
  notes: z.string().max(2000).optional(),
  rate: z.union([z.string(), z.number()]).optional(),
  rate_source: rateSourceSchema.optional(),
  approve: z.boolean().optional(),
  // A transfer's two legs are corrected separately: across different currencies
  // they share neither amount nor rate, and treating them as one left the
  // destination untouched without saying so.
  to_account: z.string().min(1).optional(),
  to_amount: amountSchema.optional(),
  to_rate: z.union([z.string(), z.number()]).optional(),
  to_rate_source: rateSourceSchema.optional(),
  /**
   * The breakdown. `replace` sends the whole list; `append` adds to what is there.
   *
   * The mode is explicit and never guessed: «add the bread to it» names one
   * line, and treating it as the complete list would delete the other nine in
   * silence.
   */
  items: itemsSchema,
  items_mode: z.enum(["replace", "append"]).optional(),
});

/**
 * Setting a slot's rate by hand for a day.
 *
 * `slot` does not include 'manual': you choose WHICH rate is being set — the
 * official or the parallel one — not where it comes from. That it comes from a
 * person is precisely what distinguishes this route.
 */
export const manualRateSchema = z.object({
  slot: z.enum(["bcv", "p2p"]).default("bcv"),
  rate: z.union([z.string().min(1), z.number()]),
  effective_on: isoDate.optional(),
  base_currency: z.string().min(2).max(10).toUpperCase().default("USD"),
  quote_currency: z.string().min(2).max(10).toUpperCase().default("VES"),
  note: z.string().max(200).optional(),
});

export const accountTypeSchema = z.enum([
  "cash",
  "bank",
  "crypto",
  "investment",
  "credit_card",
  "prepaid",
  "loan",
  "other",
]);

/**
 * Creating an account. Note it does NOT ask for `nature`: that is inferred from
 * the type, because leaving them loose invites marking a card as an asset and
 * having the debt add to net worth instead of subtracting.
 */
export const createAccountSchema = z.object({
  name: z.string().min(1).max(80),
  type: accountTypeSchema,
  currency: z.string().min(2).max(10).toUpperCase(),
  /** Major units as they are written. On a liability, what is owed. */
  opening_balance: z.string().max(30).optional(),
  institution: z.string().max(120).optional(),
  /** Comma-separated: they are the hints the bot finds the account by. */
  aliases: z.string().max(400).optional(),
});

export const updateAccountSchema = createAccountSchema.partial().extend({
  id: z.string().uuid(),
});

export const reportSchema = z.object({
  report: z
    .enum([
      "net_worth",
      "balances",
      "spending_by_category",
      "budgets",
      "recent_transactions",
      "month_summary",
    ])
    .default("month_summary"),
  period: z.string().max(60).optional(),
  valuation: valuationSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

/**
 * A recurring operation, as the bot sends it.
 *
 * Days of the month go as a list of integers; `-1` is the last one, be it 28, 30
 * or 31. The `monthly` and `biweekly` cadences bring their own and whatever
 * arrives here is ignored: two sources for the same datum would end up disagreeing.
 */
export const createRecurringSchema = z.object({
  name: z.string().min(1).max(120),
  cadence: z.enum(["monthly", "biweekly", "custom"]),
  days_of_month: z.array(z.number().int().min(-1).max(31)).max(31).optional(),
  kind: transactionKindSchema.default("expense"),
  /** In MAJOR units, as spoken: "15" is fifteen, not fifteen cents. */
  amount: amountSchema,
  /** The ACCOUNT's currency. If omitted, whichever the resolved account has. */
  currency: z.string().min(2).max(10).toUpperCase().optional(),
  /**
   * The currency the amount is THOUGHT of in, if it isn't the account's.
   *
   * It is what makes «15 dollars a month, debited from the bolívar account at
   * the day's rate» possible: storing the bolívares would expire.
   */
  amount_currency: z.string().min(2).max(10).toUpperCase().optional(),
  rate_source: z.enum(["bcv", "p2p"]).optional(),
  account: z.string().min(1).optional(),
  to_account: z.string().min(1).optional(),
  category: z.string().min(1).optional(),
  description: z.string().max(500).optional(),
  start_on: isoDate.optional(),
});

/**
 * An installment purchase, as the bot sends it.
 *
 * The total goes in the financier's currency — Cashea deals in bolívares — but
 * it can be written in another: «some fifty-dollar shoes» is what the person
 * says, and `total_currency` with `rate_source` converts it at the day's rate.
 * Storing it already converted would lose where the number came from.
 */
export const createFinancedPurchaseSchema = z.object({
  financier: z.string().min(1),
  total: amountSchema,
  total_currency: z.string().min(2).max(10).toUpperCase().optional(),
  rate_source: z.enum(["bcv", "p2p"]).optional(),
  down_payment: amountSchema.optional(),
  down_payment_account: z.string().min(1).optional(),
  installments: z.number().int().min(1).max(60),
  frequency: z.enum(["biweekly", "monthly"]).optional(),
  first_due_on: isoDate.optional(),
  category: z.string().min(1).optional(),
  description: z.string().max(500).optional(),
  occurred_on: isoDate.optional(),
});

/** Payment of one specific installment. */
export const payInstallmentSchema = z.object({
  installment_id: z.string().uuid(),
  from_account: z.string().min(1),
  paid_on: isoDate.optional(),
});

/**
 * Correcting, archiving or unarchiving an account.
 *
 * `account` is the name or alias, not an id: the model does not handle foreign keys.
 */
export const patchAccountSchema = createAccountSchema.partial().extend({
  account: z.string().min(1),
  action: z.enum(["update", "archive", "unarchive"]).default("update"),
});

export const saveBudgetSchema = z.object({
  category: z.string().min(1),
  /** MAJOR units, in the household's base currency. */
  amount: amountSchema,
  period: z.enum(["monthly", "biweekly", "yearly", "custom"]).optional(),
  /** Only with `custom`: first day and LAST day included. */
  period_start: isoDate.optional(),
  period_end: isoDate.optional(),
});

export const removeBudgetSchema = z.object({
  category: z.string().min(1),
  /** If omitted, removes every budget that category has. */
  period: z.enum(["monthly", "biweekly", "yearly", "custom"]).optional(),
});

export const toggleRecurringSchema = z.object({ active: z.boolean() });

/**
 * Splitting: pulling a line item out of a product and giving it its own.
 *
 * `raw_text` is the text EXACTLY as it came out on the receipt, not a new name:
 * it is what identifies the lines that move. Inventing it splits nothing.
 */
export const splitProductSchema = z.object({
  product: z.string().min(1),
  raw_text: z.string().min(1),
});

/** Merges two products: the first disappears inside the second. */
export const mergeProductsSchema = z.object({
  from: z.string().min(1),
  into: z.string().min(1),
});

/** Voiding a whole installment purchase, with its reason. */
/** Undoing an installment payment. The one POST branch that had no schema. */
export const unpayInstallmentSchema = z.object({
  installment_id: z.string().uuid("the installment id has to be a uuid"),
  undo: z.literal(true),
});

export const voidPlanSchema = z.object({
  plan_id: z.string().uuid(),
  reason: z.string().max(200).optional(),
});
