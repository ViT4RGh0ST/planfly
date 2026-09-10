import { NextRequest } from "next/server";
import { z } from "zod";

import { GET, PATCH, POST } from "@/app/api/v1/places/route";
import { withInternalPrincipal } from "@/lib/api/handler";
import type { Principal } from "@/lib/api-token";
import { defineTool } from "@/lib/mcp/registry";
import type { McpToolContext } from "@/lib/mcp/tools/context";
import { confirmMcpOperation, previewMcpOperation } from "@/lib/mcp/transactions";

/**
 * Where things were bought.
 *
 * Eleven entries out of a hundred and nine carry a place, and the reason is not
 * indifference: the only door that could set one was the desktop. The question
 * the whole feature exists to answer — what does this product cost, and where —
 * has been fed by hand or not at all.
 *
 * The most conversational resource in the inventory, too: «lo compré en la
 * Farmatodo» is a sentence people say while recording an expense, and until now
 * it went into the description and stayed there.
 */

const PATH = "/api/v1/places";

const PLACE_UNPLACED = "place_unplaced";

const ACTIONS = ["list", "archived", "unplaced", "create", "update", "archive", "unarchive", "place", "confirm"] as const;

type Action = (typeof ACTIONS)[number];

const READS: readonly Action[] = ["list", "archived", "unplaced"];

/**
 * The scope that matches the ACTION.
 *
 * Reading which shops exist is part of the household's context. Naming one,
 * merging one into a brand, or relabelling forty entries is `catalog:write`:
 * what names and groups, never what a figure is. A credential with it can
 * change every answer about where the money went and cannot move a cent.
 */
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
 * `description` is the one to expect in the wrong branch: it is what
 * action='place' works from, and a model that has just read the unplaced list
 * reaches for it again on a create. Sent there it would pass
 * `rejectUnknownKeys` — the create schema has no such key, so it would be
 * refused — but `place` sent on an update would not, and the shop would be
 * renamed to the statement's text. A valid field in the wrong context is worse
 * than an invented one.
 */
const FIELDS: Record<Action, { required: string[]; optional: string[] }> = {
  list: { required: [], optional: [] },
  archived: { required: [], optional: [] },
  unplaced: { required: [], optional: [] },
  create: {
    required: ["name"],
    optional: ["tax_id", "address", "parent", "coordinates", "default_category", "aliases", "confirm"],
  },
  update: {
    required: ["place"],
    optional: [
      "name", "tax_id", "address", "parent", "coordinates", "default_category", "aliases", "confirm",
    ],
  },
  archive: { required: ["place"], optional: [] },
  unarchive: { required: ["place"], optional: [] },
  place: { required: ["place", "description"], optional: [] },
  confirm: { required: ["confirmation_id"], optional: [] },
};

