import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { z } from "zod";

import { POST as createRecurringRoute } from "@/app/api/v1/recurring/route";
import { db } from "@/db";
import { accounts, households } from "@/db/schema";
import { normalizeLocale } from "@/i18n/config";
import { withInternalPrincipal } from "@/lib/api/handler";
import type { Principal } from "@/lib/api-token";
import { today } from "@/lib/dates";
import type { McpOperation } from "@/lib/mcp/operation";
import { RouteRefusal } from "@/lib/mcp/tools/context";
import { occurrencesBetween } from "@/lib/recurrence";
import { daysFor } from "@/lib/services/recurring";
import { type Match, resolveAccount, resolveCategory } from "@/lib/services/resolve-entities";
import { createRecurringSchema } from "@/lib/validation";

/**
 * Creating a rule that starts in the PAST.
 *
 * A rule is not a schedule. `runDueRecurrences` catches up on every date already
 * passed the next time the heartbeat runs, so a start date a year back posts one
 * real entry per date already gone, unattended, each at the rate of ITS day —
 * which can be a dozen entries and real money before anybody looks. That is what
 * this operation puts a gate in front of, and the gate is on the START DATE and
 * not on how many entries come out of it: a plan that catches up on nothing
 * today catches up on one tomorrow, and the person is approving a rule.
 *
 * A rule created for today or later posts nothing until its day comes and needs
 * no gate at all — `postRecurringRule` below is that path, and it is the same
 * call this operation commits with.
 */

/** The name the confirmation is staged under, so both halves cannot disagree. */
export const CREATE_RECURRENCE = "create_recurrence";

/**
 * The heartbeat's ceiling, restated because `CATCH_UP_LIMIT` is private to
 * `src/lib/services/recurring.ts`. Everything past it is not deferred, it is
 * dropped: after a catch-up pass `next_run_on` jumps to tomorrow's occurrence,
 * so the preview has to say when a date will never be posted at all.
 */
const CATCH_UP_LIMIT = 24;

/**
 * What the first heartbeat would post, before anything is written.
 *
 * `saveRecurringRule` cannot simulate itself the way `recordTransaction` can —
 * there is no `dryRun` to ask — so the preview is a DESCRIPTION built from the
 * state the catch-up depends on: the household's today, the days the cadence
 * really resolves to, and whether the names in the mould still find an account
 * and a category. The fingerprint then goes over that state.
 *
 * What is deliberately NOT in here is the bolívar figure of each occurrence.
 * The conversion happens per date, at that date's rate, inside the service's own
 * ladder; a second copy of that arithmetic here is exactly how a preview comes
 * to show one figure while another is written.
 */
const catchUpPreviewSchema = z.object({
  operation: z.literal(CREATE_RECURRENCE),
  name: z.string(),
  kind: z.string(),
  /** As written, in major units: the same string the mould stores. */
  amount: z.string(),
  /** Set only when the amount is thought in a currency that is not the account's. */
  amount_currency: z.string().nullable(),
  /** What the call asked for, which is null whenever it asked for nothing. */
  rate_source: z.string().nullable(),
  /**
   * The source each occurrence will really be valued at, household default and
   * all — whether or not the rule names an `amount_currency`. Null only when no
   * rate can be read at all, because the entry posts in the household's own
   * currency.
   */
  effective_rate_source: z.string().nullable(),
  account: z.string().nullable(),
  /**
   * Whether that name finds an account at all today, not which one it will land
   * in: the account is resolved again for every entry, when it posts. A name
   * matching nothing is a catch-up where every single date fails.
   */
  account_recognised: z.boolean().nullable(),
  to_account: z.string().nullable(),
  to_account_recognised: z.boolean().nullable(),
  category: z.string().nullable(),
  category_recognised: z.boolean().nullable(),
  start_on: z.string(),
  today: z.string(),
  days_of_month: z.array(z.number()),
  catch_up_dates: z.array(z.string()),
  catch_up_count: z.number(),
  catch_up_limit: z.number(),
  /** True when the rule is so old that dates fall off the ceiling and are lost. */
  dropped_beyond_limit: z.boolean(),
});

export type CatchUpPreview = z.infer<typeof catchUpPreviewSchema>;

type CreateInput = z.infer<typeof createRecurringSchema>;

export const createRecurrenceOperation: McpOperation = {
  run: async (principal, input, _confirmationId, dryRun) => {
    /*
     * Parsed again on the way back, because on the confirm path `input` is what
     * came out of a jsonb column and not what the tool validated. A payload that
     * no longer matches the schema is refused here rather than handed to the
     * service.
     */
    const draft = createRecurringSchema.parse(input);
    return dryRun ? await describeCatchUp(principal, draft) : await postRecurringRule(principal, draft);
  },
  fingerprint: (preview) => approvalFingerprint(preview),
};

