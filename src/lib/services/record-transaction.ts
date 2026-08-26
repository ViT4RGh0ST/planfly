import { and, eq, isNull, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  accounts,
  households,
  transactionEntries,
  transactionItems,
  transactions,
} from "@/db/schema";
import { DEFAULT_LOCALE, normalizeLocale, type Locale } from "@/i18n/config";
import { getTranslator } from "@/i18n/translator";
import { convertToBase, formatAmount, parseAmountToMinor, parseRate } from "@/lib/money";
import { chooseRateSource, type RateSource } from "@/lib/rate-source";
import { accountBalance } from "./balances";
import { today } from "@/lib/dates";
import { resolveRates, isRateTooStale, type ResolvedRate } from "@/lib/rates/service";
import {
  ensureProducts,
  itemsNeedReview,
  itemsTotal,
  prepareItems,
  type ItemInput,
  type PreparedItem,
} from "./products";
import {
  resolveAccount,
  resolveCategory,
  REVIEW_THRESHOLD,
  type Match,
} from "./resolve-entities";

/**
 * The ONE write path into the ledger.
 *
 * Telegram, the form, the CSV importer and the OCR all come in through here. No
 * route writes `transaction_entries` directly — it is the project's most
 * important structural rule, because it is what guarantees rates get stamped,
 * invariants hold and provenance is recorded without depending on each caller
 * remembering.
 */

export type TransactionKind = "expense" | "income" | "transfer" | "adjustment";
export type EntrySource = "telegram" | "form" | "csv" | "ocr" | "mcp" | "api" | "recurring";

export type PaymentMethod =
  | "cash"
  | "card"
  | "mobile_payment"
  | "transfer"
  | "zelle"
  | "crypto"
  | "other";

/**
 * The rail that can be inferred from the account type, when there is no doubt.
 *
 * A cash account is paid from in cash and a crypto one in crypto. A bank account
 * is paid from by card, by mobile payment or by transfer: there we return null,
 * because guessing would invent precisely the datum we wanted to measure. And
 * Zelle is the exception with a name of its own.
 */
export function inferPaymentMethod(accountType: string): PaymentMethod | null {
  if (accountType === "cash") return "cash";
  if (accountType === "crypto") return "crypto";
  // A prepaid card also goes through the POS, even though it is not debt.
  if (accountType === "credit_card" || accountType === "prepaid") return "card";
  return null;
}

export type RecordTransactionInput = {
  householdId: string;
  kind: TransactionKind;
  /** MAJOR units as the person wrote them: "350,50", 350.5, "1.234". */
  amount: string | number;
  currency?: string;
  /** Name or alias; resolved fuzzily. If missing, the default account is used. */
  account?: string;
  /** Transfers only. */
  toAccount?: string;
  /** Only transfers across currencies: what actually arrived at the destination. */
  toAmount?: string | number;
  category?: string;
  description?: string;
  payeeId?: string;
  /** 'YYYY-MM-DD'. Defaults to today in the household's timezone. */
  occurredOn?: string;
  notes?: string;
  /** Manual quoted-per-base rate (859.00 Bs per USD). */
  rate?: string | number;
  rateSource?: "bcv" | "p2p" | "manual";
  /** Which rail it left by: cash, card, mobile payment, transfer… */
  paymentMethod?: PaymentMethod;

  source: EntrySource;
  sourceRef?: string;
  createdByUserId?: string;
  createdViaTokenId?: string;
  createdByAgent?: string;
  confidence?: number;
  idempotencyKey?: string;
  raw?: unknown;
  attachmentPath?: string;
  importBatchId?: string;
  /** Resolves and computes without saving. Useful for confirming large amounts. */
  dryRun?: boolean;
  /**
   * What to do when an identical entry already exists, in the same account and
   * on the same day, from a moment ago.
   *
   * `warn` (the default) writes it and mentions it: that is right for the form,
   * for the CSV and for what planfly fires on its own, where repeating an amount
   * is normal — two identical fares, two recurrences of the same size — and
   * whoever is looking at the screen has the history right there.
   *
   * `reject` refuses without writing. It is for the conversational agent, which
   * cannot see the history and cannot tell "succeeded with a warning" from
   * "failed": on 17/08/2026 it read the warning as a failure and retried five
   * times, leaving the same grocery run recorded five times over. A warning does
   * not stop a loop; a rejection does.
   */
  onDuplicate?: "warn" | "reject";
  /**
   * The purchase breakdown: which products the invoice carries.
   *
   * They do NOT have to add up to the total. A receipt carries VAT, discounts
   * and lines the OCR could not read; the entry is worth what the receipt says
   * and the difference is shown instead of blocking the record.
   */
  items?: ItemInput[];
};

