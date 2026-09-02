"use server";

import { revalidatePath } from "next/cache";
import { and, asc, eq, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  accounts,
  categories,
  households,
  netWorthSnapshots,
  payees,
  transactionEntries,
  transactions,
} from "@/db/schema";
import { requireSession, requireWriter } from "@/lib/session";
import { amountErrorMessage, messageForScreen } from "@/lib/user-error";
import { formatCoordinates } from "@/lib/coordinates";
import { normalizeLocale, type Locale } from "@/i18n/config";
import { getTranslator } from "@/i18n/translator";
import { formatAmount, formatRate, parseRate, InvalidAmountError } from "@/lib/money";
import { formatDay, today, type BudgetPeriod } from "@/lib/dates";
import {
  currentRates,
  dailySnapshot,
  removeManualRate,
  saveManualRate,
} from "@/lib/rates/service";
import { isSlotConfigured } from "@/lib/rates/load-provider";
import { removeBudget, saveBudget as saveBudgetRule } from "@/lib/services/budgets";
import {
  removeRecurringRule,
  saveRecurringRule,
  setRecurringActive,
} from "@/lib/services/recurring";
import {
  InvalidTransactionError,
  recordTransaction,
  type PaymentMethod,
} from "@/lib/services/record-transaction";
import { updateTransaction } from "@/lib/services/update-transaction";
import { voidTransaction as voidTransactionRecord } from "@/lib/services/void-transaction";
import { removeRule, saveRule } from "@/lib/services/rules";
import {
  archiveAccount,
  createAccount,
  unarchiveAccount,
  updateAccount,
  type AccountType,
} from "@/lib/services/manage-accounts";
import {
  archiveCategory,
  createCategory,
  unarchiveCategory,
  updateCategory,
  type CategoryKind,
} from "@/lib/services/manage-categories";
import {
  createCurrency,
  removeCurrency,
  updateCurrency,
} from "@/lib/services/manage-currencies";
import {
  archivePayee,
  createPayee,
  placeUnplaced,
  unarchivePayee,
  updatePayee,
} from "@/lib/services/manage-payees";
import {
  payInstallment,
  planForTransaction,
  recordFinancedPurchase,
  removeFinancierProfile,
  saveFinancierProfile,
  unpayInstallment,
  voidFinancingPlan,
} from "@/lib/services/financing";
import { itemsOfTransaction, mergeProducts, splitProduct } from "@/lib/services/products";
import { netWorth } from "@/lib/services/reports";
import {
  createAccountSchema,
  createCategorySchema,
  createPayeeSchema,
  manualRateSchema,
} from "@/lib/validation";

/**
 * Form actions.
 *
 * They all go through `recordTransaction()`, just like Telegram, the CSV and the
 * OCR. None touches `transaction_entries` on its own — that is the rule which
 * guarantees rates get stamped and invariants hold without depending on each
 * caller remembering.
 */

/**
 * `code` travels only when the screen has to do something with it.
 *
 * The services already carry one on `InvalidTransactionError`; until now the
 * actions threw it away and left the screen matching on the text. It is what
 * lets a form offer the way past its own refusal — «yes, it really is another
 * branch» — without guessing from a translated sentence.
 */
export type ActionState = { ok: boolean; message: string; code?: string } | null;

export async function createTransaction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await requireWriter();

  try {
    const kind = String(form.get("kind") ?? "expense") as "expense" | "income" | "transfer";
    const result = await recordTransaction({
      householdId: ctx.householdId,
      kind,
      amount: String(form.get("amount") ?? ""),
      currency: String(form.get("currency") ?? "") || undefined,
      account: String(form.get("account") ?? "") || undefined,
      toAccount: String(form.get("to_account") ?? "") || undefined,
      toAmount: String(form.get("to_amount") ?? "") || undefined,
      category: String(form.get("category") ?? "") || undefined,
      description: String(form.get("description") ?? "") || undefined,
      occurredOn: String(form.get("occurred_on") ?? "") || undefined,
      notes: String(form.get("notes") ?? "") || undefined,
      // The dialog's sentinel for «no place». Sending it through as a name would
      // have the resolver look for a shop called «—» and refuse the whole entry.
      payee:
        String(form.get("payee") ?? "") === "—"
          ? undefined
          : String(form.get("payee") ?? "") || undefined,
      rate: String(form.get("rate") ?? "") || undefined,
      rateSource: (String(form.get("rate_source") ?? "") || undefined) as
        | "bcv"
        | "p2p"
        | "manual"
        | undefined,
      paymentMethod: (String(form.get("payment_method") ?? "") || undefined) as
        | PaymentMethod
        | undefined,
      source: "form",
      createdByUserId: ctx.userId,
      items: parseItemsField(form.get("items"), normalizeLocale(ctx.locale)),
    });

    revalidatePath("/", "layout");
    return { ok: true, message: result.summary };
  } catch (err) {
    return { ok: false, message: messageForScreen(err, ctx.locale) };
  }
}

export type EditableTransaction = {
  id: string;
  kind: string;
  occurredOn: string;
  description: string;
  /** The shop's name, so the dialog can offer it selected. Empty when it has none. */
  payee: string;
  notes: string;
  baseCurrency: string;
  /** The two rates of the day: the correction dialog converts as well. */
  rates: Record<string, { rate: string; effectiveOn: string; stale: boolean }>;
  ratedCurrencies: string[];
  /** The current breakdown, so it can be corrected whole. */
  items: {
    description: string;
    quantity: string;
    unit: string;
    total: string;
  }[];
  legs: {
    sortOrder: number;
    account: string;
    currency: string;
    /** In major units and Venezuelan format, exactly as it gets typed back. */
    amount: string;
    /** Hand-set ones only: a source's rates are not edited, they are re-fetched. */
    manualRate: string;
    category: string;
  }[];
};

/**
 * Loads an entry for the correction form.
 *
 * It is requested when the dialog opens and does not travel with every row of
 * the listing: these are fields only needed when an edit is actually going to
 * happen, and putting them in the history query would fatten it for all 100 rows.
 */
