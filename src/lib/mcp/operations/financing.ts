import { eq } from "drizzle-orm";
import type { z } from "zod";

import { db } from "@/db";
import { accounts, households } from "@/db/schema";
import { normalizeLocale, type Locale } from "@/i18n/config";
import { getTranslator } from "@/i18n/translator";
import type { Principal } from "@/lib/api-token";
import { formatDay, today } from "@/lib/dates";
import type { McpOperation } from "@/lib/mcp/operation";
import { formatAmount, parseAmountToMinor } from "@/lib/money";
import { resolveRates } from "@/lib/rates/service";
import { accountBalance } from "@/lib/services/balances";
import {
  financingPlansView,
  payInstallment,
  recordFinancedPurchase,
} from "@/lib/services/financing";
import { InvalidTransactionError } from "@/lib/services/record-transaction";
import { resolveAccount } from "@/lib/services/resolve-entities";
import type { createFinancedPurchaseSchema, payInstallmentSchema } from "@/lib/validation";

/**
 * The two financing writes that move money, behind the one gate.
 *
 * Neither service simulates itself: `payInstallment` writes the transfer and
 * flips `paid_at` in the same call, and `recordFinancedPurchase` writes two
 * entries and a schedule. So `dryRun` here does what `operation.ts` asks of an
 * operation that cannot be simulated — it BUILDS A DESCRIPTION of what is about
 * to change, read from the live state the write depends on, and the fingerprint
 * goes over that state.
 *
 * What the description deliberately does NOT do is compute money. A preview that
 * re-derived the purchase total — the conversion in `totalInFinancierCurrency` —
 * would be a second copy of the arithmetic, and the day the two disagree the
 * person approves one figure while the service writes another, with the
 * fingerprint comparing the preview against itself and noticing nothing. So
 * every figure here is either read from a row (the installment's amount, a
 * balance, a rate) or the typed one, formatted in the currency it was typed in
 * — the parse the service does, never the conversion.
 */

type PayInput = z.infer<typeof payInstallmentSchema>;
type PurchaseInput = z.infer<typeof createFinancedPurchaseSchema>;

/** The household's clock, language and base currency: one row, read once. */
async function homeOf(householdId: string): Promise<{
  baseCurrency: string;
  today: string;
  locale: Locale;
  defaultRateSource: "official" | "parallel";
}> {
  const [row] = await db
    .select({
      baseCurrency: households.baseCurrency,
      timezone: households.timezone,
      locale: households.locale,
      defaultRateSource: households.defaultRateSource,
    })
    .from(households)
    .where(eq(households.id, householdId))
    .limit(1);

  return {
    baseCurrency: row?.baseCurrency ?? "USD",
    // The household's day, not the server's: a payment previewed at 23:50 in
    // Caracas is booked on the day Caracas is having, and `effective_on` below
    // is what the fingerprint watches so that a yes given after midnight is not
    // silently a yes for a different day's rate.
    today: today(row?.timezone ?? "UTC"),
    locale: normalizeLocale(row?.locale),
    /*
     * Which rate the household converts with when the call does not say.
     *
     * `totalInFinancierCurrency` reads this same column and treats anything
     * that is not «official» as parallel — «manual» is not a source a purchase
     * can be quoted at — so the same narrowing is done here. It is read rather
     * than assumed because the preview has to NAME the rate the write will use:
     * the two are some 15% apart on the same purchase, and a yes given without
     * knowing which one decides is a yes to either figure.
     */
    defaultRateSource: row?.defaultRateSource === "official" ? "official" : "parallel",
  };
}

type AccountSnapshot = {
  input: string;
  id: string;
  name: string;
  currency: string;
  /**
   * asset or liability, read because the write reads it.
   *
   * `recordFinancedPurchase` refuses a financier that is not a liability —
   * whoever finances you is who you owe — and the refusal used to arrive only
   * after the person had approved a preview describing the purchase as if it
   * were going to happen.
   */
  nature: "asset" | "liability";
  score: number;
  via: string;
  balance: string;
  balance_minor: number;
};

/**
 * Which account a name lands on, and what it holds right now.
 *
 * Resolution is fuzzy — «efectivo» is two accounts when there is cash in
 * bolívares and in dollars — so WHICH account a name resolves to is live state,
 * not something the typed input settles. An alias added between the preview and
 * the yes moves the money to another account, and the sentence the person
 * approved would still read the same.
 */
