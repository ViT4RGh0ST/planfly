import { and, asc, desc, eq, gte, inArray, isNull } from "drizzle-orm";
import { NextRequest } from "next/server";
import { z } from "zod";

import {
  DELETE as voidTransactionRoute,
  PATCH as patchTransactionRoute,
} from "@/app/api/v1/transactions/[id]/route";
import { db } from "@/db";
import {
  accounts,
  categories,
  payees,
  transactionEntries,
  transactionItems,
  transactions,
} from "@/db/schema";
import { normalizeLocale } from "@/i18n/config";
import { getTranslator } from "@/i18n/translator";
import { withInternalPrincipal } from "@/lib/api/handler";
import type { Principal } from "@/lib/api-token";
import { addDays, today } from "@/lib/dates";
import type { McpOperation } from "@/lib/mcp/operation";
import { RouteRefusal } from "@/lib/mcp/tools/context";
import { formatAmount } from "@/lib/money";
import { InvalidTransactionError } from "@/lib/services/record-transaction";
import { resolveAccount, resolveCategory, type Match } from "@/lib/services/resolve-entities";
import {
  AGENT_EDITABLE_DAYS,
  AGENT_EDITABLE_SOURCES,
} from "@/lib/services/update-transaction";

/**
 * Correcting, voiding or approving an entry that is already in the ledger.
 *
 * The one operation here that CANNOT simulate itself. `recordTransaction` has a
 * `dryRun` because it computes a new row from nothing; `updateTransaction` has
 * none, and there is no honest way to add one — the corrected figures are the
 * result of writing them. So the dry run does the other thing `McpOperation`
 * allows: it BUILDS A DESCRIPTION of what is about to change, read from the
 * state the change depends on — which entry it resolved to, and exactly what
 * that entry says right now — and the fingerprint goes over that state.
 *
 * That is what makes the gate worth anything here. The person is approving
 * «change THIS entry, which currently says X, to say Y». If somebody corrects
 * it from the web while the question is on screen, or it gets voided, or `last`
 * comes to mean a newer entry, then X is no longer X and the yes was for
 * something else. Without the current state in the fingerprint, the amendment
 * would land on a row nobody looked at and nothing would fail.
 */

/** What the tool stages. It survives a round trip through `jsonb`, so it is parsed back. */
const amendPayloadSchema = z.object({
  /** As the person named it: 'last' or an id. Resolved here, on both passes. */
  target: z.string().min(1),
  action: z.enum(["correct", "void", "approve"]),
  /** Exactly the keys `updateTransactionSchema` declares. Empty on a void. */
  body: z.record(z.string(), z.unknown()).default({}),
  /** The person's own words for why. Kept, not sent — see `commitAmend`. */
  reason: z.string().optional(),
});

type AmendPayload = z.infer<typeof amendPayloadSchema>;

type AmendLeg = {
  sort_order: number;
  account_id: string;
  account_name: string;
  category_id: string | null;
  category_name: string | null;
  amount_minor: number;
  /** The same figure, formatted and unsigned. See `describeAmend`. */
  amount_text: string;
  currency: string;
  base_currency: string;
  rate_bcv: string | null;
  rate_p2p: string | null;
  rate_manual: string | null;
  rate_source_used: string;
  base_amount_bcv_minor: number | null;
  base_amount_p2p_minor: number | null;
  base_amount_manual_minor: number | null;
  /** Formatted, of the three above, the one `rate_source_used` picked. */
  base_amount_text: string | null;
};

type AmendItem = {
  id: string;
  raw_text: string | null;
  quantity: string;
  unit: string | null;
  total_minor: number;
  total_text: string;
  currency: string;
};

/** A name in `changes`, and the row it was matched to. `score` and `via` say how. */
type AmendMatch = {
  id: string;
  name: string;
  score: number;
  via: Match["via"];
  /**
   * The account's own currency, and null for a category.
   *
   * It is what gives the requested amount a unit, and without it the preview
   * cannot be read: `moveAccount` sets the leg's currency to the DESTINATION
   * account's, and `setAmount` then parses the figure in that currency. So
   * «the last one was 500, from Zelle» is five hundred DOLLARS, not five
   * hundred bolívares, and a preview showing only «500» beside a leg that
   * currently reads «Bs 12.008,70» lets a person approve either one believing
   * it is the other. `record_transaction` types its resolved account as
   * `Match & { currency: string }` for the same reason.
   */
  currency: string | null;
};