export type RecordTransactionResult = {
  ok: boolean;
  duplicate: boolean;
  dryRun: boolean;
  transactionId: string | null;
  kind: TransactionKind;
  occurredOn: string;
  description: string;
  amount: { minor: number; currency: string; text: string };
  base: {
    currency: string;
    bcvMinor: number | null;
    p2pMinor: number | null;
    manualMinor: number | null;
    usedMinor: number | null;
    sourceUsed: string;
  };
  rates: {
    bcv: string | null;
    p2p: string | null;
    manual: string | null;
    effectiveOn: string | null;
    stale: boolean;
  };
  resolved: {
    account: (Match & { currency: string }) | null;
    toAccount: (Match & { currency: string }) | null;
    category: Match | null;
  };
  needsReview: boolean;
  /** The breakdown already resolved, so the bot can repeat it before confirming. */
  items: {
    product: string;
    quantity: number;
    unit: string | null;
    total: string;
    /** Just seen for the first time, not a doubtful match. */
    isNew: boolean;
  }[];
  /** What the lines do NOT cover of the total: VAT, discounts, the unread. */
  unitemizedMinor: number;
  /** Warnings, already worded: the bot repeats them to the user as-is. */
  warnings: string[];
  balanceAfter: { account: string; minor: number; text: string } | null;
  /** A summary, already formatted, ready to answer with in Telegram. */
  summary: string;
};

export class InvalidTransactionError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = "InvalidTransactionError";
  }
}

type Household = {
  id: string;
  baseCurrency: string;
  timezone: string;
  defaultRateSource: "bcv" | "p2p" | "manual";
  /**
   * The language everything this service words comes out in.
   *
   * It travels with `baseCurrency` and `timezone` because it is the same kind of
   * datum: a property of the household that the caller does not choose. The bot
   * and the web both end up reading the same column, which is what keeps the
   * summary in the chat and the toast on screen speaking alike.
   */
  locale: Locale;
};

async function loadHousehold(householdId: string): Promise<Household> {
  const [h] = await db
    .select({
      id: households.id,
      baseCurrency: households.baseCurrency,
      timezone: households.timezone,
      defaultRateSource: households.defaultRateSource,
      locale: households.locale,
    })
    .from(households)
    .where(eq(households.id, householdId))
    .limit(1);

  if (!h) {
    // In the default language, and it cannot be otherwise: the language lives in
    // the row that is missing.
    throw new InvalidTransactionError(
      getTranslator(DEFAULT_LOCALE)("services.recordTransaction.householdNotFound"),
      "household_not_found",
    );
  }
  return { ...h, locale: normalizeLocale(h.locale) };
}

async function loadAccount(
  householdId: string,
  input: string | undefined,
  field: string,
  locale: Locale,
  preferredCurrency?: string,
) {
  if (!input) return null;
  const match = await resolveAccount(householdId, input, preferredCurrency);
  if (!match) {
    throw new InvalidTransactionError(
      getTranslator(locale)("services.recordTransaction.accountNotFound", { input }),
      "account_not_found",
      { input, field },
    );
  }
  const [row] = await db
    .select({ currency: accounts.currency, type: accounts.type })
    .from(accounts)
    .where(eq(accounts.id, match.id))
    .limit(1);

  return { ...match, currency: row.currency, type: row.type as string };
}

/** Default account when the message does not mention one: the first in order,
 *  honouring the amount's currency if one was given. */
async function defaultAccount(householdId: string, locale: Locale, currency?: string) {
  const currencyFilter = currency ? eq(accounts.currency, currency.toUpperCase()) : undefined;
  const [row] = await db
    .select({ id: accounts.id, name: accounts.name, currency: accounts.currency, type: accounts.type })
    .from(accounts)
    .where(and(eq(accounts.householdId, householdId), isNull(accounts.archivedAt), currencyFilter))
    .orderBy(accounts.sortOrder)
    .limit(1);

  if (!row) {
    throw new InvalidTransactionError(
      getTranslator(locale)("services.recordTransaction.noAccounts"),
      "no_accounts",
    );
  }
  return {
    id: row.id,
    name: row.name,
    currency: row.currency,
    type: row.type as string,
    score: 0.5,
    via: "slug" as const,
  };
}


/**
 * Semantic duplicate: same account, same amount, same day, less than 10 minutes
 * ago. It is NOT rejected — two coffees in a row happen. It is flagged so the
 * agent asks instead of writing blind.
 */