async function snapshotAccount(
  householdId: string,
  input: string,
  preferredCurrency: string | undefined,
): Promise<AccountSnapshot | null> {
  const match = await resolveAccount(householdId, input, preferredCurrency);
  if (!match) return null;

  const [row] = await db
    .select({ currency: accounts.currency, nature: accounts.nature })
    .from(accounts)
    .where(eq(accounts.id, match.id))
    .limit(1);

  const currency = row?.currency ?? "";
  const balanceMinor = await accountBalance(match.id);
  return {
    input,
    id: match.id,
    name: match.name,
    currency,
    nature: row?.nature ?? "asset",
    score: match.score,
    via: match.via,
    balance: formatAmount(balanceMinor, currency),
    balance_minor: balanceMinor,
  };
}

/** Paying a quota: what would move, read from the schedule and the account. */
async function describePayment(
  principal: Principal,
  input: PayInput,
): Promise<Record<string, unknown>> {
  const home = await homeOf(principal.householdId);
  const t = getTranslator(home.locale);

  /*
   * The service's own view of the schedule, not a query of my own: it is what
   * `action='list'` showed the person, and it already excludes the plans whose
   * purchase was voided — an installment of a voided purchase owes nothing and
   * must not be payable from here.
   *
   * Settled plans are included so that an installment that was paid a minute ago
   * comes back as paid rather than as missing: `paid` below is in the
   * fingerprint, and «paid» is the honest reason to ask for the approval again.
   */
  const plans = await financingPlansView(principal.householdId, { includeSettled: true });
  const plan = plans.find((candidate) =>
    candidate.installments.some((row) => row.id === input.installment_id),
  );
  const installment = plan?.installments.find((row) => row.id === input.installment_id);

  if (!plan || !installment) {
    /*
     * Refused here rather than staged: a confirmation for an id the schedule
     * does not carry describes nothing, and asking somebody to approve a
     * payment nobody can name is how a yes gets given to the wrong row. The
     * authoritative check stays in `payInstallment`; this one only keeps the
     * gate from holding an empty preview.
     */
    throw new InvalidTransactionError(
      t("services.financing.installmentNotFound"),
      "installment_not_found",
    );
  }

  // The same currency bias `recordTransaction` applies to a transfer's origin:
  // resolving without it lands «efectivo» on the dollar account when the quota
  // is in bolívares, and the preview would name an account the write will not use.
  const from = await snapshotAccount(principal.householdId, input.from_account, plan.currency);
  if (!from) {
    throw new InvalidTransactionError(
      t("services.recordTransaction.accountNotFound", { input: input.from_account }),
      "account_not_found",
      { input: input.from_account, field: "from_account" },
    );
  }

  /*
   * The quota is transferred IN THE PLAN'S CURRENCY, whatever account is named,
   * so an origin in another currency is a refusal the write can only ever make:
   * `payInstallment` passes `currency: plan.currency` and `recordTransaction`
   * throws `currency_mismatch` against the origin's own.
   *
   * The bias above only PREFERS an account of that currency — it falls back to
   * the general search, deliberately, so that «efectivo» naming the dollar cash
   * gets the currency error rather than «no such account». Without this the
   * fallback reached the person as a preview: they approve paying Bs 1.000 from
   * Efectivo $, and the refusal lands after their yes, where it reads as the
   * payment having failed for some reason of planfly's.
   */
  if (from.currency !== plan.currency) {
    throw new InvalidTransactionError(
      t("services.recordTransaction.currencyMismatch", {
        amountCurrency: plan.currency,
        account: from.name,
        accountCurrency: from.currency,
      }),
      "currency_mismatch",
      {
        input: input.from_account,
        field: "from_account",
        amountCurrency: plan.currency,
        accountCurrency: from.currency,
      },
    );
  }

  return {
    installment: {
      id: installment.id,
      number: installment.number,
      due_on: installment.dueOn,
      due_text: formatDay(installment.dueOn, home.locale),
      amount: formatAmount(installment.amountMinor, plan.currency),
      amount_minor: installment.amountMinor,
      paid: installment.paid,
    },
    plan: {
      id: plan.id,
      description: plan.description,
      financier: plan.financier,
      currency: plan.currency,
      pending: formatAmount(plan.pendingMinor, plan.currency),
      pending_minor: plan.pendingMinor,
    },
    from_account: from,
    paid_on: input.paid_on ?? null,
    // What the transfer would actually be dated. Absent `paid_on` it is today,
    // and today changes while the person is reading.
    effective_on: input.paid_on ?? home.today,
  };
}

