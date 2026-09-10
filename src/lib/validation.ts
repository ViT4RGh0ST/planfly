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
export const categoryKindSchema = z.enum(["expense", "income"]);
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

/**
 * The old spellings of the two slots, kept for good.
 *
 * They were named after Venezuelan institutions — `bcv` for the central bank and
 * `p2p` for the way the street trades — and the schema now calls them what they
 * MEAN, which travels to any country with two rates. But those two words are
 * what the installed bot sends, what a script somebody wrote last month sends,
 * and what sits inside conversations already in flight.
 *
 * Dropping them would not fail loudly: `rate_source` is optional everywhere, so
 * a rejected value would be an entry valued at the household's default instead
 * of the one that was asked for — a figure that is wrong and looks right.
 *
 * So they are translated on the way in, permanently, and this table is the one
 * place that knows the old names. Same decision, for the same reason, as the
 * Spanish period aliases in `dates.ts`.
 */
export const RATE_SLOT_ALIASES: Record<string, string> = {
  bcv: "official",
  p2p: "parallel",
};

/** Whatever arrived, in the name the schema knows. */
export function canonicalSlot<T>(value: T): T | string {
  return typeof value === "string" && value in RATE_SLOT_ALIASES
    ? RATE_SLOT_ALIASES[value]
    : value;
}

export const rateSourceSchema = z.enum(["official", "parallel", "manual"]);
export const valuationSchema = z.preprocess(canonicalSlot, z.enum(["official", "parallel"]));

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
  /**
   * Where it was bought. An empty string clears it.
   *
   * `updateTransaction` has always accepted this and its own comment says a
   * correction «is where a place gets put on an entry that never had one — which
   * is nearly all of them». The schema did not declare it, and the v1 route runs
   * `rejectUnknownKeys` against this schema, so no door but the dashboard could
   * ever set one. Eleven entries of a hundred and nine carried a place, and the
   * question the whole feature exists to answer — what a product cost and where
   * — could only be fed by hand.
   *
   * The service refuses a name it cannot resolve rather than leaving the entry
   * as it was, so a corrected place is one that exists or an error that says so.
   */
  payee: z.string().max(120).optional(),
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
  slot: z.preprocess(canonicalSlot, z.enum(["official", "parallel"])).default("official"),
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
  /**
   * The person's explicit yes, after the server warned the account may exist.
   *
   * It has to be DECLARED here even though the route only needs its value,
   * because `rejectUnknownKeys` walks this shape: without it the API answered
   * «call again with confirm=true» and then refused `confirm` as a field it did
   * not know. The bot did as it was told, was told no, and tried again — a
   * closed loop in which the account could never be opened.
   */
  confirm: z.boolean().optional(),
});

export const updateAccountSchema = createAccountSchema.partial().extend({
  id: z.string().uuid(),
});

/**
 * A category as the screen sends it.
 *
 * `kind` and `parent_id` are the two that decide figures: a category of the
 * wrong kind leaves the month's total, and a parent is what a budget looks one
 * level down from. Both are validated here and checked against the household in
 * `manage-categories.ts`, which is the only place that can see the tree.
 */
export const createCategorySchema = z.object({
  name: z.string().min(1).max(80),
  kind: categoryKindSchema,
  /** Empty string from a `<select>` means «no parent», which is a real choice. */
  parent_id: z.union([z.string().uuid(), z.literal("")]).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  /** Comma-separated: they are the hints the bot finds the category by. */
  aliases: z.string().max(400).optional(),
});

export const updateCategorySchema = createCategorySchema.partial().extend({
  id: z.string().uuid(),
});

/**
 * A place as the screen sends it.
 *
 * `tax_id` is not validated against the Venezuelan RIF shape on purpose: a
 * receipt from a Colombian shop or a made-up number for the plumber are both
 * legitimate here, and rejecting them would be the app arguing with the paper.
 * It is normalised for comparison and stored; it is never computed with.
 */
export const createPayeeSchema = z.object({
  name: z.string().min(1).max(120),
  tax_id: z.string().max(40).optional(),
  address: z.string().max(300).optional(),
  /** Empty string from a `<select>` means «not a branch», which is a real choice. */
  parent_id: z.union([z.string().uuid(), z.literal("")]).optional(),
  default_category_id: z.union([z.string().uuid(), z.literal("")]).optional(),
  /** A pasted pair of numbers or a map URL. Parsed, never validated into an error. */
  coordinates: z.string().max(500).optional(),
  /** Comma-separated: they are the hints the bot finds the place by. */
  aliases: z.string().max(400).optional(),
  /** «Yes, it really is another branch of that same company.» */
  allow_shared_tax_id: z.boolean().optional(),
});