export async function transactionForEdit(id: string): Promise<EditableTransaction | null> {
  const ctx = await requireSession();

  const [header] = await db
    .select({
      id: transactions.id,
      kind: transactions.kind,
      occurredOn: transactions.occurredOn,
      description: transactions.description,
      payee: payees.name,
      notes: transactions.notes,
      voidedAt: transactions.voidedAt,
    })
    .from(transactions)
    .leftJoin(payees, eq(payees.id, transactions.payeeId))
    .where(and(eq(transactions.id, id), eq(transactions.householdId, ctx.householdId)))
    .limit(1);

  if (!header || header.voidedAt) return null;

  const rates = await currentRates(today(ctx.timezone));
  const existingItems = await itemsOfTransaction(ctx.householdId, header.id);

  const legs = await db
    .select({
      sortOrder: transactionEntries.sortOrder,
      account: accounts.name,
      currency: transactionEntries.currency,
      amountMinor: transactionEntries.amountMinor,
      rateManual: transactionEntries.rateManual,
      category: categories.name,
    })
    .from(transactionEntries)
    .innerJoin(accounts, eq(accounts.id, transactionEntries.accountId))
    .leftJoin(categories, eq(categories.id, transactionEntries.categoryId))
    .where(eq(transactionEntries.transactionId, header.id))
    .orderBy(asc(transactionEntries.sortOrder));

  return {
    id: header.id,
    kind: header.kind,
    occurredOn: header.occurredOn,
    description: header.description,
    payee: header.payee ?? "",
    notes: header.notes ?? "",
    baseCurrency: ctx.baseCurrency,
    rates,
    // Only the USD/VES pair is solved: offering it on USDT would promise a
    // conversion that does not exist.
    ratedCurrencies: rates.bcv || rates.p2p ? ["VES"] : [],
    items: existingItems.map((i) => ({
      // The raw text before the product name: it is what the receipt said, and
      // correcting a breakdown starts by comparing against what was read.
      description: i.rawText || i.product,
      quantity: String(Number(i.quantity)),
      unit: i.unit ?? "",
      total: formatAmount(i.totalMinor, i.currency, { withSymbol: false }),
    })),
    legs: legs.map((l) => ({
      sortOrder: l.sortOrder,
      account: l.account,
      currency: l.currency,
      // Without a symbol and in es-VE: it is exactly what `parseAmountToMinor` knows
      // how to read back, so the field can be edited without translating formats.
      amount: formatAmount(Math.abs(l.amountMinor), l.currency, { withSymbol: false }),
      manualRate: l.rateManual ? String(Number(l.rateManual)) : "",
      category: l.category ?? "",
    })),
  };
}

export type EditableAccount = {
  id: string;
  name: string;
  type: string;
  currency: string;
  /** In major units and Venezuelan format; on a liability, the debt as positive. */
  openingBalance: string;
  institution: string;
  aliases: string;
  /** The sum of its entries, so we can say what balance it will end up at. */
  movementsMinor: number;
  /** The currency can only be changed while the account is empty. */
  currencyLocked: boolean;
};

export type EditableCategory = {
  id: string;
  name: string;
  kind: "expense" | "income";
  parentId: string | null;
  color: string;
  aliases: string;
  /** How many entries carry it. The kind can only change while it has none. */
  entries: number;
  /** True once it has entries: turning it into income would empty the month's total. */
  kindLocked: boolean;
  /** True if categories hang from it, in which case it cannot hang from another. */
  hasChildren: boolean;
};

/** Loads a category for the correction dialog. */
export async function categoryForEdit(id: string): Promise<EditableCategory | null> {
  const ctx = await requireSession();

  const [row] = await db
    .select()
    .from(categories)
    .where(and(eq(categories.id, id), eq(categories.householdId, ctx.householdId)))
    .limit(1);

  if (!row) return null;

  const { rows: counts } = await db.execute<{ entries: string; children: string }>(sql`
    SELECT (SELECT count(*) FROM transaction_entries WHERE category_id = ${id})::text AS entries,
           (SELECT count(*) FROM categories WHERE parent_id = ${id})::text AS children
  `);

  const entries = Number(counts[0]?.entries ?? 0);

  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    parentId: row.parentId,
    color: row.color,
    // Back as they are typed, comma separated: it is what `parseAliases` reads.
    aliases: row.aliases.join(", "),
    entries,
    kindLocked: entries > 0,
    hasChildren: Number(counts[0]?.children ?? 0) > 0,
  };
}

/** Loads an account for the correction dialog. */
export async function accountForEdit(id: string): Promise<EditableAccount | null> {
  const ctx = await requireSession();

  const [row] = await db
    .select()
    .from(accounts)
    .where(and(eq(accounts.id, id), eq(accounts.householdId, ctx.householdId)))
    .limit(1);

  if (!row) return null;

  const { rows: sums } = await db.execute<{ total: string; n: string }>(sql`
    SELECT COALESCE(SUM(e.amount_minor) FILTER (WHERE t.voided_at IS NULL), 0)::text AS total,
           count(e.id)::text AS n
      FROM transaction_entries e
      JOIN transactions t ON t.id = e.transaction_id
     WHERE e.account_id = ${id}
  `);

  return {
    id: row.id,
    name: row.name,
    type: row.type,
    currency: row.currency,
    // Without a symbol and in es-VE: it is what `parseAmountToMinor` reads back.
    // On a liability it is shown positive because the field asks how much you owe.
    openingBalance: formatAmount(Math.abs(row.openingBalanceMinor), row.currency, {
      withSymbol: false,
    }),
    institution: row.institution ?? "",
    aliases: row.aliases.join(", "),
    movementsMinor: Number(sums[0]?.total ?? 0),
    currencyLocked: Number(sums[0]?.n ?? 0) > 0,
  };
}

/** Approves a row the AI flagged as doubtful: takes it out of the tray as-is. */
export async function approveTransaction(id: string): Promise<ActionState> {
  const ctx = await requireWriter();

  // Through the service, like overrideRate and recategorize. Writing
  // `needsReview: false` bare gave a DIFFERENT result from the API's: over
  // there `approve` recalculates, and if the line still has no equivalent it
  // goes back to the tray. Two paths with the same label and different effects
  // is what made the bot approve, see the row still there, and retry.
  const result = await updateTransaction({
    householdId: ctx.householdId,
    transactionId: id,
    approve: true,
    reviewedById: ctx.userId,
  });

  revalidatePath("/", "layout");
  return { ok: true, message: result.summary };
}

/**
 * Reads the breakdown the form sends.
 *
 * Three different answers, and the difference matters:
 *
 *   - `undefined`: the field never travelled. The form doesn't touch the
 *     breakdown and whatever was there stays.
 *   - `[]`: it travelled empty. Deletion was requested, and that IS a change.
 *   - a list: the new breakdown.
 *
 * And what can't be read **throws**. My first version returned `undefined` on
 * broken JSON, so deleting every line left the breakdown intact while the app
 * answered "done, corrected it". A swallowed error that also lies about what it
 * did is worse than a plain error.
 */
