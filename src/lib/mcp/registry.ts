import { z } from "zod";

import type { McpToolContext, ToolResult } from "@/lib/mcp/tools/context";

/**
 * The catalogue, and the one list every door reads from.
 *
 * Eleven tools, each with the paragraph of description it needs to be used
 * correctly, is roughly nine thousand characters of tool definitions sent on
 * every single conversation — before the person has said anything. And it only
 * grows: places, categories and currencies all want a tool, and each one taxes
 * every chat that will never mention them.
 *
 * So the shape is the one landifly settled on: a handful of ESSENTIALS listed
 * natively — the ones a finance chat reaches for constantly — and everything
 * else discovered on demand through three meta tools, `planfly_search_tool`,
 * `planfly_tool_schema` and `planfly_use_tool`.
 *
 * **The property that makes this safe to do at all: routing adds no privilege.**
 * `use_tool` calls the very same `run` the native door calls, with the very same
 * context built from the authenticated credential, and that `run` checks its own
 * scope. The gateway cannot reach anything the caller could not already reach by
 * name — it is fail-closed, and the checks below in `registry-guard.test.ts`
 * exist to keep it that way when the next tool is written.
 */

/** A tool as both doors need to see it: described, schema'd, and runnable. */
export type McpTool = {
  name: string;
  title: string;
  description: string;
  /**
   * Always a `ZodObject`, never the raw-shape shorthand the SDK deprecated:
   * the gateway has to parse arguments with this same schema, and a bare shape
   * is not something you can call `.parse` on.
   */
  inputSchema: z.ZodObject<z.ZodRawShape>;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint?: boolean;
  };
  /**
   * Words a person might use for this, in both languages. Ranked over, never
   * shown. `search_tool` matching only the description would miss «cuota» for
   * the financing tool, because the description is written in English.
   */
  keywords: string[];
  /**
   * Listed natively even in gateway mode. Reserve it for what a finance chat
   * does constantly: every essential is paid for by every conversation.
   */
  essential?: boolean;
  /**
   * `false` takes it off `use_tool` — a declarative opt-out for a tool that one
   * day must only ever be called by name. Nothing needs it today, and nothing
   * should need it while the rule above holds; it is here so that the day a tool
   * does, saying so is one field rather than an argument about the gateway.
   */
  gatewayRoutable?: boolean;
  /**
   * The scopes this tool may require, for `search_tool` to show. A HINT, not the
   * check: `run` is the guard, and a tool whose scope depends on its action —
   * listing budgets against setting one — lists both here and decides inside.
   */
  scopes: string[];
  /** Shown by `tool_schema`. What used to be `planfly_help`'s reason to exist. */
  examples?: string[];
  run(input: unknown, ctx: McpToolContext): Promise<ToolResult>;
};

type McpToolDefinition<S extends z.ZodObject<z.ZodRawShape>> = Omit<McpTool, "inputSchema" | "run"> & {
  inputSchema: S;
  run(input: z.infer<S>, ctx: McpToolContext): Promise<ToolResult>;
};

/**
 * Declares a tool with its input type inferred from its own schema.
 *
 * The cast is the only one in this file and it is sound in both directions,
 * which is the point of routing through a single definition: the SDK parses
 * with `inputSchema` before calling the native door, and `useTool` parses with
 * the same `inputSchema` before calling the routed one. Neither door hands
 * `run` anything that schema did not accept.
 */
export function defineTool<S extends z.ZodObject<z.ZodRawShape>>(def: McpToolDefinition<S>): McpTool {
  return { ...def, run: (input, ctx) => def.run(input as z.infer<S>, ctx) };
}

/**
 * How planfly is used, whatever tool you arrived through.
 *
 * These outlive any one tool, so they travel with the catalogue rather than
 * living in the description of whichever tool happened to be written first.
 */
export const RULES = [
  "Never create a new entry to dodge an error from another one. A ledger with a",
  "duplicate is worse than a ledger missing a datum: the duplicate goes unnoticed",
  "and the hole does not.",
  "",
  "If a tool rejects the call, read which fields it asks for and call it again with",
  "those. If it still does not accept it, say so and stop. Do not change the amount,",
  "do not duplicate and do not assume the tool is broken.",
];
