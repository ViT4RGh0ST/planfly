import { NextRequest } from "next/server";
import { z } from "zod";

import { GET as financingListRoute, POST as financingWriteRoute } from "@/app/api/v1/financing/route";
import { withInternalPrincipal } from "@/lib/api/handler";
import type { Principal } from "@/lib/api-token";
import { defineTool } from "@/lib/mcp/registry";
import { confirmMcpOperation, previewMcpOperation } from "@/lib/mcp/transactions";
import {
  createFinancedPurchaseSchema,
  payInstallmentSchema,
  unpayInstallmentSchema,
  voidPlanSchema,
} from "@/lib/validation";

/**
 * The operations this tool stages, and the only ones it may confirm.
 *
 * Paying an instalment and recording a financed purchase both stage through the
 * gate, and action='confirm' does not say which of the two an id was staged for.
 * Naming both is what stops this tool committing ANOTHER tool's pending
 * operation — a declined expense confirmed and reported as a paid quota.
 */
const FINANCING_OPERATIONS = ["pay_installment", "record_financed_purchase"] as const;

/**
 * Installment purchases over MCP.
 *
 * The four writes are one family and one permission, but four different bodies,
 * and `/api/v1/financing` discriminates between them by which fields arrive. So
 * does this tool, through `action`: each branch builds ONLY the keys its own
 * schema declares. That is not tidiness. `undo: true` on a payment is a 400 from
 * `rejectUnknownKeys`, and `from_account` on an undo is worse — it validates
 * nowhere and the datum lands in the bin — so no branch can reach another's
 * fields by accident.
 *
 * The two that move money wait for an approval, and neither of them stages it
 * here: `previewMcpOperation` writes the confirmation and `confirmMcpOperation`
 * claims it before writing. This file does not know the table exists, which is
 * the point — every hand-written copy of «claim the row before writing» was
 * another chance to drop the claim, and what follows that is an installment
 * paid twice.
 */

const PATH = "/api/v1/financing";

/** The two that move money, and therefore the two that wait for an approval. */
const PURCHASE_OPERATION = "record_financed_purchase";
const PAY_OPERATION = "pay_installment";

/**
 * POST the v1 route the way `callRoute` reads one.
 *
 * `callRoute` builds the request itself, and it builds a GET; the principal it
 * carries lives in a WeakMap keyed by that very request object. A body needs a
 * new object, so the principal is put on that one too — without it `withToken`
 * falls back to an Authorization header MCP never sends and the call comes back
 * 401 from its own household.
 */
