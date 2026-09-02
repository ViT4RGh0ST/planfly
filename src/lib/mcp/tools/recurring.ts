import { z } from "zod";

import { GET as recurringListRoute } from "@/app/api/v1/recurring/route";
import { normalizeLocale, type Locale } from "@/i18n/config";
import { describeZodIssues } from "@/lib/api/handler";
import { today } from "@/lib/dates";
import {
  CREATE_RECURRENCE,
  isBackdated,
  postRecurringRule,
} from "@/lib/mcp/operations/create-recurrence";
import { defineTool } from "@/lib/mcp/registry";
import type { McpToolContext } from "@/lib/mcp/tools/context";
import { previewMcpOperation, confirmMcpOperation } from "@/lib/mcp/transactions";
import {
  daysFor,
  InvalidRecurrenceError,
  removeRecurringRule,
  setRecurringActive,
} from "@/lib/services/recurring";
import { createRecurringSchema } from "@/lib/validation";

/**
 * Rules that fire on their own: the rent, a subscription, the fortnightly pay.
 *
 * The parameter wording is the bot plugin's, on purpose. Every sentence here was
 * written after watching a model get it wrong — a rate source guessed between
 * two that differ by more than 14%, an amount stored in bolívares that expires
 * next month, «I pay it every month» taken for a rule when it was an expense
 * that already happened.
 *
 * Only one branch goes through the confirmation gate, and it is the create with
 * a start date in the PAST: see `operations/create-recurrence.ts` for why.
 */

const recurringInputSchema = z.object({
  action: z
    .enum(["create", "list", "pause", "resume", "remove"])
    .describe(
      "pause/resume/remove need `id`, which comes from action='list'. " +
        "pause stops it without deleting it; remove deletes it, and what it already recorded stays. " +
        "create needs name, cadence, amount and account.",
    ),
  id: z
    .string()
    .min(1)
    .optional()
    .describe("The rule's id, from action='list'. Required for pause, resume and remove."),
  confirmation_id: z
    .uuid()
    .optional()
    .describe(
      "Only to commit a back-dated create that this tool already previewed, and only after the " +
        "person approved the dates it returned. The rule is created from the payload that was " +
        "approved: any other field sent alongside this one is ignored, never merged.",
    ),
  name: z
    .string()
    .optional()
    .describe("What the user calls it: 'Alquiler', 'Netflix', 'Gimnasio'."),
  cadence: z
    .enum(["monthly", "biweekly", "custom"])
    .optional()
    .describe(
      "monthly = the 1st of every month · biweekly = the 15th and the last day · " +
        "custom = whichever days the user says, in days_of_month.",
    ),
  days_of_month: z
    .array(z.number().int().min(-1).max(31))
    .max(31)
    .optional()
    .describe(
      "Only with cadence='custom': which days of the month. Use -1 for 'the last day'. " +
        "'El 5 y el 20' is [5, 20]; 'el 5 y a fin de mes' is [5, -1]. " +
        "A day that does not exist in a month is clamped to the last: the 31st in February is the 28th.",
    ),
  kind: z
    .enum(["expense", "income", "transfer"])
    .optional()
    .describe("Defaults to expense."),
  amount: z
    .union([z.string().min(1), z.number()])
    .optional()
    .describe("In major units, exactly as they said it: 15 is fifteen, not fifteen cents."),
  amount_currency: z
    .string()
    .min(2)
    .max(10)
    .optional()
    .describe(
      "The currency the user THINKS the amount in, when it is NOT the account's. " +
        "'El gimnasio son 15 dólares y me lo cobran en bolívares' → amount 15, " +
        "amount_currency USD, account the bolívar account. " +
        "It is converted at the rate of the day it fires, not today's: that is why the 15 has " +
        "to be stored and not the bolívares, which change every month. Omit it if the amount is " +
        "already in the account's currency. Take the code from planfly_context; never guess one.",
    ),
  rate_source: z
    .enum(["bcv", "p2p"])
    .optional()
    .describe(
      "Which rate to convert with when there is an amount_currency. Ask the user if they do " +
        "not say: between BCV and P2P there is more than 14% and it is not a detail.",
    ),
  account: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Which account it leaves from (or arrives at). By name or nickname, as it comes back from " +
        "planfly_context. Always send it: a name that matches nothing writes the money " +
        "elsewhere, and sending none at all makes every occurrence fall back to whichever " +
        "account the household happens to list first. It is required whenever there is an " +
        "amount_currency, because what the amount is converted INTO is this account's currency.",
    ),
  to_account: z
    .string()
    .min(1)
    .optional()
    .describe("Only for transfer: which account it arrives at."),
  category: z
    .string()
    .min(1)
    .optional()
    .describe("In the user's own words. Ignored on transfers."),
  start_on: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe(
      "YYYY-MM-DD. From when it counts; the first time will be the next chosen day on or " +
        "after that date. Defaults to today. A date in the PAST is not a formality: every " +
        "occurrence between it and today is posted on the next heartbeat.",
    ),
});

