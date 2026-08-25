import { createClient, toolResult, toolError } from "./client.js";

/** Short cache: the agent may ask for it several times in the same conversation
 *  and the accounts and categories do not change from one minute to the next. */
const TTL_MS = 60_000;
let cache = null;

export function createContextTool(api) {
  const client = createClient(api);

  return {
    name: "planfly_context",
    label: "planfly context",
    description:
      "Returns the accounts with their balances, the category tree and today's rates. " +
      "Use it when the user asks '¿qué cuentas tengo?' or '¿qué categorías hay?', " +
      "and also when planfly_record warns that it did not recognise an account or category: " +
      "that way you can offer the ones that genuinely exist instead of inventing one.",
    parameters: { type: "object", properties: {} },
    async execute() {
      try {
        const now = Date.now();
        if (!cache || now - cache.at > TTL_MS) {
          cache = { at: now, data: await client.get("/api/v1/context") };
        }
        const data = cache.data;
        /*
         * The listing comes worded from the server.
         *
         * It used to be assembled here, which meant this adapter had to know
         * which language the household speaks — and it does not: it only has a
         * token. The whole of `data` still travels alongside, because that is
         * what lets the model answer about a particular account.
         */
        return toolResult(data.summary, data);
      } catch (err) {
        cache = null;
        return toolError(err);
      }
    },
  };
}