function parseItemsField(raw: FormDataEntryValue | null, locale: Locale) {
  const t = getTranslator(locale);
  if (raw == null) return undefined;
  const text = String(raw).trim();
  // An empty field is an empty list, not the absence of the field: `JSON.parse("")`
  // throws, and swallowing it turned "delete it all" into "touch nothing".
  if (text === "") return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(t("services.actions.items.unreadable"));
  }
  if (!Array.isArray(parsed)) {
    throw new Error(t("services.actions.items.notAList"));
  }

  const rows = parsed as Array<Record<string, unknown>>;
  // A half-written line is reported, not dropped in silence: typing the
  // product and forgetting the price is a mistake worth hearing about.
  for (const [i, row] of rows.entries()) {
    const description = String(row?.description ?? "").trim();
    const total = String(row?.total ?? "").trim();
    if (description && !total) {
      throw new Error(t("services.actions.items.noTotal", { n: i + 1, description }));
    }
    if (!description && total) {
      throw new Error(t("services.actions.items.noDescription", { n: i + 1 }));
    }
  }

  return rows
    .filter((r) => String(r?.description ?? "").trim() && String(r?.total ?? "").trim())
    .map((r) => ({
      description: String(r.description).trim(),
      quantity: r.quantity ? Number(String(r.quantity).replace(",", ".")) : undefined,
      unit: r.unit ? String(r.unit).trim() : undefined,
      total: String(r.total),
    }));
}

/**
 * Correcting an entry from the dashboard.
 *
 * Everything goes through `updateTransaction()`, just as writes go through
 * `recordTransaction()`. Each verb used to carry its own copy of the logic and
 * they had diverged: the API's `PATCH` knew how to change amount, date and
 * account, and the dashboard didn't; and the dashboard's version picked the leg
 * to revalue without ordering, so on a transfer it could touch the wrong one.
 */
export async function editTransaction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await requireWriter();
  const t = getTranslator(normalizeLocale(ctx.locale));
  const id = String(form.get("id") ?? "");
  if (!id) return { ok: false, message: t("services.actions.missingEntry") };

  const field = (name: string) => {
    const value = form.get(name);
    if (value == null) return undefined;
    const text = String(value).trim();
    return text === "" ? undefined : text;
  };

  try {
    const result = await updateTransaction({
      householdId: ctx.householdId,
      transactionId: id,
      amount: field("amount"),
      toAmount: field("to_amount"),
      account: field("account"),
      toAccount: field("to_account"),
      category: field("category"),
      // «—» is how the dialog says «nowhere»; the empty string takes the place
      // off, and undefined leaves it alone.
      payee:
        form.get("payee") == null
          ? undefined
          : String(form.get("payee")) === "—"
            ? ""
            : String(form.get("payee")),
      description: field("description"),
      occurredOn: field("occurred_on"),
      // Notes do admit empty: clearing them is a legitimate edit.
      notes: form.get("notes") == null ? undefined : String(form.get("notes")),
      rate: field("rate"),
      toRate: field("to_rate"),
      // Which rate the incoming figure was derived with. Without this, converting
      // $40 at BCV in the field stored the result and then revalued it with the
      // household preference: the history gave back $ 34,96 where you typed 40.
      rateSource: rateSourceOf(field("rate_source")),
      toRateSource: rateSourceOf(field("to_rate_source")),
      // The breakdown travels as JSON: a variable-length list in a FormData forces
      // you to invent indexed names and rebuild them on the other side.
      items: parseItemsField(form.get("items"), normalizeLocale(ctx.locale)),
      reviewedById: ctx.userId,
    });

    revalidatePath("/", "layout");
    return { ok: true, message: result.summary };
  } catch (err) {
    return { ok: false, message: messageForScreen(err, ctx.locale) };
  }
}

/**
 * The name of a rate source, if it is one of the three that exist.
 *
 * It arrives from a hidden form field, so it is checked rather than trusted:
 * anything else is ignored and the service falls back to the usual ladder, which
 * is what it did before this datum existed.
 */
function rateSourceOf(value: string | undefined): "bcv" | "p2p" | "manual" | undefined {
  return value === "bcv" || value === "p2p" || value === "manual" ? value : undefined;
}

/** Corrects an entry's category and marks it reviewed. */
export async function recategorize(id: string, categoryName: string): Promise<ActionState> {
  const ctx = await requireWriter();

  try {
    const result = await updateTransaction({
      householdId: ctx.householdId,
      transactionId: id,
      category: categoryName,
      reviewedById: ctx.userId,
    });
    revalidatePath("/", "layout");
    return { ok: true, message: result.summary };
  } catch (err) {
    return { ok: false, message: messageForScreen(err, ctx.locale) };
  }
}

/**
 * Voids an entry. It is never really deleted: an expense that existed and was
 * then voided is information, and deleting it would leave an unexplainable hole
 * in the account's history.
 */
export async function voidTransaction(id: string, reason: string): Promise<ActionState> {
  const ctx = await requireWriter();
  const t = getTranslator(normalizeLocale(ctx.locale));

  /*
   * If the entry is the purchase of an installment plan, the WHOLE purchase is
   * voided: the expense, the down payment and the installments already paid.
   *
   * Without this the schedule was left orphaned claiming a debt the account no
   * longer had — the screen said "Bs 46.931 pending" next to a financier who was
   * up to date — and there was no way to fix it from the interface.
   */
  const planId = await planForTransaction(ctx.householdId, id);
  if (planId) {
    const result = await voidFinancingPlan({
      householdId: ctx.householdId,
      planId,
      reason: reason || t("services.actions.voidReason"),
    });
    revalidatePath("/", "layout");
    return { ok: true, message: result.summary };
  }

  await voidTransactionRecord({
    householdId: ctx.householdId,
    transactionId: id,
    reason: reason || t("services.actions.voidReason"),
  });

  revalidatePath("/", "layout");
  return { ok: true, message: t("services.actions.voided") };
}

/**
 * Changes an entry's rate and recomputes its base-currency equivalent.
 *
 * Always the origin leg. The previous version did `limit(1)` with no `order by`
 * over the entry's lines, so on a transfer Postgres returned whichever it felt
 * like and the rate could end up on the wrong side. For the destination leg
 * there is the edit form, which tells them apart.
 */
