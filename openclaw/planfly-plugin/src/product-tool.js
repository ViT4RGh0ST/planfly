import { createClient, toolResult, toolError } from "./client.js";

/**
 * Price history.
 *
 * It was the only thing from the web with no presence in the bot at all, and
 * «¿a cómo estaba la harina la última vez?» is exactly the kind of question
 * asked over chat rather than by opening a screen.
 *
 * It goes in dollars on purpose: a bolívar curve always rises and does not tell
 * «this got dearer» from «the rate moved», which call for opposite decisions.
 */
export function createProductTool(api) {
  const client = createClient(api);

  return {
    name: "planfly_product",
    label: "Products",
    description:
      "Consults a product's price history, lists the catalogue, and fixes the matching in both " +
      "directions: merges two that were left apart, or splits two that were joined without being " +
      "the same. Use it for '¿a cómo estaba la harina?', '¿qué se me ha encarecido?', " +
      "'HARINA PAN 1KG y Harina Pan son lo mismo', 'el néctar de pera no es el de manzana'. " +
      "Products appear on their own when a purchase brings its breakdown: they are not created here.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["history", "list", "merge", "split"],
          description:
            "history = one product and its curve · list = the catalogue · merge = merge two · " +
            "split = pull a line item into its own product.",
        },
        product: {
          type: "string",
          description:
            "With action='history': the name, however the user says it. 'harina' is enough. " +
            "With action='split': the product the line item is pulled OUT OF.",
        },
        raw_text: {
          type: "string",
          description:
            "ONLY with action='split': the line item EXACTLY as it came out on the receipt, copied " +
            "letter by letter from the list action='history' returns. Do not write it from memory " +
            "and do not correct it: it is what identifies the lines that move, and a text not on " +
            "that list is rejected.",
        },
        rate: {
          type: "string",
          enum: ["p2p", "bcv"],
          description: "Which rate the dollar prices are read at. Defaults to p2p.",
        },
        from: {
          type: "string",
          description: "With action='merge': the one that DISAPPEARS inside the other.",
        },
        into: { type: "string", description: "With action='merge': the one that stays." },
      },
    },
    async execute(_id, params) {
      try {
        const action = params.action ?? "history";
        const rate = params.rate === "bcv" ? "bcv" : "p2p";

        if (action === "split") {
          const result = await client.post("/api/v1/products", {
            product: params.product,
            raw_text: params.raw_text,
          });
          return toolResult(result.summary, result);
        }

        if (action === "merge") {
          const result = await client.post("/api/v1/products", {
            from: params.from,
            into: params.into,
          });
          return toolResult(result.summary, result);
        }

        if (action === "list") {
          const result = await client.get(`/api/v1/products?rate=${rate}`);
          return toolResult(result.summary, result);
        }

        /*
         * The detail comes worded from the server, line items included.
         *
         * The model cannot split what it has not seen: `raw_text` has to be the
         * receipt's literal line, and without them in front of it, it invents
         * one and the call is rejected.
         */
        const result = await client.get(
          `/api/v1/products?product=${encodeURIComponent(params.product ?? "")}&rate=${rate}`,
        );
        return toolResult(result.summary, result);
      } catch (err) {
        return toolError(err);
      }
    },
  };
}
