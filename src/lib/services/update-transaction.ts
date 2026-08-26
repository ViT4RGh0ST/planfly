import { amountErrorMessage } from "@/lib/user-error";
import { and, asc, eq } from "drizzle-orm";

import { db } from "@/db";
import {
  accounts,
  households,
  transactionEntries,
  transactionItems,
  transactions,
} from "@/db/schema";
import {
  convertToBase,
  formatAmount,
  InvalidAmountError,
  formatRate,
  minorToDecimalString,
  parseAmountToMinor,
  parseRate,
} from "@/lib/money";
import { chooseRateSource, type RateSource } from "@/lib/rate-source";
import { DEFAULT_LOCALE, normalizeLocale } from "@/i18n/config";
import { getTranslator } from "@/i18n/translator";
import { addDays, formatDay, today } from "@/lib/dates";
import { resolveRates, isRateTooStale } from "@/lib/rates/service";
import {
  ensureProducts,
  itemsNeedReview,
  itemsTotal,
  prepareItems,
  type ItemInput,
  type PreparedItem,
} from "./products";
import { resolveAccount, resolveCategory } from "./resolve-entities";
import { InvalidTransactionError } from "./record-transaction";

/**
 * The ONE editing path into the ledger.
 *
 * Sibling of `recordTransaction()`, and for the same reason: until now each
 * caller corrected on its own, and the versions had diverged. The `PATCH`
 * endpoint knew how to change amount, date, account and description; the
 * dashboard only category, rate and voiding. That is, over Telegram you could
 * correct more than sitting in front of the screen.
 *
 * Worse: the dashboard action picked the leg to revalue with a `limit(1)` and no
 * `order by`, so on a transfer Postgres returned whichever it liked and the rate
 * could end up stamped on the wrong side.
 *
 * Here both legs are treated as one unit and rates are recomputed by an explicit
 * rule, not as a side effect.
 */

export type UpdateTransactionInput = {
  householdId: string;
  transactionId: string;
  /** MAJOR units as the person writes them: "13.936,46". Origin leg. */
  amount?: string | number;
  /** Destination leg. Transfers only. */
  toAmount?: string | number;
  /** Account name or alias; resolved fuzzily. */
  account?: string;
  toAccount?: string;
  category?: string;
  description?: string;
  /** 'YYYY-MM-DD'. Changing it re-resolves THAT day's rates. */
  occurredOn?: string;
  notes?: string;
  /** Manual quoted-per-base rate for the origin leg. */
  rate?: string | number;
  /** Same for the destination leg. */
  toRate?: string | number;
  /**
   * Which rate the incoming amount was derived with, if it was derived at all.
   *
   * Without this, writing 40 dollars and converting them at BCV in the field
   * stored the result but revalued with the household preference: the history
   * gave back $ 34,96 where you had written 40. It is the same failure
   * `useMoneyEntry` describes as its reason to exist, and the wire that was
   * missing.
   */
  rateSource?: "bcv" | "p2p" | "manual";
  /** Same for a transfer's destination leg. */
  toRateSource?: "bcv" | "p2p" | "manual";
  /**
   * The complete breakdown, if it is touched at all.
   *
   * It replaces whatever was there: editing a list line by line with identifiers
   * would force keeping track of which ones were deleted, and an invoice's
   * breakdown is corrected by looking at it whole, not row by row.
   *
   * `undefined` keeps what is there; `[]` deletes it.
   */
  items?: ItemInput[];
  /**
   * What to do with the lines that were already there.
   *
   * `replace` is the usual one and what the form needs: it arrives pre-filled
   * and resends the whole breakdown, so what it sends is the complete list.
   *
   * `append` exists for the bot. «Add the bread to it» is a sentence naming ONE
   * line, and with `replace` it would have deleted the other nine without saying
   * so — the worst kind of failure: silent and shaped like a success.
   */
  itemsMode?: "replace" | "append";
  /** Take it out of the tray without changing anything else. */
  approve?: boolean;
  /**
   * Bounds it to what the agent may touch: rows it created itself (telegram or
   * ocr) and from the last 7 days. A conversational correction must never be
   * able to silently rewrite an imported bank statement.
   */
  agentWindow?: boolean;
  reviewedById?: string;
};

