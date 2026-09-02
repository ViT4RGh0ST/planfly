import { NextRequest } from "next/server";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";

import { DELETE, GET, POST } from "@/app/api/v1/budgets/route";
import type { Principal } from "@/lib/api-token";
import type { McpToolContext } from "@/lib/mcp/tools/context";

/**
 * Spending caps: set, list, remove.
 *
 * The reading side already existed — planfly_report brings how the month is
 * going against each cap — but not the configuring side, so raising a cap forced
 * opening the web. This closes that half.
 */

const PATH = "/api/v1/budgets";

const PERIODS = ["monthly", "biweekly", "yearly", "custom"] as const;

type Action = "set" | "list" | "remove";

/**
 * The scope that matches the ACTION, not one for the whole tool.
 *
 * Listing caps is part of reading the household's context; setting or removing
 * one changes what every figure is compared against. A token holding only
 * context:read must not earn a write by entering through this tool.
 */
function requireScopeFor(ctx: McpToolContext, action: Action): Principal {
  return ctx.requireScope(action === "list" ? "context:read" : "budgets:write");
}

/**
 * Re-issues the request callRoute built, with a method and a body.
 *
 * The headers travel over untouched: the token in them is what resolves the
 * household, and the /api/v1 handlers refuse an identity sent in the body.
 */
function withBody(
  method: "POST" | "DELETE",
  body: Record<string, unknown>,
  route: (req: NextRequest) => Promise<Response>,
): (req: NextRequest) => Promise<Response> {
  return (req) => {
    const headers = new Headers(req.headers);
    headers.set("content-type", "application/json");
    return route(new NextRequest(req.url, { method, headers, body: JSON.stringify(body) }));
  };
}

export function registerBudget(server: McpServer, ctx: McpToolContext): void {
  /*
   * The route's own body goes back whole — its message, its previous amount, its
   * detail.suggestion. Only the error flag is added on top of it.
   */
  const reply = (payload: Record<string, unknown>) => ctx.result(payload, payload.ok === false);

  server.registerTool(
    "planfly_budget",
    {
      title: "Budgets",
      description:
        "Sets, changes or removes a spending cap by category. " +
        "To CONSULT how spending is going against a cap use planfly_report with " +
        "report='budgets'; this tool is for configuring them.",
      annotations: {
        readOnlyHint: false,
        /*
         * No preview/confirm gate, unlike the transaction tools, because a cap
         * moves no money and repeating the call cannot duplicate anything:
         * setting one is an upsert keyed by category, period and period start,
         * so a second call lands on the same cap instead of a second one, and
         * removing deactivates rather than deletes — the period that already
         * passed keeps the cap it was compared against.
         */
        idempotentHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
      inputSchema: {
        action: z
          .enum(["set", "list", "remove"])
          .optional()
          .describe(
            "set sets or changes the cap · list shows them · remove takes it away. Defaults to set.",
          ),
        category: z
          .string()
          .min(1)
          .optional()
          .describe(
            "In the user's own words. Do not translate it; planfly matches it. " +
              "Required to set and to remove, and never guessed: a cap on the wrong " +
              "category silently changes which spending gets compared.",
          ),
        amount: z
          .union([z.string().min(1), z.number()])
          .optional()
          .describe(
            "The cap, in the household's base currency. It goes in the base currency on " +
              "purpose: in the local one it would have to be rewritten every time the rate moves.",
          ),
        period: z
          .enum(PERIODS)
          .optional()
          .describe(
            "monthly = per month (what the server assumes when it is omitted) · " +
              "biweekly = per fortnight, which is how people are paid here · yearly = per year · " +
              "custom = a range of your own, with period_start and period_end. " +
              "On remove, omitting it removes every budget that category has.",
          ),
        period_start: z
          .string()
          .optional()
          .describe("Only with period='custom'. YYYY-MM-DD, first day included."),
        period_end: z
          .string()
          .optional()
          .describe("Only with period='custom'. YYYY-MM-DD, LAST day included."),
      },
    },
    async (args) => {
      try {
        const action: Action = args.action ?? "set";
        requireScopeFor(ctx, action);

        if (action === "list") {
          return reply(await ctx.callRoute(PATH, GET));
        }

        if (action === "remove") {
          /*
           * removeBudgetSchema declares these two keys and nothing else. An
           * amount or a range sent along would be a 400 naming a key that means
           * nothing when removing, so they do not travel.
           */
          const body: Record<string, unknown> = { category: args.category };
          if (args.period !== undefined) body.period = args.period;
          return reply(await ctx.callRoute(PATH, withBody("DELETE", body, DELETE)));
        }

        /*
         * A range outside period='custom' is the failure this codebase fears: the
         * schema accepts both keys, so it would validate, and the service would
         * derive the dates from the period and drop what was sent. Naming the
         * field that makes them meaningful beats a 201 with the datum in the bin.
         */
        if (
          args.period !== "custom" &&
          (args.period_start !== undefined || args.period_end !== undefined)
        ) {
          return ctx.result(
            {
              ok: false,
              error: "invalid_body",
              message:
                "period_start and period_end only mean something with period='custom'. " +
                "A monthly, biweekly or yearly cap derives its range from the period itself: " +
                "send period='custom' with both dates, or leave them out.",
              detail: { fields: ["period_start", "period_end"], requires: "period=custom" },
            },
            true,
          );
        }

        const body: Record<string, unknown> = { category: args.category, amount: args.amount };
        if (args.period !== undefined) body.period = args.period;
        if (args.period === "custom") {
          body.period_start = args.period_start;
          body.period_end = args.period_end;
        }

        return reply(await ctx.callRoute(PATH, withBody("POST", body, POST)));
      } catch (err) {
        return ctx.fail(err);
      }
    },
  );
}
