import { z } from "zod";

import { GET as contextRoute } from "@/app/api/v1/context/route";
import { GET as reportsRoute } from "@/app/api/v1/reports/route";
import { defineTool } from "@/lib/mcp/registry";
import { confirmMcpTransaction, previewMcpTransaction } from "@/lib/mcp/transactions";
import { mcpTransactionDraftSchema } from "@/lib/validation";

/**
 * The four a finance chat reaches for constantly, and the only ones listed
 * natively in gateway mode.
 *
 * Read the context, read a figure, propose an entry, commit the one that was
 * approved. Everything else — opening an account, moving a cap, paying an
 * installment — is occasional, and occasional is what `planfly_search_tool`
 * is for.
 *
 * They lived inline in the route handler, which is why the route handler was
 * the file that grew every time a tool was added.
 */

export const contextTool = defineTool({
  name: "planfly_context",
  title: "Planfly financial context",
  description:
    "Get the authenticated household's accounts, categories, current rates and net worth.",
  inputSchema: z.object({}),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  surface: "catalog",
  keywords: ["accounts", "categories", "rates", "cuentas", "categorias", "tasas", "saldo", "context"],
  scopes: ["context:read"],
  essential: true,
  examples: [
    "No parameters. Returns accounts with balances, categories and the day's rates.",
    "  Use it BEFORE writing an account name you have not seen in this conversation.",
    "  It is also where the currencies this installation knows are listed.",
  ],
  run: async (_input, ctx) => {
    try {
      ctx.requireScope("context:read");
      return ctx.result(await ctx.callRoute("/api/v1/context", contextRoute));
    } catch (error) {
      return ctx.fail(error);
    }
  },
});

export const reportTool = defineTool({
  name: "planfly_report",
  title: "Planfly financial report",
  description:
    "Read a server-calculated financial report; do not calculate balances yourself.",
  inputSchema: z.object({
    report: z
      .enum([
        "net_worth",
        "balances",
        "spending_by_category",
        "budgets",
        "recent_transactions",
        "month_summary",
      ])
      .default("month_summary"),
    period: z.string().max(60).optional(),
    valuation: z.enum(["official", "parallel"]).optional(),
    limit: z.number().int().min(1).max(100).optional(),
    needs_review: z.boolean().optional(),
  }),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  surface: "reports",
  keywords: [
    "report", "spending", "balance", "net worth", "budget", "summary",
    "reporte", "gastos", "saldo", "patrimonio", "presupuesto", "resumen", "cuanto",
  ],
  scopes: ["reports:read"],
  essential: true,
  examples: [
    '  {"report": "month_summary"}  ← the server calculates; do not add up balances yourself',
    "period: today, yesterday, week, month, last_month, year, '2026-07', or a range '2026-07-01..2026-07-15'.",
    "  Defaults to the current month. limit only applies to recent_transactions.",
    "valuation: use official only if the person explicitly asks for the official rate.",
  ],
  run: async (input, ctx) => {
    try {
      ctx.requireScope("reports:read");
      const params = new URLSearchParams({ report: input.report });
      if (input.period) params.set("period", input.period);
      if (input.valuation) params.set("valuation", input.valuation);
      if (input.limit != null) params.set("limit", String(input.limit));
      if (input.needs_review) params.set("review", "1");
      return ctx.result(await ctx.callRoute(`/api/v1/reports?${params}`, reportsRoute));
    } catch (error) {
      return ctx.fail(error);
    }
  },
});

export const previewTransactionTool = defineTool({
  name: "planfly_preview_transaction",
  title: "Preview a Planfly transaction",
  description:
    "Validate and calculate a transaction without posting it. Return the confirmation id and call " +
    "planfly_confirm_transaction only after explicit approval. MCP itself does not perform OCR or vision.",
  inputSchema: mcpTransactionDraftSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  surface: "ledger",
  keywords: [
    "expense", "income", "transfer", "record", "spend", "buy", "receipt",
    "gasto", "ingreso", "transferencia", "compra", "pagar", "factura", "recibo", "gaste",
  ],
  scopes: ["transactions:write"],
  essential: true,
  examples: [
    "An ordinary expense:",
    '  {"kind": "expense", "amount": 12008.7, "currency": "VES", "account": "Banco Provincial", "category": "mercado", "description": "compra mercado"}',
    "The account ALWAYS goes in account. `to_account` is a transfer's destination:",
    "  on an expense planfly rejects it, because there it means nothing and the",
    "  expense would end up in another account without anyone noticing.",
    "Currency, account and category have NO default here: if the person did not say one, ask.",
    "  A guessed one writes the entry somewhere else and nothing fails.",
    "If the account or the category is not recognised, the reply says so and does NOT invent:",
    "  call planfly_context and offer the ones that genuinely exist.",
    "It posts nothing: it returns a confirmation id. Show the figures, get an explicit yes,",
    "  and only then call planfly_confirm_transaction with that id.",
  ],
  run: async (input, ctx) => {
    try {
      const draft = await previewMcpTransaction(ctx.requireScope("transactions:write"), input);
      return ctx.result({ ok: true, ...draft });
    } catch (error) {
      return ctx.fail(error);
    }
  },
});

export const confirmTransactionTool = defineTool({
  name: "planfly_confirm_transaction",
  title: "Confirm a previewed Planfly transaction",
  description:
    "Persist exactly one previously previewed transaction. Call only after the person explicitly " +
    "approved that confirmation id.",
  inputSchema: z.object({ confirmation_id: z.uuid() }),
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  surface: "ledger",
  keywords: ["confirm", "approve", "yes", "commit", "confirmar", "aprobar", "si", "dale"],
  scopes: ["transactions:write"],
  essential: true,
  examples: [
    '  {"confirmation_id": "<the id planfly_preview_transaction returned>"}',
    "One id, one entry. If it comes back expired or preview_changed, preview again and show",
    "  the new figures: the person approved the old ones, not these.",
  ],
  run: async ({ confirmation_id }, ctx) => {
    try {
      const result = await confirmMcpTransaction(
        ctx.requireScope("transactions:write"),
        confirmation_id,
      );
      return ctx.result({ ok: true, result });
    } catch (error) {
      return ctx.fail(error);
    }
  },
});