export type UpdateTransactionResult = {
  ok: boolean;
  transactionId: string;
  changes: string[];
  warnings: string[];
  summary: string;
};

/** Which origin and age the agent is allowed to correct. */
export const AGENT_EDITABLE_SOURCES = ["telegram", "ocr", "mcp"] as const;
export const AGENT_EDITABLE_DAYS = 7;

type Leg = {
  id: string;
  sortOrder: number;
  accountId: string;
  accountName: string;
  categoryId: string | null;
  amountMinor: number;
  currency: string;
  baseCurrency: string;
  rateBcv: string | null;
  rateP2p: string | null;
  rateManual: string | null;
  rateBcvId: string | null;
  rateP2pId: string | null;
  rateSourceUsed: string;
};

/** What is going to be written on a leg. Accumulated and applied once. */
type LegPatch = Record<string, unknown>;

export async function updateTransaction(
  input: UpdateTransactionInput,
): Promise<UpdateTransactionResult> {
  const [household] = await db
    .select({
      baseCurrency: households.baseCurrency,
      timezone: households.timezone,
      defaultRateSource: households.defaultRateSource,
      locale: households.locale,
    })
    .from(households)
    .where(eq(households.id, input.householdId))
    .limit(1);

  if (!household) {
    // In the default language: the language lives in the row that is missing.
    throw new InvalidTransactionError(
      getTranslator(DEFAULT_LOCALE)("services.updateTransaction.householdNotFound"),
      "household_not_found",
    );
  }

  const t = getTranslator(normalizeLocale(household.locale));

  // ── The entry and its legs ────────────────────────────────────────────────
  const [header] = await db
    .select({
      id: transactions.id,
      kind: transactions.kind,
      occurredOn: transactions.occurredOn,
      description: transactions.description,
      notes: transactions.notes,
      source: transactions.source,
      voidedAt: transactions.voidedAt,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.id, input.transactionId),
        eq(transactions.householdId, input.householdId),
      ),
    )
    .limit(1);

  if (!header) {
    throw new InvalidTransactionError(t("services.updateTransaction.notFound"), "not_found");
  }

  // A voided one keeps its lines exactly as they were: it stays in the history
  // so as not to leave a hole, but it no longer takes part in anything.
  if (header.voidedAt) {
    throw new InvalidTransactionError(t("services.updateTransaction.voided"), "voided");
  }

  if (input.agentWindow) {
    const since = addDays(today(household.timezone), -AGENT_EDITABLE_DAYS);
    const editable =
      (AGENT_EDITABLE_SOURCES as readonly string[]).includes(header.source) &&
      header.occurredOn >= since;
    if (!editable) {
      throw new InvalidTransactionError(t("services.updateTransaction.notEditable"), "not_editable");
    }
  }

  const legRows = await db
    .select({
      id: transactionEntries.id,
      sortOrder: transactionEntries.sortOrder,
      accountId: transactionEntries.accountId,
      accountName: accounts.name,
      categoryId: transactionEntries.categoryId,
      amountMinor: transactionEntries.amountMinor,
      currency: transactionEntries.currency,
      baseCurrency: transactionEntries.baseCurrency,
      rateBcv: transactionEntries.rateBcv,
      rateP2p: transactionEntries.rateP2p,
      rateManual: transactionEntries.rateManual,
      rateBcvId: transactionEntries.rateBcvId,
      rateP2pId: transactionEntries.rateP2pId,
      rateSourceUsed: transactionEntries.rateSourceUsed,
    })
    .from(transactionEntries)
    .innerJoin(accounts, eq(accounts.id, transactionEntries.accountId))
    .where(eq(transactionEntries.transactionId, header.id))
    .orderBy(asc(transactionEntries.sortOrder));

  // `sort_order` and not whatever order the database returns: it is what tells
  // the origin leg from the destination one, and which gets the rate stamped.
  const from = legRows.find((l) => l.sortOrder === 0) as Leg | undefined;
  const to = legRows.find((l) => l.sortOrder === 1) as Leg | undefined;
  if (!from) {
    throw new InvalidTransactionError(t("services.updateTransaction.malformed"), "malformed_transaction");
  }

  const isTransfer = header.kind === "transfer";
  const changes: string[] = [];
  const warnings: string[] = [];
  const headerPatch: Record<string, unknown> = {};
  const patches = new Map<string, LegPatch>();
  let itemsPatch: PreparedItem[] | null = null;
  let itemsDoubtful = false;

  const patchOf = (leg: Leg): LegPatch => {
    let p = patches.get(leg.id);
    if (!p) {
      p = {};
      patches.set(leg.id, p);
    }
    return p;
  };

  /**
   * Legs whose valuation has to be redone.
   *
   * Only the ones changing amount, currency, date or rate. Always recalculating
   * would make recategorising an expense change its rate source — if the
   * household preference is no longer the one stamped that day — and a category
   * correction cannot move figures behind your back.
   */
  const revalue = new Set<string>();

  // ── Accounts ──────────────────────────────────────────────────────────────
  // A line's currency MUST be its account's: it is the invariant that makes a
  // balance mean something. Moving the line to an account in another currency
  // is not changing account, it is a different entry — unless the amount is
  // corrected too, and then it can be redone whole.
  const currencyOf = new Map<string, string>([[from.id, from.currency]]);
  if (to) currencyOf.set(to.id, to.currency);

  /*
   * `leg` and not a written label.
   *
   * It used to take the words «cuenta» / «cuenta de destino» and compare against
   * them to decide things, which is a comparison against a translatable string.
   * Now it takes which leg it is and the catalogue does the naming.
   */
  async function moveAccount(leg: Leg, wanted: string, which: "from" | "to") {
    /*
     * WITHOUT the currency bias, unlike when recording.
     *
     * That bias exists for natural language: "efectivo" with 350 Bs has to land
     * on the bolívar account. But here the name comes from a dropdown of exact
     * names, and biasing made asking for "Efectivo USD" from a bolívar line
     * return "Efectivo Bs" — the wrong account, in silence — because they look
     * alike and one was of the "right" currency.
     */
    const match = await resolveAccount(input.householdId, wanted);
    if (!match) {
      throw new InvalidTransactionError(
        t("services.updateTransaction.accountNotFound", { wanted }),
        "account_not_found",
      );
    }
    if (match.id === leg.accountId) return;

    const [row] = await db
      .select({ currency: accounts.currency })
      .from(accounts)
      .where(eq(accounts.id, match.id))
      .limit(1);

    const changesCurrency = row.currency !== leg.currency;
    const amountGiven = leg.sortOrder === 0 ? input.amount : input.toAmount;
    if (changesCurrency && amountGiven == null) {
      throw new InvalidTransactionError(
        t("services.updateTransaction.accountCurrencyMismatch", {
          account: match.name,
          accountCurrency: row.currency,
          legCurrency: leg.currency,
        }),
        "currency_mismatch",
      );
    }

    patchOf(leg).accountId = match.id;
    if (changesCurrency) {
      patchOf(leg).currency = row.currency;
      currencyOf.set(leg.id, row.currency);
      revalue.add(leg.id);
    }
    changes.push(t("services.updateTransaction.change.account", { leg: which, name: match.name }));
  }

  if (input.account) await moveAccount(from, input.account, "from");
  if (input.toAccount) {
    if (!to) {
      throw new InvalidTransactionError(t("services.updateTransaction.notATransferAccount"), "not_a_transfer");
    }
    await moveAccount(to, input.toAccount, "to");
  }

  // Origin and destination cannot end up being the same account: the trigger
  // would reject it with a Postgres error nobody knows how to explain.
  if (to) {
    const fromId = (patches.get(from.id)?.accountId as string) ?? from.accountId;
    const toId = (patches.get(to.id)?.accountId as string) ?? to.accountId;
    if (fromId === toId) {
      throw new InvalidTransactionError(t("services.updateTransaction.sameAccount"), "same_account");
    }
  }

  // ── Amounts ───────────────────────────────────────────────────────────────
  const amounts = new Map<string, number>([[from.id, from.amountMinor]]);
  if (to) amounts.set(to.id, to.amountMinor);

  function setAmount(leg: Leg, raw: string | number, which: "from" | "to") {
    const currency = currencyOf.get(leg.id)!;
    const abs = Math.abs(parseAmountToMinor(raw, currency));
    if (abs === 0) {
      throw new InvalidTransactionError(t("services.updateTransaction.zeroAmount"), "zero_amount");
    }
    // The sign is kept: the entry kind sets it and the trigger validates it.
    // An expense does not stop being an expense because the figure is corrected.
    const signed = abs * (leg.amountMinor < 0 ? -1 : 1);
    // The form arrives pre-filled with the current values, so saving without
    // touching anything sends every field. Without this guard, changing nothing
    // would be reported as "corrected amount, category, description…".
    if (signed === leg.amountMinor && currency === leg.currency) return;
    amounts.set(leg.id, signed);
    patchOf(leg).amountMinor = signed;
    revalue.add(leg.id);
    changes.push(t("services.updateTransaction.change.amount", { leg: which, amount: formatAmount(abs, currency) }));
  }

  if (input.amount != null && input.amount !== "") setAmount(from, input.amount, "from");
  if (input.toAmount != null && input.toAmount !== "") {
    if (!to) {
      throw new InvalidTransactionError(t("services.updateTransaction.notATransferAmount"), "not_a_transfer");
    }
    setAmount(to, input.toAmount, "to");
  }

  // A transfer within the same currency has to leave and arrive at the same
  // figure. Editing one leg alone left the other unbalanced, and the trigger
  // did not see it: it only checks there is one positive and one negative,
  // because across different currencies it is legitimate for them to differ.
  if (to && currencyOf.get(from.id) === currencyOf.get(to.id)) {
    const fromAmount = amounts.get(from.id)!;
    const toAmount = amounts.get(to.id)!;
    const touchedFrom = patches.get(from.id)?.amountMinor != null;
    const touchedTo = patches.get(to.id)?.amountMinor != null;

    if (touchedFrom && touchedTo && fromAmount !== -toAmount) {
      throw new InvalidTransactionError(t("services.updateTransaction.sameCurrencyAmounts"), "unbalanced_transfer");
    }
    if (touchedFrom && !touchedTo) {
      amounts.set(to.id, -fromAmount);
      patchOf(to).amountMinor = -fromAmount;
      revalue.add(to.id);
    } else if (touchedTo && !touchedFrom) {
      amounts.set(from.id, -toAmount);
      patchOf(from).amountMinor = -toAmount;
      revalue.add(from.id);
    }
  }

  // ── Category ──────────────────────────────────────────────────────────────
  if (input.category) {
    if (isTransfer) {
      throw new InvalidTransactionError(
        t("services.updateTransaction.transferHasNoCategory"),
        "transfer_has_no_category",
      );
    }
    const category = await resolveCategory(
      input.householdId,
      input.category,
      header.kind === "income" ? "income" : "expense",
    );
    if (!category) {
      throw new InvalidTransactionError(
        t("services.updateTransaction.categoryNotFound", { input: input.category }),
        "category_not_found",
      );
    }
    if (category.id !== from.categoryId) {
      patchOf(from).categoryId = category.id;
      changes.push(t("services.updateTransaction.change.category", { name: category.name }));
    }
  }

  // ── Date: redoes that day's rates ─────────────────────────────────────────
  const occurredOn = input.occurredOn ?? header.occurredOn;
  const dateChanged = input.occurredOn != null && input.occurredOn !== header.occurredOn;
  if (dateChanged) {
    headerPatch.occurredOn = input.occurredOn;
    changes.push(t("services.updateTransaction.change.date", { date: formatDay(occurredOn, household.locale) }));
  }

  // If a line's currency also changed, its old rates say nothing about it any
  // more: they have to be resolved again even if the date was left alone.
  const currencyChanged = (leg: Leg) => currencyOf.get(leg.id) !== leg.currency;

  const stamped = new Map<string, { bcv: string | null; p2p: string | null }>([
    [from.id, { bcv: from.rateBcv, p2p: from.rateP2p }],
  ]);
  if (to) stamped.set(to.id, { bcv: to.rateBcv, p2p: to.rateP2p });

  for (const leg of [from, to].filter(Boolean) as Leg[]) {
    if (!dateChanged && !currencyChanged(leg)) continue;

    const currency = currencyOf.get(leg.id)!;
    const fresh = await resolveRates({
      quoteCurrency: currency,
      baseCurrency: household.baseCurrency,
      date: occurredOn,
      isToday: occurredOn === today(household.timezone),
    });

    stamped.set(leg.id, { bcv: fresh.bcv?.value ?? null, p2p: fresh.p2p?.value ?? null });
    revalue.add(leg.id);
    const p = patchOf(leg);
    p.rateBcv = fresh.bcv?.value ?? null;
    p.rateP2p = fresh.p2p?.value ?? null;
    p.rateBcvId = fresh.bcv?.id ?? null;
    p.rateP2pId = fresh.p2p?.id ?? null;
    p.rateStale = Boolean(fresh.bcv?.stale || fresh.p2p?.stale);

    if (currency !== household.baseCurrency && !fresh.bcv && !fresh.p2p) {
      warnings.push(
        t("services.updateTransaction.warning.noRate", {
          date: occurredOn,
          currency,
          base: household.baseCurrency,
        }),
      );
    } else if (
      (fresh.bcv && isRateTooStale(fresh.bcv, occurredOn)) ||
      (fresh.p2p && isRateTooStale(fresh.p2p, occurredOn))
    ) {
      warnings.push(t("services.updateTransaction.warning.staleRate", { date: occurredOn }));
    }
  }

  // ── Manual rate, per leg ──────────────────────────────────────────────────
  const manual = new Map<string, string | null>([[from.id, from.rateManual]]);
  if (to) manual.set(to.id, to.rateManual);

  function setManualRate(leg: Leg, raw: string | number, which: "from" | "to") {
    const currency = currencyOf.get(leg.id)!;
    if (currency === household.baseCurrency) {
      warnings.push(
        t("services.updateTransaction.warning.rateIgnored", { leg: which, base: household.baseCurrency }),
      );
      return;
    }
    // With `parseRate` and not a hand-rolled `Number()`: the old one swapped the
    // FIRST comma for a dot, so "1.234,56" came out NaN and the correction was
    // discarded in silence. And it is the same reader as recording and /rates.
    let value: string;
    try {
      value = parseRate(raw);
    } catch (err) {
      // Written out here: `parseRate` throws a code and this is where the
      // household's language is known.
      throw new InvalidTransactionError(
        err instanceof InvalidAmountError
          ? amountErrorMessage(err, household.locale)
          : (err as Error).message,
        "invalid_rate",
      );
    }
    if (leg.rateManual != null && Number(leg.rateManual) === Number(value)) return;
    manual.set(leg.id, value);
    patchOf(leg).rateManual = value;
    revalue.add(leg.id);
    changes.push(t("services.updateTransaction.change.rate", { leg: which, rate: formatRate(value) }));
  }

  if (input.rate != null && input.rate !== "") setManualRate(from, input.rate, "from");
  if (input.toRate != null && input.toRate !== "") {
    if (!to) {
      throw new InvalidTransactionError(t("services.updateTransaction.notATransferRate"), "not_a_transfer");
    }
    setManualRate(to, input.toRate, "to");
  }

  /*
   * Saying which rate the figure was derived with also forces a revaluation.
   *
   * Otherwise, converting in the field and saving without the amount changing —
   * because it already was that number — left the line on the old source: the
   * datum travelled and nobody read it. It only counts when what is stored
   * genuinely changes.
   */
  /*
   * The adjective agrees with a noun that is not in the value.
   *
   * It used to be a table of loose words — «oficial», «paralela» — and in
   * Spanish the ending depends on *la tasa*, which is nowhere near the table. It
   * now agrees inside the sentence that contains it, with a `select`.
   */
  for (const [leg, asked, which] of [
    [from, input.rateSource, "from"],
    [to, input.toRateSource, "to"],
  ] as const) {
    if (!leg || !asked || leg.rateSourceUsed === asked) continue;
    revalue.add(leg.id);
    // And it counts as a change: without this the function left through «There
    // was nothing to change» before writing, because converting in the field
    // does not always move the amount — sometimes it already was that figure.
    changes.push(t("services.updateTransaction.change.valuation", { leg: which, source: asked }));
  }

  // ── Recomputing the equivalents ───────────────────────────────────────────
  // Redone whenever anything feeding the calculation changed: amount,
  // currency, date or rate. Recomputing with the rates already stamped is what
  // makes correcting a figure not rewrite the rate's history.
  let leftUnvalued = false;

  for (const leg of [from, to].filter(Boolean) as Leg[]) {
    if (!revalue.has(leg.id)) {
      // Nothing changed that affects the equivalent, but if the line was already
      // unvalued we still have to keep saying so.
      if (currencyOf.get(leg.id) !== household.baseCurrency && leg.rateSourceUsed === "none") {
        leftUnvalued = true;
      }
      continue;
    }
    const p = patchOf(leg);

    const currency = currencyOf.get(leg.id)!;
    const amount = amounts.get(leg.id)!;
    const rates = stamped.get(leg.id)!;
    const manualRate = manual.get(leg.id) ?? null;

    const baseBcv = convertToBase(amount, currency, household.baseCurrency, rates.bcv);
    const baseP2p = convertToBase(amount, currency, household.baseCurrency, rates.p2p);
    const baseManual = convertToBase(amount, currency, household.baseCurrency, manualRate);

    p.baseAmountBcvMinor = baseBcv;
    p.baseAmountP2pMinor = baseP2p;
    p.baseAmountManualMinor = baseManual;

    /*
     * Which source rules. The ladder lives in `chooseRateSource`, shared with
     * `recordTransaction`: there used to be two copies deciding which of the
     * three figures is the true one, and the day one of them gained a rung —
     * like the one just below — recording and correcting would start disagreeing
     * about what the same thing cost.
     *
     * Correcting's own rung: if none is asked for, **the one the line already
     * had** is honoured. Without it, correcting the amount of an expense you
     * once valued at BCV silently returned it to the household preference, and
     * this module's rule is that correcting a figure does not rewrite the rate's
     * history.
     */
    const previous =
      leg.rateSourceUsed === "bcv" ||
      leg.rateSourceUsed === "p2p" ||
      leg.rateSourceUsed === "manual"
        ? leg.rateSourceUsed
        : undefined;
    const { source: used } = chooseRateSource({
      isBaseCurrency: currency === household.baseCurrency,
      preferred: (leg === to ? input.toRateSource : input.rateSource) ?? previous,
      fallback: household.defaultRateSource as RateSource,
      baseBcvMinor: baseBcv,
      baseP2pMinor: baseP2p,
      baseManualMinor: baseManual,
    });

    p.rateSourceUsed = used;

    if (currency !== household.baseCurrency && used === "none") leftUnvalued = true;
  }

  // ── The breakdown ──────────────────────────────────────────────────────
  if (input.items != null) {
    let itemsIn: ItemInput[] = input.items;
    /*
     * In `append` mode the ones already there go first, exactly as they were
     * stored. They are re-read here rather than asked of the caller because the
     * bot doesn't have them: its sentence names the new line, not the old nine.
     */
    if (input.itemsMode === "append" && itemsIn.length > 0) {
      const existing = await db
        .select({
          rawText: transactionItems.rawText,
          quantity: transactionItems.quantity,
          unit: transactionItems.unit,
          totalMinor: transactionItems.totalMinor,
        })
        .from(transactionItems)
        .where(eq(transactionItems.transactionId, header.id))
        .orderBy(asc(transactionItems.sortOrder));

      itemsIn = [
        ...existing.map((e) => ({
          description: e.rawText ?? "",
          quantity: Number(e.quantity),
          unit: e.unit ?? undefined,
          total: minorToDecimalString(e.totalMinor, from.currency),
        })),
        ...itemsIn,
      ];
    }

    /*
     * The form arrives pre-filled and resends the breakdown as-is, so "did it
     * change?" has to genuinely compare it. Counting rows — or worse, my first
     * version, `length !== had || length > 0`, which is true whenever there are
     * lines — made saving without touching anything pull the purchase out of the
     * review tray and claim it had been corrected.
     */
    const previous = await db
      .select({
        rawText: transactionItems.rawText,
        quantity: transactionItems.quantity,
        unit: transactionItems.unit,
        totalMinor: transactionItems.totalMinor,
      })
      .from(transactionItems)
      .where(eq(transactionItems.transactionId, header.id))
      .orderBy(asc(transactionItems.sortOrder));

    // With the currency already changed, the amounts the form resends are
    // written in the PREVIOUS one: "1.234,56" of bolívares would be stored as
    // 1.234,56 dollars and leave a false point in the price series.
    if (currencyOf.get(from.id) !== from.currency && itemsIn.length > 0) {
      throw new InvalidTransactionError(
        t("services.updateTransaction.itemsWithCurrencyChange"),
        "items_with_currency_change",
      );
    }

    for (const item of itemsIn) {
      if (Math.abs(parseAmountToMinor(item.total, currencyOf.get(from.id)!)) === 0) {
        throw new InvalidTransactionError(
          t("services.updateTransaction.zeroItemTotal", { description: item.description }),
          "zero_item_total",
        );
      }
    }

    const prepared = itemsIn.length
      ? await prepareItems(input.householdId, itemsIn, currencyOf.get(from.id)!, false)
      : [];

    const signature = (rows: { rawText: string | null; quantity: string; unit: string | null; totalMinor: number }[]) =>
      rows.map((r) => `${r.rawText ?? ""}|${Number(r.quantity)}|${r.unit ?? ""}|${r.totalMinor}`).join("\n");
    const before = signature(previous);
    const ahora = signature(
      prepared.map((i) => ({
        rawText: i.rawText,
        quantity: String(i.quantity),
        unit: i.unit,
        totalMinor: i.totalMinor,
      })),
    );

    if (before !== ahora) {
      itemsPatch = prepared;
      changes.push(
        prepared.length === 0
          ? t("services.updateTransaction.change.itemsCleared")
          : t("services.updateTransaction.change.items", { n: prepared.length }),
      );
      // The same rules as when recording: a weak match sends the purchase to
      // review, and if the lines exceed the total it is flagged. Without this,
      // correcting a breakdown left it marked as reviewed, and in silence.
      if (itemsNeedReview(prepared)) {
        itemsDoubtful = true;
        warnings.push(t("services.updateTransaction.warning.itemsNeedReview"));
      }
      const covered = itemsTotal(prepared);
      const total = Math.abs(amounts.get(from.id)!);
      if (covered > total) {
        warnings.push(
          t("services.updateTransaction.warning.itemsExceedTotal", {
            amount: formatAmount(covered, currencyOf.get(from.id)!),
          }),
        );
      }
    }
  }

  // ── Header ────────────────────────────────────────────────────────────────
  if (
    input.description != null &&
    input.description.trim() !== "" &&
    input.description.trim() !== header.description
  ) {
    headerPatch.description = input.description.trim();
    changes.push(t("services.updateTransaction.change.description"));
  }
  if (input.notes != null) {
    const notes = input.notes.trim() || null;
    if (notes !== (header.notes ?? null)) {
      headerPatch.notes = notes;
      changes.push(t("services.updateTransaction.change.notes"));
    }
  }

  if (changes.length === 0 && !input.approve) {
    return {
      ok: true,
      transactionId: header.id,
      changes: [],
      warnings,
      summary: t("services.updateTransaction.summary.nothingToChange"),
    };
  }

  // Correcting settles the doubt: leaving the row flagged after fixing it
  // would force touching it again in the dashboard for nothing. Unless the
  // correction left it without an equivalent, which is exactly what to review.
  headerPatch.needsReview = leftUnvalued || itemsDoubtful;
  headerPatch.reviewedAt = new Date();
  if (input.reviewedById) headerPatch.reviewedById = input.reviewedById;
  headerPatch.updatedAt = new Date();

  if (leftUnvalued) {
    warnings.push(t("services.updateTransaction.warning.leftUnvalued"));
  }

  // ── Writing ───────────────────────────────────────────────────────────────
  // All in one transaction: the trigger is DEFERRABLE INITIALLY DEFERRED, so
  // it validates at COMMIT and both legs can be updated separately without an
  // unbalanced intermediate state setting it off.
  await db.transaction(async (tx) => {
    for (const [entryId, patch] of patches) {
      if (Object.keys(patch).length === 0) continue;
      await tx.update(transactionEntries).set(patch).where(eq(transactionEntries.id, entryId));
    }
    await tx.update(transactions).set(headerPatch).where(eq(transactions.id, header.id));

    if (itemsPatch != null) {
      // Replaced whole: see above for why it is not edited line by line.
      await tx.delete(transactionItems).where(eq(transactionItems.transactionId, header.id));
      if (itemsPatch.length > 0) {
        // Products are created IN HERE: if the write fails, no products from a
        // correction that never happened can be left in the catalogue.
        itemsPatch = await ensureProducts(input.householdId, itemsPatch, tx);
        const currency = currencyOf.get(from.id)!;
        const stampedRates = stamped.get(from.id)!;
        await tx.insert(transactionItems).values(
          itemsPatch.map((item, i) => ({
            householdId: input.householdId,
            transactionId: header.id,
            productId: item.productId,
            rawText: item.rawText,
            quantity: item.quantity.toFixed(4),
            unit: item.unit,
            baseQuantity: item.baseQuantity.toFixed(4),
            totalMinor: item.totalMinor,
            currency,
            // With the rates ALREADY stamped on the line, not with today's:
            // correcting a breakdown cannot rewrite the price's history.
            baseAmountBcvMinor: convertToBase(
              item.totalMinor,
              currency,
              household.baseCurrency,
              stampedRates.bcv,
            ),
            baseAmountP2pMinor: convertToBase(
              item.totalMinor,
              currency,
              household.baseCurrency,
              stampedRates.p2p,
            ),
            confidence: item.confidence.toFixed(3),
            sortOrder: i,
          })),
        );
      }
    }
  });

  const summary =
    changes.length > 0
      ? t("services.updateTransaction.summary.done", { changes: changes.join(", ") })
      : t("services.updateTransaction.summary.markedReviewed");

  return {
    ok: true,
    transactionId: header.id,
    changes: changes.length > 0 ? changes : [t("services.updateTransaction.change.reviewed")],
    warnings,
    summary: warnings.length > 0 ? `${summary} ${warnings.join(" ")}` : summary,
  };
}