/** Buying in installments: which accounts it lands on, and the day's rates. */
async function describePurchase(
  principal: Principal,
  input: PurchaseInput,
): Promise<Record<string, unknown>> {
  const home = await homeOf(principal.householdId);
  const t = getTranslator(home.locale);

  // No currency bias: the financier's own currency is what everything else is
  // measured in, so it cannot be used to choose the financier.
  const financier = await snapshotAccount(principal.householdId, input.financier, undefined);
  if (!financier) {
    throw new InvalidTransactionError(
      t("services.financing.financierNotFound", { input: input.financier }),
      "account_not_found",
    );
  }

  /*
   * A financier that is not a liability, refused here and not after the yes.
   *
   * `recordFinancedPurchase` reads `accounts.nature` and refuses anything but a
   * liability — with an asset account, owing somebody money would RAISE what you
   * have. That refusal is decided by state the preview has already read, so
   * staging it means describing a purchase that cannot happen, taking somebody's
   * approval for it, and then answering the confirm with an error: from where
   * they sit, planfly failed while recording it, and the natural next move is to
   * record the purchase by hand as a plain expense — which leaves the debt
   * wrong forever, exactly what this tool exists to prevent.
   *
   * The wording is the service's own, so the person is told the same thing here
   * as there: change the account's type, do not invent another financier.
   */
  if (financier.nature !== "liability") {
    throw new InvalidTransactionError(
      t("services.financing.financierNotLiability", { account: financier.name }),
      "financier_not_liability",
      { input: input.financier, field: "financier" },
    );
  }

  const downAccount = input.down_payment_account
    ? await snapshotAccount(principal.householdId, input.down_payment_account, financier.currency)
    : null;
  if (input.down_payment_account && !downAccount) {
    throw new InvalidTransactionError(
      t("services.recordTransaction.accountNotFound", { input: input.down_payment_account }),
      "account_not_found",
      { input: input.down_payment_account, field: "down_payment_account" },
    );
  }

  /*
   * The down payment, checked against the account it would leave from BEFORE
   * anything is staged. This is the one that costs money.
   *
   * `recordFinancedPurchase` is three writes and only the third is inside a
   * transaction: the expense against the financier is committed first, and the
   * down payment's transfer second. The transfer is written in the FINANCIER's
   * currency against the down-payment account, so a down account in another
   * currency — or one that resolves to the financier itself — throws after the
   * expense is already in the ledger. What is left behind is a Bs 4.000 expense
   * against Cashea with no plan and no schedule attached: the debt shown is not
   * the debt owed, `action='list'` does not show it because there is no plan,
   * and nothing logs it. The confirmation is consumed (`retryable` is not set),
   * so the second attempt cannot even overwrite it.
   *
   * The bias when resolving above only PREFERS the financier's currency; it
   * falls back to any account of that name. So the comparison has to be made,
   * not assumed. Both refusals are worded exactly as `recordTransaction` words
   * them, because they are its refusals, arriving before the yes instead of
   * after it.
   *
   * The real cure is one transaction around the three writes, in
   * `services/financing.ts`. This is the half that can be done from here.
   */
  if (downAccount && downAccount.id === financier.id) {
    throw new InvalidTransactionError(
      t("services.recordTransaction.sameAccount"),
      "same_account",
      { input: input.down_payment_account, field: "down_payment_account" },
    );
  }
  if (downAccount && downAccount.currency !== financier.currency) {
    throw new InvalidTransactionError(
      t("services.recordTransaction.currencyMismatch", {
        amountCurrency: financier.currency,
        account: downAccount.name,
        accountCurrency: downAccount.currency,
      }),
      "currency_mismatch",
      {
        input: input.down_payment_account,
        field: "down_payment_account",
        amountCurrency: financier.currency,
        accountCurrency: downAccount.currency,
      },
    );
  }

  /*
   * A down payment with no account to take it from.
   *
   * The service refuses this one before it writes anything, so no orphan is left
   * — but the preview would still have named a down payment, been approved, and
   * come back refused. It is read in the financier's currency because that is
   * where the service reads it too, and only its being non-zero is decided here:
   * how much it is worth stays the service's arithmetic.
   */
  const downMinor =
    input.down_payment == null
      ? 0
      : Math.abs(parseAmountToMinor(input.down_payment, financier.currency));
  if (downMinor > 0 && !input.down_payment_account) {
    throw new InvalidTransactionError(
      t("services.financing.missingDownPaymentAccount"),
      "missing_down_payment_account",
      { field: "down_payment_account" },
    );
  }

  const effectiveOn = input.occurred_on ?? home.today;
  const written = input.total_currency?.toUpperCase() ?? null;

  /*
   * Both candidate rates, and not the one the service is going to pick.
   *
   * `totalInFinancierCurrency` decides the direction — it quotes whichever side
   * of the pair is not the base currency — and a second copy of that decision
   * here is a decision that can drift. A fingerprint watching the rate the write
   * does NOT use is a gate that is not there: the rate moves, the total written
   * changes, and nothing notices. Watching both sides cannot pick wrong.
   *
   * Nothing is converted when the price was already said in the financier's
   * currency, and then there is no rate to watch at all.
   */
  const converts = written !== null && written !== financier.currency;
  const rate = converts
    ? {
        on: effectiveOn,
        base_currency: home.baseCurrency,
        /*
         * WHICH of the two below decides the total. Omitted from the call it is
         * the household's default, a setting somebody can flip, and the two
         * rates are some 15% apart on the same purchase: a preview handing over
         * both and naming neither asks for a yes to either figure. It is in the
         * fingerprint for the same reason — the default flipping between the
         * preview and the yes rewrites the total with nothing else moving.
         */
        source: input.rate_source ?? home.defaultRateSource,
        written: await quotes(written, home.baseCurrency, effectiveOn, home.today),
        financier: await quotes(financier.currency, home.baseCurrency, effectiveOn, home.today),
      }
    : null;

  /*
   * The currency the total is READ in, before any conversion: the written one
   * only when it really differs from the financier's, which is the first thing
   * `totalInFinancierCurrency` decides. Parsing "4.000" against the wrong minor
   * unit is a figure a hundred times out that nothing else would catch.
   */
  const totalCurrency = converts && written ? written : financier.currency;

  return {
    // What was typed, echoed and — where it is money — formatted. These are
    // frozen in the confirmation's payload and cannot move; they are here to be
    // READ back to the person, which is the half of the approval the resolved
    // state does not cover.
    purchase: {
      total: String(input.total),
      total_currency: written,
      /*
       * The typed price made readable, in the currency it was typed in. It is
       * the service's own parse and NOT its conversion: when nothing converts
       * this is exactly the expense that will be charged to the financier, and
       * when something does it is the price the person said, at the rate and
       * from the source `rate` above names. A bare "50" read out to somebody is
       * a figure they cannot check against anything.
       */
      total_text: formatAmount(
        Math.abs(parseAmountToMinor(input.total, totalCurrency)),
        totalCurrency,
      ),
      rate_source: input.rate_source ?? null,
      down_payment: input.down_payment == null ? null : String(input.down_payment),
      // Always read in the financier's currency, whatever the price was written
      // in — that is what the service does, and it is what leaves the account.
      down_payment_text:
        input.down_payment == null ? null : formatAmount(downMinor, financier.currency),
      installments: input.installments,
      frequency: input.frequency ?? "biweekly",
      first_due_on: input.first_due_on ?? null,
      category: input.category ?? null,
      description: input.description ?? null,
      occurred_on: input.occurred_on ?? null,
    },
    financier,
    down_payment_account: downAccount,
    rate,
    effective_on: effectiveOn,
  };
}