async function findNearDuplicate(
  householdId: string,
  accountId: string,
  amountMinor: number,
  occurredOn: string,
): Promise<{
  id: string;
  description: string;
  minutesAgo: number;
  amountMinor: number;
} | null> {
  const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
  const { rows } = await db.execute<{
    id: string;
    description: string;
    minutes_ago: number;
    amount_minor: number;
  }>(sql`
    SELECT t.id,
           t.description,
           e.amount_minor,
           EXTRACT(EPOCH FROM (now() - t.created_at)) / 60 AS minutes_ago
      FROM transactions t
      JOIN transaction_entries e ON e.transaction_id = t.id
     WHERE t.household_id = ${householdId}
       AND t.occurred_on = ${occurredOn}
       AND t.voided_at IS NULL
       AND t.created_at >= ${tenMinutesAgo.toISOString()}
       AND e.account_id = ${accountId}
       -- With slack, not exact. On 17/08/2026 the model dodged the rejection by
       -- raising the amount a cent at a time, one per attempt, until it got
       -- through, and left five purchases where there had been one. A guardrail
       -- you get past by changing a cent is not a guardrail.
       -- 1% is plenty for that and still lets through two purchases that really
       -- do look alike; for those there is allow_duplicate.
       AND ABS(e.amount_minor - ${amountMinor}) <= GREATEST(1, ABS(${amountMinor}) / 100)
     ORDER BY ABS(e.amount_minor - ${amountMinor}) ASC, t.created_at DESC
     LIMIT 1
  `);
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    description: row.description,
    minutesAgo: Math.max(0, Math.round(Number(row.minutes_ago))),
    amountMinor: Number(row.amount_minor),
  };
}

