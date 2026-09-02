import { z } from "zod";

import { essentials, resolve, search } from "@/lib/mcp/catalog";
import { defineTool, RULES, type McpTool } from "@/lib/mcp/registry";
import type { McpToolContext, ToolResult } from "@/lib/mcp/tools/context";

/**
 * Discovery, schema, use — the three doors that stand in for the rest.
 *
 * The catalogue behind them costs nothing until it is asked for: a chat about
 * this month's spending never pays for the paragraph explaining how a prepaid
 * card differs from a credit one. And a tool added next month costs nothing
 * either, which is the part that decides how many tools this server can have.
 *
 * **They add no privilege, and that is the property to protect.**
 *
 * `use_tool` calls the same `run` the native door calls, with the same context
 * built from the same authenticated credential — the `name` argument selects a
 * tool, never an identity — and that `run` performs its own `requireScope`. A
 * credential that cannot open an account by name cannot open one through here
 * either; it gets that tool's own refusal, naming the scope it lacks.
 *
 * So the gateway is fail-closed, and `registry-guard.test.ts` is what keeps it
 * that way when the next tool is written.
 */

/** The doors themselves, which are not things to route to. */
const META = new Set(["planfly_search_tool", "planfly_tool_schema", "planfly_use_tool"]);

/**
 * One answer for «that tool does not exist» and for «that tool is not routable».
 *
 * Two different answers would let a caller sort names into real and not-real by
 * reading the refusals — an existence oracle built out of error messages. There
 * is nothing secret in the catalogue, `planfly_search_tool` hands out the whole
 * thing; the habit is worth keeping anyway, because the day a tool opts out of
 * the gateway the refusal must not become the way to learn it is there.
 */
function unknownTool(ctx: McpToolContext, name: string): ToolResult {
  return ctx.result(
    {
      ok: false,
      error: "unknown_tool",
      message: `Unknown tool '${name}'. Call planfly_search_tool to discover the tools there are.`,
    },
    true,
  );
}

/**
 * The JSON Schema a client would have been sent had the tool been listed.
 *
 * It is derived from the tool's own zod schema rather than written beside it: a
 * hand-kept copy falls out of step on the first parameter added, and then it
 * describes a call the server will reject.
 */
function inputSchemaJson(tool: McpTool): Record<string, unknown> | null {
  try {
    return z.toJSONSchema(tool.inputSchema, { io: "input" }) as Record<string, unknown>;
  } catch {
    // Better to say nothing than to publish a shape the tool does not accept.
    return null;
  }
}

export const searchToolTool = defineTool({
  name: "planfly_search_tool",
  title: "Find a planfly tool",
  description:
    "Discover planfly tools by intent. Returns ranked summaries — name, what it does, whether it writes. " +
    "Then call planfly_tool_schema for one tool's parameters, and planfly_use_tool to run it. " +
    "Use it whenever the person asks for something the listed tools do not obviously cover: " +
    "opening or correcting an account, spending caps, installments, recurring entries, products. " +
    "Reads nothing financial.",
  inputSchema: z.object({
    query: z
      .string()
      .max(200)
      .optional()
      .describe(
        "What you are trying to do, in the person's own words: 'abrir una cuenta', 'pagar una cuota', " +
          "'spending cap'. Both languages match. Omit it to see the whole catalogue.",
      ),
    limit: z.number().int().min(1).max(20).optional().describe("Max results. Defaults to 8."),
    offset: z.number().int().min(0).optional().describe("For paging, from a previous next_offset."),
  }),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  keywords: ["search", "find", "discover", "which tool", "buscar", "herramienta"],
  /*
   * No scope: it reads the catalogue, not the household. Which is also why the
   * catalogue is not a secret — a tool being unlisted saves tokens, it does not
   * hide anything, and calling one still costs its own scope.
   */
  scopes: [],
  run: async (input, ctx) => {
    try {
      return ctx.result({
        ok: true,
        ...search(input.query, input.limit ?? 8, input.offset ?? 0),
        how_to_run: "planfly_tool_schema for the parameters, then planfly_use_tool with { name, arguments }.",
        rules: RULES,
      });
    } catch (error) {
      return ctx.fail(error);
    }
  },
});

