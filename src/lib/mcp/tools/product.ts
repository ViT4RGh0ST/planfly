import { z } from "zod";

import { GET as productsRead } from "@/app/api/v1/products/route";
import { McpConfirmationError } from "@/lib/mcp/operation";
import { defineTool } from "@/lib/mcp/registry";
import { confirmMcpOperation, previewMcpOperation } from "@/lib/mcp/transactions";
import { mergeProductsSchema, splitProductSchema } from "@/lib/validation";

/**
 * The operations this tool stages, and the only ones it may confirm.
 *
 * A merge and a split both stage through the gate, and action='confirm' does not
 * say which. Naming both is what stops this tool committing ANOTHER tool's
 * pending operation and reporting it as a merge.
 */
const PRODUCT_OPERATIONS = ["merge_products", "split_product"] as const;

/**
 * The product catalogue behind the line items of a purchase.
 *
 * Reading is the everyday half — «what was flour going for last time?» — and the
 * other half is fixing what fuzzy matching got wrong in either direction. Both
 * of those writes are gated: merging rewrites which product every past line item
 * points at, deletes the origin row, and does not undo.
 */

const PATH = "/api/v1/products";

/**
 * Which fields belong to which action, enforced instead of ignored.
 *
 * Zod drops a field the branch does not use without a word, so `from` and
 * `into` sent with action='split' would leave a correct-looking call that
 * splits by a raw text and never touches the two products the caller named.
 */
const FIELDS: Record<string, { required: string[]; optional: string[] }> = {
  history: { required: ["product"], optional: ["rate"] },
  list: { required: [], optional: ["rate"] },
  merge: { required: ["from", "into"], optional: [] },
  split: { required: ["product", "raw_text"], optional: [] },
  confirm: { required: ["confirmation_id"], optional: [] },
};

const productInputSchema = z
  .object({
    action: z
      .enum(["history", "list", "merge", "split", "confirm"])
      .default("history")
      .describe(
        "history = one product and its curve · list = the catalogue · merge = merge two · " +
          "split = pull a line item into its own product · confirm = commit the merge or the " +
          "split the person approved.",
      ),
    product: z
      .string()
      .min(1)
      .optional()
      .describe(
        "With action='history': the name, however the user says it; a fragment is enough. " +
          "With action='split': the product the line item is pulled OUT OF.",
      ),
    raw_text: z
      .string()
      .min(1)
      .optional()
      .describe(
        "ONLY with action='split': the line item EXACTLY as it came out on the receipt, copied " +
          "letter by letter from the list action='history' returns. Do not write it from memory " +
          "and do not correct it: it is what identifies the lines that move, and a text not on " +
          "that list is rejected.",
      ),
    rate: z
      .enum(["parallel", "official"])
      .optional()
      .describe("Which rate the dollar prices are read at. Defaults to parallel."),
    from: z
      .string()
      .min(1)
      .optional()
      .describe("With action='merge': the one that DISAPPEARS inside the other."),
    into: z.string().min(1).optional().describe("With action='merge': the one that stays."),
    confirmation_id: z
      .uuid()
      .optional()
      .describe(
        "The id a merge or split preview returned. Send it with action='confirm' and nothing " +
          "else, and only after the person approved that exact preview: a merge moves the whole " +
          "price series into the other product and cannot be undone from here.",
      ),
  })
  .superRefine((input, ctx) => {
    const values = input as Record<string, unknown>;
    const given = Object.keys(values).filter(
      (key) => key !== "action" && values[key] !== undefined,
    );

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
            ? // The approval was given for the previewed products, not for the
              // ones this call happens to carry. And the confirmation itself
              // knows which operation it staged: a merge id arriving with the
              // arguments of a split would commit the merge while the caller
              // reported a split.
              "A confirmation travels alone: send confirmation_id and action='confirm', nothing else."
            : `${key} does not belong to action='${input.action}'.`,
      });
    }
  });

