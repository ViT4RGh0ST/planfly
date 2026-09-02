import type { McpServer } from "@modelcontextprotocol/server";
import { NextRequest } from "next/server";
import { z } from "zod";

import { PATCH as accountsPatchRoute, POST as accountsPostRoute } from "@/app/api/v1/accounts/route";
import { withInternalPrincipal } from "@/lib/api/handler";
import type { Principal } from "@/lib/api-token";
import type { McpToolContext } from "@/lib/mcp/tools/context";

const toolOutputSchema = z.object({ ok: z.boolean() }).passthrough();

/**
 * The parameter wording is the bot plugin's, on purpose.
 *
 * Every sentence here was written after watching a model get it wrong —
 * prepaid taken for a credit card, a new «Provincial» opened next to «Banco
 * Provincial», an opening balance recorded as an expense. Rewording it is
 * throwing that away.
 */
const accountInputSchema = z.object({
  action: z
    .enum(["create", "update", "archive", "unarchive"])
    .default("create")
    .describe("Defaults to create. update/archive/unarchive need `account`."),
  account: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Which account, by name or nickname: 'efectivo bs', 'provincial'. " +
        "Required for update, archive and unarchive. It is unused when creating: there you send `name`.",
    ),
  name: z
    .string()
    .min(1)
    .max(80)
    .optional()
    .describe(
      "What the user is going to call it: 'Banco Mercantil', 'Tarjeta Visa', 'Cashea'. Exactly as they said it. " +
        "When correcting, only if they want to rename it.",
    ),
  type: z
    .enum(["cash", "bank", "prepaid", "crypto", "investment", "credit_card", "loan", "other"])
    .optional()
    .describe(
      "cash = physical cash · bank = bank account, mobile payment or Zelle · " +
        "prepaid = prepaid card or wallet, the kind you load before spending (Zinli, Wally, Ridivi) · " +
        "crypto = Binance or similar · credit_card = a CREDIT card · " +
        "loan = a loan or whoever fronts you money in installments (Cashea) · investment = investment · other = the rest. " +
        "Watch prepaid against credit_card: a prepaid card is your own money already loaded and it ADDS; " +
        "a credit one is debt and it SUBTRACTS.",
    ),
  currency: z
    .string()
    .min(2)
    .max(10)
    .optional()
    .describe(
      "Which currency the account is in. It has NO default: send the one the user stated, and it must be one " +
        "of the currencies this installation knows — planfly_context lists them. Never guess one: an account " +
        "opened in the wrong currency values every balance it holds at the wrong rate.",
    ),
  opening_balance: z
    .string()
    .max(30)
    .optional()
    .describe(
      "What it starts with, in major units exactly as they said it: '1.500,50'. " +
        "On a card or a loan it is HOW MUCH IS OWED, as a positive; planfly applies the sign. " +
        "When correcting it is usually what is needed: 'en efectivo tengo 5.000' means " +
        "opening_balance 5000, not an entry.",
    ),
  institution: z
    .string()
    .max(120)
    .optional()
    .describe("The bank or company behind it, if mentioned: 'Provincial', 'Binance'."),
  aliases: z
    .string()
    .max(400)
    .optional()
    .describe(
      "Other names the user is going to call it by, comma separated: 'provincial, el banco, bbva'. " +
        "They are the hints it later finds itself by when recording an expense, so they are worth setting.",
    ),
  confirm: z
    .boolean()
    .optional()
    .describe(
      "Only when creating, and only after asking the user. If planfly warns the account may already exist, " +
        "do not insist on your own: tell them which one it found and wait for them to say it is a different one.",
    ),
});

/**
 * `callRoute` builds the request, and a read needs no body, so the body is put
 * on a copy of the one it hands over. The principal travels in a WeakMap keyed
 * by the request object — the copy is a different object, so it is registered
 * again or the route answers 401.
 */
function withBody(
  req: NextRequest,
  method: "POST" | "PATCH",
  body: Record<string, unknown>,
  principal: Principal,
): NextRequest {
  return withInternalPrincipal(
    new NextRequest(req, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    principal,
  );
}

export function registerAccount(server: McpServer, ctx: McpToolContext): void {
  server.registerTool(
    "planfly_account",
    {
      title: "Open or correct a Planfly account",
      description:
        "Opens, corrects, archives or unarchives an account: another bank, a card, a wallet, a loan or whoever fronts you money. " +
        "Use it ONLY when the person explicitly asks to create, correct or retire an account. " +
        "To correct or archive, the account is identified by NAME, not by id. " +
        "Correcting the OPENING BALANCE is the most useful thing here: while the accounts lack one, net worth comes out negative. " +
        "If they mention an account you do not recognise while recording an expense, do NOT create it: ask whether they want to open it. " +
        "Call planfly_context first: opening 'Provincial' when 'Banco Provincial' exists splits the history in two, and it is also " +
        "where the currencies this installation knows are listed. " +
        "Creating answers 409 account_may_exist naming what it found, and the same call plus confirm:true then succeeds — " +
        "surface that 409 as a question for the person, and never resend confirm on your own initiative.",
      inputSchema: accountInputSchema,
      outputSchema: toolOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    async (input) => {
      try {
        const principal = ctx.requireScope("accounts:write");

        /*
         * Two bodies, not one with an extra key.
         *
         * `action` and `account` are keys of the PATCH schema only, and `confirm`
         * of the POST one only — `patchAccountSchema` is a partial of the create
         * schema, so it would take `confirm` and quietly do nothing with it. The
         * server rejects a key it does not know; a key it knows in the wrong
         * branch is the one that passes and lands in the bin.
         */
        if (input.action !== "create") {
          const patch = {
            account: input.account,
            action: input.action,
            name: input.name,
            type: input.type,
            currency: input.currency,
            opening_balance: input.opening_balance,
            institution: input.institution,
            aliases: input.aliases,
          };
          const patched = await ctx.callRoute("/api/v1/accounts", (req) =>
            accountsPatchRoute(withBody(req, "PATCH", patch, principal)),
          );
          return ctx.result({ ok: true, ...patched });
        }

        /*
         * `account` is not carried over into the create body, not even as a
         * fallback for `name`. A model that fills `account` in on a create is
         * guessing at the parameter; filling `name` in from it would be guessing
         * at the account, and one of those opens an account under a name nobody
         * wrote. The route's own answer — `name` is missing — is fixable.
         */
        const created = await ctx.callRoute("/api/v1/accounts", (req) =>
          accountsPostRoute(
            withBody(
              req,
              "POST",
              {
                name: input.name,
                type: input.type,
                currency: input.currency,
                opening_balance: input.opening_balance,
                institution: input.institution,
                aliases: input.aliases,
                confirm: input.confirm,
              },
              principal,
            ),
          ),
        );
        return ctx.result({ ok: true, ...created });
      } catch (error) {
        return ctx.fail(error);
      }
    },
  );
}