/** The description a person is shown, and the thing the fingerprint reads. */
type AmendPreview = {
  action: AmendPayload["action"];
  target: string;
  transaction_id: string;
  reason: string | null;
  /** The fields that will be sent to PATCH. Empty on a void. */
  changes: Record<string, unknown>;
  /**
   * The rows the names in `changes` will land on, matched HERE.
   *
   * `changes.account` travels as the person's words and `updateTransaction`
   * resolves them fuzzily at write time, so without this the preview describes
   * a destination nobody looked at: an alias added to another account between
   * the preview and the yes moves the entry somewhere else, the entry itself is
   * untouched, and every other value in the fingerprint is identical. Matched
   * on both passes, fingerprinted, and shown — `score` and `via` are how the
   * person sees that «Zelle» was a 0.42 guess and not the account they meant.
   */
  resolved: {
    account: AmendMatch | null;
    category: AmendMatch | null;
  };
  /** The entry as it stands RIGHT NOW. Not a projection of the result. */
  current: {
    kind: string;
    occurred_on: string;
    description: string;
    notes: string | null;
    payee_id: string | null;
    payee_name: string | null;
    source: string;
    needs_review: boolean;
    legs: AmendLeg[];
    items: AmendItem[];
  };
};

export const amendTransactionOperation: McpOperation = {
  run: (principal, input, _confirmationId, dryRun) =>
    runAmend(principal, amendPayloadSchema.parse(input), dryRun),
  fingerprint: (preview) => amendFingerprint(preview as unknown as AmendPreview),
};

/**
 * The confirmation id is not carried into the write, unlike `record_transaction`.
 *
 * There it becomes an idempotency key, because a second insert would be a
 * second expense. A correction has no such key: setting the amount to 500 twice
 * leaves 500. The one part that is NOT idempotent is `items_mode: 'append'`,
 * which would duplicate the lines — and what stops that is the gate claiming
 * the confirmation row before it writes, so a confirmation commits once.
 */
async function runAmend(
  principal: Principal,
  payload: AmendPayload,
  dryRun: boolean,
): Promise<Record<string, unknown>> {
  const transactionId = await resolveAgentTarget(principal, payload.target, payload.action);

  if (dryRun) return (await describeAmend(principal, payload, transactionId)) as unknown as Record<string, unknown>;

  return payload.action === "void"
    ? callTransactionRoute(principal, transactionId, "DELETE", voidTransactionRoute)
    : callTransactionRoute(principal, transactionId, "PATCH", patchTransactionRoute, payload.body);
}

/**
 * Which entry 'last' means, and whether this credential may touch it at all.
 *
 * A second copy of the route's own `resolveTarget`, which is not exported. It
 * has to be a copy for now and it has to stay in step: the window it applies —
 * rows the agent itself recorded, from the last `AGENT_EDITABLE_DAYS` days, not
 * already voided — is what keeps a conversation from silently rewriting an
 * imported bank statement. Both constants come from the service, so the two
 * copies cannot disagree about the number of days or the list of sources; what
 * they could come to disagree about is the shape of the query.
 *
 * Resolving here rather than letting the route resolve 'last' again is also
 * what closes the gap between the fingerprint and the write: the id that was
 * compared is the id that is written to.
 */
