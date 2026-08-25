import { createClient, toolResult, toolError } from "./client.js";

/**
 * Spending caps.
 *
 * The bot already knew how to READ how the budgets were going — `planfly_report`
 * brings them — but not to touch them, so «súbeme el tope de mercado a 300»
 * forced opening the web. This closes that half.
 */
export function createBudgetTool(api) {
  const client = createClient(api);

  return {
    name: "planfly_budget",
    label: "Budgets",
    description:
      "Sets, changes or removes a spending cap by category. Use it for 'ponme 250 al mes en " +
      "mercado', 'súbelo a 300', 'quítame el de comida callejera'. " +
      "To CONSULT how spending is going against the cap use planfly_report with report='budgets'; " +
      "this tool is for configuring them.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["set", "list", "remove"],
          description: "set sets or changes the cap · list shows them · remove takes it away. Defaults to set.",
        },
        category: {
          type: "string",
          description:
            "In the user's own words: 'mercado', 'comida callejera'. Do not translate it; planfly matches it.",
        },
        amount: {
          type: "number",
          description:
            "The cap, in the household's base currency (dollars). It goes in dollars on purpose: in " +
            "bolívares it would have to be rewritten every time the rate moves.",
        },
        period: {
          type: "string",
          enum: ["monthly", "biweekly", "yearly", "custom"],
          description:
            "monthly = per month (the default) · biweekly = per fortnight, which is how people are paid here · " +
            "yearly = per year · custom = a range of your own, with period_start and period_end.",
        },
        period_start: {
          type: "string",
          description: "Only with period='custom'. YYYY-MM-DD, first day included.",
        },
        period_end: {
          type: "string",
          description: "Only with period='custom'. YYYY-MM-DD, LAST day included.",
        },
      },
    },
    async execute(_id, params) {
      try {
        const action = params.action ?? "set";

        if (action === "list") {
          const result = await client.get("/api/v1/budgets");
          return toolResult(result.summary, result);
        }

        if (action === "remove") {
          const result = await client.del("/api/v1/budgets", {
            category: params.category,
            period: params.period,
          });
          return toolResult(result.summary, result);
        }

        const body = {
          category: params.category,
          amount: params.amount,
          period: params.period,
          period_start: params.period_start,
          period_end: params.period_end,
        };
        for (const key of Object.keys(body)) {
          if (body[key] === undefined) delete body[key];
        }

        const result = await client.post("/api/v1/budgets", body);
        return toolResult(result.summary, result);
      } catch (err) {
        return toolError(err);
      }
    },
  };
}
