import { and, asc, eq, lte } from "drizzle-orm";

import { db } from "@/db";
import { normalizeLocale, type Locale } from "@/i18n/config";
import { getTranslator } from "@/i18n/translator";
import { accounts, households, recurringRules } from "@/db/schema";
import { addDays, formatDay, today } from "@/lib/dates";
import { LAST_DAY, nextOccurrence, occurrencesBetween } from "@/lib/recurrence";
import { notify, notificationsEnabled } from "@/lib/notify";
import { minorToDecimalString, minorUnit, parseAmountToMinor } from "@/lib/money";
import { resolveRates } from "@/lib/rates/service";
import { recordTransaction, type RecordTransactionInput } from "./record-transaction";
import { resolveAccount } from "./resolve-entities";

/**
 * Operations that repeat, fired on their own.
 *
 * They lean on the same heartbeat as the rates and the installment reminders,
 * and on **state, not time**: there is no timer aimed at the 1st, but a question
 * — «is there any whose next date has passed?» — asked every quarter of an hour.
 * On this machine that is not a detail: if it was off on the 1st and gets turned
 * on the 3rd, the recurrence fires on power-up instead of being lost.
 *
 * And it genuinely catches up. If it was off for two weeks, the two fortnights
 * that passed did happen: the rent was owed all the same. One entry is recorded
 * **per date**, each with its own day, not a single one dated today — otherwise
 * the month would come out short and the history would say it all happened on
 * the same day.
 */

/** The mould of an entry, minus the identity, which comes from the token or session. */
export type RecurringTemplate = Omit<
  RecordTransactionInput,
  "householdId" | "createdByUserId" | "createdViaTokenId" | "idempotencyKey" | "occurredOn"
> & {
  /**
   * The currency the amount is THOUGHT of in, if it isn't the account's.
   *
   * It is what makes «the gym is 15 dollars, debited from the bolívar account at
   * the day's rate» possible. Without it you would have to store the bolívares,
   * and that figure expires: it is 12.900 in July and 13.160 in August for the
   * same old subscription.
   */
  amountCurrency?: string;
};

export type RecurringRuleView = {
  id: string;
  name: string;
  cadence: "monthly" | "biweekly" | "custom";
  daysOfMonth: number[];
  nextRunOn: string;
  lastRunOn: string | null;
  isActive: boolean;
  estimatedAmountMinor: number | null;
  template: RecurringTemplate;
};

/** Each preset's days. `custom` brings its own from outside. */
export const CADENCE_DAYS: Record<"monthly" | "biweekly", number[]> = {
  monthly: [1],
  biweekly: [15, LAST_DAY],
};

/**
 * How many overdue dates are caught up at most in one go.
 *
 * A rule created with an old date by mistake would generate hundreds of entries
 * at once. It is clamped and it is said; silence would be worse.
 */
const CATCH_UP_LIMIT = 24;

export async function listRecurringRules(householdId: string): Promise<RecurringRuleView[]> {
  const rows = await db
    .select()
    .from(recurringRules)
    .where(eq(recurringRules.householdId, householdId))
    .orderBy(asc(recurringRules.nextRunOn), asc(recurringRules.name));

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    cadence: r.cadence,
    daysOfMonth: r.daysOfMonth,
    nextRunOn: r.nextRunOn,
    lastRunOn: r.lastRunOn,
    isActive: r.isActive,
    estimatedAmountMinor: r.estimatedAmountMinor,
    template: r.template as RecurringTemplate,
  }));
}

/**
 * What was recorded on this pass, so it can be counted.
 *
 * It is returned rather than just written because the caller — the heartbeat —
 * is the one sending the alert, and an alert that doesn't know what was recorded
 * is worth nothing.
 */
export type RecurringRun = {
  householdId: string;
  ruleName: string;
  occurredOn: string;
  summary: string;
  ok: boolean;
  /** The household's language: the alert wording is assembled by the caller. */
  locale: string;
};

/**
 * Fires everything already due, across all households.
 *
 * Each entry carries the idempotency key `recurring:{rule}:{date}`. That is what
 * makes it safe for the heartbeat to pass four times an hour and for the process
 * to restart halfway: the same date of the same rule cannot be recorded twice,
 * however hard it tries.
 */