function productsPath(params: { product?: string; rate?: "parallel" | "official" }): string {
  const query = new URLSearchParams();
  if (params.product) query.set("product", params.product);
  if (params.rate) query.set("rate", params.rate);
  const search = query.toString();
  return search ? `${PATH}?${search}` : PATH;
}

export const productTool = defineTool({
  name: "planfly_product",
  title: "Planfly product prices",
  description:
    "Read a product's price history or the catalogue, and fix what fuzzy matching got wrong " +
    "in either direction: merge two that were left apart, or split two that were joined " +
    "without being the same. Products appear on their own when a purchase brings its " +
    "breakdown: they are not created here. Merging and splitting are gated — call action='merge' " +
    "or action='split' to obtain a preview, and send its confirmation_id back with " +
    "action='confirm' only after the person approved the products and the number of line items " +
    "it shows.",
  inputSchema: productInputSchema,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  surface: "reports",
  keywords: [
    "product", "price", "price history", "catalogue", "merge", "split", "receipt", "duplicate",
    "producto", "precio", "precios", "catalogo", "historial", "fusionar", "unir", "separar",
    "duplicado", "costaba", "compra",
  ],
  /* Both, because which one is required depends on the action. `run` decides. */
  scopes: ["reports:read", "transactions:write"],
  examples: [
    'What it was going for: {"action": "history", "product": "harina pan"}',
    'The whole catalogue: {"action": "list"}',
    'Joining two that are one: {"action": "merge", "from": "harina pan 1kg", "into": "harina pan"}',
    'Pulling one out: {"action": "split", "product": "nectar", "raw_text": "NECTAR DE PERA 1L"}',
    "merge and split answer with a confirmation_id and a preview; they change nothing yet.",
    "  Show the products and the line items it counts, wait for an explicit yes, and only then",
    '  {"action": "confirm", "confirmation_id": "<that id>"}.',
    "If the confirmation comes back preview_changed, the catalogue moved: show the new preview,",
    "  because the person approved the old figures and not these.",
  ],
  run: async (input, ctx) => {
    try {
      if (input.action === "history" || input.action === "list") {
        ctx.requireScope("reports:read");
        return ctx.result(
          await ctx.callRoute(
            productsPath({
              product: input.action === "history" ? input.product : undefined,
              rate: input.rate,
            }),
            productsRead,
          ),
        );
      }

      const principal = ctx.requireScope("transactions:write");
      /*
       * The gate has to say how many line items move and where they land, and
       * that count is the price history: this write cannot be previewed without
       * the read scope. It is asked for on the confirm too, because the gate
       * builds the preview again there to compare it.
       */
      ctx.requireScope("reports:read");

      if (input.action === "confirm") {
        if (!input.confirmation_id) {
          // Unreachable through the schema, which requires it. It is here so the
          // branch never has to assert its way into the gate.
          throw new McpConfirmationError("Confirmation was not found.", "not_found");
        }
        return ctx.result({ ok: true, result: await confirmMcpOperation(principal, input.confirmation_id, PRODUCT_OPERATIONS) });
      }

      /*
       * Parsed through v1's own schemas, never assembled by hand.
       *
       * They are the two branches of POST /api/v1/products, which runs
       * `rejectUnknownKeys`: a key the branch does not declare is a 400, and a
       * key valid in the OTHER branch is worse — `from` on a split passes the
       * whole schema and the split silently becomes something else. Parsing
       * through the route's own schema strips everything that does not belong
       * to the branch, and what is staged is what will be written.
       */
      const staged =
        input.action === "split"
          ? await previewMcpOperation(principal, "split_product", splitProductSchema.parse(input))
          : await previewMcpOperation(principal, "merge_products", mergeProductsSchema.parse(input));

      return ctx.result({
        ok: true,
        confirmation_id: staged.confirmationId,
        expires_at: staged.expiresAt,
        preview: staged.preview,
      });
    } catch (error) {
      return ctx.fail(error);
    }
  },
});