async function resolveAgentTarget(
  principal: Principal,
  target: string,
  action: AmendPayload["action"],
): Promise<string> {
  const since = addDays(today(principal.timezone), -AGENT_EDITABLE_DAYS);
  const editable = and(
    eq(transactions.householdId, principal.householdId),
    isNull(transactions.voidedAt),
    inArray(transactions.source, [...AGENT_EDITABLE_SOURCES]),
    gte(transactions.occurredOn, since),
  );

  const [row] =
    target === "last"
      ? await db
          .select({ id: transactions.id })
          .from(transactions)
          .where(editable)
          .orderBy(desc(transactions.createdAt))
          .limit(1)
      : await db
          .select({ id: transactions.id })
          .from(transactions)
          .where(and(eq(transactions.id, target), editable))
          .limit(1);

  if (!row) {
    /*
     * The route's own sentence, in the household's language, and not one
     * written here: it is repeated verbatim to the person, and an English
     * sentence in a Spanish chat is how the bot stops sounding like planfly.
     *
     * This is also the answer when the entry was voided or aged out of the
     * window BETWEEN the preview and the yes — the refresh finds nothing and
     * the confirmation fails loudly instead of writing to something else.
     */
    const t = getTranslator(normalizeLocale(principal.locale));
    throw new InvalidTransactionError(
      action === "void" ? t("api.transactions.notVoidable") : t("api.transactions.notEditable"),
      "not_editable",
    );
  }

  return row.id;
}

/** The entry as it stands, plus the instruction that would be applied to it. */
async function describeAmend(
  principal: Principal,
  payload: AmendPayload,
  transactionId: string,
): Promise<AmendPreview> {
  const [header] = await db
    .select({
      kind: transactions.kind,
      occurredOn: transactions.occurredOn,
      description: transactions.description,
      notes: transactions.notes,
      payeeId: transactions.payeeId,
      payeeName: payees.name,
      source: transactions.source,
      needsReview: transactions.needsReview,
    })
    .from(transactions)
    .leftJoin(payees, eq(payees.id, transactions.payeeId))
    .where(
      and(eq(transactions.id, transactionId), eq(transactions.householdId, principal.householdId)),
    )
    .limit(1);

  if (!header) {
    // Resolved a moment ago, so this is a row deleted underneath us rather than
    // a target that was never valid. Same answer: there is nothing to amend.
    const t = getTranslator(normalizeLocale(principal.locale));
    throw new InvalidTransactionError(t("api.transactions.notEditable"), "not_editable");
  }

  // Before the rest is read: a name that matches no account is the route's
  // refusal to give, and it is worth more here than after somebody said yes.
  const resolved = await resolveRequested(principal, payload.body, header.kind);

  const legRows = await db
    .select({
      sortOrder: transactionEntries.sortOrder,
      accountId: transactionEntries.accountId,
      accountName: accounts.name,
      categoryId: transactionEntries.categoryId,
      categoryName: categories.name,
      amountMinor: transactionEntries.amountMinor,
      currency: transactionEntries.currency,
      baseCurrency: transactionEntries.baseCurrency,
      rateBcv: transactionEntries.rateBcv,
      rateP2p: transactionEntries.rateP2p,
      rateManual: transactionEntries.rateManual,
      rateSourceUsed: transactionEntries.rateSourceUsed,
      baseAmountBcvMinor: transactionEntries.baseAmountBcvMinor,
      baseAmountP2pMinor: transactionEntries.baseAmountP2pMinor,
      baseAmountManualMinor: transactionEntries.baseAmountManualMinor,
    })
    .from(transactionEntries)
    .innerJoin(accounts, eq(accounts.id, transactionEntries.accountId))
    .leftJoin(categories, eq(categories.id, transactionEntries.categoryId))
    .where(eq(transactionEntries.transactionId, transactionId))
    // `sort_order` and not the order the database felt like: on a transfer it is
    // what tells the origin leg from the destination one.
    .orderBy(asc(transactionEntries.sortOrder));

  const itemRows = await db
    .select({
      id: transactionItems.id,
      rawText: transactionItems.rawText,
      quantity: transactionItems.quantity,
      unit: transactionItems.unit,
      totalMinor: transactionItems.totalMinor,
      currency: transactionItems.currency,
    })
    .from(transactionItems)
    .where(eq(transactionItems.transactionId, transactionId))
    // Any stable order will do; what matters is that two reads of an unchanged
    // breakdown produce the same list, or every confirmation would look changed.
    .orderBy(asc(transactionItems.id));

  return {
    action: payload.action,
    target: payload.target,
    transaction_id: transactionId,
    reason: payload.reason ?? null,
    changes: payload.body,
    resolved,
    current: {
      kind: header.kind,
      occurred_on: header.occurredOn,
      description: header.description,
      notes: header.notes ?? null,
      payee_id: header.payeeId ?? null,
      payee_name: header.payeeName ?? null,
      source: header.source,
      needs_review: header.needsReview,
      legs: legRows.map((leg) => ({
        sort_order: leg.sortOrder,
        account_id: leg.accountId,
        account_name: leg.accountName,
        category_id: leg.categoryId ?? null,
        category_name: leg.categoryName ?? null,
        amount_minor: leg.amountMinor,
        /*
         * The figure a person recognises, next to the one the fingerprint uses.
         *
         * `amount_minor` is minor units and signed, and a model handed only
         * that narrates «-1.200.870 VES» for twelve thousand bolívares — a
         * number that is neither the person's nor wrong by a factor they can
         * spot. Unsigned because the sign is the ledger's side of the entry,
         * not part of the amount: `kind` above is what says where it went.
         */
        amount_text: formatAmount(Math.abs(leg.amountMinor), leg.currency),
        currency: leg.currency,
        base_currency: leg.baseCurrency,
        rate_bcv: leg.rateBcv ?? null,
        rate_p2p: leg.rateP2p ?? null,
        rate_manual: leg.rateManual ?? null,
        rate_source_used: leg.rateSourceUsed,
        base_amount_bcv_minor: leg.baseAmountBcvMinor ?? null,
        base_amount_p2p_minor: leg.baseAmountP2pMinor ?? null,
        base_amount_manual_minor: leg.baseAmountManualMinor ?? null,
        base_amount_text: usedBaseText(leg),
      })),
      items: itemRows.map((item) => ({
        id: item.id,
        raw_text: item.rawText ?? null,
        quantity: item.quantity,
        unit: item.unit ?? null,
        total_minor: item.totalMinor,
        total_text: formatAmount(Math.abs(item.totalMinor), item.currency),
        currency: item.currency,
      })),
    },
  };
}