export async function recordTransaction(
  input: RecordTransactionInput,
): Promise<RecordTransactionResult> {
  const household = await loadHousehold(input.householdId);
  const t = getTranslator(household.locale);
  const occurredOn = input.occurredOn ?? today(household.timezone);
  const isToday = occurredOn === today(household.timezone);
  const warnings: string[] = [];

  // ── Idempotency: a client retry must not duplicate the expense ────────────
  if (input.idempotencyKey) {
    const [existing] = await db
      .select({ id: transactions.id })
      .from(transactions)
      .where(
        and(
          eq(transactions.householdId, household.id),
          eq(transactions.idempotencyKey, input.idempotencyKey),
        ),
      )
      .limit(1);

    if (existing) return await describeExisting(existing.id, household, true);
  }

  // ── Accounts ──────────────────────────────────────────────────────────────
  // The amount's currency biases resolution: "efectivo" with 350 Bs must land
  // on the bolívar account, not the dollar one.
  const fromAccount =
    (await loadAccount(household.id, input.account, "account", household.locale, input.currency)) ??
    (await defaultAccount(household.id, household.locale, input.currency));

  if (!input.account) {
    warnings.push(
      t("services.recordTransaction.defaultedAccount", { account: fromAccount.name }),
    );
  }

  /*
   * `to_account` on something that is not a transfer.
   *
   * It is the most expensive failure of 17/08/2026 and the hardest to see: the
   * model DID send the account — "compra en mercado con provincial banco"
   * travelled as to_account: "Banco Provincial" — but in the field for a
   * transfer's destination, which means nothing on an expense. The server
   * ignored it, charged the expense to the default account and returned 201.
   * Twelve purchases in a row into Efectivo Bs, with the bot swearing it had set
   * Provincial.
   *
   * A valid field in the wrong place is worse than an invented one: the invented
   * one is already caught by `rejectUnknownKeys`. This one passed the whole schema.
   */
  if (input.kind !== "transfer" && (input.toAccount || input.toAmount != null)) {
    const kind = input.kind;
    throw new InvalidTransactionError(
      t("services.recordTransaction.toAccountNotTransfer.head", { kind }) +
        (input.toAccount
          ? t("services.recordTransaction.toAccountNotTransfer.hint", {
              kind,
              sent: input.toAccount,
            })
          : "") +
        t("services.recordTransaction.toAccountNotTransfer.retry"),
      "to_account_not_transfer",
      { sent: input.toAccount, use_instead: "account" },
    );
  }

  let toAccount: Awaited<ReturnType<typeof loadAccount>> = null;
  if (input.kind === "transfer") {
    if (!input.toAccount) {
      throw new InvalidTransactionError(
        t("services.recordTransaction.transferNeedsDestination"),
        "missing_to_account",
      );
    }
    // No currency bias here: a transfer's destination is usually in precisely
    // ANOTHER currency than the origin.
    toAccount = await loadAccount(household.id, input.toAccount, "to_account", household.locale);
    if (toAccount!.id === fromAccount.id) {
      throw new InvalidTransactionError(
        t("services.recordTransaction.sameAccount"),
        "same_account",
      );
    }
  }

  // ── Category ──────────────────────────────────────────────────────────────
  let category: Match | null = null;
  if (input.kind === "expense" || input.kind === "income") {
    if (input.category) {
      category = await resolveCategory(household.id, input.category, input.kind);
      if (!category) {
        warnings.push(
          t("services.recordTransaction.categoryNotRecognised", { input: input.category }),
        );
      } else if (category.score < REVIEW_THRESHOLD) {
        warnings.push(
          t("services.recordTransaction.categoryUnsure", {
            input: input.category,
            category: category.name,
          }),
        );
      }
    } else {
      warnings.push(t("services.recordTransaction.noCategory"));
    }
  }

  // ── Amounts ───────────────────────────────────────────────────────────────
  const currency = (input.currency ?? fromAccount.currency).toUpperCase();
  if (currency !== fromAccount.currency) {
    throw new InvalidTransactionError(
      t("services.recordTransaction.currencyMismatch", {
        amountCurrency: currency,
        account: fromAccount.name,
        accountCurrency: fromAccount.currency,
      }),
      "currency_mismatch",
      { amountCurrency: currency, accountCurrency: fromAccount.currency },
    );
  }

  const absAmount = Math.abs(parseAmountToMinor(input.amount, currency));
  if (absAmount === 0) {
    throw new InvalidTransactionError(
      t("services.recordTransaction.zeroAmount"),
      "zero_amount",
    );
  }

  // Sign by kind. It is what the ledger's trigger validates.
  const sign = input.kind === "income" ? 1 : -1;
  const amountMinor = absAmount * sign;

  // ── Rates: BOTH get stamped ───────────────────────────────────────────────
  const rates = await resolveRates({
    quoteCurrency: currency,
    baseCurrency: household.baseCurrency,
    date: occurredOn,
    isToday,
  });

  /*
   * The typed-in rate is READ, not copied.
   *
   * It used to go raw into a NUMERIC(24,10) and both readings failed in silence:
   * "1.234" was stored as one point two three four — Postgres reads the dot as
   * decimal — and a Bs. 350 expense ended up valued at $283,63 with no warning
   * and no review flag; and "859,00", which is the format the field itself
   * shows, blew up the whole INSERT with a raw Postgres error. `parseRate`
   * disambiguates, bounds and rejects with a message you can read, and it is the
   * same reader the day's rate uses in /rates: two readers for the same figure
   * guarantees they disagree some day.
   */
  const manualRate =
    input.rate != null && input.rate !== "" ? parseRate(input.rate) : null;

  const preferredSource = input.rateSource ?? (manualRate ? "manual" : household.defaultRateSource);

  const toBase = (rate: string | null) =>
    convertToBase(amountMinor, currency, household.baseCurrency, rate);

  const baseBcv = toBase(rates.bcv?.value ?? null);
  const baseP2p = toBase(rates.p2p?.value ?? null);
  const baseManual = manualRate ? toBase(manualRate) : null;

  const needsRate = currency !== household.baseCurrency;
  // The ladder deciding which figure is the true one is shared with
  // `updateTransaction`: there used to be two copies that agreed today, and
  // nothing warns you when they stop — only an expense worth 14% more or less
  // depending on whether you recorded it or corrected it.
  const chosen = chooseRateSource({
    isBaseCurrency: !needsRate,
    preferred: preferredSource,
    fallback: household.defaultRateSource as RateSource,
    baseBcvMinor: baseBcv,
    baseP2pMinor: baseP2p,
    baseManualMinor: baseManual,
  });
  const sourceUsed = chosen.source;
  // In the household's currency the equivalent is the amount itself.
  const baseUsed = needsRate ? chosen.baseMinor : amountMinor;

  // Non-negotiable rule: a failing rate NEVER stops the expense being recorded.
  let needsReview = false;
  if (needsRate && baseUsed == null) {
    needsReview = true;
    warnings.push(t("services.recordTransaction.noRate"));
  }

  const usedRate: ResolvedRate | null =
    sourceUsed === "bcv" ? rates.bcv : sourceUsed === "p2p" ? rates.p2p : null;

  if (usedRate?.stale) {
    warnings.push(
      t("services.recordTransaction.staleRate", { date: usedRate.effectiveOn }),
    );
    if (isRateTooStale(usedRate, occurredOn)) needsReview = true;
  }

  if (input.confidence != null && input.confidence < 0.7) needsReview = true;
  if (category && category.score < REVIEW_THRESHOLD) needsReview = true;

  /*
   * The account, held to the same bar as the category.
   *
   * It was missing, and it is the field that decides WHICH BALANCE MOVES.
   * «banco» matches four different accounts in the grey band by resemblance and
   * breaks the tie alphabetically: without this warning the expense landed on
   * one of them with nothing to flag it, while a weak category match — which
   * only affects a report — did go to the tray.
   */
  for (const [written, account] of [
    [input.account, fromAccount],
    [input.toAccount, toAccount],
  ] as const) {
    if (account && account.score < REVIEW_THRESHOLD) {
      needsReview = true;
      warnings.push(
        t("services.recordTransaction.accountUnsure", {
          input: written ?? "",
          account: account.name,
        }),
      );
    }
  }
  if ((input.kind === "expense" || input.kind === "income") && !category) needsReview = true;

  // ── Near-duplicate ────────────────────────────────────────────────────────
  const nearDuplicate = await findNearDuplicate(
    household.id,
    fromAccount.id,
    amountMinor,
    occurredOn,
  );
  if (nearDuplicate) {
    const when =
      nearDuplicate.minutesAgo < 1
        ? t("services.recordTransaction.when.justNow")
        : t("services.recordTransaction.when.minutesAgo", { n: nearDuplicate.minutesAgo });

    if (input.onDuplicate === "reject" && !input.dryRun) {
      /*
       * The message is written for whoever will read it: a model that has just
       * called and does not know whether its previous call landed. That is why
       * it says the three things it needs — that it IS already stored, under
       * which id, and what the way out is if these really are two purchases —
       * instead of describing the problem.
       *
       * Without the explicit way out, a rejection is worse than the warning: the
       * model would retry shifting the amount by a cent until it got through.
       */
      throw new InvalidTransactionError(
        t("services.recordTransaction.duplicate.head", {
          description: nearDuplicate.description,
          amount: formatAmount(Math.abs(nearDuplicate.amountMinor), currency),
          account: fromAccount.name,
          when,
        }) +
          // So it knows a cent will not save it: coming back with another similar
          // amount lands in the same place.
          t("services.recordTransaction.duplicate.noCent") +
          t("services.recordTransaction.duplicate.allow") +
          t("services.recordTransaction.duplicate.amend", { id: nearDuplicate.id }),
        "possible_duplicate",
        {
          transaction_id: nearDuplicate.id,
          description: nearDuplicate.description,
          minutes_ago: nearDuplicate.minutesAgo,
        },
      );
    }

    warnings.push(
      t("services.recordTransaction.duplicate.warn", {
        when,
        description: nearDuplicate.description,
      }),
    );
  }

  const description =
    input.description?.trim() ||
    category?.name ||
    (input.kind === "transfer"
      ? t("services.recordTransaction.summary.transferDescription")
      : t("services.recordTransaction.summary.noDescription"));

  // ── Destination line, for transfers ───────────────────────────────────────
  let toAmountMinor: number | null = null;
  let toBases: { bcv: number | null; p2p: number | null; manual: number | null } | null = null;
  let toRates = rates;

  if (input.kind === "transfer" && toAccount) {
    const toCurrency = toAccount.currency;
    if (toCurrency === currency) {
      toAmountMinor = absAmount;
      toBases = {
        bcv: baseBcv == null ? null : -baseBcv,
        p2p: baseP2p == null ? null : -baseP2p,
        manual: baseManual == null ? null : -baseManual,
      };
    } else {
      // Across currencies we need to know what actually arrived: the effective
      // rate of your own exchange is almost never the market's.
      if (input.toAmount == null) {
        throw new InvalidTransactionError(
          t("services.recordTransaction.transferNeedsToAmount", {
            from: currency,
            to: toCurrency,
            account: toAccount.name,
          }),
          "missing_to_amount",
        );
      }
      toAmountMinor = Math.abs(parseAmountToMinor(input.toAmount, toCurrency));
      toRates = await resolveRates({
        quoteCurrency: toCurrency,
        baseCurrency: household.baseCurrency,
        date: occurredOn,
        isToday,
      });
      toBases = {
        bcv: convertToBase(toAmountMinor, toCurrency, household.baseCurrency, toRates.bcv?.value ?? null),
        p2p: convertToBase(toAmountMinor, toCurrency, household.baseCurrency, toRates.p2p?.value ?? null),
        manual: manualRate
          ? convertToBase(toAmountMinor, toCurrency, household.baseCurrency, manualRate)
          : null,
      };
    }
  }

  /*
   * The breakdown is resolved BEFORE writing so that the simulation can describe
   * it. In simulation no product is created: if you say no, the catalogue cannot
   * be left seeded from a purchase that never happened.
   */
  let preparedItems: PreparedItem[] = [];
  if (input.items?.length) {
    // Without creating: products are born inside the write transaction, so that
    // a later failure does not leave them loose in the catalogue.
    preparedItems = await prepareItems(household.id, input.items, currency, false);
    if (itemsNeedReview(preparedItems)) {
      needsReview = true;
      warnings.push(t("services.recordTransaction.itemsNeedReview"));
    }
    const covered = itemsTotal(preparedItems);
    if (covered > absAmount) {
      warnings.push(
        t("services.recordTransaction.itemsExceedTotal", {
          amount: formatAmount(covered, currency),
        }),
      );
    }
  }

  const buildArgs = {
    ok: true,
    duplicate: false,
    household,
    kind: input.kind,
    occurredOn,
    description,
    amountMinor,
    currency,
    baseBcv,
    baseP2p,
    baseManual,
    baseUsed,
    sourceUsed,
    rates,
    manualRate,
    account: fromAccount,
    toAccount,
    category,
    needsReview,
    warnings,
    preparedItems,
    unitemizedMinor: preparedItems.length ? absAmount - itemsTotal(preparedItems) : 0,
  };

  // ── Simulation: everything resolved, nothing written ──────────────────────
  if (input.dryRun) {
    return buildResult({ ...buildArgs, dryRun: true, transactionId: null, balanceAfterMinor: null });
  }

  // ── Writing, all in one transaction ───────────────────────────────────────
  const transactionId = await db.transaction(async (tx) => {
    const [header] = await tx
      .insert(transactions)
      .values({
        householdId: household.id,
        kind: input.kind,
        occurredOn,
        description,
        notes: input.notes ?? null,
        payeeId: input.payeeId ?? null,
        paymentMethod: input.paymentMethod ?? inferPaymentMethod(fromAccount.type),
        source: input.source,
        sourceRef: input.sourceRef ?? null,
        createdByUserId: input.createdByUserId ?? null,
        createdViaTokenId: input.createdViaTokenId ?? null,
        createdByAgent: input.createdByAgent ?? null,
        confidence: input.confidence != null ? input.confidence.toFixed(3) : null,
        needsReview,
        raw: (input.raw ?? null) as never,
        attachmentPath: input.attachmentPath ?? null,
        idempotencyKey: input.idempotencyKey ?? null,
        importBatchId: input.importBatchId ?? null,
      })
      .returning({ id: transactions.id });

    const entries = [
      {
        transactionId: header.id,
        householdId: household.id,
        accountId: fromAccount.id,
        categoryId: input.kind === "transfer" ? null : (category?.id ?? null),
        amountMinor,
        currency,
        baseCurrency: household.baseCurrency,
        rateBcv: rates.bcv?.value ?? null,
        rateP2p: rates.p2p?.value ?? null,
        rateManual: manualRate,
        rateBcvId: rates.bcv?.id ?? null,
        rateP2pId: rates.p2p?.id ?? null,
        rateSourceUsed: sourceUsed,
        rateStale: Boolean(usedRate?.stale),
        baseAmountBcvMinor: baseBcv,
        baseAmountP2pMinor: baseP2p,
        baseAmountManualMinor: baseManual,
        sortOrder: 0,
      },
    ];

    if (input.kind === "transfer" && toAccount && toAmountMinor != null) {
      entries.push({
        transactionId: header.id,
        householdId: household.id,
        accountId: toAccount.id,
        categoryId: null,
        amountMinor: toAmountMinor,
        currency: toAccount.currency,
        baseCurrency: household.baseCurrency,
        rateBcv: toRates.bcv?.value ?? null,
        rateP2p: toRates.p2p?.value ?? null,
        rateManual: manualRate,
        rateBcvId: toRates.bcv?.id ?? null,
        rateP2pId: toRates.p2p?.id ?? null,
        rateSourceUsed: sourceUsed,
        rateStale: Boolean(toRates.bcv?.stale || toRates.p2p?.stale),
        baseAmountBcvMinor: toBases?.bcv ?? null,
        baseAmountP2pMinor: toBases?.p2p ?? null,
        baseAmountManualMinor: toBases?.manual ?? null,
        sortOrder: 1,
      });
    }

    await tx.insert(transactionEntries).values(entries);

    if (preparedItems.length > 0) {
      const withProducts = await ensureProducts(household.id, preparedItems, tx);
      await tx.insert(transactionItems).values(
        withProducts.map((item, i) => ({
          householdId: household.id,
          transactionId: header.id,
          productId: item.productId,
          rawText: item.rawText,
          quantity: item.quantity.toFixed(4),
          unit: item.unit,
          baseQuantity: item.baseQuantity.toFixed(4),
          totalMinor: item.totalMinor,
          currency,
          // EACH line's equivalent at that day's rate: it is what lets you ask whether
          // a product went up without reconverting fourteen rows per purchase, and
          // without the answer depending on today's rate.
          baseAmountBcvMinor: convertToBase(
            item.totalMinor,
            currency,
            household.baseCurrency,
            rates.bcv?.value ?? null,
          ),
          baseAmountP2pMinor: convertToBase(
            item.totalMinor,
            currency,
            household.baseCurrency,
            rates.p2p?.value ?? null,
          ),
          confidence: item.confidence.toFixed(3),
          sortOrder: i,
        })),
      );
    }

    return header.id;
  });

  return buildResult({
    ...buildArgs,
    dryRun: false,
    transactionId,
    balanceAfterMinor: await accountBalance(fromAccount.id),
  });
}