export async function runDueRecurrences(): Promise<RecurringRun[]> {
  const homes = await db
    .select({ id: households.id, timezone: households.timezone, locale: households.locale })
    .from(households);

  const done: RecurringRun[] = [];

  for (const home of homes) {
    const todayIso = today(home.timezone);

    const due = await db
      .select()
      .from(recurringRules)
      .where(
        and(
          eq(recurringRules.householdId, home.id),
          eq(recurringRules.isActive, true),
          lte(recurringRules.nextRunOn, todayIso),
        ),
      )
      .orderBy(asc(recurringRules.nextRunOn));

    for (const rule of due) {
      const dates = occurrencesBetween(rule.daysOfMonth, rule.nextRunOn, todayIso, CATCH_UP_LIMIT);
      const template = rule.template as RecurringTemplate;

      for (const date of dates) {
        try {
          const resolved = await resolveTemplateAmount(home.id, template, date);
          const result = await recordTransaction({
            ...template,
            ...resolved,
            householdId: home.id,
            occurredOn: date,
            source: "recurring",
            idempotencyKey: `recurring:${rule.id}:${date}`,
          });
          // A retry returns `duplicate`: it was already there, and that is not a failure.
          if (!result.duplicate) {
            done.push({
              householdId: home.id,
              ruleName: rule.name,
              occurredOn: date,
              summary: result.summary,
              ok: true,
              locale: home.locale,
            });
          }
        } catch (err) {
          /*
           * A rule that fails cannot take the others down nor block itself
           * forever. It is noted, it is reported, and `next_run_on` advances all
           * the same: otherwise every heartbeat would retry the same thing every
           * quarter of an hour until someone looked, and the alert would turn
           * into spam.
           */
          done.push({
            householdId: home.id,
            ruleName: rule.name,
            occurredOn: date,
            summary: (err as Error).message,
            ok: false,
            locale: home.locale,
          });
        }
      }

      const next = nextOccurrence(rule.daysOfMonth, addDays(todayIso, 1));
      await db
        .update(recurringRules)
        .set({
          nextRunOn: next ?? addDays(todayIso, 1),
          lastRunOn: dates.length > 0 ? dates[dates.length - 1] : rule.lastRunOn,
        })
        .where(eq(recurringRules.id, rule.id));
    }
  }

  await announce(done);
  return done;
}

/**
 * The day's amount, when it is written in another currency.
 *
 * A valued recurrence stores «15 USD at BCV» and not «12.900 VES»: the first is
 * still true next month and the second is not. The conversion happens on the day
 * it fires, at THAT day's rate and from the source that was chosen, and that
 * same source travels to `recordTransaction` so the line is valued with it — if
 * not, the history's dollar equivalent would not give back the 15 you wrote,
 * which is the failure that already cost a fix in «Correct entry».
 *
 * It returns whatever has to be overridden on the mould. Empty when the amount
 * is already in the account's currency and there is nothing to convert.
 */
async function resolveTemplateAmount(
  householdId: string,
  template: RecurringTemplate,
  date: string,
): Promise<Partial<RecordTransactionInput>> {
  const written = template.amountCurrency;
  if (!written) return {};

  const account = template.account ? await resolveAccount(householdId, template.account) : null;
  const native = account ? await currencyOfAccount(account.id) : template.currency;
  if (!native || native === written) return {};

  const home = await homeOf(householdId);
  const source: "bcv" | "p2p" =
    template.rateSource === "bcv" || template.rateSource === "p2p"
      ? template.rateSource
      : home.defaultRateSource === "bcv"
        ? "bcv"
        : "p2p";

  /*
   * The rate quotes the NON-base currency against the base: 877,50 bolívares per
   * dollar. So the one needed is always that of whichever currency is not the
   * base, be it the written one or the account's, and which of the two it is
   * decides the direction.
   */
  const quoted = written === home.baseCurrency ? native : written;
  const rates = await resolveRates({
    quoteCurrency: quoted,
    baseCurrency: home.baseCurrency,
    date: date,
    /*
     * Computed, not hard-wired to `false`.
     *
     * With a fixed `false`, `resolveRates` does not go out for the rate even
     * when the occurrence is from today: it valued with yesterday's and right
     * after that `recordTransaction` stamped the equivalent with today's, so the
     * figure written and the one stored were not the same. And if there was no
     * stored rate at all, it threw: the `catch` above notes the failure but
     * `next_run_on` advances anyway, meaning that occurrence is NEVER retried.
     * Made worse by the heartbeat firing recurrences before capturing the day's
     * rates.
     */
    isToday: date === today(home.timezone),
  });
  const rate = rates[source]?.value ?? null;
  if (!rate) {
    throw new Error(
      getTranslator(normalizeLocale(home.locale))("services.recurring.missingRate", {
        source: source.toUpperCase(),
        date: formatDay(date, home.locale),
        from: written,
        to: native,
      }),
    );
  }

  const writtenMinor = Math.abs(parseAmountToMinor(template.amount, written));
  const value = writtenMinor / 10 ** minorUnit(written);
  const converted = written === home.baseCurrency ? value * Number(rate) : value / Number(rate);
  const nativoMinor = Math.round(converted * 10 ** minorUnit(native));

  return {
    amount: minorToDecimalString(nativoMinor, native),
    currency: native,
    rateSource: source,
  };
}

