import { createClient, toolResult, toolError } from "./client.js";

export function createReportTool(api) {
  const client = createClient(api);

  return {
    name: "planfly_report",
    label: "Consult finances",
    description:
      "Consults the finances in planfly: net position (net worth), balances per account, " +
      "spending by category, budget usage, recent entries or the month's summary. " +
      "Use it for '¿cuánto llevo gastado?', '¿cuánto tengo?', '¿en qué se me fue la plata?', " +
      "'¿cómo voy con el presupuesto?'. It returns text already worded and ready to answer with: " +
      "repeat it verbatim instead of recomputing the figures.",
    parameters: {
      type: "object",
      properties: {
        report: {
          type: "string",
          enum: [
            "month_summary",
            "net_worth",
            "balances",
            "spending_by_category",
            "budgets",
            "recent_transactions",
          ],
          description: "Defaults to month_summary.",
        },
        period: {
          type: "string",
          description:
            "today, yesterday, week, month, last_month, year, '2026-07', or a range " +
            "'2026-07-01..2026-07-15'. Defaults to the current month.",
        },
        valuation: {
          type: "string",
          enum: ["parallel", "official"],
          description:
            "Which rate to value at. Defaults to the household's preferred one (P2P). Use bcv only if the user explicitly asks for the official rate.",
        },
        limit: { type: "number", description: "For recent_transactions. Defaults to 10." },
        needs_review: {
          type: "boolean",
          description:
            "With report='recent_transactions': only what is pending review — what the bot " +
            "recorded without being sure. It is what you need in order to approve it afterwards " +
            "with planfly_amend action='approve'.",
        },
      },
    },
    async execute(_id, params) {
      try {
        const query = new URLSearchParams();
        if (params.report) query.set("report", params.report);
        if (params.period) query.set("period", params.period);
        if (params.valuation) query.set("valuation", params.valuation);
        if (params.needs_review === true) query.set("review", "1");
        if (params.limit) query.set("limit", String(params.limit));

        const result = await client.get(`/api/v1/reports?${query.toString()}`);
        return toolResult(result.summary, result);
      } catch (err) {
        return toolError(err);
      }
    },
  };
}
