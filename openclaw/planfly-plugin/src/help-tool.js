import { toolResult } from "./client.js";

/**
 * planfly's catalogue and schemas, so an agent that does not know the plugin can
 * find its bearings without guessing.
 *
 * It is built from the already registered tools, not from a copy: a hand-written
 * list falls out of sync on the first parameter change and then it lies, which
 * is worse than not existing.
 *
 * It does not replace the schema the model already receives with each tool. It
 * serves something else: when an agent gets stuck — a rejected call, an account
 * name it cannot find — it has somewhere to look before improvising. Improvising
 * in a ledger is how a duplicate entry appears with the amount deliberately
 * changed to dodge an error.
 */
const RECIPES = {
  planfly_amend: [
    "To correct you do NOT send action: you send the new field alongside target.",
    '  {"target": "last", "account": "Banco Provincial"}   ← changes the account',
    '  {"action": "update", "target": "last"}              ← does NOTHING: it does not say what to set',
    "Adding the breakdown to an already recorded purchase:",
    '  {"target": "last", "items": [{"description": "HARINA PAN 1KG", "total": 80}]}',
    "  items is enough on its own. There is NO need to send amount, category or account.",
    "Correcting the amount:",
    '  {"target": "last", "amount": 500}',
    "Changing the account when it ended up in the wrong one:",
    '  {"target": "last", "account": "Banco Provincial"}',
    "  The name has to be exact. Get it from planfly_context, do not abbreviate it.",
  ],
  planfly_record: [
    "An ordinary expense:",
    '  {"kind": "expense", "amount": 12008.7, "account": "Banco Provincial", "description": "compra mercado"}',
    "The account ALWAYS goes in account. `to_account` is a transfer's destination:",
    "  on an expense planfly rejects it, because there it means nothing and the",
    "  expense would end up in the default account without anyone noticing.",
    "If the account or the category is not recognised, planfly_record says so and does NOT invent:",
    "  call planfly_context and offer the ones that genuinely exist.",
  ],
  planfly_context: [
    "No parameters. Returns accounts with balances, categories and the day's rates.",
    "  Use it BEFORE writing an account name you have not seen in this conversation.",
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

export function createHelpTool(_api, tools) {
  return {
    name: "planfly_help",
    label: "How planfly is used",
    description:
      "Explains which planfly tools exist, which parameters each one accepts and how they " +
      "combine, with examples. Use it when a call of yours is rejected and you do not understand " +
      "why, or when you do not know which tool matches what you are being asked. " +
      "With no parameters it lists them all; with tool='planfly_amend' it details that one.",
    parameters: {
      type: "object",
      properties: {
        tool: {
          type: "string",
          description: "Exact name of a tool, to see its parameters and examples.",
        },
      },
    },
    async execute(_id, params) {
      const catalogue = tools.filter((tool) => tool.name !== "planfly_help");
      const requested = params?.tool;

      if (requested) {
        const tool = catalogue.find((candidate) => candidate.name === requested);
        if (!tool) {
          return toolResult(
            `${requested} does not exist. The ones there are: ${catalogue.map((t) => t.name).join(", ")}.`,
            { ok: false, error: "unknown_tool", available: catalogue.map((t) => t.name) },
          );
        }

        return toolResult(describe(tool).join("\n"), { ok: true, tool: schemaOf(tool) });
      }

      const lines = ["planfly's tools:", ""];
      for (const tool of catalogue) {
        lines.push(`· ${tool.name} — ${firstSentence(tool.description)}`);
      }
      lines.push("", "Ask planfly_help with tool='<name>' to see one tool's parameters.");
      lines.push("", ...RULES);

      return toolResult(lines.join("\n"), {
        ok: true,
        tools: catalogue.map(schemaOf),
      });
    },
  };
}

function describe(tool) {
  const lines = [`${tool.name} — ${tool.label}`, "", tool.description, "", "Parameters:"];
  const properties = tool.parameters?.properties ?? {};
  const required = new Set(tool.parameters?.required ?? []);

  if (Object.keys(properties).length === 0) {
    lines.push("  (none)");
  }

  for (const [name, schema] of Object.entries(properties)) {
    const parts = [`  ${name} (${schema.type ?? "any"}${required.has(name) ? ", required" : ""})`];
    if (Array.isArray(schema.enum)) {
      parts.push(`    values: ${schema.enum.join(" | ")}`);
    }
    if (schema.description) {
      parts.push(`    ${schema.description}`);
    }
    lines.push(...parts);
  }

  const recipes = RECIPES[tool.name];
  if (recipes) {
    lines.push("", "Examples:", ...recipes.map((line) => `  ${line}`));
  }

  return lines;
}

function schemaOf(tool) {
  return {
    name: tool.name,
    label: tool.label,
    description: tool.description,
    parameters: tool.parameters,
    examples: RECIPES[tool.name] ?? [],
  };
}

function firstSentence(description) {
  const text = String(description ?? "");
  const stop = text.indexOf(". ");

  return stop === -1 ? text : text.slice(0, stop + 1);
}