/**
 * Creates the rule through the /api/v1 route, both here and for the immediate
 * case in the tool.
 *
 * Through the route and not straight to `saveRecurringRule` on purpose: the
 * route is where the mould a rule stores is assembled — which template fields
 * travel, and that a transfer carries no category. A second copy of that
 * assembly is how a back-dated rule comes to store a different mould from one
 * created today, and nothing would fail: it would simply charge something else,
 * every month.
 */
export async function postRecurringRule(
  principal: Principal,
  draft: CreateInput,
): Promise<Record<string, unknown>> {
  const request = withInternalPrincipal(
    new NextRequest("http://planfly.internal/api/v1/recurring", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(draft),
    }),
    principal,
  );

  const response = await createRecurringRoute(request);
  const payload = (await response.json()) as Record<string, unknown>;
  // The route's own refusal, whole: which field it wants is what lets the
  // caller fix its call instead of trying the same thing again.
  if (!response.ok) throw new RouteRefusal(payload, response.status);
  return payload;
}

/** Whether a start date is back-dated, by the household's clock and not UTC. */
export function isBackdated(startOn: string | undefined, todayIso: string): boolean {
  return (startOn?.trim() || todayIso) < todayIso;
}

async function describeCatchUp(principal: Principal, draft: CreateInput): Promise<CatchUpPreview> {
  const todayIso = today(principal.timezone);
  const startOn = draft.start_on?.trim() || todayIso;

  /*
   * `daysFor` is the service's own resolution of the cadence, not a copy of it.
   * A preview built from different days than the rule will use is worse than no
   * preview: the person approves dates that never happen, and the ones that do
   * happen nobody saw.
   */
  const days = daysFor(draft.cadence, draft.days_of_month, normalizeLocale(principal.locale));

  // One past the ceiling, only to learn whether the ceiling was reached.
  const found = occurrencesBetween(days, startOn, todayIso, CATCH_UP_LIMIT + 1);
  const posts = found.slice(0, CATCH_UP_LIMIT);

  const account = draft.account ? await resolveAccount(principal.householdId, draft.account) : null;
  const toAccount = draft.to_account
    ? await resolveAccount(principal.householdId, draft.to_account)
    : null;
  // A transfer carries no category: it is the ledger's invariant, and the route
  // drops the field. Resolving one here would describe a mould that is not stored.
  const categoryKind = draft.kind === "expense" || draft.kind === "income" ? draft.kind : undefined;
  const category =
    draft.kind !== "transfer" && draft.category
      ? await resolveCategory(principal.householdId, draft.category, categoryKind)
      : null;

  return {
    operation: CREATE_RECURRENCE,
    name: draft.name.trim(),
    kind: draft.kind,
    amount: String(draft.amount),
    amount_currency: draft.amount_currency ?? null,
    rate_source: draft.rate_source ?? null,
    effective_rate_source: await effectiveRateSource(principal.householdId, draft, account),
    account: draft.account ?? null,
    account_recognised: draft.account ? account !== null : null,
    to_account: draft.to_account ?? null,
    to_account_recognised: draft.to_account ? toAccount !== null : null,
    category: draft.kind === "transfer" ? null : (draft.category ?? null),
    category_recognised:
      draft.kind !== "transfer" && draft.category ? category !== null : null,
    start_on: startOn,
    today: todayIso,
    days_of_month: days,
    catch_up_dates: posts,
    catch_up_count: posts.length,
    catch_up_limit: CATCH_UP_LIMIT,
    dropped_beyond_limit: found.length > CATCH_UP_LIMIT,
  };
}

