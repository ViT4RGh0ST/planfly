import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { z } from "zod";

import type { Principal } from "@/lib/api-token";
import { NATIVE } from "@/lib/mcp/catalog";
import type { McpTool } from "@/lib/mcp/registry";
import {
  makeToolContext,
  mcpErrorResult,
  McpScopeError,
  toolResult,
  type McpToolContext,
  type ToolResult,
} from "@/lib/mcp/tools/context";

/**
 * Which credential each ACTION needs — not each tool.
 *
 * `registry-guard.test.ts` already asks that every tool call `requireScope`.
 * That is a floor, and it is satisfied by the mention: a tool with six branches
 * passes it with one check in the first branch, and the other five write with
 * whatever the caller happens to hold. Ten tools carry about thirty actions,
 * so the surface this watches is already three times what the tool count
 * suggests, and every resource the plan adds multiplies it again.
 *
 * The failure this exists for MISTAKES ITSELF FOR SUCCESS: a read-only
 * credential that writes gets back `{"ok": true}`. Nothing is logged, nothing
 * is thrown, and the household finds out when the month does not add up. That
 * is why it is a table and not thirty near-identical files — the cost of adding
 * a row has to stay lower than the cost of skipping one.
 *
 * `"*"` is a tool with no `action` field: the whole tool is one action.
 * `"(omitted)"` is the branch taken when an optional `action` is left out,
 * which is a branch like any other and the easiest one to forget.
 *
 * Scopes are listed IN THE ORDER THE TOOL CHECKS THEM.
 */
const ACTIONS: Record<string, Record<string, readonly string[]>> = {
  planfly_context: { "*": ["context:read"] },
  planfly_report: { "*": ["reports:read"] },
  planfly_preview_transaction: { "*": ["transactions:write"] },
  planfly_confirm_transaction: { "*": ["transactions:write"] },
  planfly_account: {
    create: ["accounts:write"],
    update: ["accounts:write"],
    archive: ["accounts:write"],
    unarchive: ["accounts:write"],
    "(omitted)": ["accounts:write"],
  },
  planfly_amend: {
    void: ["transactions:write"],
    approve: ["transactions:write"],
    "(omitted)": ["transactions:write"],
  },
  planfly_budget: {
    list: ["context:read"],
    set: ["budgets:write"],
    remove: ["budgets:write"],
    "(omitted)": ["budgets:write"],
  },
  planfly_financing: {
    list: ["context:read"],
    purchase: ["financing:write"],
    pay: ["financing:write"],
    unpay: ["financing:write"],
    void: ["financing:write"],
    confirm: ["financing:write"],
  },
  planfly_product: {
    history: ["reports:read"],
    list: ["reports:read"],
    // The gate has to say how many line items move and where they land, and that
    // count IS the price history: this write cannot be previewed without the read.
    merge: ["transactions:write", "reports:read"],
    split: ["transactions:write", "reports:read"],
    confirm: ["transactions:write", "reports:read"],
    "(omitted)": ["transactions:write", "reports:read"],
  },
  planfly_recurring: {
    list: ["context:read"],
    create: ["recurring:write"],
    pause: ["recurring:write"],
    resume: ["recurring:write"],
    remove: ["recurring:write"],
  },
};

/** The `action` values a tool's own schema accepts, read off the schema. */
function actionsOf(tool: McpTool): string[] {
  const shape = (tool.inputSchema as z.ZodObject<z.ZodRawShape>).shape;
  const field = shape.action as z.ZodTypeAny | undefined;
  if (field === undefined) return ["*"];

  const values: string[] = [];
  const dig = (node: unknown): void => {
    const def = (node as { def?: { type?: string; entries?: Record<string, string>; innerType?: unknown } }).def;
    if (!def) return;
    if (def.type === "enum" && def.entries) values.push(...Object.values(def.entries));
    if (def.innerType) dig(def.innerType);
  };
  dig(field);

  // Optional means there is one more branch than the enum names.
  if (field.safeParse(undefined).success) values.push("(omitted)");
  return values;
}

/** The arguments that choose a branch and nothing else. */
function argsFor(action: string): Record<string, unknown> {
  return action === "*" || action === "(omitted)" ? {} : { action };
}

function principalWith(scopes: readonly string[], role: "member" | "viewer" = "member"): Principal {
  return {
    householdId: "h",
    userId: "u",
    credentialId: "c",
    scopes: [...scopes],
    role,
    tokenId: null,
  } as unknown as Principal;
}

/**
 * A context with the REAL scope check and no way out to the database.
 *
 * `requireScope` and the `hasScope` under it are what is on trial, so they are
 * the real ones; only `callRoute` is replaced, because a tool that gets past
 * its checks would otherwise open a connection this test has no business
 * needing.
 */
function contextFor(principal: Principal) {
  const asked: string[] = [];
  /*
   * Only a refusal about the credential is worded here.
   *
   * These arguments name a branch and nothing else, so a tool that clears its
   * checks goes on to fail at its schema or at a database that is not running
   * — and `mcpErrorResult` logs every one of those, which would put thirty
   * stack traces into a run that is passing. Flattening them is safe because
   * this file judges exactly one thing, and says so: whether the answer is
   * `forbidden`, and for which scope.
   */
  const real = makeToolContext(principal, (error) =>
    error instanceof McpScopeError
      ? mcpErrorResult(error)
      : toolResult({ ok: false, error: "not_about_the_credential" }, true),
  );
  const ctx: McpToolContext = {
    ...real,
    requireScope(scope: string) {
      asked.push(scope);
      return real.requireScope(scope);
    },
    callRoute: async () => ({ ok: true }),
  };
  return { ctx, asked };
}