type ToolInput = z.infer<typeof recurringInputSchema>;

export const recurringTool = defineTool({
  name: "planfly_recurring",
  title: "Planfly recurring rules",
  description:
    "Configures or consults operations that repeat on their own: the rent, the internet, a " +
    "subscription, the fortnightly pay coming in. Use it when the user asks for something to be " +
    "recorded automatically every month or every fortnight. " +
    "Do NOT use it to record an expense that already happened — that is " +
    "planfly_preview_transaction, even if the user says they pay it every month. " +
    "Consult with action='list' before creating, so as not to configure the same thing twice — " +
    "and to get the id that pause, resume and remove need. " +
    "A badly set rule records on its own every month: pausing it is more urgent than fixing it. " +
    "A rule is not merely a schedule. One created with start_on in the past is caught up on the " +
    "next heartbeat, which posts one real entry per date already passed, up to 24 at once, with " +
    "nobody watching; anything beyond those 24 is dropped, not deferred. So a back-dated create " +
    "writes nothing on the first call: it returns a confirmation_id and the exact dates it would " +
    "post. Show the person those dates and call again with that confirmation_id only after they " +
    "approve them. A rule starting today or later posts nothing until its day comes and is " +
    "created straight away.",
  inputSchema: recurringInputSchema,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  keywords: [
    "recurring", "recurrence", "subscription", "rent", "salary", "payroll",
    "monthly", "biweekly", "schedule", "rule", "pause", "resume",
    "recurrente", "suscripcion", "alquiler", "mensual", "quincenal", "sueldo",
    "nomina", "regla", "pausar", "domiciliado", "netflix",
  ],
  /* Both, because which one is required depends on the action. `run` decides. */
  scopes: ["context:read", "recurring:write"],
  examples: [
    'Creating one: {"action": "create", "name": "Alquiler", "cadence": "monthly", "amount": 120, "amount_currency": "USD", "rate_source": "bcv", "account": "provincial", "category": "vivienda"}',
    'Seeing them, and getting the ids: {"action": "list"}',
    'Pausing one: {"action": "pause", "id": "<the id action=list returned>"}',
    "A back-dated start_on comes back as confirmation_required with the exact dates it would post.",
    '  Read those dates to the person, and only after an explicit yes call again with',
    '  {"action": "create", "confirmation_id": "<the id it returned>"} and nothing else.',
  ],
  run: async (input, ctx) => {
    try {
      /*
       * The scope that matches the ACTION, not one for the whole tool. Listing
       * the rules is part of reading the household's context; everything else
       * here changes what gets written every month with nobody watching, and a
       * token holding only context:read must not earn that by entering here.
       */
      if (input.action === "list") {
        ctx.requireScope("context:read");
        return ctx.result(await ctx.callRoute("/api/v1/recurring", recurringListRoute));
      }

      const principal = ctx.requireScope("recurring:write");

      if (input.action === "pause" || input.action === "resume") {
        if (!input.id) return missingId(ctx, input.action);
        return ctx.result({
          ok: true,
          ...(await setRecurringActive(
            principal.householdId,
            input.id,
            input.action === "resume",
            principal.timezone,
            principal.locale,
          )),
        });
      }

      if (input.action === "remove") {
        if (!input.id) return missingId(ctx, input.action);
        return ctx.result({
          ok: true,
          ...(await removeRecurringRule(principal.householdId, input.id, principal.locale)),
        });
      }

      /*
       * The yes to a back-dated create. Nothing sent alongside it is read: the
       * rule is built from the payload that was previewed, so what is written is
       * what the person saw and not a draft edited after their approval.
       */
      if (input.confirmation_id) {
        return ctx.result({
          ok: true,
          ...(await confirmMcpOperation(principal, input.confirmation_id, "create_recurrence")),
        });
      }

      const parsed = createRecurringSchema.safeParse(toCreateBody(input));
      if (!parsed.success) {
        /*
         * The v1 route's own sentence, from the v1 route's own builder: which
         * field is missing is what lets the caller fix its call. The shared
         * mapper turns a ZodError into «the tool input did not match its
         * schema», and against that a model can only guess again.
         */
        return ctx.result(
          {
            ok: false,
            error: "invalid_body",
            message: describeZodIssues(parsed.error, normalizeLocale(principal.locale)),
            detail: parsed.error.issues.map((issue) => ({
              field: issue.path.join("."),
              problem: issue.message,
            })),
          },
          true,
        );
      }
      const draft = parsed.data;

      /*
       * Combinations the schema accepts and the heartbeat cannot honour. They
       * are refused here, before a preview promises them, because every one of
       * them is silent afterwards: nothing fails at creation, and what shows up
       * a month later is either an entry in the wrong currency or a rule that
       * has never posted anything.
       */
      const refusal = refuseImpossibleRule(draft, normalizeLocale(principal.locale));
      if (refusal) return ctx.result({ ok: false, ...refusal }, true);

      /*
       * Gated on the start date alone, before anything is resolved. A rule
       * starting today or later posts nothing until its day comes; one starting
       * yesterday posts every date in between on the next heartbeat.
       */
      if (!isBackdated(draft.start_on, today(principal.timezone))) {
        return ctx.result(await postRecurringRule(principal, draft));
      }

      const staged = await previewMcpOperation(principal, CREATE_RECURRENCE, draft);
      return ctx.result(
        {
          ok: false,
          error: "confirmation_required",
          message:
            "This rule starts in the past, so creating it posts the entries listed in `preview` " +
            "on the next heartbeat. Read those dates to the person and call planfly_recurring " +
            "again with this confirmation_id only after they approve them.",
          confirmation_id: staged.confirmationId,
          expires_at: staged.expiresAt,
          preview: staged.preview,
        },
        true,
      );
    } catch (error) {
      /*
       * The rule's own sentence, not «planfly could not complete the request».
       *
       * `InvalidRecurrenceError` is what the service throws when the id names no
       * rule, when a custom cadence resolves to no days, or when the name is
       * blank — each of them something the caller can fix, or must stop on. The
       * shared mapper only knows the transaction errors, so without this branch
       * all three arrive as an internal error and the only move left is to try
       * the same call again.
       */
      if (error instanceof InvalidRecurrenceError) {
        return ctx.result({ ok: false, error: error.code, message: error.message }, true);
      }
      return ctx.fail(error);
    }
  },
});

