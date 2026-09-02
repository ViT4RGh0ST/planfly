import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { McpToolContext } from "@/lib/mcp/tools/context";

const NAME = "planfly_help";

const toolOutputSchema = z.object({ ok: z.boolean() }).passthrough();

const helpInputSchema = z.object({
  tool: z.string().max(100).optional().describe("Exact name of a tool, to see its parameters and examples."),
});

type JsonSchema = Record<string, unknown>;

/**
 * One entry of the catalogue, in the shape `tools/list` publishes it.
 *
 * The same shape serves both sources — the server's own registry and a list the
 * caller passes in — so there is a single renderer and no chance of the two
 * paths describing a tool differently.
 */
type ToolEntry = {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: JsonSchema;
  annotations?: Record<string, unknown>;
};

/**
 * Examples keyed by tool name, never a list of tools.
 *
 * A key that no longer matches a registered tool simply never attaches, so a
 * removed or renamed tool cannot keep appearing in the catalogue: what gets
 * listed always comes from the registry.
 */
const EXAMPLES: Record<string, string[]> = {
  planfly_context: [
    "No parameters. Returns accounts with balances, categories and the day's rates.",
    "  Use it BEFORE writing an account name you have not seen in this conversation.",
  ],
  planfly_report: [
    '  {"report": "month_summary"}  ← the server calculates; do not add up balances yourself',
    "period: today, yesterday, week, month, last_month, year, '2026-07', or a range '2026-07-01..2026-07-15'.",
    "  Defaults to the current month. limit only applies to recent_transactions.",
    "valuation: use bcv only if the person explicitly asks for the official rate.",
  ],
  planfly_preview_transaction: [
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
  planfly_confirm_transaction: [
    '  {"confirmation_id": "<the id planfly_preview_transaction returned>"}',
    "One id, one entry. If it comes back expired or preview_changed, preview again and show",
    "  the new figures: the person approved the old ones, not these.",
  ],
};

const RULES = [
  "Never create a new entry to dodge an error from another one. A ledger with a",
  "duplicate is worse than a ledger missing a datum: the duplicate goes unnoticed",
  "and the hole does not.",
  "",
  "If a tool rejects the call, read which fields it asks for and call it again with",
  "those. If it still does not accept it, say so and stop. Do not change the amount,",
  "do not duplicate and do not assume the tool is broken.",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The JSON Schema `tools/list` would emit for one tool, or nothing if this SDK build cannot say. */
function inputSchemaOf(server: McpServer, name: string): JsonSchema | undefined {
  const read = (server as { toolInputSchemaJson?: (tool: string) => JsonSchema | undefined }).toolInputSchemaJson;
  if (typeof read !== "function") return undefined;
  try {
    return read.call(server, name);
  } catch {
    return undefined;
  }
}

/**
 * The server's own tool table, or null when this SDK build does not expose one.
 *
 * It is reached through a field the SDK marks private, so every step is checked
 * at runtime: the one tool a stuck model calls after everything else failed has
 * to degrade to the caller's list, not throw.
 */
function readRegistry(server: McpServer): ToolEntry[] | null {
  const registry = (server as unknown as { _registeredTools?: unknown })._registeredTools;
  if (!isRecord(registry)) return null;

  const entries: ToolEntry[] = [];
  for (const [name, value] of Object.entries(registry)) {
    const tool = isRecord(value) ? value : {};
    // A disabled tool cannot be called: listing it only invites a call that fails.
    if (tool.enabled === false) continue;
    entries.push({
      name,
      title: typeof tool.title === "string" ? tool.title : undefined,
      description: typeof tool.description === "string" ? tool.description : undefined,
      annotations: isRecord(tool.annotations) ? tool.annotations : undefined,
      inputSchema: inputSchemaOf(server, name),
    });
  }
  return entries;
}

function parametersOf(schema: JsonSchema | undefined): Record<string, unknown>[] {
  const properties = isRecord(schema?.properties) ? schema.properties : {};
  const required = new Set(
    Array.isArray(schema?.required) ? schema.required.filter((key): key is string => typeof key === "string") : [],
  );

  return Object.entries(properties).map(([name, raw]) => {
    const field = isRecord(raw) ? raw : {};
    return {
      name,
      type: typeof field.type === "string" ? field.type : "any",
      required: required.has(name),
      ...(Array.isArray(field.enum) ? { values: field.enum } : {}),
      ...(typeof field.description === "string" ? { description: field.description } : {}),
    };
  });
}

function describe(entry: ToolEntry): Record<string, unknown> {
  return {
    name: entry.name,
    ...(entry.title ? { title: entry.title } : {}),
    ...(entry.description ? { description: entry.description } : {}),
    parameters: parametersOf(entry.inputSchema),
    ...(entry.annotations ? { annotations: entry.annotations } : {}),
    ...(EXAMPLES[entry.name] ? { examples: EXAMPLES[entry.name] } : {}),
  };
}

function summarize(entry: ToolEntry): Record<string, unknown> {
  const text = entry.description ?? "";
  const stop = text.indexOf(". ");
  return {
    name: entry.name,
    ...(entry.title ? { title: entry.title } : {}),
    summary: stop === -1 ? text : text.slice(0, stop + 1),
  };
}

/**
 * The catalogue and schemas of this server, so an agent that does not know it
 * can find its bearings without guessing a tool name.
 *
 * `catalogue` is the fallback for an SDK that keeps its registry to itself: the
 * caller then passes what it registered. It is never a second source of truth —
 * while the registry answers, the registry wins, because a hand-written list
 * falls out of sync on the first tool added and then it lies, which is worse
 * than not existing.
 */
export function registerHelp(server: McpServer, ctx: McpToolContext, catalogue: readonly ToolEntry[] = []): void {
  server.registerTool(
    NAME,
    {
      title: "How planfly is used",
      description:
        "Explains which planfly tools exist, which parameters each one accepts and how they " +
        "combine, with examples. Use it when a call of yours is rejected and you do not understand " +
        "why, or when you do not know which tool matches what you are being asked. " +
        "With no parameters it lists them all; with tool='planfly_preview_transaction' it details that one.",
      inputSchema: helpInputSchema,
      outputSchema: toolOutputSchema,
      // It reads no financial data and writes nothing: no scope to check, nothing to confirm.
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async ({ tool }) => {
      try {
        const registered = readRegistry(server)?.filter((entry) => entry.name !== NAME);
        const tools = registered?.length ? registered : catalogue.filter((entry) => entry.name !== NAME);

        if (tools.length === 0) {
          // Saying that nothing is known beats returning an empty list, which reads
          // as "this server has no tools" and sends the model off to improvise.
          return ctx.result(
            {
              ok: false,
              error: "catalogue_unavailable",
              message:
                "Planfly cannot list its own tools right now. Read the tool definitions your client already received.",
            },
            true,
          );
        }

        if (tool) {
          const found = tools.find((entry) => entry.name === tool);
          if (!found) {
            return ctx.result(
              {
                ok: false,
                error: "unknown_tool",
                message: `${tool} does not exist. The ones there are: ${tools.map((entry) => entry.name).join(", ")}.`,
                available: tools.map((entry) => entry.name),
              },
              true,
            );
          }
          return ctx.result({ ok: true, tool: describe(found), rules: RULES });
        }

        return ctx.result({
          ok: true,
          tools: tools.map(summarize),
          detail: `Ask ${NAME} with tool='<name>' to see one tool's parameters and examples.`,
          rules: RULES,
        });
      } catch (error) {
        return ctx.fail(error);
      }
    },
  );
}