const placeInputSchema = z
  .object({
    action: z
      .enum(ACTIONS)
      .describe(
        "What to do. 'unplaced' is the one worth starting from: it groups the repeated statement " +
          "text that has no place yet, so one answer settles forty entries.",
      ),
    place: z
      .string()
      .min(1)
      .max(120)
      .optional()
      .describe("Which place, by name or alias — never an id. Required for update, archive, unarchive and place."),
    name: z.string().min(1).max(120).optional().describe("The shop's name. Required with action='create'."),
    /* Whatever the receipt heads it with: RIF here, NIT or CUIT elsewhere. */
    tax_id: z
      .string()
      .max(40)
      .optional()
      .describe(
        "The fiscal id printed on the receipt. Two branches of one chain share one, and that is " +
          "allowed once confirm says it is deliberate.",
      ),
    address: z.string().max(240).optional(),
    parent: z
      .string()
      .max(120)
      .optional()
      .describe(
        "The brand this is a branch of, by name: 'Farmatodo' for 'Farmatodo C31'. " +
          "Send it empty to lift a shop out of its brand.",
      ),
    coordinates: z
      .string()
      .max(120)
      .optional()
      .describe(
        "A pair of numbers or a map link the person gave you. NEVER invent them: a made-up point " +
          "is indistinguishable from a real one afterwards.",
      ),
    default_category: z
      .string()
      .max(120)
      .optional()
      .describe("What purchases here usually are, by name. A spending category; empty clears it."),
    aliases: z
      .string()
      .max(500)
      .optional()
      .describe(
        "Comma-separated, exactly as the statement prints them: 'FARMATODO C31, PAGO FARMATODO'. " +
          "They are what makes the next import land here on its own.",
      ),
    description: z
      .string()
      .max(500)
      .optional()
      .describe(
        "ONLY with action='place': the repeated text EXACTLY as action='unplaced' returned it, " +
          "copied letter by letter. Do not retype it from memory — it is matched exactly, and a " +
          "character out places nothing.",
      ),
    confirm: z
      .boolean()
      .optional()
      .describe("Only for create and update: yes, it really is another branch sharing that fiscal id."),
    confirmation_id: z
      .string()
      .optional()
      .describe("The id a place preview returned. Send it with action='confirm' and nothing else."),
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

export const placeTool = defineTool({
  name: "planfly_place",
  title: "Where things were bought",
  description:
    "Lists, adds, corrects, retires or reinstates a place — a shop, a pharmacy, a petrol station — and puts one on " +
    "entries that never had it. Places are what make 'how much do I spend at X' and 'where is this product cheapest' " +
    "answerable at all. " +
    "Start with action='unplaced': it groups the repeated statement text with no place yet and counts what each group " +
    "is worth, so one answer settles forty entries instead of forty questions. " +
    "It lists EXPENSES only, on purpose — a salary, a withdrawal, a transfer between your own accounts or an " +
    "instalment paid to a financier does not happen at a shop, so do not ask about them. " +
    "action='place' writes a label onto every entry with exactly that description and CANNOT be undone in bulk: it " +
    "returns a confirmation_id with the name, the count and the dates, and only action='confirm' applies it. " +
    "Never send confirm on your own initiative. " +
    "Aliases are what make the next import land on its own, so add the statement's own spelling when you know it.",
  inputSchema: placeInputSchema,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  surface: "catalog",
  keywords: [
    "place", "shop", "store", "where", "bought", "merchant", "branch", "pharmacy", "supermarket",
    "sitio", "tienda", "comercio", "donde", "compre", "sucursal", "farmacia", "bodega", "abasto",
    "farmatodo", "supermercado", "local",
  ],
  scopes: ["context:read", "catalog:write"],
  examples: [
    'What has no place yet: {"action": "unplaced"}',
    'The shops there are: {"action": "list"}',
    'Adding one: {"action": "create", "name": "Farmatodo C31", "parent": "Farmatodo", "aliases": "PAGO C31 FARMATODO"}',
    'Labelling what is pending, step one:',
    '  {"action": "place", "place": "Farmatodo", "description": "<the text unplaced returned, letter by letter>"}',
    'Step two, after the person says yes:',
    '  {"action": "confirm", "confirmation_id": "<the id it returned>"} and nothing else.',
    'Retiring a shop that closed: {"action": "archive", "place": "Bodega La Esquina"}',
  ],
  run: async (input, ctx) => {
    try {
      const principal = requireScopeFor(ctx, input.action);

      if (input.action === "confirm") {
        if (!input.confirmation_id) {
          // Unreachable through the schema, which requires it. It is here so the
          // branch never has to assert its way into the gate.
          return ctx.result({ ok: false, error: "not_found" }, true);
        }
        return ctx.result({
          ok: true,
          result: await confirmMcpOperation(principal, input.confirmation_id, PLACE_UNPLACED),
        });
      }

      if (input.action === "place") {
        const preview = await previewMcpOperation(principal, PLACE_UNPLACED, {
          place: input.place,
          description: input.description,
        });
        return ctx.result({
          ok: true,
          confirmation_id: preview.confirmationId,
          expires_at: preview.expiresAt,
          preview: preview.preview,
        });
      }

      if (READS.includes(input.action)) {
        const view = input.action === "list" ? "" : `?view=${input.action}`;
        return ctx.result(
          await ctx.callRoute(`${PATH}${view}`, (req) => GET(withInternalPrincipal(req, principal))),
        );
      }

      if (input.action === "create") {
        const body = {
          name: input.name,
          tax_id: input.tax_id,
          address: input.address,
          parent: input.parent,
          coordinates: input.coordinates,
          default_category: input.default_category,
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
       * `patchPlaceSchema` is a partial of the create one, so it would accept a
       * `name` on an archive and quietly do nothing with it — the branch returns
       * before the update is built. A key that is accepted and ignored is the
       * one that lands in the bin.
       */
      const body =
        input.action === "update"
          ? {
              place: input.place,
              action: "update",
              name: input.name,
              tax_id: input.tax_id,
              address: input.address,
              parent: input.parent,
              coordinates: input.coordinates,
              default_category: input.default_category,
              aliases: input.aliases,
              confirm: input.confirm,
            }
          : { place: input.place, action: input.action };

      return ctx.result(
        await ctx.callRoute(PATH, (req) => PATCH(withBody(req, "PATCH", body, principal))),
      );
    } catch (error) {
      return ctx.fail(error);
    }
  },
});