export async function overrideRate(id: string, rate: string): Promise<ActionState> {
  const ctx = await requireWriter();

  try {
    const result = await updateTransaction({
      householdId: ctx.householdId,
      transactionId: id,
      rate,
      // Declaring the intent, not just writing the number. Without this the line
      // stored `rate_manual` while keeping the previous source in
      // `rate_source_used`, and the row showed one figure while the totals added
      // up another: whoever hits «Set the rate» is saying that the truth of this
      // line is the one they type.
      rateSource: "manual",
      reviewedById: ctx.userId,
    });
    revalidatePath("/", "layout");
    return { ok: true, message: result.summary };
  } catch (err) {
    return { ok: false, message: messageForScreen(err, ctx.locale) };
  }
}

/**
 * Creating, correcting and archiving accounts.
 *
 * Everything goes through `manage-accounts`, just as ledger writes go through
 * `recordTransaction()`. Until now accounts were only born in the seed, so
 * adding one meant opening psql — and the six that exist were left with a zero
 * opening balance, which is why net worth came out negative.
 */
export async function createAccountAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await requireWriter();
  const text = (name: string) => {
    const value = form.get(name);
    return value == null ? undefined : String(value).trim() || undefined;
  };

  try {
    const input = createAccountSchema.parse({
      name: text("name") ?? "",
      type: text("type") ?? "bank",
      currency: text("currency") ?? ctx.baseCurrency,
      opening_balance: text("opening_balance"),
      institution: text("institution"),
      aliases: text("aliases"),
    });

    const result = await createAccount({
      householdId: ctx.householdId,
      timezone: ctx.timezone,
      locale: ctx.locale,
      name: input.name,
      type: input.type,
      currency: input.currency,
      openingBalance: input.opening_balance,
      institution: input.institution,
      aliases: input.aliases,
    });

    revalidatePath("/", "layout");
    return { ok: true, message: result.summary };
  } catch (err) {
    return { ok: false, message: messageForScreen(err, ctx.locale) };
  }
}

export async function editAccountAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await requireWriter();
  const t = getTranslator(normalizeLocale(ctx.locale));
  const id = String(form.get("id") ?? "");
  if (!id) return { ok: false, message: t("services.actions.missingAccount") };

  // Institution and aliases do admit empty: clearing them is a legitimate edit.
  const raw = (name: string) => {
    const value = form.get(name);
    return value == null ? undefined : String(value);
  };
  const text = (name: string) => raw(name)?.trim() || undefined;

  try {
    const result = await updateAccount({
      householdId: ctx.householdId,
      accountId: id,
      locale: ctx.locale,
      name: text("name"),
      type: text("type") as AccountType | undefined,
      currency: text("currency"),
      openingBalance: raw("opening_balance"),
      institution: raw("institution"),
      aliases: raw("aliases"),
    });

    revalidatePath("/", "layout");
    return { ok: true, message: result.summary };
  } catch (err) {
    return { ok: false, message: messageForScreen(err, ctx.locale) };
  }
}

export async function archiveAccountAction(id: string): Promise<ActionState> {
  const ctx = await requireWriter();
  try {
    const result = await archiveAccount(ctx.householdId, id);
    revalidatePath("/", "layout");
    return { ok: true, message: result.summary };
  } catch (err) {
    return { ok: false, message: messageForScreen(err, ctx.locale) };
  }
}

export async function unarchiveAccountAction(id: string): Promise<ActionState> {
  const ctx = await requireWriter();
  try {
    const result = await unarchiveAccount(ctx.householdId, id);
    revalidatePath("/", "layout");
    return { ok: true, message: result.summary };
  } catch (err) {
    return { ok: false, message: messageForScreen(err, ctx.locale) };
  }
}

/**
 * Categories.
 *
 * Same shape as the accounts above, and for the same reason: the screen sends
 * text, `manage-categories.ts` decides. What it decides here is not cosmetic —
 * the aliases are what the bot matches an expense by, and the parent is what a
 * budget looks one level down from.
 */
export async function createCategoryAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await requireWriter();
  const text = (name: string) => {
    const value = form.get(name);
    return value == null ? undefined : String(value).trim() || undefined;
  };

  try {
    const input = createCategorySchema.parse({
      name: text("name") ?? "",
      kind: text("kind") ?? "expense",
      parent_id: form.get("parent_id") == null ? undefined : String(form.get("parent_id")),
      color: text("color"),
      aliases: text("aliases"),
    });

    const result = await createCategory({
      householdId: ctx.householdId,
      locale: ctx.locale,
      name: input.name,
      kind: input.kind,
      parentId: input.parent_id || null,
      color: input.color,
      aliases: input.aliases,
    });

    revalidatePath("/", "layout");
    return { ok: true, message: result.summary };
  } catch (err) {
    return { ok: false, message: messageForScreen(err, ctx.locale) };
  }
}

export async function editCategoryAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await requireWriter();
  const t = getTranslator(normalizeLocale(ctx.locale));
  const id = String(form.get("id") ?? "");
  if (!id) return { ok: false, message: t("services.actions.missingCategory") };

  // Aliases admit empty: clearing them is a legitimate edit. The parent too —
  // an empty `<select>` means «lift it to the top level», which is a choice and
  // not a missing field.
  const raw = (name: string) => {
    const value = form.get(name);
    return value == null ? undefined : String(value);
  };
  const text = (name: string) => raw(name)?.trim() || undefined;

  try {
    const result = await updateCategory({
      householdId: ctx.householdId,
      categoryId: id,
      locale: ctx.locale,
      name: text("name"),
      kind: text("kind") as CategoryKind | undefined,
      parentId: raw("parent_id") === undefined ? undefined : raw("parent_id") || null,
      color: text("color"),
      aliases: raw("aliases"),
    });

    revalidatePath("/", "layout");
    return { ok: true, message: result.summary };
  } catch (err) {
    return { ok: false, message: messageForScreen(err, ctx.locale) };
  }
}

export async function archiveCategoryAction(id: string): Promise<ActionState> {
  const ctx = await requireWriter();
  try {
    const result = await archiveCategory(ctx.householdId, id);
    revalidatePath("/", "layout");
    return { ok: true, message: result.summary };
  } catch (err) {
    return { ok: false, message: messageForScreen(err, ctx.locale) };
  }
}

export async function unarchiveCategoryAction(id: string): Promise<ActionState> {
  const ctx = await requireWriter();
  try {
    const result = await unarchiveCategory(ctx.householdId, id);
    revalidatePath("/", "layout");
    return { ok: true, message: result.summary };
  } catch (err) {
    return { ok: false, message: messageForScreen(err, ctx.locale) };
  }
}

