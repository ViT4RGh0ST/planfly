import { NextRequest } from "next/server";
import { z } from "zod";

import { GET, PATCH, POST } from "@/app/api/v1/categories/route";
import { withInternalPrincipal } from "@/lib/api/handler";
import type { Principal } from "@/lib/api-token";
import { defineTool } from "@/lib/mcp/registry";
import type { McpToolContext } from "@/lib/mcp/tools/context";

/**
 * The categories, from the chat.
 *
 * It has been matching them since the first entry it recorded and has never
 * been able to add one: an expense that belongs nowhere lands in the review tray
 * or in whatever happened to resemble it, and the person is told to open the
 * web. `planfly_context` lists them flat, which is enough to spend against and
 * not enough to organise.
 */

const PATH = "/api/v1/categories";

const ACTIONS = ["list", "archived", "create", "update", "archive", "unarchive"] as const;

type Action = (typeof ACTIONS)[number];

const READS: readonly Action[] = ["list", "archived"];

function requireScopeFor(ctx: McpToolContext, action: Action): Principal {
  return ctx.requireScope(READS.includes(action) ? "context:read" : "catalog:write");
}

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

/**
 * Which fields belong to which action, enforced instead of ignored.
 *
 * `category` and `name` are the pair to watch. On a create the new name goes in
 * `name`; on an update `category` says which one and `name` is the new name.
 * A model that sends `category` on a create is naming a category it means to
 * make — and the create schema has no such key, so it is refused. `name` sent
 * on an archive would not be: the branch returns before the patch is built, and
 * a key that is accepted and ignored is the one that lands in the bin.
 */
const FIELDS: Record<Action, { required: string[]; optional: string[] }> = {
  list: { required: [], optional: [] },
  archived: { required: [], optional: [] },
  create: { required: ["name", "kind"], optional: ["parent", "aliases", "confirm"] },
  update: { required: ["category"], optional: ["name", "kind", "parent", "aliases"] },
  archive: { required: ["category"], optional: [] },
  unarchive: { required: ["category"], optional: [] },
};

const categoryInputSchema = z
  .object({
    action: z.enum(ACTIONS).describe("What to do. 'list' first: it is how you avoid making a second «Salud»."),
    category: z
      .string()
      .min(1)
      .max(80)
      .optional()
      .describe("Which one, by name or alias. Required for update, archive and unarchive."),
    name: z
      .string()
      .min(1)
      .max(80)
      .optional()
      .describe("The name. Required with action='create'; with action='update' it is the NEW name."),
    kind: z
      .enum(["expense", "income"])
      .optional()
      .describe(
        "Spending or earning. Required with action='create' — it is what keeps a salary off a " +
          "spending report — and changing it later is refused once entries carry the category.",
      ),
    parent: z
      .string()
      .max(80)
      .optional()
      .describe(
        "The category this hangs under, by name, and always of the same kind: 'Salud' for " +
          "'Medicinas'. Send it empty to lift one back to the top level.",
      ),
    aliases: z
      .string()
      .max(500)
      .optional()
      .describe(
        "Comma-separated: what the person actually says when recording — 'super, supermercado' " +
          "for 'Mercado'. They are what makes the next expense land here on its own.",
      ),
    confirm: z
      .boolean()
      .optional()
      .describe(
        "Only after a 409: yes, make it anyway even though it resembles one that exists. " +
          "Never send it on your own initiative — ask the person first.",
      ),
  })
  .superRefine((input, ctx) => {
    const spec = FIELDS[input.action];
    for (const key of spec.required) {
      if (input[key as keyof typeof input] == null) {
        ctx.addIssue({ code: "custom", path: [key], message: `action='${input.action}' needs ${key}.` });
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

export const categoryTool = defineTool({
  name: "planfly_category",
  title: "Spending and earning categories",
  description:
    "Lists, adds, renames, retires or reinstates a category, and hangs one under another. " +
    "Use it ONLY when the person explicitly asks for a new category or to fix one — if an expense mentions a " +
    "category you do not recognise, do NOT create it: ask. " +
    "Call action='list' first. Creating 'Medicinas' when 'Salud' exists splits the history in two: different names, " +
    "no index sees them clash, and from then on half the spending is in each — both totals false, every budget on " +
    "either measuring a fraction, and nothing failing anywhere. " +
    "Creating answers 409 category_may_exist naming what it found, and the same call plus confirm:true then succeeds. " +
    "Surface that 409 as a question for the person; never resend confirm on your own initiative. " +
    "Aliases are worth more than a tidy name: they are what makes the next expense land here without being asked. " +
    "There is no deleting — a category with history is retired, not removed, because the entries still point at it.",
  inputSchema: categoryInputSchema,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  surface: "catalog",
  keywords: [
    "category", "categories", "kind", "expense", "income", "rename", "group", "subcategory",
    "categoria", "categorias", "gasto", "ingreso", "renombrar", "agrupar", "subcategoria", "rubro",
  ],
  scopes: ["context:read", "catalog:write"],
  examples: [
    'What there is: {"action": "list"}',
    'Adding one: {"action": "create", "name": "Medicinas", "kind": "expense", "parent": "Salud", "aliases": "farmacia, pastillas"}',
    'Renaming: {"action": "update", "category": "Mercado", "name": "Supermercado"}',
    'Lifting it out of its parent: {"action": "update", "category": "Medicinas", "parent": ""}',
    'Retiring one that is no longer used: {"action": "archive", "category": "Mudanza"}',
  ],
  run: async (input, ctx) => {
    try {
      const principal = requireScopeFor(ctx, input.action);

      if (READS.includes(input.action)) {
        const view = input.action === "list" ? "" : `?view=${input.action}`;
        return ctx.result(
          await ctx.callRoute(`${PATH}${view}`, (req) => GET(withInternalPrincipal(req, principal))),
        );
      }

      if (input.action === "create") {
        const body = {
          name: input.name,
          kind: input.kind,
          parent: input.parent,
          aliases: input.aliases,
          confirm: input.confirm,
        };
        return ctx.result(
          await ctx.callRoute(PATH, (req) => POST(withBody(req, "POST", body, principal))),
        );
      }

      /*
       * Archive and unarchive send only what their branch takes.
       *
       * The patch schema is a partial of the create one, so it would accept a
       * `name` on an archive and quietly do nothing with it: the branch returns
       * before the update is built.
       */
      const body =
        input.action === "update"
          ? {
              category: input.category,
              action: "update",
              name: input.name,
              kind: input.kind,
              parent: input.parent,
              aliases: input.aliases,
            }
          : { category: input.category, action: input.action };

      return ctx.result(
        await ctx.callRoute(PATH, (req) => PATCH(withBody(req, "PATCH", body, principal))),
      );
    } catch (error) {
      return ctx.fail(error);
    }
  },
});