function withBody(
  body: Record<string, unknown>,
  principal: Principal,
): (req: NextRequest) => Promise<Response> {
  return (req) =>
    financingWriteRoute(
      withInternalPrincipal(
        new NextRequest(req.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
        principal,
      ),
    );
}

/**
 * The six actions, written once.
 *
 * The enum below and `FIELDS` are both keyed to this tuple, so a seventh action
 * added to one and not the other stops compiling. Keyed to `string` it did not:
 * `FIELDS[input.action]` came back undefined and `spec.required` threw a
 * TypeError out of `superRefine` — i.e. out of the `.parse` the gateway itself
 * calls, which is not a validation error and does not reach `mcpErrorResult`.
 * The tool would stop accepting ANY call for that action, and the answer the
 * model gets names no field it could correct.
 */
const ACTIONS = ["list", "purchase", "pay", "unpay", "void", "confirm"] as const;
type FinancingAction = (typeof ACTIONS)[number];

/**
 * Which fields belong to which action, enforced instead of ignored.
 *
 * Every branch below builds its body from named keys, so a field belonging to
 * another action never reaches the service — and, without this, is never
 * refused either. `paid_on` sent with action='purchase' is the case that costs:
 * the model reaches for the date field it knows from action='pay', the purchase
 * is booked on today instead, the four installments fall due a month out and
 * the conversion runs at today's rate rather than the day's. It comes back ok,
 * and nothing in the answer says the date was dropped. The route's own
 * `rejectUnknownKeys` cannot help here, because this tool constructs the body.
 */
const FIELDS: Record<FinancingAction, { required: string[]; optional: string[] }> = {
  list: { required: [], optional: [] },
  purchase: {
    required: ["financier", "total", "installments"],
    optional: [
      "total_currency",
      "rate_source",
      "down_payment",
      "down_payment_account",
      "frequency",
      "first_due_on",
      "category",
      "description",
      "occurred_on",
    ],
  },
  pay: { required: ["installment_id", "from_account"], optional: ["paid_on"] },
  unpay: { required: ["installment_id"], optional: [] },
  void: { required: ["plan_id"], optional: ["reason"] },
  confirm: { required: ["confirmation_id"], optional: [] },
};

/*
 * The schema is its own binding, because the gateway parses arguments with it
 * too. The raw-shape shorthand the SDK still accepts cannot be called: a
 * `{ field: z.string() }` record has no `.parse`.
 */
const financingInputSchema = z.object({
  action: z
    .enum(ACTIONS)
    .describe(
      "purchase = buy in installments · pay = pay an installment · unpay = undo a payment · " +
        "void = void the whole purchase · list = what is owed · confirm = commit a purchase or a " +
        "payment that was previewed. There is no default: name the one you mean. unpay also voids " +
        "the transfer that paid the installment; void voids the purchase, the down payment and any " +
        "installments already paid, and it all stays in the history, marked. purchase and pay write " +
        "nothing on their own: they return a confirmation_id to send back with confirm.",
    ),

  financier: z
    .string()
    .min(1)
    .optional()
    .describe(
      "With action='purchase': who finances it — 'Cashea', a person, the shop. It is a liability " +
        "account in Planfly. If it does not exist, do NOT invent it: tell the person to open it as a " +
        "loan account.",
    ),
  total: z
    .union([z.string(), z.number()])
    .optional()
    .describe(
      "With action='purchase': the FULL price of the purchase, not the installment's, in major units.",
    ),
  total_currency: z
    .string()
    .min(2)
    .max(10)
    .optional()
    .describe(
      "The currency the person says the price in, when it is NOT the financier's. 'Some fifty-dollar " +
        "shoes on Cashea' → total 50, total_currency USD; Cashea deals in bolivars and Planfly " +
        "converts at the purchase day's rate. Omit it if they already said it in the financier's " +
        "currency. The ones that exist come back in `currencies` from planfly_context; this tool " +
        "carries no list of its own. Never substitute one the person did not ask for.",
    ),
  rate_source: z
    .enum(["official", "parallel"])
    .optional()
    .describe("Which rate to convert with when there is a total_currency. Ask if they do not say."),
  down_payment: z
    .union([z.string(), z.number()])
    .optional()
    .describe(
      "The down payment, if they paid one. In major units. Zero or absent if there was none.",
    ),
  down_payment_account: z
    .string()
    .min(1)
    .optional()
    .describe("Which account the down payment left from. Required if there is one."),
  installments: z
    .number()
    .int()
    .min(1)
    .max(60)
    .optional()
    .describe("How many installments the rest is split into. Cashea usually runs 3 or 4."),
  frequency: z
    .enum(["biweekly", "monthly"])
    .optional()
    .describe(
      "biweekly = every 15 days, which is Cashea's. monthly = every month. Defaults to biweekly.",
    ),
  first_due_on: z
    .string()
    .optional()
    .describe("YYYY-MM-DD of the first installment. Defaults to one period after the purchase."),
  category: z.string().min(1).optional().describe("In the person's own words."),
  description: z.string().max(500).optional().describe("What they bought."),
  occurred_on: z.string().optional().describe("YYYY-MM-DD of the purchase. Defaults to today."),

  installment_id: z
    .string()
    .optional()
    .describe(
      "With action='pay' and action='unpay': the installment's id, which comes from action='list'. " +
        "Do NOT ask the person for it — they say 'the next Cashea one' and you look up which it is.",
    ),
  from_account: z
    .string()
    .min(1)
    .optional()
    .describe("Only with action='pay': which account the payment leaves from."),
  paid_on: z.string().optional().describe("Only with action='pay'. Defaults to today."),

  plan_id: z
    .string()
    .optional()
    .describe("Only with action='void': which purchase is voided. Comes from action='list'."),
  reason: z
    .string()
    .max(200)
    .optional()
    .describe(
      "With action='void': why it is voided, in the person's own words. It is what will explain the " +
        "row to them in three months' time.",
    ),

  // A uuid here and not in the WHERE below: an id that is not one reaches
  // Postgres as a cast error and comes back as a 500 with its text inside.
  confirmation_id: z
    .uuid()
    .optional()
    .describe(
      "Only with action='confirm': the id the purchase or pay preview returned. Send it only after " +
        "the person explicitly approved THAT preview.",
    ),
}).superRefine((input, ctx) => {
  const values = input as Record<string, unknown>;
  const given = Object.keys(values).filter((key) => key !== "action" && values[key] !== undefined);

  const spec = FIELDS[input.action];
  for (const key of spec.required) {
    if (values[key] === undefined) {
      ctx.addIssue({ code: "custom", path: [key], message: `action='${input.action}' needs ${key}.` });
    }
  }
  for (const key of given) {
    if (spec.required.includes(key) || spec.optional.includes(key)) continue;
    ctx.addIssue({
      code: "custom",
      path: [key],
      message:
        input.action === "confirm"
          ? // The approval was given for the previewed purchase or quota, not
            // for whatever this call happens to carry, and the id already knows
            // which of the two it staged: a purchase id arriving with a
            // from_account would commit the purchase while the caller reported
            // a payment.
            "A confirmation travels alone: send confirmation_id and action='confirm', nothing else."
          : `${key} does not belong to action='${input.action}'.`,
    });
  }
});

export const financingTool = defineTool({
  name: "planfly_financing",
  title: "Planfly installment purchases",
  description:
    "Records a financed purchase, pays an installment, or consults what is owed and what is " +
    "due. Use it ALWAYS when the purchase is in installments — a store plan, a card plan, a " +
    "loan — and also when they say they paid an installment. NEVER record any of this as a " +
    "plain transaction: an installment purchase is two entries and a schedule, and recording it " +
    "by hand leaves the debt wrong forever. With action='list' you see the plans and their " +
    "installments with ids, which is what you need to pay one. action='purchase' and " +
    "action='pay' move money and write nothing on their own: they return a preview and a " +
    "confirmation_id, and only action='confirm' with that id posts it, after the person " +
    "explicitly approved that preview.",
  inputSchema: financingInputSchema,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  keywords: [
    "financing", "installment", "installments", "loan", "debt", "instalment", "quota",
    "cuota", "cuotas", "financiamiento", "prestamo", "deuda", "cashea", "abono", "inicial",
  ],
  /* Both, because which one is required depends on the action. `run` decides. */
  scopes: ["context:read", "financing:write"],
  examples: [
    'What is owed, with the ids: {"action": "list"}',
    'Buying in installments: {"action": "purchase", "financier": "Cashea", "total": 4000, "installments": 4, "down_payment": 1000, "down_payment_account": "efectivo bs", "description": "nevera"}',
    'Paying one: {"action": "pay", "installment_id": "<the id action=list gave>", "from_account": "provincial"}',
    "purchase and pay only PROPOSE. Show the preview's figures, get an explicit yes, and then",
    '  {"action": "confirm", "confirmation_id": "<the id the preview returned>"}.',
    "If the confirm comes back expired or preview_changed, preview again and show the new figures:",
    "  the person approved the old ones. Never repeat a pay to «make sure» it went through — ask",
    "  with action='list', because a quota paid twice looks exactly like a quota paid once.",
  ],
  run: async (input, ctx) => {
    try {
      switch (input.action) {
        case "list":
          // A listing reads the household's context and writes nothing, so it
          // takes the reading scope: a token that may only look must not earn a
          // write by entering through the tool that also pays.
          ctx.requireScope("context:read");
          return ctx.result(await ctx.callRoute(PATH, financingListRoute));

        case "purchase": {
          const principal = ctx.requireScope("financing:write");
          // Parsed here so a body that the route would refuse never becomes a
          // confirmation the person is asked to approve, and so what is stored
          // is exactly the keys the schema declares.
          const body = createFinancedPurchaseSchema.parse({
            financier: input.financier,
            total: input.total,
            total_currency: input.total_currency,
            rate_source: input.rate_source,
            down_payment: input.down_payment,
            down_payment_account: input.down_payment_account,
            installments: input.installments,
            frequency: input.frequency,
            first_due_on: input.first_due_on,
            category: input.category,
            description: input.description,
            occurred_on: input.occurred_on,
          });
          return ctx.result(await stage(principal, PURCHASE_OPERATION, body));
        }

        case "pay": {
          const principal = ctx.requireScope("financing:write");
          const body = payInstallmentSchema.parse({
            installment_id: input.installment_id,
            from_account: input.from_account,
            paid_on: input.paid_on,
          });
          return ctx.result(await stage(principal, PAY_OPERATION, body));
        }

        case "unpay": {
          const principal = ctx.requireScope("financing:write");
          // `undo` is a literal the route needs to reach this branch at all,
          // and it is written here, never taken from the input: an action the
          // model can only name cannot be spelled in a way that reads as a pay.
          const body = unpayInstallmentSchema.parse({
            installment_id: input.installment_id,
            undo: true,
          });
          // No gate: it takes money out of nothing. It puts an installment back
          // to pending and voids the transfer that paid it, and the void stays
          // in the history to be seen.
          return ctx.result(await ctx.callRoute(PATH, withBody(body, principal)));
        }

        case "void": {
          const principal = ctx.requireScope("financing:write");
          const body = voidPlanSchema.parse({ plan_id: input.plan_id, reason: input.reason });
          return ctx.result(await ctx.callRoute(PATH, withBody(body, principal)));
        }

        case "confirm": {
          const principal = ctx.requireScope("financing:write");
          // Unreachable through the schema, which now requires it per action.
          // It stays so the branch never has to assert its way into the gate.
          if (!input.confirmation_id) {
            return ctx.result(
              {
                ok: false,
                error: "invalid_input",
                message: "action='confirm' needs the confirmation_id the preview returned.",
              },
              true,
            );
          }
          /*
           * The gate re-runs the operation's own dry run, compares its
           * fingerprint against the one the person saw, and claims the row
           * before writing. Nothing about that is repeated here — an expired
           * confirmation, one already used and one whose figures moved all come
           * back through `McpConfirmationError`, with the refreshed preview
           * attached in the last case.
           */
          const result = await confirmMcpOperation(principal, input.confirmation_id, FINANCING_OPERATIONS);
          return ctx.result({ ok: true, ...result });
        }
      }
    } catch (error) {
      // Whatever the route said — the account it could not find, the field it
      // suggests instead, the installment already paid — travels out as it came.
      return ctx.fail(error);
    }
  },
});

/**
 * Stages a write and answers with what the person has to approve.
 *
 * The keys are the ones the prior tool answered with, and `confirmation_id` is
 * deliberately spelled the way the PARAMETER that takes it back is spelled: the
 * value has to be copied from one to the other, and a reply that names it
 * `confirmationId` is a reply the model retypes.
 */
async function stage(
  principal: Principal,
  operation: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const staged = await previewMcpOperation(principal, operation, body);
  return {
    ok: true,
    awaiting_confirmation: true,
    confirmation_id: staged.confirmationId,
    expires_at: staged.expiresAt,
    operation,
    preview: staged.preview,
  };
}
