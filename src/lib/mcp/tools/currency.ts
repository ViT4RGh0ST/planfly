import { NextRequest } from "next/server";
import { z } from "zod";

import { DELETE, GET, PATCH, POST } from "@/app/api/v1/currencies/route";
import { withInternalPrincipal } from "@/lib/api/handler";
import type { Principal } from "@/lib/api-token";
import { defineTool } from "@/lib/mcp/registry";
import type { McpToolContext } from "@/lib/mcp/tools/context";

/**
 * The currencies this installation knows.
 *
 * It is the root of the dependency: `planfly_account` refuses a currency this
 * planfly does not have, and until now there was no way to add one from a chat
 * — the person with an account in soles or in reais had to open the web, or
 * wait for a release. It goes first among the resources for that reason.
 *
 * **A currency belongs to the installation, not to a household.** The table has
 * no household column, so this is the one tool here whose writes are seen by
 * everyone on the same planfly. The description says so, because a model that
 * believes it is editing «their» currencies would rename one without asking.
 */

const PATH = "/api/v1/currencies";

const ACTIONS = ["list", "create", "update", "remove"] as const;

type Action = (typeof ACTIONS)[number];

/**
 * The scope that matches the ACTION.
 *
 * Listing is part of reading what the household can use. Creating, renaming or
 * removing is reference data for the whole installation, which is a different
 * thing to hand over and has its own scope.
 */
function requireScopeFor(ctx: McpToolContext, action: Action): Principal {
  return ctx.requireScope(action === "list" ? "context:read" : "rates:write");
}

function withBody(
  req: NextRequest,
  method: "POST" | "PATCH" | "DELETE",
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

/**
 * Which fields belong to which action, enforced instead of ignored.
 *
 * The same rule the financing and product tools run on: a key that is valid in
 * another branch passes `rejectUnknownKeys` and lands in the bin, which is the
 * failure that cost twelve purchases in the wrong account. `name` sent with
 * action='remove' is the one to expect here — the model reaches for the field
 * it used a moment ago.
 */
const FIELDS: Record<Action, { required: string[]; optional: string[] }> = {
  list: { required: [], optional: [] },
  create: { required: ["code", "name"], optional: ["symbol", "has_official", "is_crypto"] },
  update: { required: ["code"], optional: ["name", "has_official"] },
  remove: { required: ["code"], optional: [] },
};

const currencyInputSchema = z
  .object({
    action: z.enum(ACTIONS).describe("What to do. Start with 'list': it says what is already there."),
    code: z
      .string()
      .min(2)
      .max(6)
      .optional()
      .describe("The ISO code, uppercase: PEN, COP, BRL. Required for create, update and remove."),
    name: z
      .string()
      .max(60)
      .optional()
      .describe("What it is called: 'Sol peruano'. Required with action='create'."),
    symbol: z
      .string()
      .max(8)
      .optional()
      .describe(
        "Only accepted if it is the symbol the formatter will actually print, which for a new " +
          "currency is its own code. Sending another one answers symbol_fixed naming the one that " +
          "will be used — that is the server being precise, not your call being wrong. Omit it.",
      ),
    has_official: z
      .boolean()
      .optional()
      .describe("Whether a central bank publishes an official rate for it. Most currencies: no."),
    is_crypto: z
      .boolean()
      .optional()
      .describe("A stablecoin pegged to the base does not go out of date; everything else does."),
  })
  .superRefine((input, ctx) => {
    const spec = FIELDS[input.action];
    for (const key of spec.required) {
      if (input[key as keyof typeof input] == null) {
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: `action='${input.action}' needs ${key}.`,
        });
      }
    }
    for (const key of Object.keys(input)) {
      if (key === "action") continue;
      if (input[key as keyof typeof input] == null) continue;
      if (spec.required.includes(key) || spec.optional.includes(key)) continue;
      ctx.addIssue({
        code: "custom",
        path: [key],
        message: `${key} does not belong to action='${input.action}'. It takes: ${[...spec.required, ...spec.optional].join(", ") || "nothing else"}.`,
      });
    }
  });

export const currencyTool = defineTool({
  name: "planfly_currency",
  title: "Currencies this Planfly knows",
  description:
    "Lists, adds, renames or removes a currency. Use it when someone wants an account in a currency planfly does not " +
    "yet know — planfly_account refuses an unknown one, and this is how it becomes known. " +
    "These are shared by EVERYONE on this installation, not by one household: say what you are about to rename or " +
    "remove before doing it. " +
    "The decimals are never asked for and cannot be set: a new currency gets two, which is right for almost all of them; " +
    "the few written whole, like the yen, need a code change. " +
    "Removing only works while no account is held in it, in any household — the refusal says how many there are.",
  inputSchema: currencyInputSchema,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  surface: "rates",
  keywords: [
    "currency", "currencies", "code", "symbol", "add currency", "iso",
    "moneda", "monedas", "divisa", "codigo", "simbolo", "sol", "peso", "real", "euro",
  ],
  scopes: ["context:read", "rates:write"],
  examples: [
    'Seeing them: {"action": "list"}',
    'Adding one: {"action": "create", "code": "PEN", "name": "Sol peruano"}',
    'One with an official rate: {"action": "create", "code": "ARS", "name": "Peso argentino", "has_official": true}',
    'Correcting the name: {"action": "update", "code": "PEN", "name": "Sol"}',
    'Taking it out: {"action": "remove", "code": "PEN"}',
  ],
  run: async (input, ctx) => {
    try {
      const principal = requireScopeFor(ctx, input.action);

      if (input.action === "list") {
        return ctx.result(await ctx.callRoute(PATH, GET));
      }

      if (input.action === "remove") {
        return ctx.result(
          await ctx.callRoute(PATH, (req) =>
            DELETE(withBody(req, "DELETE", { code: input.code }, principal)),
          ),
        );
      }

      if (input.action === "update") {
        const body = { code: input.code, name: input.name, has_official: input.has_official };
        return ctx.result(
          await ctx.callRoute(PATH, (req) => PATCH(withBody(req, "PATCH", body, principal))),
        );
      }

      const body = {
        code: input.code,
        name: input.name,
        symbol: input.symbol,
        has_official: input.has_official,
        is_crypto: input.is_crypto,
      };
      return ctx.result(
        await ctx.callRoute(PATH, (req) => POST(withBody(req, "POST", body, principal))),
      );
    } catch (error) {
      return ctx.fail(error);
    }
  },
});