/**
 * Places.
 *
 * The fiscal id is the only field here that can be told «no» twice: the first
 * time it names the place that already carries it, and the second — with the
 * box ticked — it writes it anyway, because a franchise really does give two
 * branches two companies. Same shape as a suspected duplicate entry.
 */
export async function createPayeeAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await requireWriter();
  const text = (name: string) => {
    const value = form.get(name);
    return value == null ? undefined : String(value).trim() || undefined;
  };

  try {
    const input = createPayeeSchema.parse({
      name: text("name") ?? "",
      tax_id: text("tax_id"),
      address: text("address"),
      parent_id: form.get("parent_id") == null ? undefined : String(form.get("parent_id")),
      default_category_id:
        form.get("default_category_id") == null ? undefined : String(form.get("default_category_id")),
      coordinates: text("coordinates"),
      aliases: text("aliases"),
      allow_shared_tax_id: form.get("allow_shared_tax_id") === "on",
    });

    const result = await createPayee({
      householdId: ctx.householdId,
      locale: ctx.locale,
      name: input.name,
      taxId: input.tax_id,
      address: input.address,
      parentId: input.parent_id || null,
      coordinates: input.coordinates,
      defaultCategoryId: input.default_category_id || null,
      aliases: input.aliases,
      allowSharedTaxId: input.allow_shared_tax_id,
    });

    revalidatePath("/", "layout");
    return { ok: true, message: result.summary };
  } catch (err) {
    return {
      ok: false,
      message: messageForScreen(err, ctx.locale),
      code: err instanceof InvalidTransactionError ? err.code : undefined,
    };
  }
}

export async function editPayeeAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await requireWriter();
  const t = getTranslator(normalizeLocale(ctx.locale));
  const id = String(form.get("id") ?? "");
  if (!id) return { ok: false, message: t("services.actions.missingPayee") };

  // These admit empty: clearing an address, a fiscal id or the brand is a
  // legitimate edit, and `undefined` has to keep meaning «leave it alone».
  const raw = (name: string) => {
    const value = form.get(name);
    return value == null ? undefined : String(value);
  };
  const text = (name: string) => raw(name)?.trim() || undefined;

  try {
    const result = await updatePayee({
      householdId: ctx.householdId,
      payeeId: id,
      locale: ctx.locale,
      name: text("name"),
      taxId: raw("tax_id"),
      address: raw("address"),
      parentId: raw("parent_id") === undefined ? undefined : raw("parent_id") || null,
      coordinates: raw("coordinates"),
      defaultCategoryId:
        raw("default_category_id") === undefined ? undefined : raw("default_category_id") || null,
      aliases: raw("aliases"),
      allowSharedTaxId: form.get("allow_shared_tax_id") === "on",
    });

    revalidatePath("/", "layout");
    return { ok: true, message: result.summary };
  } catch (err) {
    return {
      ok: false,
      message: messageForScreen(err, ctx.locale),
      code: err instanceof InvalidTransactionError ? err.code : undefined,
    };
  }
}

/**
 * Puts a place on every entry that carries one description.
 *
 * It writes `payee_id` and nothing else — no amount, no rate, no account — so it
 * does not go through `updateTransaction`. What it changes is a label on rows
 * that were never labelled.
 */
export async function placeUnplacedAction(
  description: string,
  payeeId: string,
): Promise<ActionState> {
  const ctx = await requireWriter();
  try {
    const result = await placeUnplaced(ctx.householdId, description, payeeId);
    revalidatePath("/", "layout");
    return { ok: true, message: result.summary };
  } catch (err) {
    return { ok: false, message: messageForScreen(err, ctx.locale) };
  }
}

export async function archivePayeeAction(id: string): Promise<ActionState> {
  const ctx = await requireWriter();
  try {
    const result = await archivePayee(ctx.householdId, id);
    revalidatePath("/", "layout");
    return { ok: true, message: result.summary };
  } catch (err) {
    return { ok: false, message: messageForScreen(err, ctx.locale) };
  }
}

export async function unarchivePayeeAction(id: string): Promise<ActionState> {
  const ctx = await requireWriter();
  try {
    const result = await unarchivePayee(ctx.householdId, id);
    revalidatePath("/", "layout");
    return { ok: true, message: result.summary };
  } catch (err) {
    return { ok: false, message: messageForScreen(err, ctx.locale) };
  }
}

export type EditablePayee = {
  id: string;
  name: string;
  taxId: string;
  address: string;
  parentId: string | null;
  /** As it goes back into the field: "10.4806, -66.9036". */
  coordinates: string;
  defaultCategoryId: string | null;
  aliases: string;
  /** True if branches hang off it, in which case it cannot become one. */
  hasBranches: boolean;
};

/** Loads a place for the correction dialog. */
export async function payeeForEdit(id: string): Promise<EditablePayee | null> {
  const ctx = await requireSession();

  const [row] = await db
    .select()
    .from(payees)
    .where(and(eq(payees.id, id), eq(payees.householdId, ctx.householdId)))
    .limit(1);

  if (!row) return null;

  const [branch] = await db
    .select({ id: payees.id })
    .from(payees)
    .where(eq(payees.parentId, id))
    .limit(1);

  return {
    id: row.id,
    name: row.name,
    taxId: row.taxId ?? "",
    address: row.address ?? "",
    parentId: row.parentId,
    coordinates: formatCoordinates(row.lat, row.lon),
    defaultCategoryId: row.defaultCategoryId,
    // Back as they are typed, comma separated: it is what `parseAliases` reads.
    aliases: row.aliases.join(", "),
    hasBranches: Boolean(branch),
  };
}

/**
 * Currencies.
 *
 * The only reference data a person can add from the app, and the only field it
 * refuses to take is the one that could lie: the decimals come from `money.ts`,
 * which cannot read the table. See `manage-currencies.ts`.
 */
export async function createCurrencyAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await requireWriter();
  try {
    const result = await createCurrency({
      locale: ctx.locale,
      code: String(form.get("code") ?? ""),
      name: String(form.get("name") ?? ""),
      hasOfficial: form.get("has_official") === "on",
      isCrypto: form.get("is_crypto") === "on",
    });
    revalidatePath("/", "layout");
    return { ok: true, message: result.summary };
  } catch (err) {
    return { ok: false, message: messageForScreen(err, ctx.locale) };
  }
}