/** One currency's two rates for a day, flattened so a fingerprint can read them. */
async function quotes(
  currency: string,
  baseCurrency: string,
  date: string,
  todayHere: string,
): Promise<{ currency: string; official: string | null; parallel: string | null }> {
  const resolved = await resolveRates({
    quoteCurrency: currency,
    baseCurrency,
    date,
    isToday: date === todayHere,
  });
  return {
    currency,
    official: resolved.official?.value ?? null,
    parallel: resolved.parallel?.value ?? null,
  };
}

export const payInstallmentOperation: McpOperation = {
  run: (principal, input, _confirmationId, dryRun) =>
    dryRun
      ? describePayment(principal, input as PayInput)
      : (payInstallment({
          householdId: principal.householdId,
          installmentId: (input as PayInput).installment_id,
          fromAccount: (input as PayInput).from_account,
          paidOn: (input as PayInput).paid_on,
        }) as Promise<Record<string, unknown>>),

  /*
   * What the yes was for.
   *
   * The amount, the due date and the number say WHICH quota — pay number 3
   * believing it is number 2 and the debt is right by luck and the history is
   * wrong. `paid` is the one that matters most: an installment paid between the
   * preview and the yes must not be paid a second time, and this is the check
   * that turns the second confirm into a refusal instead of a duplicate transfer.
   * The account and its balance because the money leaves from there, and
   * `effective_on` because an unspecified date is today, and today moves.
   *
   * A balance that moved does force the approval again, which is stricter than
   * `record_transaction` is. It is the right side to err on here: this is the
   * one write in planfly whose double is invisible — two transfers of the same
   * quota, on the same day, to the same financier, both of them plausible.
   */
  fingerprint: (preview) => {
    const installment = preview.installment as {
      id: string;
      number: number;
      due_on: string;
      amount_minor: number;
      paid: boolean;
    };
    const plan = preview.plan as { id: string; currency: string; pending_minor: number };
    const from = preview.from_account as { id: string; currency: string; balance_minor: number };

    // Fields picked and ordered by hand: `jsonb` hands the stored preview back
    // with its keys in whatever order it likes, and a reordering is not a change
    // of what the money does.
    return JSON.stringify({
      installment: {
        id: installment.id,
        number: installment.number,
        due_on: installment.due_on,
        amount_minor: installment.amount_minor,
        paid: installment.paid,
      },
      plan: { id: plan.id, currency: plan.currency, pending_minor: plan.pending_minor },
      from: { id: from.id, currency: from.currency, balance_minor: from.balance_minor },
      effective_on: preview.effective_on,
    });
  },
};