export const toolSchemaTool = defineTool({
  name: "planfly_tool_schema",
  title: "Read a planfly tool's parameters",
  description:
    "Get one tool's full description, input schema and examples, by the name planfly_search_tool gave you, " +
    "so you can build a valid planfly_use_tool call. Reads nothing financial.",
  inputSchema: z.object({
    name: z.string().max(100).describe("The tool name, exactly as planfly_search_tool returned it."),
  }),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  keywords: ["schema", "parameters", "arguments", "how", "esquema", "parametros", "como"],
  scopes: [],
  run: async ({ name }, ctx) => {
    try {
      const tool = resolve(name);
      if (!tool || META.has(name)) return unknownTool(ctx, name);

      return ctx.result({
        ok: true,
        tool: {
          name: tool.name,
          title: tool.title,
          description: tool.description,
          input_schema: inputSchemaJson(tool),
          annotations: tool.annotations,
          scopes: tool.scopes,
          ...(tool.examples ? { examples: tool.examples } : {}),
        },
        how_to_run: `planfly_use_tool with { "name": "${tool.name}", "arguments": { ... } }.`,
        rules: RULES,
      });
    } catch (error) {
      return ctx.fail(error);
    }
  },
});

export const useToolTool = defineTool({
  name: "planfly_use_tool",
  title: "Run a planfly tool",
  description:
    "Run any planfly tool by name with its arguments — discover names with planfly_search_tool, " +
    "parameters with planfly_tool_schema. The tool behaves exactly as if it had been called directly: " +
    "the same validation, the same permission check, the same preview-and-confirm where there is one. " +
    "A tool that moves money still previews first and still needs the person's explicit yes.",
  inputSchema: z.object({
    name: z.string().max(100).describe("The tool to run, from planfly_search_tool."),
    arguments: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("That tool's own arguments object, as planfly_tool_schema describes it."),
  }),
  /*
   * The honest annotations for a multiplexer: it can route to a tool that
   * writes, so it is neither read-only nor idempotent. A client that refuses
   * destructive calls should refuse this one, because what is behind it may be.
   */
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  keywords: ["run", "call", "execute", "use", "ejecutar", "llamar", "usar"],
  scopes: [],
  run: async (input, ctx) => {
    try {
      /*
       * Anti-recursion first, and with the same refusal as an unknown name: a
       * door that routes to itself is a loop an agent finds within a few turns.
       */
      if (META.has(input.name)) return unknownTool(ctx, input.name);

      const tool = resolve(input.name);
      if (!tool) return unknownTool(ctx, input.name);

      /*
       * Parsed by the INNER tool's own schema, which is the line that keeps the
       * two doors equal.
       *
       * The SDK parses arguments against `inputSchema` before calling a natively
       * listed tool. Handing `arguments` through unparsed would make this door
       * the lax one: a `run` written to trust its input — every one of them is —
       * would receive a string where it expected an amount, or a key it never
       * declared. A route that accepts what the front door rejects is how a
       * datum ends up in the bin with a 200 on top of it.
       *
       * And only `arguments` crosses. `name` is this tool's parameter, never the
       * inner tool's, so it cannot arrive as a field the inner schema has to
       * think about.
       */
      const parsed = tool.inputSchema.safeParse(input.arguments ?? {});
      if (!parsed.success) {
        return ctx.result(
          {
            ok: false,
            error: "invalid_arguments",
            message:
              `Invalid arguments for '${tool.name}'. Call planfly_tool_schema with that name ` +
              "to see what it takes.",
            detail: z.treeifyError(parsed.error),
          },
          true,
        );
      }

      /*
       * The same `run`, the same context, the same scope check. `ctx` was built
       * from the authenticated credential before any of this was read, so the
       * `name` above chose a tool and nothing else.
       */
      return await tool.run(parsed.data, ctx);
    } catch (error) {
      return ctx.fail(error);
    }
  },
});

/** The doors, in the order a model meets them. */
export const GATEWAY: readonly McpTool[] = [searchToolTool, toolSchemaTool, useToolTool];

/**
 * What this server lists, by mode.
 *
 * `gateway` is the default and the reason this exists. `native` lists everything
 * and is the way back if a client copes badly with the indirection; `both` is
 * for watching one against the other while migrating.
 */
export function listedTools(mode: "native" | "gateway" | "both", all: readonly McpTool[]): McpTool[] {
  if (mode === "native") return [...all];
  if (mode === "both") return [...all, ...GATEWAY];
  return [...essentials(), ...GATEWAY];
}