type CreateDraft = z.infer<typeof createRecurringSchema>;

/**
 * The pairs of fields that pass the schema and lie anyway.
 *
 * This is the one place that sees the whole call — the cadence with its days,
 * the currency with its account, the kind with its destination — and each of
 * these combinations is a valid field in the wrong context: the write takes it,
 * returns 201, and the wrong thing happens every month with nobody watching.
 * `rejectUnknownKeys` cannot see any of them, because none of the keys is
 * unknown.
 *
 * It returns the refusal rather than throwing it, except for the cadence's own
 * days: that one is `daysFor` throwing the service's own sentence, which the
 * `catch` in `run` hands back whole. Restating it here would be a second copy of
 * a wording that has to match what the rule will actually do.
 */
function refuseImpossibleRule(
  draft: CreateDraft,
  locale: Locale,
): { error: string; message: string } | null {
  /*
   * An amount thought in another currency, with no account to convert INTO.
   *
   * `resolveTemplateAmount` needs the account's currency to know what to
   * convert to; with no account there is none, it returns early, and
   * `recordTransaction` then falls back to the household's first account and
   * takes the figure as already being in that account's currency. «15 USD at
   * BCV» becomes 15,00 Bs, on every caught-up date, and nothing anywhere fails.
   */
  if (draft.amount_currency && !draft.account) {
    return {
      error: "amount_currency_needs_account",
      message:
        `An amount in ${draft.amount_currency} is only converted when the rule says which ` +
        "`account` it posts to, because what it converts INTO is that account's currency. " +
        `Without it the entry would be recorded as ${draft.amount} of whatever currency the ` +
        "account it falls back to happens to keep. Send `account`, or drop `amount_currency` " +
        "if the amount is already in that account's own currency.",
    };
  }

  /*
   * A destination on something that is not a transfer, and a transfer without
   * one. Both are refused by `recordTransaction` on EVERY occurrence, so the
   * rule is created, the preview lists its dates, and the person is notified of
   * one failure per date instead of being told at the door.
   */
  if (draft.kind !== "transfer" && draft.to_account) {
    return {
      error: "to_account_not_transfer",
      message:
        `\`to_account\` is only read on a transfer, and this rule is a ${draft.kind}: every ` +
        "occurrence would be refused and the rule would post nothing. Use `account` for the " +
        `account the money leaves from, or send kind='transfer' if ${draft.to_account} is ` +
        "really where it arrives.",
    };
  }
  if (draft.kind === "transfer" && !draft.to_account) {
    return {
      error: "missing_to_account",
      message:
        "A transfer rule needs `to_account`: which account the money arrives at. Without it " +
        "every occurrence would be refused and the rule would post nothing.",
    };
  }

  /*
   * Days sent against a preset cadence. `daysFor` returns the preset's own days
   * and never looks at the ones sent, so «el alquiler, el 5 de cada mes» with
   * cadence='monthly' fires on the 1st — four days early, every month, and the
   * discarded [5] is said nowhere.
   */
  if (draft.cadence !== "custom" && draft.days_of_month?.length) {
    return {
      error: "days_of_month_needs_custom",
      message:
        `cadence='${draft.cadence}' always fires on [${daysFor(draft.cadence, undefined, locale).join(", ")}] ` +
        "(-1 = the last day of the month), and `days_of_month` is read only with " +
        `cadence='custom'. Send cadence='custom' to keep [${draft.days_of_month.join(", ")}], ` +
        "or drop `days_of_month` to accept the preset's days.",
    };
  }

  // The cadence's own days, from the service, so a custom cadence resolving to
  // nothing is refused with the same sentence on both paths — the immediate one
  // reaches `daysFor` inside the v1 route, where the message is replaced by a
  // generic 500 and the caller is left with nothing to fix.
  daysFor(draft.cadence, draft.days_of_month, locale);
  return null;
}

/** Exactly the keys `createRecurringSchema` declares, and no others. */
function toCreateBody(input: ToolInput): Record<string, unknown> {
  return {
    name: input.name,
    cadence: input.cadence,
    days_of_month: input.days_of_month,
    kind: input.kind,
    amount: input.amount,
    amount_currency: input.amount_currency,
    rate_source: input.rate_source,
    account: input.account,
    to_account: input.to_account,
    category: input.category,
    start_on: input.start_on,
  };
}

function missingId(ctx: McpToolContext, action: string) {
  return ctx.result(
    {
      ok: false,
      error: "missing_id",
      message: `The action '${action}' needs the rule's id. Call planfly_recurring with action='list' to get it.`,
    },
    true,
  );
}