export const recordFinancedPurchaseOperation: McpOperation = {
  run: (principal, input, _confirmationId, dryRun) => {
    if (dryRun) return describePurchase(principal, input as PurchaseInput);
    const purchase = input as PurchaseInput;
    return recordFinancedPurchase({
      householdId: principal.householdId,
      financier: purchase.financier,
      total: purchase.total,
      // Compared against the financier's currency inside the service: when they
      // match nothing is converted, and converting a figure that was already
      // right returns it hundreds of times smaller without failing.
      totalCurrency: purchase.total_currency,
      downPayment: purchase.down_payment,
      downPaymentAccount: purchase.down_payment_account,
      installmentCount: purchase.installments,
      frequency: purchase.frequency,
      firstDueOn: purchase.first_due_on,
      category: purchase.category,
      description: purchase.description,
      occurredOn: purchase.occurred_on,
      rateSource: purchase.rate_source,
      source: "api",
      createdByUserId: principal.userId,
    }) as Promise<Record<string, unknown>>;
  },

  /*
   * The purchase's figures are typed, but WHERE they land and WHAT they are
   * worth are not. The financier decides the currency the whole plan is
   * measured in; the day's rate, and which of the two, decides what a price
   * written in dollars becomes in bolívares; the down payment leaves a real
   * account. Any of those moving between the preview and the yes writes a total
   * the person never saw — and a financed purchase is the entry nobody
   * re-reads, because the debt it creates looks the same whatever the number is.
   *
   * The financier's own balance is in here, and it is the one that stops a
   * double purchase. `recordFinancedPurchase` is three writes and not one
   * transaction — the expense, the down payment's transfer, then the schedule —
   * and the gate releases its claim when the write throws, so a purchase that
   * failed at the transfer leaves the confirmation usable with the expense
   * already in the ledger. Confirmed again with nothing but typed figures and
   * an untouched down account watched, it would pass and charge the whole
   * purchase a second time. The balance moved, so it does not: the second
   * confirm comes back `preview_changed`, which is the truth. The same watch
   * covers two previews of one purchase confirmed in turn, which is the shape
   * with no down payment at all.
   */
  fingerprint: (preview) => {
    const purchase = preview.purchase as {
      total: string;
      total_currency: string | null;
      rate_source: string | null;
      down_payment: string | null;
      installments: number;
      frequency: string;
      first_due_on: string | null;
    };
    const financier = preview.financier as {
      id: string;
      currency: string;
      balance_minor: number;
    };
    const down = preview.down_payment_account as {
      id: string;
      currency: string;
      balance_minor: number;
    } | null;
    const rate = preview.rate as {
      on: string;
      base_currency: string;
      source: string;
      written: { currency: string; official: string | null; parallel: string | null };
      financier: { currency: string; official: string | null; parallel: string | null };
    } | null;

    return JSON.stringify({
      purchase: {
        total: purchase.total,
        total_currency: purchase.total_currency,
        rate_source: purchase.rate_source,
        down_payment: purchase.down_payment,
        installments: purchase.installments,
        frequency: purchase.frequency,
        first_due_on: purchase.first_due_on,
      },
      financier: {
        id: financier.id,
        currency: financier.currency,
        balance_minor: financier.balance_minor,
      },
      down_payment_account: down
        ? { id: down.id, currency: down.currency, balance_minor: down.balance_minor }
        : null,
      rate: rate
        ? {
            on: rate.on,
            base_currency: rate.base_currency,
            source: rate.source,
            written: [rate.written.currency, rate.written.official, rate.written.parallel],
            financier: [rate.financier.currency, rate.financier.official, rate.financier.parallel],
          }
        : null,
      effective_on: preview.effective_on,
    });
  },
};