/** An account's currency, by id. */
async function currencyOfAccount(accountId: string): Promise<string | undefined> {
  const [row] = await db
    .select({ currency: accounts.currency })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1);
  return row?.currency;
}

async function homeOf(householdId: string) {
  const [row] = await db
    .select({
      baseCurrency: households.baseCurrency,
      defaultRateSource: households.defaultRateSource,
      timezone: households.timezone,
      locale: households.locale,
    })
    .from(households)
    .where(eq(households.id, householdId))
    .limit(1);
  return row;
}

/**
 * The Telegram alert.
 *
 * One message per household and pass, not one per entry: turning the machine on
 * after a week could produce six, and six messages in a row read as a bot
 * malfunction. What failed goes separately and with its reason, because it is
 * the only part asking you to do something.
 */
async function announce(runs: RecurringRun[]): Promise<void> {
  if (runs.length === 0 || !notificationsEnabled()) return;

  const byHousehold = Map.groupBy(runs, (run) => run.householdId);
  for (const [householdId, householdRuns] of byHousehold) {
    const ok = householdRuns.filter((r) => r.ok);
    const bad = householdRuns.filter((r) => !r.ok);
    const lines: string[] = [];

    if (ok.length > 0) {
      const t = getTranslator(normalizeLocale(ok[0].locale));
      // `<b>` outside the message: ICU would read it as a rich-text tag.
      lines.push(`<b>${t("services.recurring.announce.recorded", { n: ok.length })}</b>`);
      for (const r of ok) lines.push(`· ${formatDay(r.occurredOn, r.locale)} — ${r.summary}`);
    }
    if (bad.length > 0) {
      const t = getTranslator(normalizeLocale(bad[0].locale));
      if (lines.length > 0) lines.push("");
      lines.push(`<b>${t("services.recurring.announce.failed", { n: bad.length })}</b>`);
      for (const r of bad) {
        lines.push(`· ${r.ruleName} (${formatDay(r.occurredOn, r.locale)}): ${r.summary}`);
      }
    }

    await notify(householdId, lines.join("\n"));
  }
}

export type SaveRecurringInput = {
  householdId: string;
  timezone: string;
  /** The household's language. It travels with the timezone: both shape a date. */
  locale: string;
  id?: string;
  name: string;
  cadence: "monthly" | "biweekly" | "custom";
  /** Only read when the cadence is `custom`; the others bring their own. */
  daysOfMonth?: number[];
  template: RecurringTemplate;
  estimatedAmountMinor?: number | null;
  /** From when it counts. Defaults to today: the next one due from now on. */
  startOn?: string;
};

export class InvalidRecurrenceError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "InvalidRecurrenceError";
  }
}

/** The days the rule will actually use, according to its cadence. */
export function daysFor(
  cadence: "monthly" | "biweekly" | "custom",
  custom: number[] | undefined,
  locale: Locale,
): number[] {
  if (cadence !== "custom") return CADENCE_DAYS[cadence];

  const clean = [...new Set((custom ?? []).map(Number))]
    .filter((d) => d === LAST_DAY || (Number.isInteger(d) && d >= 1 && d <= 31))
    .sort((a, b) => a - b);

  if (clean.length === 0) {
    throw new InvalidRecurrenceError(getTranslator(locale)("services.recurring.noDays"), "no_days");
  }
  return clean;
}