/**
 * The rows the names in `changes` resolve to, matched exactly as the write will.
 *
 * `updateTransaction` takes «Zelle» and asks `resolveAccount` which account that
 * is, and a trigram match above 0.3 wins. Two different things go wrong if the
 * preview does not do the same:
 *
 * - The frequent one, with no concurrency at all: the person is asked to
 *   approve «move it to Zelle» and never sees WHICH of their accounts that
 *   turned out to be. A 0.34 match reads exactly like an exact one.
 * - The one the gate exists for: an alias added to another account between the
 *   preview and the yes — from the dashboard, or another chat — makes the same
 *   name resolve elsewhere. The entry is untouched, so every other value in the
 *   fingerprint is byte-identical and the confirmation would sail through.
 *
 * Matched here, put in the preview and fingerprinted, both close. A name that
 * matches nothing is refused NOW, in the household's own words, rather than
 * after the yes, where it reads as the approval itself having failed.
 *
 * What this does not close is the instant between the fingerprint check and the
 * write, because `updateTransaction` takes a name and resolves it again. That
 * window is milliseconds against the fifteen minutes an approval can sit for,
 * and shutting it needs the service to accept the account it was shown — which
 * is a change to the service, not to the preview.
 */
async function resolveRequested(
  principal: Principal,
  body: Record<string, unknown>,
  kind: string,
): Promise<AmendPreview["resolved"]> {
  const t = getTranslator(normalizeLocale(principal.locale));
  const wantedAccount = nameIn(body, "account");
  const wantedCategory = nameIn(body, "category");

  let account: AmendMatch | null = null;
  if (wantedAccount) {
    /*
     * WITHOUT the currency bias, because `moveAccount` resolves it without one:
     * a preview biased differently from the write is a preview of another row.
     */
    const match = await resolveAccount(principal.householdId, wantedAccount);
    if (!match) {
      throw new InvalidTransactionError(
        t("services.updateTransaction.accountNotFound", { wanted: wantedAccount }),
        "account_not_found",
      );
    }
    account = toAmendMatch(match, await currencyOfAccount(match.id));
  }

  let category: AmendMatch | null = null;
  // A transfer has no category, and `updateTransaction` refuses one before it
  // resolves anything. Repeating that refusal here would be a second copy of a
  // rule; resolving anyway would show a match the write is never going to use.
  if (wantedCategory && kind !== "transfer") {
    const match = await resolveCategory(
      principal.householdId,
      wantedCategory,
      kind === "income" ? "income" : "expense",
    );
    if (!match) {
      throw new InvalidTransactionError(
        t("services.updateTransaction.categoryNotFound", { input: wantedCategory }),
        "category_not_found",
      );
    }
    category = toAmendMatch(match, null);
  }

  return { account, category };
}