export async function toggleCurrencyOfficialAction(
  code: string,
  hasOfficial: boolean,
): Promise<ActionState> {
  const ctx = await requireWriter();
  try {
    const result = await updateCurrency({ locale: ctx.locale, code, hasOfficial });
    revalidatePath("/", "layout");
    return { ok: true, message: result.summary };
  } catch (err) {
    return { ok: false, message: messageForScreen(err, ctx.locale) };
  }
}

export async function removeCurrencyAction(code: string): Promise<ActionState> {
  const ctx = await requireWriter();
  try {
    const result = await removeCurrency(code, ctx.locale);
    revalidatePath("/", "layout");
    return { ok: true, message: result.summary };
  } catch (err) {
    return { ok: false, message: messageForScreen(err, ctx.locale) };
  }
}

/**
 * Financed purchases.
 *
 * The purchase is recorded as two entries — the whole expense against the
 * financier, and the down payment as a transfer towards it — and the installment
 * schedule lives apart. Paying an installment is NEVER an expense: the expense
 * was counted on the day of the purchase, and counting it again would duplicate
 * the month.
 */
export async function createFinancedPurchase(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await requireWriter();
  const t = getTranslator(normalizeLocale(ctx.locale));
  const text = (name: string) => String(form.get(name) ?? "").trim() || undefined;

  try {
    /*
     * Whoever fronts you the money is almost never on file: Cashea, Kari, a
     * neighbour. Sending you to Accounts and back just to type a name is the
     * friction that makes a purchase go unrecorded, so it is created right here.
     *
     * As a loan account, which is a liability: the financier is who you owe, and
     * their balance has to subtract from net worth. Charging the purchase to an
     * asset account would leave your cash at -4.000 while you still have it.
     */
    let financier = text("financier") ?? "";
    if (financier === "__nueva__") {
      const name = text("new_financier_name");
      if (!name) {
        return { ok: false, message: t("services.actions.missingFinancierName") };
      }
      const created = await createAccount({
        householdId: ctx.householdId,
        timezone: ctx.timezone,
        locale: ctx.locale,
        name,
        type: "loan",
        currency: text("new_financier_currency") ?? ctx.baseCurrency,
        aliases: name,
      });
      financier = name;
      void created;
    }

    const result = await recordFinancedPurchase({
      householdId: ctx.householdId,
      financier,
      total: text("total") ?? "",
      downPayment: text("down_payment"),
      downPaymentAccount: text("down_payment_account"),
      category: text("category"),
      description: text("description"),
      occurredOn: text("occurred_on"),
      installmentCount: Number(text("installment_count") ?? "3"),
      frequency: (text("frequency") ?? "biweekly") as "biweekly" | "monthly",
      rateSource: text("rate_source") as "bcv" | "p2p" | undefined,
      firstDueOn: text("first_due_on"),
      source: "form",
      createdByUserId: ctx.userId,
    });

    revalidatePath("/", "layout");
    return { ok: true, message: result.summary };
  } catch (err) {
    return { ok: false, message: messageForScreen(err, ctx.locale) };
  }
}

export async function payInstallmentAction(
  installmentId: string,
  fromAccount: string,
): Promise<ActionState> {
  const ctx = await requireWriter();
  try {
    const result = await payInstallment({
      householdId: ctx.householdId,
      installmentId,
      fromAccount,
    });
    revalidatePath("/", "layout");
    return { ok: true, message: result.summary };
  } catch (err) {
    return { ok: false, message: messageForScreen(err, ctx.locale) };
  }
}

export async function voidFinancingPlanAction(
  planId: string,
  reason: string,
): Promise<ActionState> {
  const ctx = await requireWriter();
  try {
    const result = await voidFinancingPlan({
      householdId: ctx.householdId,
      planId,
      reason,
    });
    revalidatePath("/", "layout");
    return { ok: true, message: result.summary };
  } catch (err) {
    return { ok: false, message: messageForScreen(err, ctx.locale) };
  }
}

export async function unpayInstallmentAction(installmentId: string): Promise<ActionState> {
  const ctx = await requireWriter();
  try {
    const result = await unpayInstallment(ctx.householdId, installmentId);
    revalidatePath("/", "layout");
    return { ok: true, message: result.summary };
  } catch (err) {
    return { ok: false, message: messageForScreen(err, ctx.locale) };
  }
}

/**
 * Marking an account as a financier and saving how it finances you.
 *
 * If a name arrives instead of an existing account, it is created first: adding
 * Cashea shouldn't force a trip through Accounts.
 */
export async function saveFinancier(_prev: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await requireWriter();
  const t = getTranslator(normalizeLocale(ctx.locale));
  const text = (name: string) => String(form.get(name) ?? "").trim() || undefined;
  const num = (name: string) => {
    const value = text(name);
    if (!value) return null;
    const parsed = Number(value.replace(",", "."));
    return Number.isFinite(parsed) ? parsed : null;
  };

  try {
    let accountId = text("account_id");

    if (!accountId) {
      const name = text("name");
      if (!name) {
        return { ok: false, message: t("services.actions.missingFinancierName") };
      }
      const created = await createAccount({
        householdId: ctx.householdId,
        timezone: ctx.timezone,
        locale: ctx.locale,
        name,
        type: "loan",
        currency: text("currency") ?? ctx.baseCurrency,
        aliases: name,
      });
      accountId = created.id;
    }

    const result = await saveFinancierProfile({
      householdId: ctx.householdId,
      accountId,
      downPaymentPercent: num("down_payment_percent"),
      defaultInstallments: num("default_installments"),
      defaultFrequency: (text("default_frequency") ?? "biweekly") as "biweekly" | "monthly",
    });

    revalidatePath("/", "layout");
    return { ok: true, message: result.summary };
  } catch (err) {
    return { ok: false, message: messageForScreen(err, ctx.locale) };
  }
}

export async function removeFinancier(accountId: string): Promise<ActionState> {
  const ctx = await requireWriter();
  try {
    const result = await removeFinancierProfile(ctx.householdId, accountId);
    revalidatePath("/", "layout");
    return { ok: true, message: result.summary };
  } catch (err) {
    return { ok: false, message: messageForScreen(err, ctx.locale) };
  }
}