/**
 * The source the caught-up dates will really convert at.
 *
 * `resolveTemplateAmount` falls back to the household's `default_rate_source`
 * whenever the rule names neither bcv nor p2p, and that setting can be changed
 * while the person is being read the preview. Between BCV and P2P there is more
 * than 14%: with only the call's own `rate_source` in the preview, «null» is
 * pinned, the refreshed preview is byte-identical after the default moved, the
 * fingerprint matches, and every caught-up date posts a figure the yes was not
 * for. So the EFFECTIVE source is what travels, and what is fingerprinted.
 *
 * The ladder is the service's, `manual` included: a household set to `manual`
 * converts a recurrence at P2P, and a preview that named `manual` would name a
 * source the write does not use.
 *
 * And NOT only when the rule names an `amount_currency`. The mould stores
 * `rateSource` either way, and `recordTransaction` reads it — or falls back to
 * the household default — to value the entry's equivalent in the household's
 * own currency every time the account it posts to keeps a different one. That
 * equivalent is the figure every report adds up, and BCV against P2P moves it
 * by more than 14%. A rule of 120 on a dollar account in a bolívar household
 * names no currency at all and is valued by that setting on every caught-up
 * date; with `null` pinned, the default could move between the reading and the
 * yes, the refreshed preview would still match, and the fingerprint would see
 * nothing.
 *
 * So the question is not «is there an amount_currency» but «can this rule need
 * a rate at all», and `mayNeedARate` answers it. Null only when it provably
 * cannot: pinning a source that changes no figure would refuse good
 * confirmations for nothing. Which account the amount lands in is still read
 * for its CURRENCY only — the account itself is resolved again on the day, so
 * this stays the source IF a rate is read, the same promise
 * `account_recognised` makes about the name.
 */
async function effectiveRateSource(
  householdId: string,
  draft: CreateInput,
  account: Match | null,
): Promise<string | null> {
  const [home] = await db
    .select({
      baseCurrency: households.baseCurrency,
      defaultRateSource: households.defaultRateSource,
    })
    .from(households)
    .where(eq(households.id, householdId))
    .limit(1);

  if (!(await mayNeedARate(draft, account, home?.baseCurrency))) return null;
  if (draft.rate_source) return draft.rate_source;
  return home?.defaultRateSource === "bcv" ? "bcv" : "p2p";
}

/**
 * Whether any occurrence of this rule can end up reading a rate.
 *
 * It is the household's base currency against the currency the entry will post
 * in: equal, and the equivalent is the amount itself, no ladder is consulted
 * and no source matters. Different — or unknown — and one is.
 *
 * Unknown counts as yes on purpose. With no `account` the write falls back to
 * whichever account the household lists first, which nothing here can name;
 * being wrong that way costs one refused confirmation and a second preview,
 * and being wrong the other way costs the figure, silently, on every date.
 */
async function mayNeedARate(
  draft: CreateInput,
  account: Match | null,
  baseCurrency: string | undefined,
): Promise<boolean> {
  if (draft.amount_currency) return true;
  if (!baseCurrency) return true;

  const posting = draft.currency ?? (account ? await currencyOfAccount(account.id) : undefined);
  if (!posting) return true;
  return posting.toUpperCase() !== baseCurrency.toUpperCase();
}

/** An account's currency, by the id the name resolved to. */
async function currencyOfAccount(accountId: string): Promise<string | undefined> {
  const [row] = await db
    .select({ currency: accounts.currency })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1);
  return row?.currency;
}

/**
 * Everything the yes was for: which dates post, what each of them posts, and
 * which of them are lost.
 *
 * `today` is deliberately NOT in it. The catch-up is measured against today and
 * today moves, but a confirmation crossing midnight without a new date falling
 * due is still a yes to the same entries — and if one DID fall due,
 * `catch_up_dates` already says so. Fingerprinting the day itself would refuse
 * every approval given near midnight while protecting nothing.
 *
 * `catch_up_count` is out for the same reason it is in the preview: it is the
 * length of the dates, there for the person to read, not a second fact.
 */
function approvalFingerprint(preview: Record<string, unknown>): string {
  const read = catchUpPreviewSchema.safeParse(preview);
  /*
   * A stored preview that is not this operation's shape is not comparable, and
   * answering «equal» for it would let a confirmation through with no gate at
   * all. It is refused, not guessed at — and not as a ZodError, which upstream
   * reads as «the caller sent a bad argument», which this is not.
   */
  if (!read.success) {
    throw new Error("The stored preview is not a create_recurrence preview.");
  }
  const p = read.data;

  // `jsonb` does not preserve object-key order. Pick and order the fields
  // explicitly so the persisted preview compares by value, not serialization.
  return JSON.stringify({
    name: p.name,
    kind: p.kind,
    amount: p.amount,
    amountCurrency: p.amount_currency,
    rateSource: p.rate_source,
    effectiveRateSource: p.effective_rate_source,
    account: p.account,
    accountRecognised: p.account_recognised,
    toAccount: p.to_account,
    toAccountRecognised: p.to_account_recognised,
    category: p.category,
    categoryRecognised: p.category_recognised,
    startOn: p.start_on,
    days: p.days_of_month,
    dates: p.catch_up_dates,
    dropped: p.dropped_beyond_limit,
  });
}