// ── Assembling the result and the summary ─────────────────────────────────

type BuildArgs = {
  ok: boolean;
  duplicate: boolean;
  dryRun: boolean;
  transactionId: string | null;
  household: Household;
  kind: TransactionKind;
  occurredOn: string;
  description: string;
  amountMinor: number;
  currency: string;
  baseBcv: number | null;
  baseP2p: number | null;
  baseManual: number | null;
  baseUsed: number | null;
  sourceUsed: "bcv" | "p2p" | "manual" | "none";
  rates: { bcv: ResolvedRate | null; p2p: ResolvedRate | null };
  manualRate: string | null;
  account: { id: string; name: string; currency: string; type?: string; score: number; via: string };
  toAccount: {
    id: string;
    name: string;
    currency: string;
    type?: string;
    score: number;
    via: string;
  } | null;
  category: Match | null;
  needsReview: boolean;
  warnings: string[];
  balanceAfterMinor: number | null;
  preparedItems?: PreparedItem[];
  unitemizedMinor?: number;
};

function buildResult(a: BuildArgs): RecordTransactionResult {
  const t = getTranslator(a.household.locale);
  const amountText = formatAmount(Math.abs(a.amountMinor), a.currency);
  const baseText =
    a.baseUsed != null && a.currency !== a.household.baseCurrency
      ? formatAmount(Math.abs(a.baseUsed), a.household.baseCurrency)
      : null;

  const sourceLabel = a.sourceUsed === "p2p" ? "P2P" : a.sourceUsed === "bcv" ? "BCV" : "manual";

  // The bot repeats the summary verbatim in Telegram. It is assembled here, and
  // not in the model, so it has to do no arithmetic and reformat no figures.
  const parts: string[] = [];
  if (a.dryRun) parts.push(t("services.recordTransaction.summary.dryRun"));

  if (a.kind === "transfer" && a.toAccount) {
    parts.push(
      t("services.recordTransaction.summary.transfer", {
        amount: amountText,
        from: a.account.name,
        to: a.toAccount.name,
      }),
    );
  } else {
    /*
     * One message and not four fragments joined up.
     *
     * The verb, the preposition and the order all move together: an income goes
     * «Ingreso … a la cuenta» and «Income … to the account», but an expense goes
     * «desde» and "from". Concatenating outside would have needed a preposition
     * table that says nothing about which sentence it belongs to; inside a
     * `select` the two forms sit next to each other and cannot drift apart.
     */
    parts.push(
      t("services.recordTransaction.summary.entry", {
        kind: a.kind,
        amount: amountText,
        equivalent: baseText
          ? t("services.recordTransaction.summary.equivalent", {
              base: baseText,
              source: sourceLabel,
            })
          : "",
        category: a.category
          ? t("services.recordTransaction.summary.category", { name: a.category.name })
          : "",
        account: a.account.name,
      }),
    );
  }

  // The breakdown, on one line: it is what the bot shows before asking for a yes.
  if (a.preparedItems?.length) {
    const n = a.preparedItems.length;
    const missing = a.unitemizedMinor ?? 0;
    parts.push(
      t("services.recordTransaction.summary.items", {
        n,
        missing:
          missing > 0
            ? t("services.recordTransaction.summary.itemsMissing", {
                amount: formatAmount(missing, a.currency),
              })
            : "",
      }),
    );
  }

  if (a.balanceAfterMinor != null) {
    parts.push(
      t("services.recordTransaction.summary.balance", {
        account: a.account.name,
        amount: formatAmount(a.balanceAfterMinor, a.account.currency),
      }),
    );
  }

  let summary = parts.join(". ") + ".";
  if (a.warnings.length > 0) summary += " " + a.warnings.join(" ");
  if (a.duplicate) summary = t("services.recordTransaction.summary.alreadyStored") + summary;

  return {
    ok: a.ok,
    duplicate: a.duplicate,
    dryRun: a.dryRun,
    transactionId: a.transactionId,
    kind: a.kind,
    occurredOn: a.occurredOn,
    description: a.description,
    amount: { minor: a.amountMinor, currency: a.currency, text: amountText },
    base: {
      currency: a.household.baseCurrency,
      bcvMinor: a.baseBcv,
      p2pMinor: a.baseP2p,
      manualMinor: a.baseManual,
      usedMinor: a.baseUsed,
      sourceUsed: a.sourceUsed,
    },
    rates: {
      bcv: a.rates.bcv?.value ?? null,
      p2p: a.rates.p2p?.value ?? null,
      manual: a.manualRate,
      effectiveOn: a.rates.p2p?.effectiveOn ?? a.rates.bcv?.effectiveOn ?? null,
      stale: Boolean(a.rates.p2p?.stale || a.rates.bcv?.stale),
    },
    resolved: {
      account: { ...a.account, via: a.account.via as Match["via"] },
      toAccount: a.toAccount
        ? { ...a.toAccount, via: a.toAccount.via as Match["via"] }
        : null,
      category: a.category,
    },
    needsReview: a.needsReview,
    items: (a.preparedItems ?? []).map((i) => ({
      product: i.productName,
      quantity: i.quantity,
      unit: i.unit,
      total: formatAmount(i.totalMinor, a.currency),
      isNew: i.created,
    })),
    unitemizedMinor: a.unitemizedMinor ?? 0,
    warnings: a.warnings,
    balanceAfter:
      a.balanceAfterMinor != null
        ? {
            account: a.account.name,
            minor: a.balanceAfterMinor,
            text: formatAmount(a.balanceAfterMinor, a.account.currency),
          }
        : null,
    summary,
  };
}