export async function refreshRates(): Promise<ActionState> {
  const ctx = await requireWriter();
  const t = getTranslator(normalizeLocale(ctx.locale));
  const result = await dailySnapshot(today(ctx.timezone));

  const failures = [result.bcv ? null : "BCV", result.p2p ? null : "P2P"].filter(Boolean);
  revalidatePath("/", "layout");

  // "No source configured" is not a failure, and saying it as one sends people
  // hunting for a breakdown where something just needs plugging in — or the
  const noSource = failures.filter((f) => !isSlotConfigured(f === "BCV" ? "bcv" : "p2p"));
  const broken = failures.filter((f) => !noSource.includes(f));

  if (broken.length === 0 && noSource.length > 0) {
    return {
      ok: true,
      message:
        noSource.length === 2
          ? t("services.actions.rates.noSources")
          : t("services.actions.rates.oneWithoutSource", { source: noSource[0]! }),
    };
  }
  if (broken.length === 2) return { ok: false, message: t("services.actions.rates.bothBroken") };
  if (broken.length === 1) {
    return { ok: true, message: t("services.actions.rates.oneBroken", { source: broken[0]! }) };
  }
  return { ok: true, message: t("services.actions.rates.updated") };
}

/**
 * Sets the day's rate by hand.
 *
 * This is what makes planfly useful with no source connected at all. The figure
 * is stored anchored to its slot and beats the automatic one for THAT day:
 * whoever typed it was looking at the screen.
 */
export async function setManualRate(_prev: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await requireWriter();
  const t = getTranslator(normalizeLocale(ctx.locale));

  try {
    const input = manualRateSchema.parse({
      slot: String(form.get("slot") ?? "bcv"),
      rate: String(form.get("rate") ?? ""),
      effective_on: String(form.get("effective_on") ?? "") || undefined,
      note: String(form.get("note") ?? "") || undefined,
    });

    const effectiveOn = input.effective_on ?? today(ctx.timezone);
    const value = parseRate(input.rate);

    await saveManualRate({
      slot: input.slot,
      value,
      effectiveOn,
      baseCurrency: input.base_currency,
      quoteCurrency: input.quote_currency,
      note: input.note,
    });

    revalidatePath("/", "layout");
    // The message states the consequence, not the operation: what matters is not
    // that a row was saved, but that that day's entries are now valued this way.
    return {
      ok: true,
      message: t("services.actions.rates.manualSaved", {
        slot: input.slot,
        date: formatDay(effectiveOn, ctx.locale),
        rate: formatRate(value),
      }),
    };
  } catch (err) {
    if (err instanceof InvalidAmountError) {
      return { ok: false, message: amountErrorMessage(err, ctx.locale) };
    }
    return { ok: false, message: messageForScreen(err, ctx.locale) };
  }
}

/** Undoes a hand-written rate. One extra zero shouldn't require psql. */
export async function deleteManualRate(id: string): Promise<ActionState> {
  const ctx = await requireWriter();
  const t = getTranslator(normalizeLocale(ctx.locale));
  try {
    const removed = await removeManualRate(id, ctx.locale);
    revalidatePath("/", "layout");
    return removed
      ? { ok: true, message: t("services.actions.rates.removed") }
      : { ok: false, message: t("services.actions.rates.alreadyGone") };
  } catch (err) {
    // `removeManualRate` refuses to delete a rate that has already valued
    // entries, and the message explains what to do instead. Without this catch
    // the action rejected, the toast never arrived and Next's opaque error was
    // all that was left: the user saw nothing happen and had no idea why.
    return { ok: false, message: messageForScreen(err, ctx.locale) };
  }
}

/**
 * The household's language.
 *
 * It lives on the row and not in the URL or a cookie, because it is the same
 * datum the bot reads: what the chat answers in and what the screen shows have
 * to be one thing, or the same expense comes back worded two ways.
 */
export async function setLocale(locale: string): Promise<ActionState> {
  const ctx = await requireWriter();
  const chosen = normalizeLocale(locale);

  await db
    .update(households)
    .set({ locale: chosen, updatedAt: new Date() })
    .where(eq(households.id, ctx.householdId));

  revalidatePath("/", "layout");
  return { ok: true, message: getTranslator(chosen)("ui.nav.language") };
}

export async function saveBudget(_prev: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await requireWriter();
  const t = getTranslator(normalizeLocale(ctx.locale));
  try {
    const result = await saveBudgetRule({
      householdId: ctx.householdId,
      baseCurrency: ctx.baseCurrency,
      timezone: ctx.timezone,
      locale: ctx.locale,
      today: today(ctx.timezone),
      category: String(form.get("category") ?? ""),
      amount: String(form.get("amount") ?? ""),
      period: String(form.get("period") ?? "monthly") as BudgetPeriod,
      periodStart: String(form.get("period_start") ?? "") || undefined,
      periodEnd: String(form.get("period_end") ?? "") || undefined,
    });
    revalidatePath("/", "layout");
    return { ok: true, message: t("services.actions.budgetSaved", { summary: result.summary }) };
  } catch (err) {
    return { ok: false, message: messageForScreen(err, ctx.locale) };
  }
}

/** Removes a cap from the screen. Deactivates, does not delete. */
/**
 * AWAITING A SCREEN. The bot can already delete a budget and this action is
 * tested, but the /budgets row still has no menu to call it. This is not dead
 * code: it is half a feature. What's missing is the `···`.
 */
export async function deleteBudget(category: string, period?: BudgetPeriod): Promise<ActionState> {
  const ctx = await requireWriter();
  try {
    const result = await removeBudget({ householdId: ctx.householdId, locale: ctx.locale, category, period });
    revalidatePath("/", "layout");
    return { ok: true, message: result.summary };
  } catch (err) {
    return { ok: false, message: messageForScreen(err, ctx.locale) };
  }
}

/**
 * A snapshot of today's net worth, for the evolution chart.
 *
 * It stores BOTH valuations and the per-account breakdown. The breakdown is what
 * later lets you explain an odd jump in the curve without rebuilding the whole
 * history.
 */
/**
 * AWAITING A DECISION. It writes to `net_worth_snapshots`, which has sat at zero
 * rows for months: nothing calls it and there is no screen showing a historical
 * net worth series. Either it gets wired to something that fires it, or it is
 * retired along with its table.
 */
