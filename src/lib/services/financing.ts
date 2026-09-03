import { and, asc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";

import { db } from "@/db";
import { normalizeLocale, type Locale } from "@/i18n/config";
import { getTranslator } from "@/i18n/translator";
import { localeOf } from "./household-locale";
import {
  accounts,
  financierProfiles,
  households,
  financingPlans,
  installments,
  transactions,
} from "@/db/schema";
import { formatAmount, minorToDecimalString, minorUnit, parseAmountToMinor } from "@/lib/money";
import { addDays, formatDay, today } from "@/lib/dates";
import { resolveRates } from "@/lib/rates/service";
import { balanceExpression } from "./balances";
import { InvalidTransactionError, recordTransaction } from "./record-transaction";
import { resolveAccount } from "./resolve-entities";

/**
 * Financed purchases.
 *
 * An installment purchase is recorded as TWO entries, not as one odd hybrid:
 *
 *   1. The full expense, charged to the financier's account. That account is a
 *      liability, so its balance goes negative: that is what you owe.
 *   2. The down payment, as a transfer from your account towards the financier.
 *
 * That way each row is true on its own and the ledger's invariant — one line per
 * expense, two per transfer — stays intact. The installment schedule lives
 * apart, in `financing_plans` and `installments`, because it is the only thing
 * the ledger cannot answer: how much is left and by when.
 *
 * **An installment is not an expense.** The expense happened on the day of the
 * purchase, at its full value. Paying an installment moves money from your
 * account to the debt and nothing more. Counting it as an expense would
 * duplicate the month: Bs 4.000 bought in three installments would show up as
 * Bs 8.000 spent.
 */

import { splitInstallments, STEP_DAYS, type Frequency } from "@/lib/installments";

export { splitInstallments };
export type { Frequency };

/** How often an installment falls due. Cashea runs biweekly; a loan usually monthly. */
export type FinancedPurchaseInput = {
  householdId: string;
  /** Name or alias of the financier's liability account. */
  financier: string;
  /** Total amount of the purchase, in major units: "4.000,00". */
  total: string | number;
  /**
   * The currency the price was WRITTEN in, if it isn't the financier's.
   *
   * «Some fifty-dollar shoes on Cashea» and Cashea deals in bolívares. It is
   * compared against the financier's currency and only converted if they really
   * differ: converting when they match divides by the rate a figure that was
   * already right, and the result doesn't fail — it comes out 877 times smaller
   * and the down payment ends up larger than it.
   */
  totalCurrency?: string;
  /** What is paid up front. It may be zero. */
  downPayment?: string | number;
  /** Which account the down payment leaves from. Required if there is one. */
  downPaymentAccount?: string;
  category?: string;
  description?: string;
  occurredOn?: string;
  installmentCount: number;
  /**
   * The interest AGREED for the whole schedule, in major units. Never derived.
   *
   * A financier's paper says what it says — its own rounding, its own day count,
   * its own fees — and a rate applied here would give a figure close to it and
   * different from it. The difference would surface, if ever, on the last
   * instalment. So planfly stores what was agreed and computes nothing.
   *
   * It is spread across the instalments the same way the principal is, and each
   * one records its share, because that is the part that must not be treated as
   * a movement when it is paid.
   */
  interest?: string | number;
  frequency?: Frequency;
  /** Due date of the first installment. Defaults to one period later. */
  firstDueOn?: string;
  source?: "telegram" | "form" | "api";
  createdByUserId?: string;
  /**
   * Which rate to value the purchase at.
   *
   * If the price was written in dollars and converted at BCV, the row has to say
   * that price in dollars again. Without this it would be valued with the
   * household preference and the number would not match what you typed.
   */
  rateSource?: "official" | "parallel" | "manual";
};

/**
 * The total, already in the financier's currency.
 *
 * The check that was missing is the first one: **if the currencies match there
 * is nothing to convert**. Without it, sending the price in bolívares for a
 * bolívar financier divided it by the rate, and the error that came out — «the
 * down payment cannot be larger than the total» — pointed nowhere near the cause.
 *
 * It lives here and not in the route because here is where the financier's
 * currency is known: the route would have had to resolve the account on its own,
 * and that is precisely the resolution that must not be duplicated.
 */
async function totalInFinancierCurrency(
  input: FinancedPurchaseInput,
  currency: string,
): Promise<number> {
  const written = input.totalCurrency?.toUpperCase();
  if (!written || written === currency) {
    return Math.abs(parseAmountToMinor(input.total, currency));
  }

  const [home] = await db
    .select({
      baseCurrency: households.baseCurrency,
      timezone: households.timezone,
      locale: households.locale,
      defaultRateSource: households.defaultRateSource,
    })
    .from(households)
    .where(eq(households.id, input.householdId))
    .limit(1);

  const date = input.occurredOn ?? today(home.timezone);
  // The rate quotes the non-base currency against the base, so the one needed is
  // always the non-base one, and which of the two decides the direction.
  const quoted = written === home.baseCurrency ? currency : written;
  if (quoted === home.baseCurrency) {
    return Math.abs(parseAmountToMinor(input.total, currency));
  }

  const rates = await resolveRates({
    quoteCurrency: quoted,
    baseCurrency: home.baseCurrency,
    date: date,
    isToday: date === today(home.timezone),
  });
  const source = input.rateSource === "official" || input.rateSource === "parallel"
    ? input.rateSource
    : home.defaultRateSource === "official"
      ? "official"
      : "parallel";
  const rate = rates[source]?.value ?? null;
  if (!rate) {
    throw new InvalidTransactionError(
      getTranslator(normalizeLocale(home.locale))("services.financing.missingRate", {
        source: source.toUpperCase(),
        date: formatDay(date, home.locale),
        from: written,
        to: currency,
      }),
      "missing_rate",
    );
  }

  const writtenMinor = Math.abs(parseAmountToMinor(input.total, written));
  const value = writtenMinor / 10 ** minorUnit(written);
  const converted = written === home.baseCurrency ? value * Number(rate) : value / Number(rate);
  return Math.round(converted * 10 ** minorUnit(currency));
}

/**
 * The household's day, not Caracas's.
 *
 * It was hand-written in two places, three functions below where it was already
 * being done right. With the wrong timezone, a 21:00 purchase is booked on the
 * following day and the installments fall due a day out.
 */
async function todayOf(householdId: string): Promise<string> {
  return (await contextOf(householdId)).today;
}

/**
 * The household's day AND its language, in one query.
 *
 * They travel together because they are needed together: a summary says a date,
 * and a date is written differently in each language. Reading them separately
 * would be two round trips for two columns of the same row.
 */
async function contextOf(householdId: string): Promise<{ today: string; locale: Locale }> {
  const [row] = await db
    .select({ timezone: households.timezone, locale: households.locale })
    .from(households)
    .where(eq(households.id, householdId))
    .limit(1);
  return { today: today(row?.timezone ?? "UTC"), locale: normalizeLocale(row?.locale) };
}

export async function recordFinancedPurchase(input: FinancedPurchaseInput) {
  const home = await contextOf(input.householdId);
  const t = getTranslator(home.locale);

  if (input.installmentCount < 1 || !Number.isInteger(input.installmentCount)) {
    throw new InvalidTransactionError(
      t("services.financing.invalidInstallmentCount"),
      "invalid_installment_count",
    );
  }

  const financier = await resolveAccount(input.householdId, input.financier);
  if (!financier) {
    throw new InvalidTransactionError(
      t("services.financing.financierNotFound", { input: input.financier }),
      "account_not_found",
    );
  }

  const [financierRow] = await db
    .select({ nature: accounts.nature, currency: accounts.currency, name: accounts.name })
    .from(accounts)
    .where(eq(accounts.id, financier.id))
    .limit(1);

  // Whoever finances you lends to you: their account has to subtract from net
  // worth. With an asset account, buying in installments would RAISE what you have.
  if (financierRow.nature !== "liability") {
    throw new InvalidTransactionError(
      t("services.financing.financierNotLiability", { account: financierRow.name }),
      "financier_not_liability",
    );
  }

  const currency = financierRow.currency;
  const totalMinor = await totalInFinancierCurrency(input, currency);
  const downMinor =
    input.downPayment == null || input.downPayment === ""
      ? 0
      : Math.abs(parseAmountToMinor(input.downPayment, currency));

  if (downMinor > totalMinor) {
    throw new InvalidTransactionError(t("services.financing.downPaymentTooLarge"), "down_payment_too_large");
  }
  const remaining = totalMinor - downMinor;
  if (remaining === 0) {
    throw new InvalidTransactionError(t("services.financing.nothingToFinance"), "nothing_to_finance");
  }
  if (downMinor > 0 && !input.downPaymentAccount) {
    throw new InvalidTransactionError(
      t("services.financing.missingDownPaymentAccount"),
      "missing_down_payment_account",
    );
  }

  const occurredOn = input.occurredOn ?? home.today;
  // Written to the row: it is frozen in the language it was recorded in and
  // never retranslated on reading. It is a historical record, and rewriting it
  // when the language changes would rewrite history.
  const description = input.description?.trim() || t("services.financing.defaultDescription");
  const frequency = input.frequency ?? "biweekly";
  const step = STEP_DAYS[frequency];
  const firstDue = input.firstDueOn ?? addDays(occurredOn, step);
  const interestMinor =
    input.interest == null ? 0 : parseAmountToMinor(String(input.interest), currency);
  const amounts = splitInstallments(remaining, input.installmentCount);
  const interests = splitInstallments(interestMinor, input.installmentCount);

  // ── 1. The full expense, against the financier ───────────────────────────
  const purchase = await recordTransaction({
    householdId: input.householdId,
    kind: "expense",
    // `minorToDecimalString` rather than dividing by hand: the minor unit depends
    // on the currency, and a fixed /100 would lie the moment one exists that does
    // not have two decimals.
    amount: minorToDecimalString(totalMinor, currency),
    currency,
    account: financierRow.name,
    category: input.category,
    description,
    occurredOn,
    source: input.source ?? "form",
    rateSource: input.rateSource,
    createdByUserId: input.createdByUserId,
    // Written to the row: frozen in the household's language, like every other
    // description and note this service stores.
    notes: t("services.financing.financedNote", { n: input.installmentCount }),
  });

  // ── 2. The down payment, as a transfer towards the financier ─────────────
  let downPaymentTransactionId: string | null = null;
  if (downMinor > 0) {
    const down = await recordTransaction({
      householdId: input.householdId,
      kind: "transfer",
      amount: minorToDecimalString(downMinor, currency),
      currency,
      account: input.downPaymentAccount,
      toAccount: financierRow.name,
      description: t("services.financing.downPaymentDescription", { description }),
      occurredOn,
      rateSource: input.rateSource,
      source: input.source ?? "form",
      createdByUserId: input.createdByUserId,
    });
    downPaymentTransactionId = down.transactionId;
  }

  // ── 3. The schedule ──────────────────────────────────────────────────────
  const planId = await db.transaction(async (tx) => {
    const [plan] = await tx
      .insert(financingPlans)
      .values({
        householdId: input.householdId,
        purchaseTransactionId: purchase.transactionId!,
        financierAccountId: financier.id,
        description,
        totalMinor,
        downPaymentMinor: downMinor,
        downPaymentTransactionId,
        currency,
        purchasedOn: occurredOn,
      })
      .returning({ id: financingPlans.id });

    await tx.insert(installments).values(
      amounts.map((principalMinor, i) => ({
        householdId: input.householdId,
        planId: plan.id,
        number: i + 1,
        dueOn: addDays(firstDue, step * i),
        // What leaves the account, interest included: every screen that already
        // reads this column keeps reading the figure that is actually paid.
        amountMinor: principalMinor + interests[i],
        interestMinor: interests[i],
      })),
    );

    return plan.id;
  });

  const installment = formatAmount(amounts[0] + interests[0], currency);
  return {
    ok: true,
    planId,
    purchaseTransactionId: purchase.transactionId,
    summary: t("services.financing.purchaseSummary", {
      description,
      total: formatAmount(totalMinor, currency),
      financier: financierRow.name,
      downPayment:
        downMinor > 0
          ? t("services.financing.downPaymentPart", { amount: formatAmount(downMinor, currency) })
          : "",
      n: input.installmentCount,
      installment,
      firstDue: formatDay(firstDue, home.locale),
    }),
  };
}

/**
 * Marks an installment as paid and records the entry that pays it.
 *
 * The entry is a TRANSFER from your account to the financier, never an expense:
 * the expense was already counted in full on the day of the purchase.
 */
export type LoanMadeInput = {
  householdId: string;
  /** The asset account standing for what this person owes you. */
  borrower: string;
  /** Which of your accounts the money actually leaves from. */
  fromAccount: string;
  /** What you handed over, in major units. */
  total: string | number;
  /** The interest AGREED for the whole schedule. Never derived. */
  interest?: string | number;
  description?: string;
  occurredOn?: string;
  installmentCount: number;
  frequency?: Frequency;
  firstDueOn?: string;
  source?: "telegram" | "form" | "api";
  createdByUserId?: string;
};

/**
 * Money you lend, with a schedule for getting it back.
 *
 * A sibling of `recordFinancedPurchase` and deliberately not a flag on it. The
 * two share a schedule and nothing else: borrowing starts with an EXPENSE
 * against a liability — you got the goods and now owe for them — while lending
 * starts with a TRANSFER out of your account into a receivable. You spent
 * nothing by lending; what you have changed shape, from cash into somebody's
 * promise, and net worth does not move on the day.
 *
 * Folded into one function behind a nature check, every parameter would mean two
 * different things according to a test made a hundred lines away — `category`
 * says where a purchase is counted and means nothing here; `downPayment` is what
 * you paid up front and would have to become what they paid you. That is this
 * codebase's own rule about a valid field in the wrong context, and it is worse
 * than an invented one because it passes and lands in the bin.
 *
 * What IS shared is the part that must never diverge: the schedule, the interest
 * split, and `payInstallment`, which reads the direction off the account's
 * nature rather than being told.
 */
export async function recordLoanMade(input: LoanMadeInput) {
  const home = await contextOf(input.householdId);
  const t = getTranslator(home.locale);

  const borrower = await resolveAccount(input.householdId, input.borrower);
  if (!borrower) {
    throw new InvalidTransactionError(
      t("services.financing.financierNotFound", { input: input.borrower }),
      "account_not_found",
    );
  }

  const [borrowerRow] = await db
    .select({ nature: accounts.nature, currency: accounts.currency, name: accounts.name })
    .from(accounts)
    .where(eq(accounts.id, borrower.id))
    .limit(1);

  /*
   * What somebody owes you ADDS to net worth, so it has to be an asset. Against
   * a liability this would record a loan you made as a debt you took, and the
   * position would move by twice the amount in the wrong direction.
   */
  if (borrowerRow.nature !== "asset") {
    throw new InvalidTransactionError(
      t("services.financing.borrowerNotAsset", { account: borrowerRow.name }),
      "borrower_not_asset",
    );
  }

  const currency = borrowerRow.currency;
  const totalMinor = Math.abs(parseAmountToMinor(input.total, currency));
  if (totalMinor <= 0) {
    throw new InvalidTransactionError(t("services.financing.totalPositive"), "total_not_positive");
  }
  if (input.installmentCount < 1) {
    throw new InvalidTransactionError(
      t("services.financing.installmentsPositive"),
      "installments_not_positive",
    );
  }

  const occurredOn = input.occurredOn ?? home.today;
  const description = input.description?.trim() || t("services.financing.defaultLoanDescription");
  const frequency = input.frequency ?? "biweekly";
  const step = STEP_DAYS[frequency];
  const firstDue = input.firstDueOn ?? addDays(occurredOn, step);
  const interestMinor =
    input.interest == null ? 0 : parseAmountToMinor(String(input.interest), currency);
  const amounts = splitInstallments(totalMinor, input.installmentCount);
  const interests = splitInstallments(interestMinor, input.installmentCount);

  /*
   * The disbursement: a transfer, not an expense.
   *
   * The money leaves your account and becomes what they owe you. Recording it as
   * an expense would take it off net worth twice — once as spending and once as
   * cash gone — and show a month in which you gave away what you actually lent.
   */
  const handover = await recordTransaction({
    householdId: input.householdId,
    kind: "transfer",
    amount: minorToDecimalString(totalMinor, currency),
    currency,
    account: input.fromAccount,
    toAccount: borrowerRow.name,
    description,
    occurredOn,
    source: input.source ?? "form",
    createdByUserId: input.createdByUserId,
    notes: t("services.financing.lentNote", { n: input.installmentCount }),
  });

  const planId = await db.transaction(async (tx) => {
    const [plan] = await tx
      .insert(financingPlans)
      .values({
        householdId: input.householdId,
        // Non-null because this call is never a dry run: the id is null only
        // when `recordTransaction` simulates, and nothing here simulates.
        purchaseTransactionId: handover.transactionId!,
        financierAccountId: borrower.id,
        description,
        totalMinor,
        // Nothing was paid up front: lending IS the handover.
        downPaymentMinor: 0,
        currency,
        purchasedOn: occurredOn,
      })
      .returning({ id: financingPlans.id });

    await tx.insert(installments).values(
      amounts.map((principalMinor, i) => ({
        householdId: input.householdId,
        planId: plan.id,
        number: i + 1,
        dueOn: addDays(firstDue, step * i),
        amountMinor: principalMinor + interests[i],
        interestMinor: interests[i],
      })),
    );

    return plan.id;
  });

  return {
    ok: true as const,
    planId,
    transactionId: handover.transactionId,
    summary: t("services.financing.loanSummary", {
      description,
      total: formatAmount(totalMinor, currency),
      borrower: borrowerRow.name,
      n: input.installmentCount,
      installment: formatAmount(amounts[0] + interests[0], currency),
      firstDue: formatDay(firstDue, home.locale),
    }),
  };
}

export async function payInstallment(params: {
  householdId: string;
  installmentId: string;
  /** Which account the payment leaves from. */
  fromAccount: string;
  paidOn?: string;
  /**
   * Where the interest is counted, when the instalment carries any.
   *
   * Left empty it goes wherever an expense with no category goes, which is the
   * review tray — deliberately. Interest is a real cost and putting it silently
   * under the purchase's own category would make a month of «Mercado» include
   * money that bought no food.
   */
  interestCategory?: string;
}) {
  const [row] = await db
    .select({
      id: installments.id,
      number: installments.number,
      amountMinor: installments.amountMinor,
      interestMinor: installments.interestMinor,
      paidAt: installments.paidAt,
      planDescription: financingPlans.description,
      currency: financingPlans.currency,
      financierName: accounts.name,
      /*
       * Which way the money goes, read from the counterparty and never asked for.
       *
       * A liability is somebody who lent to YOU: the instalment leaves your
       * account. An asset is somebody who owes you: it arrives. Asking the caller
       * would let a screen send the wrong direction and pay a loan that was owed
       * to you — the balance moves twice the wrong way and nothing fails.
       */
      counterpartyNature: accounts.nature,
    })
    .from(installments)
    .innerJoin(financingPlans, eq(financingPlans.id, installments.planId))
    .innerJoin(accounts, eq(accounts.id, financingPlans.financierAccountId))
    .where(
      and(
        eq(installments.id, params.installmentId),
        eq(installments.householdId, params.householdId),
      ),
    )
    .limit(1);

  const t = getTranslator(await localeOf(params.householdId));

  if (!row) {
    throw new InvalidTransactionError(t("services.financing.installmentNotFound"), "installment_not_found");
  }
  if (row.paidAt) {
    throw new InvalidTransactionError(
      t("services.financing.alreadyPaid", { number: row.number, plan: row.planDescription }),
      "already_paid",
    );
  }

  /*
   * The principal MOVES and the interest is SPENT, so a payment carrying
   * interest is two entries and not one.
   *
   * Transferring the whole payment to the financier would pay the debt down by
   * more than was actually paid off — on Bs 1.100 of which Bs 100 is interest,
   * the debt would drop by 1.100 — and the cost would appear in no report at
   * all. Nothing fails: the balance is simply wrong, by the interest, on every
   * instalment, for the life of the loan.
   *
   * The description says which is which, because the two land side by side in
   * the same day's list and «cuota 3» twice is unreadable.
   */
  const label = t("services.financing.installmentDescription", {
    number: row.number,
    plan: row.planDescription,
  });
  const principalMinor = row.amountMinor - row.interestMinor;

  /*
   * Lending and borrowing are the same schedule read from opposite ends.
   *
   * Owing: the principal goes from your account to the debt. Being owed: it
   * comes from the receivable into your account, and what you gain is income,
   * not a cost. One direction, taken from the account's own nature, rather than
   * two functions that would drift apart on the first fix applied to one.
   */
  const theyOweYou = row.counterpartyNature === "asset";

  const result = await recordTransaction({
    householdId: params.householdId,
    kind: "transfer",
    amount: minorToDecimalString(principalMinor, row.currency),
    currency: row.currency,
    account: theyOweYou ? row.financierName : params.fromAccount,
    toAccount: theyOweYou ? params.fromAccount : row.financierName,
    description: label,
    occurredOn: params.paidOn,
    source: "form",
  });

  /*
   * The interest goes second, and only after the principal committed.
   *
   * The two are not one database transaction because `recordTransaction` owns
   * its own, and reaching inside it to share one would fork the single write
   * path this codebase keeps. So the order is chosen instead: if the interest
   * fails, what is left is a paid-down debt and an uncounted cost — a figure
   * that is too favourable and visible in the plan. The other order would leave
   * an expense for a debt nobody paid.
   */
  let interestTransactionId: string | null = null;
  if (row.interestMinor > 0) {
    const interest = await recordTransaction({
      householdId: params.householdId,
      // Interest you PAY is a cost; interest you RECEIVE is income. Recording
      // the second as an expense would show a loan that earns you money as a
      // month of spending.
      kind: theyOweYou ? "income" : "expense",
      amount: minorToDecimalString(row.interestMinor, row.currency),
      currency: row.currency,
      account: params.fromAccount,
      category: params.interestCategory,
      description: t("services.financing.interestDescription", {
        number: row.number,
        plan: row.planDescription,
      }),
      occurredOn: params.paidOn,
      source: "form",
    });
    interestTransactionId = interest.transactionId;
  }

  await db
    .update(installments)
    .set({ paidTransactionId: result.transactionId, interestTransactionId, paidAt: new Date() })
    .where(eq(installments.id, row.id));

  return {
    ok: true,
    summary:
      row.interestMinor > 0
        ? t("services.financing.installmentPaidWithInterest", {
            number: row.number,
            plan: row.planDescription,
            amount: formatAmount(row.amountMinor, row.currency),
            interest: formatAmount(row.interestMinor, row.currency),
          })
        : t("services.financing.installmentPaid", {
            number: row.number,
            plan: row.planDescription,
            amount: formatAmount(row.amountMinor, row.currency),
          }),
  };
}

/**
 * Undoes an installment payment: it goes back to pending **and the transfer that
 * paid it is voided**.
 *
 * Without voiding it, undoing left the money out of your account and the debt
 * standing again: net worth was off by the installment's amount, subtracted
 * twice, from one click on a button that says «Undo». It failed nowhere; it just
 * returned a false figure.
 *
 * The id is read BEFORE setting it to null. The foreign key is `set null`, so as
 * soon as the link is cleared there is no trace left with which to find the
 * orphaned entry.
 *
 * It is voided, not deleted, and both writes go in the same transaction: if the
 * second one failed, the installment would be left pending with the money out,
 * which is exactly the state this exists to prevent. Same criterion as
 * `voidFinancingPlan`.
 */
export async function unpayInstallment(householdId: string, installmentId: string) {
  const [row] = await db
    .select({
      id: installments.id,
      number: installments.number,
      amountMinor: installments.amountMinor,
      paidTransactionId: installments.paidTransactionId,
      interestTransactionId: installments.interestTransactionId,
      currency: financingPlans.currency,
      planDescription: financingPlans.description,
    })
    .from(installments)
    .innerJoin(financingPlans, eq(financingPlans.id, installments.planId))
    .where(and(eq(installments.id, installmentId), eq(installments.householdId, householdId)))
    .limit(1);

  const t = getTranslator(await localeOf(householdId));
  if (!row) {
    throw new InvalidTransactionError(t("services.financing.installmentNotFound"), "installment_not_found");
  }

  // Frozen in the household's language: `void_reason` is a free-text column that
  // also takes reasons written by a person, and it is a historical record.
  const reason = t("services.financing.unpayReason", { number: row.number, plan: row.planDescription });
  let voided = false;

  await db.transaction(async (tx) => {
    /*
     * BOTH entries, because a payment with interest is two.
     *
     * Voiding only the transfer would undo the movement and leave the interest
     * standing as an expense of a payment that no longer happened — a cost in
     * the month's total with nothing behind it. They go in one database
     * transaction with the installment for the reason the whole function
     * exists: any half-done state here is money out of the account with the
     * debt still owed.
     */
    const voidOne = async (id: string | null) => {
      if (!id) return false;
      const done = await tx
        .update(transactions)
        .set({ voidedAt: new Date(), voidReason: reason, needsReview: false })
        .where(
          and(
            eq(transactions.id, id),
            eq(transactions.householdId, householdId),
            isNull(transactions.voidedAt),
          ),
        )
        .returning({ id: transactions.id });
      return done.length > 0;
    };

    const principalVoided = await voidOne(row.paidTransactionId);
    const interestVoided = await voidOne(row.interestTransactionId);
    voided = principalVoided || interestVoided;

    await tx
      .update(installments)
      .set({ paidTransactionId: null, interestTransactionId: null, paidAt: null })
      .where(eq(installments.id, row.id));
  });

  // What actually happened, not a generic reassurance: the previous summary
  // asserted a state that was not true.
  return {
    ok: true,
    summary: voided
      ? t("services.financing.unpaidWithVoid", {
          number: row.number,
          amount: formatAmount(row.amountMinor, row.currency),
        })
      : t("services.financing.unpaid", { number: row.number }),
  };
}

export type PlanView = {
  id: string;
  description: string;
  financier: string;
  currency: string;
  totalMinor: number;
  downPaymentMinor: number;
  paidMinor: number;
  pendingMinor: number;
  purchasedOn: string;
  installments: {
    id: string;
    number: number;
    dueOn: string;
    amountMinor: number;
    paid: boolean;
  }[];
};

/** The plans with their installments. Settled ones stay out unless asked for. */
export async function financingPlansView(
  householdId: string,
  options: { includeSettled?: boolean } = {},
): Promise<PlanView[]> {
  const rows = await db
    .select({
      planId: financingPlans.id,
      description: financingPlans.description,
      currency: financingPlans.currency,
      totalMinor: financingPlans.totalMinor,
      downPaymentMinor: financingPlans.downPaymentMinor,
      purchasedOn: financingPlans.purchasedOn,
      financier: accounts.name,
      installmentId: installments.id,
      number: installments.number,
      dueOn: installments.dueOn,
      amountMinor: installments.amountMinor,
      paidAt: installments.paidAt,
    })
    .from(financingPlans)
    .innerJoin(accounts, eq(accounts.id, financingPlans.financierAccountId))
    .innerJoin(installments, eq(installments.planId, financingPlans.id))
    // A plan whose purchase was voided claims nothing any more: without this it
    // went on showing its debt while the account said zero, which is exactly
    // what happened when a purchase was voided from the history.
    .innerJoin(transactions, eq(transactions.id, financingPlans.purchaseTransactionId))
    .where(and(eq(financingPlans.householdId, householdId), isNull(transactions.voidedAt)))
    .orderBy(asc(financingPlans.purchasedOn), asc(installments.number));

  const byPlan = new Map<string, PlanView>();
  for (const r of rows) {
    let plan = byPlan.get(r.planId);
    if (!plan) {
      plan = {
        id: r.planId,
        description: r.description,
        financier: r.financier,
        currency: r.currency,
        totalMinor: r.totalMinor,
        downPaymentMinor: r.downPaymentMinor,
        paidMinor: r.downPaymentMinor,
        pendingMinor: 0,
        purchasedOn: r.purchasedOn,
        installments: [],
      };
      byPlan.set(r.planId, plan);
    }
    const paid = r.paidAt != null;
    plan.installments.push({
      id: r.installmentId,
      number: r.number,
      dueOn: r.dueOn,
      amountMinor: r.amountMinor,
      paid,
    });
    if (paid) plan.paidMinor += r.amountMinor;
    else plan.pendingMinor += r.amountMinor;
  }

  const plans = [...byPlan.values()];
  return options.includeSettled ? plans : plans.filter((p) => p.pendingMinor > 0);
}

/** Installments falling due in the next N days and still unpaid. */
export async function upcomingInstallments(householdId: string, withinDays: number) {
  const from = await todayOf(householdId);
  const to = addDays(from, withinDays);

  return db
    .select({
      id: installments.id,
      number: installments.number,
      dueOn: installments.dueOn,
      amountMinor: installments.amountMinor,
      currency: financingPlans.currency,
      description: financingPlans.description,
      financier: accounts.name,
    })
    .from(installments)
    .innerJoin(financingPlans, eq(financingPlans.id, installments.planId))
    .innerJoin(accounts, eq(accounts.id, financingPlans.financierAccountId))
    .innerJoin(transactions, eq(transactions.id, financingPlans.purchaseTransactionId))
    .where(
      and(
        eq(installments.householdId, householdId),
        isNull(installments.paidAt),
        isNull(transactions.voidedAt),
        sql`${installments.dueOn} <= ${to}`,
      ),
    )
    .orderBy(asc(installments.dueOn), asc(installments.number));
}

// ── Financiers ─────────────────────────────────────────────────────────────

export type FinancierRules = {
  downPaymentPercent: number | null;
  defaultInstallments: number | null;
  defaultFrequency: Frequency;
};

export type FinancierView = FinancierRules & {
  accountId: string;
  name: string;
  currency: string;
  /** What you owe them: their account's balance, as a positive. */
  owedMinor: number;
  openPlans: number;
  pendingInstallments: number;
  nextDueOn: string | null;
};

/**
 * Who you owe, how much, and what is coming.
 *
 * It comes from the account balance, not from a parallel sum: the debt already
 * lives there and it is the one subtracting from net worth. Adding up the
 * pending installments separately would give a second number for the same thing,
 * and the moment a payment is recorded outside a plan — or an installment gets
 * corrected — the two would stop agreeing.
 */
export async function financiersView(householdId: string): Promise<FinancierView[]> {
  const { rows } = await db.execute<{
    account_id: string;
    name: string;
    currency: string;
    owed: string;
    down_payment_percent: string | null;
    default_installments: number | null;
    default_frequency: Frequency;
    open_plans: string;
    pending_installments: string;
    next_due_on: string | null;
  }>(sql`
    SELECT a.id AS account_id, a.name, a.currency,
           -- As a positive: "you owe 2.400", not "-2.400". The sign is already
           -- carried by the account, and the question here is how much, not in
           -- which direction.
           (-${balanceExpression})::text AS owed,
           p.down_payment_percent, p.default_installments, p.default_frequency,
           -- In all three: a plan whose purchase was voided neither counts nor
           -- adds pending installments.
           (SELECT count(*)::text FROM financing_plans fp JOIN transactions pt ON pt.id = fp.purchase_transaction_id
             WHERE fp.financier_account_id = a.id AND pt.voided_at IS NULL
               AND EXISTS (SELECT 1 FROM installments i
                            WHERE i.plan_id = fp.id AND i.paid_at IS NULL)) AS open_plans,
           (SELECT count(*)::text FROM installments i
              JOIN financing_plans fp ON fp.id = i.plan_id
              JOIN transactions pt ON pt.id = fp.purchase_transaction_id
             WHERE fp.financier_account_id = a.id AND i.paid_at IS NULL
               AND pt.voided_at IS NULL) AS pending_installments,
           (SELECT min(i.due_on)::text FROM installments i
              JOIN financing_plans fp ON fp.id = i.plan_id
              JOIN transactions pt ON pt.id = fp.purchase_transaction_id
             WHERE fp.financier_account_id = a.id AND i.paid_at IS NULL
               AND pt.voided_at IS NULL) AS next_due_on
      FROM financier_profiles p
      JOIN accounts a ON a.id = p.account_id
      LEFT JOIN transaction_entries e ON e.account_id = a.id
      LEFT JOIN transactions t ON t.id = e.transaction_id
     WHERE p.household_id = ${householdId} AND a.archived_at IS NULL
     GROUP BY a.id, a.name, a.currency, a.opening_balance_minor,
              p.down_payment_percent, p.default_installments, p.default_frequency
     ORDER BY a.sort_order, a.name
  `);

  return rows.map((r) => ({
    accountId: r.account_id,
    name: r.name,
    currency: r.currency,
    owedMinor: Number(r.owed),
    downPaymentPercent: r.down_payment_percent == null ? null : Number(r.down_payment_percent),
    defaultInstallments: r.default_installments,
    defaultFrequency: r.default_frequency,
    openPlans: Number(r.open_plans),
    pendingInstallments: Number(r.pending_installments),
    nextDueOn: r.next_due_on,
  }));
}

/** Marks an account as a financier and stores how it finances you. Upserts. */
export async function saveFinancierProfile(params: {
  householdId: string;
  accountId: string;
  downPaymentPercent?: number | null;
  defaultInstallments?: number | null;
  defaultFrequency?: Frequency;
}) {
  const [account] = await db
    .select({ nature: accounts.nature, name: accounts.name })
    .from(accounts)
    .where(and(eq(accounts.id, params.accountId), eq(accounts.householdId, params.householdId)))
    .limit(1);

  const t = getTranslator(await localeOf(params.householdId));
  if (!account) throw new InvalidTransactionError(t("services.financing.accountNotFound"), "account_not_found");
  // Whoever finances you is who you owe: with an asset account, buying in
  // installments would raise what you have.
  if (account.nature !== "liability") {
    throw new InvalidTransactionError(
      t("services.financing.profileNotLiability", { account: account.name }),
      "financier_not_liability",
    );
  }

  const percent = params.downPaymentPercent;
  if (percent != null && (percent < 0 || percent >= 100)) {
    throw new InvalidTransactionError(t("services.financing.invalidPercent"), "invalid_percent");
  }

  const values = {
    accountId: params.accountId,
    householdId: params.householdId,
    downPaymentPercent: percent == null ? null : percent.toFixed(2),
    defaultInstallments: params.defaultInstallments ?? null,
    defaultFrequency: params.defaultFrequency ?? ("biweekly" as Frequency),
  };

  await db
    .insert(financierProfiles)
    .values(values)
    .onConflictDoUpdate({
      target: financierProfiles.accountId,
      set: {
        downPaymentPercent: values.downPaymentPercent,
        defaultInstallments: values.defaultInstallments,
        defaultFrequency: values.defaultFrequency,
        updatedAt: new Date(),
      },
    });

  return { ok: true, summary: t("services.financing.profileSaved", { account: account.name }) };
}

/** Stops being a financier. The account and its debt stay untouched. */
export async function removeFinancierProfile(householdId: string, accountId: string) {
  await db
    .delete(financierProfiles)
    .where(
      and(
        eq(financierProfiles.accountId, accountId),
        eq(financierProfiles.householdId, householdId),
      ),
    );
  return {
    ok: true,
    summary: getTranslator(await localeOf(householdId))("services.financing.profileRemoved"),
  };
}

/**
 * Voiding a whole installment purchase.
 *
 * A financed purchase is two or more entries — the expense, the down payment and
 * any installment payments already made — and voiding just one leaves the
 * financier's balance worse than before: the debt half there, with nothing to
 * explain it. Here they are all voided at once.
 *
 * The plan is DELETED and the entries are VOIDED, which is neither the same
 * thing nor a whim: the entries are the record of what happened and stay in the
 * history marked as voided, whereas the schedule of a purchase that did not
 * happen describes nothing.
 */
export async function voidFinancingPlan(params: {
  householdId: string;
  planId: string;
  reason?: string;
}) {
  const [plan] = await db
    .select({
      id: financingPlans.id,
      description: financingPlans.description,
      purchaseTransactionId: financingPlans.purchaseTransactionId,
      downPaymentTransactionId: financingPlans.downPaymentTransactionId,
    })
    .from(financingPlans)
    .where(
      and(
        eq(financingPlans.id, params.planId),
        eq(financingPlans.householdId, params.householdId),
      ),
    )
    .limit(1);

  const t = getTranslator(await localeOf(params.householdId));
  if (!plan) throw new InvalidTransactionError(t("services.financing.planNotFound"), "plan_not_found");

  const paid = await db
    .select({ transactionId: installments.paidTransactionId })
    .from(installments)
    .where(and(eq(installments.planId, plan.id), isNotNull(installments.paidTransactionId)));

  const ids = [
    plan.purchaseTransactionId,
    plan.downPaymentTransactionId,
    ...paid.map((p) => p.transactionId),
  ].filter((id): id is string => id != null);

  // Frozen in the household's language, like every other `void_reason`.
  const reason = params.reason?.trim() || t("services.financing.voidReason");

  await db.transaction(async (tx) => {
    await tx
      .update(transactions)
      .set({ voidedAt: new Date(), voidReason: reason, needsReview: false })
      .where(
        and(
          eq(transactions.householdId, params.householdId),
          inArray(transactions.id, ids),
          isNull(transactions.voidedAt),
        ),
      );
    // The installments go with it through the cascading foreign key.
    await tx.delete(financingPlans).where(eq(financingPlans.id, plan.id));
  });

  return {
    ok: true,
    summary: t("services.financing.planVoided", { description: plan.description, n: ids.length }),
  };
}

/**
 * The plan an entry originated from, if any.
 *
 * It is used by ordinary voiding from the history: voiding the expense of a
 * financed purchase has to take its schedule along, or the plan is left orphaned
 * claiming a debt the account no longer has.
 */
export async function planForTransaction(
  householdId: string,
  transactionId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ id: financingPlans.id })
    .from(financingPlans)
    .where(
      and(
        eq(financingPlans.householdId, householdId),
        eq(financingPlans.purchaseTransactionId, transactionId),
      ),
    )
    .limit(1);
  return row?.id ?? null;
}