/** Creates or corrects a rule. It never fires it: that is the heartbeat's job. */
export async function saveRecurringRule(input: SaveRecurringInput) {
  const locale = normalizeLocale(input.locale);
  const t = getTranslator(locale);
  const name = input.name.trim();
  if (!name) {
    throw new InvalidRecurrenceError(t("services.recurring.missingName"), "missing_name");
  }

  const days = daysFor(input.cadence, input.daysOfMonth, locale);
  const from = input.startOn?.trim() || today(input.timezone);
  const next = nextOccurrence(days, from);
  if (!next) {
    throw new InvalidRecurrenceError(t("services.recurring.noNextRun"), "no_next_run");
  }

  const values = {
    householdId: input.householdId,
    name,
    cadence: input.cadence,
    daysOfMonth: days,
    template: input.template,
    estimatedAmountMinor: input.estimatedAmountMinor ?? null,
    nextRunOn: next,
  };

  if (input.id) {
    const [row] = await db
      .update(recurringRules)
      .set(values)
      .where(
        and(eq(recurringRules.id, input.id), eq(recurringRules.householdId, input.householdId)),
      )
      .returning({ id: recurringRules.id });
    if (!row) throw new InvalidRecurrenceError(t("services.recurring.ruleNotFound"), "rule_not_found");
    return {
      id: row.id,
      summary: t("services.recurring.corrected", { name, next: formatDay(next, locale) }),
    };
  }

  const [row] = await db.insert(recurringRules).values(values).returning({
    id: recurringRules.id,
  });
  return { id: row.id, summary: t("services.recurring.created", { name, next: formatDay(next, locale) }) };
}

/**
 * Pauses or resumes. It does not delete.
 *
 * A paused rule stops firing but still explains where the entries it already
 * recorded came from; deleting it would leave a history with rows of
 * «recurring» provenance and nothing backing them.
 */
export async function setRecurringActive(
  householdId: string,
  id: string,
  isActive: boolean,
  timezone: string,
  rawLocale: string,
) {
  const locale = normalizeLocale(rawLocale);
  const t = getTranslator(locale);
  const [rule] = await db
    .select()
    .from(recurringRules)
    .where(and(eq(recurringRules.id, id), eq(recurringRules.householdId, householdId)))
    .limit(1);

  if (!rule) throw new InvalidRecurrenceError(t("services.recurring.ruleNotFound"), "rule_not_found");

  /*
   * On resume, the next date is recomputed from today.
   *
   * Otherwise a rule paused for three months would wake up with an old
   * `next_run_on` and the catch-up would record in one go the three monthly
   * charges the pause explicitly said you did not want.
   *
   * And from the day after the last one that already ran, not from plain today:
   * if today is the 15th, the rule runs on the 15th and already fired this
   * morning, «from today» returned today — the date went backwards and the
   * summary promised a recurrence that had already happened. Idempotency
   * prevented the double charge, but the number on screen lied all the same.
   */
  const todayIso = today(timezone);
  const desde = rule.lastRunOn && rule.lastRunOn >= todayIso ? addDays(rule.lastRunOn, 1) : todayIso;
  const next = isActive
    ? (nextOccurrence(rule.daysOfMonth, desde) ?? rule.nextRunOn)
    : rule.nextRunOn;

  await db
    .update(recurringRules)
    .set({ isActive, nextRunOn: next })
    .where(eq(recurringRules.id, id));

  return {
    id,
    summary: isActive
      ? t("services.recurring.resumed", { name: rule.name, next: formatDay(next, locale) })
      : t("services.recurring.paused", { name: rule.name }),
  };
}

/** Deletes a rule. The entries it already recorded stay: they happened. */
export async function removeRecurringRule(householdId: string, id: string, rawLocale: string) {
  const t = getTranslator(normalizeLocale(rawLocale));
  const [row] = await db
    .delete(recurringRules)
    .where(and(eq(recurringRules.id, id), eq(recurringRules.householdId, householdId)))
    .returning({ name: recurringRules.name });
  if (!row) throw new InvalidRecurrenceError(t("services.recurring.ruleNotFound"), "rule_not_found");
  return { summary: t("services.recurring.removed", { name: row.name }) };
}