/** Rebuilds the result of an entry that already existed (idempotent response). */
async function describeExisting(
  transactionId: string,
  household: Household,
  duplicate: boolean,
): Promise<RecordTransactionResult> {
  const { rows } = await db.execute<{
    kind: TransactionKind;
    occurred_on: string;
    description: string;
    needs_review: boolean;
    amount_minor: string;
    currency: string;
    base_amount_bcv_minor: string | null;
    base_amount_p2p_minor: string | null;
    base_amount_manual_minor: string | null;
    rate_source_used: string;
    rate_bcv: string | null;
    rate_p2p: string | null;
    rate_manual: string | null;
    account_id: string;
    account_name: string;
    account_currency: string;
    category_id: string | null;
    category_name: string | null;
  }>(sql`
    SELECT t.kind, t.occurred_on, t.description, t.needs_review,
           e.amount_minor::text, e.currency,
           e.base_amount_bcv_minor::text, e.base_amount_p2p_minor::text,
           e.base_amount_manual_minor::text, e.rate_source_used,
           e.rate_bcv, e.rate_p2p, e.rate_manual,
           a.id AS account_id, a.name AS account_name, a.currency AS account_currency,
           c.id AS category_id, c.name AS category_name
      FROM transactions t
      JOIN transaction_entries e ON e.transaction_id = t.id AND e.sort_order = 0
      JOIN accounts a ON a.id = e.account_id
      LEFT JOIN categories c ON c.id = e.category_id
     WHERE t.id = ${transactionId}
     LIMIT 1
  `);

  const r = rows[0];
  const num = (v: string | null) => (v == null ? null : Number(v));

  return buildResult({
    ok: true,
    duplicate,
    dryRun: false,
    transactionId,
    household,
    kind: r.kind,
    occurredOn: r.occurred_on,
    description: r.description,
    amountMinor: Number(r.amount_minor),
    currency: r.currency,
    baseBcv: num(r.base_amount_bcv_minor),
    baseP2p: num(r.base_amount_p2p_minor),
    baseManual: num(r.base_amount_manual_minor),
    baseUsed:
      r.rate_source_used === "bcv"
        ? num(r.base_amount_bcv_minor)
        : r.rate_source_used === "p2p"
          ? num(r.base_amount_p2p_minor)
          : r.rate_source_used === "manual"
            ? num(r.base_amount_manual_minor)
            : Number(r.amount_minor),
    sourceUsed: r.rate_source_used as BuildArgs["sourceUsed"],
    rates: {
      // Rebuilt from what is stamped on the row, not from the rates table: that is
      // why the id comes back empty and `manual` cannot be known here — the row
      // stores the figure that was used, not where it came from that day.
      bcv: r.rate_bcv
        ? { id: "", value: r.rate_bcv, effectiveOn: r.occurred_on, stale: false, manual: false, ages: true }
        : null,
      p2p: r.rate_p2p
        ? { id: "", value: r.rate_p2p, effectiveOn: r.occurred_on, stale: false, manual: false, ages: true }
        : null,
    },
    manualRate: r.rate_manual,
    account: {
      id: r.account_id,
      name: r.account_name,
      currency: r.account_currency,
      score: 1,
      via: "slug",
    },
    toAccount: null,
    category: r.category_id
      ? { id: r.category_id, name: r.category_name!, score: 1, via: "slug" }
      : null,
    needsReview: r.needs_review,
    warnings: [],
    balanceAfterMinor: await accountBalance(r.account_id),
  });
}
