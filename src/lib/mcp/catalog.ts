import type { McpTool } from "@/lib/mcp/registry";
import { accountTool } from "@/lib/mcp/tools/account";
import { budgetTool } from "@/lib/mcp/tools/budget";
import {
  confirmTransactionTool,
  contextTool,
  previewTransactionTool,
  reportTool,
} from "@/lib/mcp/tools/core";

/**
 * Every tool planfly has, listed once.
 *
 * `use_tool` routes over this whole list — a tool is reachable by name whether
 * or not the server listed it — and `search_tool` ranks over it. The gateway
 * tools themselves are NOT here: they are the doors, not what is behind them,
 * and a door that could route to itself is a recursion an agent will find.
 */
export const NATIVE: readonly McpTool[] = [
  contextTool,
  reportTool,
  previewTransactionTool,
  confirmTransactionTool,
  accountTool,
  budgetTool,
];

/** The always-on ones, listed natively even in gateway mode. */
export function essentials(): McpTool[] {
  return NATIVE.filter((tool) => tool.essential === true);
}

/**
 * A routable tool by name, or nothing.
 *
 * Returns nothing for a tool that opted out of the gateway, which is the same
 * answer as for a name that does not exist — deliberately. Distinguishing the
 * two would tell a caller that a tool it may not route to is nonetheless there.
 */
export function resolve(name: string): McpTool | undefined {
  const tool = NATIVE.find((candidate) => candidate.name === name);
  return tool && tool.gatewayRoutable !== false ? tool : undefined;
}

export type ToolSummary = {
  name: string;
  title: string;
  summary: string;
  scopes: string[];
  writes: boolean;
  has_input: boolean;
};

/**
 * Ranked search over the catalogue, returning summaries and never schemas.
 *
 * The whole point is that a description is not paid for until it is wanted, so
 * what comes back is the first sentence — enough to choose between two tools,
 * not enough to call one. `planfly_tool_schema` is the next step.
 *
 * Matching is over the name, that first sentence and the keywords. The keywords
 * are what make the search work at all for this household: the tools are
 * described in English and the person asking is typing «cuota», «tasa»,
 * «presupuesto». Ranking only over English prose would answer nothing and send
 * the model off to improvise a tool name.
 */
export function search(query: string | undefined, limit: number, offset = 0) {
  const tokens = (query ?? "")
    .toLowerCase()
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);

  const scored = NATIVE.filter((tool) => tool.gatewayRoutable !== false)
    .map((tool) => {
      const name = tool.name.toLowerCase();
      const summary = firstSentence(tool.description);
      const haystack = summary.toLowerCase();
      const keywords = tool.keywords.join(" ").toLowerCase();

      let score = 0;
      for (const token of tokens) {
        if (name.includes(token)) score += 3;
        if (haystack.includes(token)) score += 1;
        if (keywords.includes(token)) score += 1;
      }

      return { tool, summary, score };
    })
    // With no query this is the full catalogue; with one, only what matched.
    .filter((row) => tokens.length === 0 || row.score > 0)
    .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name));

  const page = scored.slice(offset, offset + limit).map(
    ({ tool, summary }): ToolSummary => ({
      name: tool.name,
      title: tool.title,
      summary,
      scopes: tool.scopes,
      // The one fact worth knowing before reading a schema: does this move money.
      writes: !tool.annotations.readOnlyHint,
      has_input: Object.keys(tool.inputSchema.shape).length > 0,
    }),
  );

  return {
    tools: page,
    total_matched: scored.length,
    next_offset: offset + limit < scored.length ? offset + limit : null,
  };
}

/**
 * The first sentence of a description, which is what a summary is.
 *
 * The descriptions here open with what the tool does and then spend a paragraph
 * on how it is got wrong; that paragraph is worth its tokens at the moment of
 * calling and not at the moment of choosing.
 */
function firstSentence(description: string): string {
  const stop = description.indexOf(". ");
  return stop === -1 ? description : description.slice(0, stop + 1);
}