/** The values that decide where the correction lands, how sure, and in what unit. */
function toAmendMatch(match: Match, currency: string | null): AmendMatch {
  return { id: match.id, name: match.name, score: match.score, via: match.via, currency };
}

/**
 * The currency of a resolved account.
 *
 * `Match` does not carry one — it is the shape every resolver returns — so it is
 * read here, in the preview path only, exactly as `recordTransaction` reads it
 * before typing its own resolved account with a currency.
 */
async function currencyOfAccount(accountId: string): Promise<string | null> {
  const [row] = await db
    .select({ currency: accounts.currency })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1);
  return row?.currency ?? null;
}

/** `changes` came back from `jsonb`, so what a key holds is only ever claimed. */
function nameIn(body: Record<string, unknown>, key: "account" | "category"): string | null {
  const value = body[key];
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/**
 * The base-currency equivalent that COUNTS, of the three the leg carries.
 *
 * A leg stores what it would be worth at each rate; `rate_source_used` is the
 * one that decided the figure the reports add up. Formatting all three would
 * hand a model three answers to «how much was that in dollars» and no way to
 * tell which. `none` — a leg already in the household's currency, or one there
 * was no rate for — has no equivalent to give, and `amount_text` is the figure.
 */
function usedBaseText(leg: {
  baseCurrency: string;
  rateSourceUsed: string;
  baseAmountBcvMinor: number | null;
  baseAmountP2pMinor: number | null;
  baseAmountManualMinor: number | null;
}): string | null {
  const minor =
    leg.rateSourceUsed === "bcv"
      ? leg.baseAmountBcvMinor
      : leg.rateSourceUsed === "p2p"
        ? leg.baseAmountP2pMinor
        : leg.rateSourceUsed === "manual"
          ? leg.baseAmountManualMinor
          : null;

  return minor == null ? null : formatAmount(Math.abs(minor), leg.baseCurrency);
}

/**
 * Re-issues the amendment against the v1 route, with the resolved id in the path.
 *
 * The route is called and not `updateTransaction()` directly because the route
 * holds two decisions that are not this operation's to re-take: that «nothing
 * changed» is a failure and not an ok:true, and that the stored `void_reason` is
 * frozen in the household's language. A second copy of either is a second thing
 * to drift.
 *
 * `callRoute` on the tool context does the same six lines, but an operation
 * runs from the gate and has no context: the confirmation is committed long
 * after the tool call that staged it.
 */
async function callTransactionRoute(
  principal: Principal,
  transactionId: string,
  method: "PATCH" | "DELETE",
  route: (req: NextRequest) => Promise<Response>,
  body?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  /*
   * The principal travels in a WeakMap on the request, not in a header: MCP is
   * a server-side adapter, and a header is something a caller could forge.
   */
  const req = withInternalPrincipal(
    new NextRequest(`http://planfly.internal/api/v1/transactions/${transactionId}`, {
      method,
      ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
    }),
    principal,
  );

  const response = await route(req);
  const payload = (await response.json()) as Record<string, unknown>;
  // The route's own refusal, whole. Its `error` and its `message` are what tell
  // the model whether to ask the person or fix its own call.
  if (!response.ok) throw new RouteRefusal(payload, response.status);
  return payload;
}

/**
 * The values that, if they moved, mean the yes was for something else.
 *
 * Three parts, and the last two are the ones the prior art was missing:
 *
 * - WHAT WAS ASKED — the resolved id, the action, the fields being set and the
 *   reason. `last` is resolved on every pass, so a newer entry arriving between
 *   the preview and the yes changes the id and the confirmation stops.
 * - WHAT IT RESOLVES TO — `changes` carries «Zelle», not an account id, and the
 *   write matches that name fuzzily. The same name resolving to another row
 *   moves nothing in `changes` and nothing in the entry: only the match moves,
 *   which is why its id, name, score and via are here. `record_transaction`'s
 *   `approvalFingerprint` covers its own resolutions for the same reason.
 * - WHAT THE ENTRY SAYS NOW — its date, description, notes, place, review flag,
 *   and per leg the account, the category, the signed amount, the currency and
 *   the whole rate snapshot with the base-currency equivalents. A correction is
 *   applied ON TOP of these: «make it 500» approved against an entry that says
 *   120 is not the same yes as against one somebody has since made 4.800, and
 *   the rates are what decide what either of those is worth in base currency.
 *   `needs_review` is here because it is the entire subject of `approve`.
 *   The breakdown is here row by row because `items_mode: 'replace'` deletes
 *   exactly the rows listed: if they changed, it would delete different ones.
 *
 * Picked and ordered by hand, like `record_transaction`'s: the preview is stored
 * as `jsonb`, which does not preserve key order, so the comparison has to be by
 * value and not by serialization.
 */
function amendFingerprint(preview: AmendPreview): string {
  const current = preview.current;

  return JSON.stringify({
    action: preview.action,
    transactionId: preview.transaction_id,
    reason: preview.reason ?? null,
    changes: stableKeys(preview.changes),
    // Rebuilt field by field like every other value here, and not spread: the
    // stored preview comes back from `jsonb`, which reorders keys, so a spread
    // would serialise differently from the fresh one and every confirmation
    // would come back `preview_changed`. A preview staged before `resolved`
    // existed has none, and that too is a changed preview: shown again, refused.
    resolved: {
      account: sameMatch(preview.resolved?.account),
      category: sameMatch(preview.resolved?.category),
    },
    kind: current.kind,
    occurredOn: current.occurred_on,
    description: current.description,
    notes: current.notes ?? null,
    payeeId: current.payee_id ?? null,
    source: current.source,
    needsReview: current.needs_review,
    legs: current.legs.map((leg) => ({
      sortOrder: leg.sort_order,
      accountId: leg.account_id,
      accountName: leg.account_name,
      categoryId: leg.category_id ?? null,
      amountMinor: leg.amount_minor,
      currency: leg.currency,
      baseCurrency: leg.base_currency,
      rateBcv: leg.rate_bcv ?? null,
      rateP2p: leg.rate_p2p ?? null,
      rateManual: leg.rate_manual ?? null,
      rateSourceUsed: leg.rate_source_used,
      baseAmountBcvMinor: leg.base_amount_bcv_minor ?? null,
      baseAmountP2pMinor: leg.base_amount_p2p_minor ?? null,
      baseAmountManualMinor: leg.base_amount_manual_minor ?? null,
    })),
    items: current.items.map((item) => ({
      id: item.id,
      quantity: item.quantity,
      unit: item.unit ?? null,
      totalMinor: item.total_minor,
      currency: item.currency,
    })),
  });
}

function sameMatch(match: AmendMatch | null | undefined) {
  return match
    ? {
        id: match.id,
        name: match.name,
        score: match.score,
        via: match.via,
        // The unit the amount will be parsed in. An account renamed into another
        // currency between the preview and the yes changes what «500» means.
        currency: match.currency ?? null,
      }
    : null;
}

/** Key order again: `changes` is a free-form object and came back from `jsonb`. */
function stableKeys(value: Record<string, unknown>): Array<[string, unknown]> {
  return Object.keys(value)
    .sort()
    .map((key) => [key, value[key]] as [string, unknown]);
}