function answerOf(result: ToolResult): Record<string, unknown> {
  return result.structuredContent;
}

const declaredFor = (tool: McpTool, action: string): readonly string[] =>
  ACTIONS[tool.name]?.[action] ?? [];

describe("what each action asks for", () => {
  it("has a row for every branch a schema accepts, and no row for one it does not", () => {
    for (const tool of NATIVE) {
      const rows = ACTIONS[tool.name];
      assert.ok(rows, `${tool.name} is in the catalogue and not in this table. Add its actions.`);
      assert.deepEqual(
        Object.keys(rows).sort(),
        actionsOf(tool).sort(),
        `${tool.name}'s rows and its own action enum disagree. A branch with no row is a ` +
          "branch whose scope nobody checked; a row with no branch is a claim about " +
          "something that cannot be called.",
      );
    }
  });

  it("never asks for a scope the tool does not advertise", () => {
    /*
     * `planfly_search_tool` shows `scopes` so a caller can tell, before writing
     * a call, whether its credential can make it. A branch enforcing something
     * outside that list makes the hint a lie in the direction that wastes the
     * most time: the model is told it may, tries, and is refused.
     */
    for (const tool of NATIVE) {
      for (const [action, scopes] of Object.entries(ACTIONS[tool.name] ?? {})) {
        for (const scope of scopes) {
          assert.ok(
            tool.scopes.includes(scope),
            `${tool.name} action='${action}' enforces ${scope}, which is not in its declared scopes`,
          );
        }
      }
    }
  });

  it("refuses every action to a credential that carries nothing", async () => {
    for (const tool of NATIVE) {
      for (const action of actionsOf(tool)) {
        const { ctx } = contextFor(principalWith([]));
        const answer = answerOf(await tool.run(argsFor(action) as never, ctx));

        assert.equal(
          answer.error,
          "forbidden",
          `${tool.name} action='${action}' ran for a credential with no scopes at all. ` +
            `It answered ${JSON.stringify(answer).slice(0, 160)}`,
        );
        assert.ok(
          declaredFor(tool, action).includes(String(answer.scope)),
          `${tool.name} action='${action}' refused for ${answer.scope}, which is not what its row says`,
        );
      }
    }
  });

  it("enforces each scope its row claims, one missing at a time", async () => {
    /*
     * The pass that finds the branch that checks nothing.
     *
     * Refusing a credential with NO scopes proves only that something was
     * checked. Removing exactly one, and demanding the refusal name that one,
     * is what proves the check belongs to this branch and not to the branch
     * above it that happened to run first.
     */
    for (const tool of NATIVE) {
      for (const action of actionsOf(tool)) {
        const declared = declaredFor(tool, action);
        for (const missing of declared) {
          const { ctx } = contextFor(principalWith(declared.filter((s) => s !== missing)));
          const answer = answerOf(await tool.run(argsFor(action) as never, ctx));

          assert.equal(
            answer.error,
            "forbidden",
            `${tool.name} action='${action}' ran without ${missing}, which its row says it needs`,
          );
          assert.equal(
            answer.scope,
            missing,
            `${tool.name} action='${action}' was refused for ${answer.scope} when ${missing} was ` +
              "the one withheld. Either the row lists a scope the branch never checks, or the " +
              "branch checks one the row does not list.",
          );
        }
      }
    }
  });

  it("asks for nothing beyond its row once the row is granted", async () => {
    for (const tool of NATIVE) {
      for (const action of actionsOf(tool)) {
        const declared = declaredFor(tool, action);
        const { ctx, asked } = contextFor(principalWith(declared));
        const answer = answerOf(await tool.run(argsFor(action) as never, ctx));

        // It may well fail — these arguments name a branch and nothing else —
        // but it must not fail for want of a credential.
        assert.notEqual(
          answer.error,
          "forbidden",
          `${tool.name} action='${action}' was refused while holding every scope its row lists. ` +
            `It asked for ${asked.join(", ")}`,
        );
        assert.deepEqual(
          asked.filter((scope) => !declared.includes(scope)),
          [],
          `${tool.name} action='${action}' asked for a scope its row does not list`,
        );
      }
    }
  });

  it("still refuses a viewer every write, scope in hand", async () => {
    /*
     * A household member who may look and not touch.
     *
     * The scopes on the credential are not the whole answer: `hasScope` denies
     * a write to a viewer even when the token carries it, because a token is
     * minted from a role and a role can be demoted afterwards. Checking only
     * the scope list would leave a demoted member writing with the credential
     * they were given while they still could.
     */
    for (const tool of NATIVE) {
      for (const action of actionsOf(tool)) {
        const declared = declaredFor(tool, action);
        const writes = declared.filter((scope) => scope.endsWith(":write"));
        if (writes.length === 0) continue;

        const { ctx } = contextFor(principalWith(declared, "viewer"));
        const answer = answerOf(await tool.run(argsFor(action) as never, ctx));

        assert.equal(
          answer.error,
          "forbidden",
          `${tool.name} action='${action}' let a viewer through holding ${writes.join(", ")}`,
        );
        assert.ok(
          writes.includes(String(answer.scope)),
          `${tool.name} action='${action}' refused a viewer for ${answer.scope}, which is not a write scope`,
        );
      }
    }
  });
});