export async function takeSnapshot(): Promise<ActionState> {
  const ctx = await requireWriter();
  const date = today(ctx.timezone);
  const position = await netWorth(ctx.householdId, date, ctx.baseCurrency);

  const breakdown = position.accounts.map((a) => ({
    account: a.name,
    currency: a.currency,
    balance_minor: a.balanceMinor,
    base_bcv_minor: a.baseBcvMinor,
    base_p2p_minor: a.baseP2pMinor,
  }));

  await db
    .insert(netWorthSnapshots)
    .values({
      householdId: ctx.householdId,
      snapshotOn: date,
      baseCurrency: ctx.baseCurrency,
      totalBcvMinor: position.totalBcvMinor,
      totalP2pMinor: position.totalP2pMinor,
      breakdown,
    })
    .onConflictDoUpdate({
      target: [netWorthSnapshots.householdId, netWorthSnapshots.snapshotOn],
      set: {
        totalBcvMinor: position.totalBcvMinor,
        totalP2pMinor: position.totalP2pMinor,
        breakdown,
      },
    });

  revalidatePath("/", "layout");
  return { ok: true, message: getTranslator(normalizeLocale(ctx.locale))("services.actions.snapshotSaved") };
}

// ── Recurrences ─────────────────────────────────────────────────────────────

/**
 * Creating and correcting a recurring operation.
 *
 * The template is composed here from the form and stored as-is: it is the same
 * payload `recordTransaction` accepts, so when its turn comes it will be written
 * through the one write path there is, with its rates and its invariants. A
 * second path would end up diverging from the first.
 */
export async function saveRecurring(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await requireWriter();
  const t = getTranslator(normalizeLocale(ctx.locale));
  const field = (name: string) => {
    const value = form.get(name);
    if (value == null) return undefined;
    const text = String(value).trim();
    return text === "" ? undefined : text;
  };

  try {
    const cadence = (field("cadence") ?? "monthly") as "monthly" | "biweekly" | "custom";
    const days = (field("days_of_month") ?? "")
      .split(",")
      .map((d) => Number(d.trim()))
      .filter((d) => Number.isFinite(d));

    const amount = field("amount");
    if (!amount) return { ok: false, message: t("services.actions.missingAmount") };

    const result = await saveRecurringRule({
      householdId: ctx.householdId,
      timezone: ctx.timezone,
      locale: ctx.locale,
      id: field("id"),
      name: field("name") ?? "",
      cadence,
      daysOfMonth: days,
      startOn: field("start_on"),
      template: {
        kind: (field("kind") ?? "expense") as "expense" | "income" | "transfer",
        amount,
        currency: field("currency"),
        // The currency the amount was written in, if it isn't the account's, and
        // which rate to convert it with on the day it fires.
        amountCurrency: field("amount_currency"),
        rateSource: field("rate_source") as "bcv" | "p2p" | undefined,
        account: field("account"),
        toAccount: field("to_account"),
        // A transfer carries no category: it is the ledger's invariant.
        category: field("kind") === "transfer" ? undefined : field("category"),
        description: field("description") ?? field("name"),
        source: "recurring",
      },
    });

    revalidatePath("/", "layout");
    return { ok: true, message: result.summary };
  } catch (err) {
    return { ok: false, message: messageForScreen(err, ctx.locale) };
  }
}

/** Pauses or resumes. Resuming recomputes the next date from today. */
export async function toggleRecurring(id: string, isActive: boolean): Promise<ActionState> {
  const ctx = await requireWriter();
  try {
    const result = await setRecurringActive(ctx.householdId, id, isActive, ctx.timezone, ctx.locale);
    revalidatePath("/", "layout");
    return { ok: true, message: result.summary };
  } catch (err) {
    return { ok: false, message: messageForScreen(err, ctx.locale) };
  }
}

export async function deleteRecurring(id: string): Promise<ActionState> {
  const ctx = await requireWriter();
  try {
    const result = await removeRecurringRule(ctx.householdId, id, ctx.locale);
    revalidatePath("/", "layout");
    return { ok: true, message: result.summary };
  } catch (err) {
    return { ok: false, message: messageForScreen(err, ctx.locale) };
  }
}

/**
 * Saves a categorisation rule.
 *
 * Rules are what keep importing a two-hundred-row statement from being two
 * hundred clicks. The function that applies them existed from the start and
 * there was no way to create one: this is the end that was missing.
 */
export async function saveRuleAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await requireWriter();
  try {
    const result = await saveRule({
      householdId: ctx.householdId,
      locale: ctx.locale,
      id: String(form.get("id") ?? "") || undefined,
      pattern: String(form.get("pattern") ?? ""),
      field: (String(form.get("field") ?? "description") || "description") as "description" | "payee",
      operator: (String(form.get("operator") ?? "contains") || "contains") as
        | "contains"
        | "equals"
        | "regex",
      category: String(form.get("category") ?? ""),
      priority: Number(form.get("priority") ?? 100) || 100,
    });
    revalidatePath("/", "layout");
    return { ok: true, message: result.summary };
  } catch (err) {
    return { ok: false, message: messageForScreen(err, ctx.locale) };
  }
}

export async function deleteRuleAction(id: string): Promise<ActionState> {
  const ctx = await requireWriter();
  const t = getTranslator(normalizeLocale(ctx.locale));
  try {
    const removed = await removeRule(ctx.householdId, id);
    revalidatePath("/", "layout");
    return removed
      ? { ok: true, message: t("services.actions.ruleRemoved") }
      : { ok: false, message: t("services.actions.ruleAlreadyGone") };
  } catch (err) {
    return { ok: false, message: messageForScreen(err, ctx.locale) };
  }
}

/**
 * Splitting: pulling a line item out of a product and giving it its own.
 *
 * The reverse of merging. It is needed because matching joins by resemblance,
 * and two products sharing a first word — «AZUCAR MORENA» and «AZUCAR BLANCA» —
 * end up with a single price series that describes neither.
 */
export async function splitProductAction(
  productId: string,
  rawText: string,
): Promise<ActionState & { productId?: string; fromId?: string; undoable?: boolean }> {
  const ctx = await requireWriter();
  try {
    const r = await splitProduct(ctx.householdId, productId, rawText);
    revalidatePath("/", "layout");
    return {
      ok: true,
      message: r.summary,
      productId: r.productId,
      fromId: r.fromId,
      undoable: r.created,
    };
  } catch (err) {
    return { ok: false, message: messageForScreen(err, ctx.locale) };
  }
}

/**
 * Merging, which here means undoing the above.
 *
 * It is only offered when splitting created a new product: then its lines are
 * exactly the ones that left, and giving them back drags nothing foreign along.
 */
export async function mergeProductsAction(fromId: string, intoId: string): Promise<ActionState> {
  const ctx = await requireWriter();
  try {
    const r = await mergeProducts(ctx.householdId, fromId, intoId);
    revalidatePath("/", "layout");
    return { ok: true, message: r.summary };
  } catch (err) {
    return { ok: false, message: messageForScreen(err, ctx.locale) };
  }
}