export const updatePayeeSchema = createPayeeSchema.partial().extend({
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
  rate_source: z.preprocess(canonicalSlot, z.enum(["official", "parallel"])).optional(),
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
  rate_source: z.preprocess(canonicalSlot, z.enum(["official", "parallel"])).optional(),
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
 * A spending or earning category, as the API takes one.
 *
 * A second shape and not a reuse of `createCategorySchema`, which is the FORM's:
 * that one takes a `parent_id` and a colour because a dialog has both in front
 * of it. This one takes a parent by NAME — the model does not handle foreign
 * keys — and takes no colour at all.
 *
 * No `color` and no `sort_order`. Both are the screen's business — what a colour
 * should be and what order reads well are decided looking at the list, and a
 * chat that sets them is a chat picking hex codes nobody asked for. The service
 * keeps its own default for the colour and puts a new category at the end of
 * its level.
 */
export const apiCategorySchema = z.object({
  name: z.string().min(1).max(80),
  /** Spending or earning. It is what keeps income off a spending report. */
  kind: z.enum(["expense", "income"]),
  /** The category this hangs under, by name. Same kind, always. */
  parent: z.string().max(80).optional(),
  /** Comma-separated: what the person calls it when recording. */
  aliases: z.string().max(500).optional(),
  /** «Yes, I know it looks like that other one; make it anyway.» */
  confirm: z.boolean().optional(),
});

export const apiCategoryPatchSchema = apiCategorySchema.partial().extend({
  /** Which category, by name or alias. */
  category: z.string().min(1),
  action: z.enum(["update", "archive", "unarchive"]).default("update"),
  /** Empty lifts it back to the top level; absent leaves it where it is. */
  parent: z.string().max(80).optional(),
});

/**
 * A place: the shop, the pharmacy, the petrol station.
 *
 * Named and never id'd, like an account. The model does not handle foreign keys,
 * and the person says «Farmatodo», not a uuid — the route resolves it with the
 * same matcher that decides where an expense goes.
 */
export const createPlaceSchema = z.object({
  name: z.string().min(1).max(120),
  /** RIF, NIT, CUIT: whatever the receipt prints. Two branches may share one. */
  tax_id: z.string().max(40).optional(),
  address: z.string().max(240).optional(),
  /** The brand this is a branch of, by name. A shop that is nobody's branch has none. */
  parent: z.string().min(1).max(120).optional(),
  /** A pasted pair of numbers or a map link. Never invented. */
  coordinates: z.string().max(120).optional(),
  /** By name: what this place's purchases usually are. */
  default_category: z.string().min(1).max(120).optional(),
  /** Comma-separated, as they come off a statement: «FARMATODO C31, PAGO FARMATODO». */
  aliases: z.string().max(500).optional(),
  /** «Yes, it really is another branch of that same company.» */
  confirm: z.boolean().optional(),
});

export const patchPlaceSchema = createPlaceSchema.partial().extend({
  /** Which place, by name or alias. */
  place: z.string().min(1),
  action: z.enum(["update", "archive", "unarchive"]).default("update"),
  /*
   * Empty is meaningful here and only here: it CLEARS.
   *
   * A shop leaves its brand, or stops having a usual category, and the only way
   * to say that in JSON is a value — `undefined` already means «leave it alone»
   * and the two must not collide. Hence the override of the create schema's
   * min(1): on the way in it is a name, on the way out it is an erasure.
   */
  parent: z.string().max(120).optional(),
  default_category: z.string().max(120).optional(),
});

/**
 * Putting a place on every entry that carries exactly one description.
 *
 * The description is matched EXACTLY, not fuzzily: what gets written has to be
 * the set that was counted and shown, never a wider one a resemblance swept in.
 */
export const assignPlaceSchema = z.object({
  description: z.string().min(1).max(500),
  place: z.string().min(1).max(120),
});

/**
 * Adding a currency this installation does not know.
 *
 * No `minor_unit` field, and it is not an oversight: `money.ts` keeps its own
 * map of decimals and cannot read the table — it is pure and synchronous and a
 * client component formats with it. A currency created at runtime therefore
 * takes the decimals that map would use anyway, which is two. The handful
 * written whole — the yen, the Chilean peso — need a line of code, and the
 * service says so rather than accepting a number it would ignore.
 */
export const createCurrencySchema = z.object({
  code: z.string().min(2).max(6).toUpperCase(),
  name: z.string().min(1).max(60),
  /** Only the symbol the formatter will actually print. The service says which. */
  symbol: z.string().max(8).optional(),
  has_official: z.boolean().optional(),
  is_crypto: z.boolean().optional(),
});

/** The two things that describe a currency. The code and the decimals are not among them. */
export const patchCurrencySchema = z.object({
  code: z.string().min(2).max(6).toUpperCase(),
  name: z.string().min(1).max(60).optional(),
  has_official: z.boolean().optional(),
});

export const removeCurrencySchema = z.object({
  code: z.string().min(2).max(6).toUpperCase(),
});

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
