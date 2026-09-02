import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { z } from "zod";

import { NATIVE, essentials, resolve, search } from "@/lib/mcp/catalog";
import type { McpTool } from "@/lib/mcp/registry";
import { toolResult, type McpToolContext, type ToolResult } from "@/lib/mcp/tools/context";
import { GATEWAY, listedTools, useToolTool } from "@/lib/mcp/tools/gateway";

/**
 * That the gateway stays a door and never becomes a way round the lock.
 *
 * `planfly_use_tool` runs any tool in the catalogue by name, which is only safe
 * because of one property: it adds no privilege. The tool it routes to performs
 * its own `requireScope`, against the credential the context was built from,
 * exactly as it would if the client had called it by name.
 *
 * That property is not enforced by the type system. It holds because every
 * `run` written so far starts with a scope check, and it would stop holding the
 * first time somebody adds a tool to `NATIVE` that forgets one — a tool nobody
 * would notice was reachable, because in gateway mode it is not even listed.
 *
 * So: the checks below are about the NEXT tool, not the six there are.
 */

const TOOLS_DIR = join(process.cwd(), "src/lib/mcp/tools");

/** The text of every tool module, so a `run` can be read as well as called. */
function toolSources(): Map<string, string> {
  const sources = new Map<string, string>();
  for (const file of readdirSync(TOOLS_DIR)) {
    if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
    sources.set(file, readFileSync(join(TOOLS_DIR, file), "utf8"));
  }
  return sources;
}

/** The module that defines a tool, found by the name it registers under. */
function sourceDefining(tool: McpTool): string {
  for (const [, text] of toolSources()) {
    if (text.includes(`name: "${tool.name}"`)) return text;
  }
  assert.fail(
    `No file under src/lib/mcp/tools defines ${tool.name}. The guard finds a tool's source by ` +
      "the name it declares; a tool defined elsewhere is a tool this test cannot check.",
  );
}

describe("the MCP catalogue", () => {
  it("was found at all", () => {
    // A guard that silently checks nothing is worse than no guard: it reports
    // green while the thing it watches is gone.
    assert.ok(NATIVE.length >= 4, "the catalogue is empty or was not imported");
    assert.ok(toolSources().size >= 3, "no tool modules were read from disk");
  });

  it("gives every tool one name, and every name one tool", () => {
    const names = NATIVE.map((tool) => tool.name);
    assert.deepEqual(
      names.filter((name, index) => names.indexOf(name) !== index),
      [],
      "two tools share a name: registering the second silently replaces the first",
    );
    for (const name of names) {
      assert.match(name, /^planfly_[a-z_]+$/, `${name} is not a planfly tool name`);
    }
  });

  it("routes to the very same tool the native door registers", () => {
    for (const tool of NATIVE) {
      // Not an equal object — the SAME object. Two implementations of one tool
      // is how the two doors come to behave differently.
      assert.strictEqual(resolve(tool.name), tool, `${tool.name} routes to a different object`);
    }
  });

  it("keeps the gateway's own tools out of the catalogue", () => {
    for (const door of GATEWAY) {
      assert.equal(
        NATIVE.some((tool) => tool.name === door.name),
        false,
        `${door.name} is in NATIVE: planfly_use_tool would be able to route to itself`,
      );
      assert.equal(resolve(door.name), undefined, `${door.name} resolves; that is a recursion`);
    }
  });

  it("makes every tool declare a scope, and check it", () => {
    for (const tool of NATIVE) {
      assert.ok(
        tool.scopes.length > 0,
        `${tool.name} declares no scope. Every tool in the catalogue is reachable through ` +
          "planfly_use_tool whether or not it is listed, so one that checks nothing is one " +
          "any credential can run.",
      );
      assert.match(
        sourceDefining(tool),
        /requireScope\(/,
        `${tool.name} never calls ctx.requireScope. The gateway adds no privilege only because ` +
          "each tool checks its own; a tool that does not is open to every credential.",
      );
    }
  });

  it("can publish every tool's schema", () => {
    for (const tool of NATIVE) {
      assert.ok(
        tool.inputSchema instanceof z.ZodObject,
        `${tool.name}'s inputSchema is not a ZodObject; the gateway could not parse arguments with it`,
      );
      // planfly_tool_schema is the ONLY way an unlisted tool's parameters can be
      // learned. One that cannot be converted is a tool nobody can call correctly.
      const json = z.toJSONSchema(tool.inputSchema, { io: "input" }) as Record<string, unknown>;
      assert.equal(json.type, "object", `${tool.name} does not convert to an object schema`);
    }
  });

  it("lists fewer tools in gateway mode than it can run", () => {
    const listed = listedTools("gateway", NATIVE);
    assert.ok(essentials().length > 0, "no essentials: a finance chat would start with no tools");
    for (const tool of essentials()) {
      assert.ok(NATIVE.includes(tool), `${tool.name} is an essential outside the catalogue`);
    }
    assert.ok(
      listed.length < NATIVE.length + GATEWAY.length,
      "gateway mode lists everything: the indirection is being paid for and nothing is saved",
    );
    // And the modes only change what is LISTED.
    assert.equal(listedTools("native", NATIVE).length, NATIVE.length);
    assert.equal(listedTools("both", NATIVE).length, NATIVE.length + GATEWAY.length);
  });

  it("finds a tool by what a person would actually type", () => {
    // Both languages, because the descriptions are English and the household is not.
    for (const query of ["abrir una cuenta", "open an account", "presupuesto", "spending cap"]) {
      const found = search(query, 8).tools.map((row) => row.name);
      assert.ok(found.length > 0, `search found nothing for «${query}»`);
    }
    assert.equal(search("cuenta", 8).tools[0].name, "planfly_account");
    assert.equal(search("presupuesto", 8).tools[0].name, "planfly_budget");
    // No query is the whole catalogue, not nothing.
    assert.equal(search(undefined, 20).tools.length, NATIVE.length);
  });
});

/**
 * A context that records what happened, so the gateway can be exercised without
 * a database, a request or a credential.
 */
function fakeContext(overrides: Partial<McpToolContext> = {}) {
  const calls: string[] = [];
  const ctx = {
    principal: { householdId: "h", userId: "u", credentialId: "c", scopes: [], tokenId: null },
    requireScope: (scope: string) => {
      calls.push(`scope:${scope}`);
      return ctx.principal;
    },
    callRoute: async () => ({ ok: true }),
    result: toolResult,
    fail: (error: unknown) => toolResult({ ok: false, thrown: String(error) }, true),
    ...overrides,
  } as unknown as McpToolContext;
  return { ctx, calls };
}

function structured(result: ToolResult): Record<string, unknown> {
  return result.structuredContent;
}

describe("planfly_use_tool", () => {
  it("answers the same for a tool that is not there and for one of its own", async () => {
    const { ctx } = fakeContext();
    const invented = structured(await useToolTool.run({ name: "planfly_nonsense" }, ctx));
    const itself = structured(await useToolTool.run({ name: "planfly_use_tool" }, ctx));

    assert.equal(invented.error, "unknown_tool");
    // Two different answers would sort names into real and not-real by reading
    // the refusals, and would make «not routable» the way to learn a tool exists.
    assert.equal(itself.message, String(invented.message).replace("planfly_nonsense", "planfly_use_tool"));
  });

  it("refuses arguments the tool itself would refuse, without running it", async () => {
    const { ctx, calls } = fakeContext();
    const answer = structured(
      // `action` is an enum; «demolish» is not one of its values.
      await useToolTool.run({ name: "planfly_budget", arguments: { action: "demolish" } }, ctx),
    );

    assert.equal(answer.error, "invalid_arguments");
    assert.deepEqual(
      calls,
      [],
      "the tool ran anyway: the gateway must parse with the inner schema BEFORE dispatching, " +
        "or it is the laxer of the two doors",
    );
  });

  it("does not carry its own parameters into the tool it routes to", async () => {
    /*
     * `name` is this tool's parameter. Reaching the inner schema it would be a
     * key nothing declared — and this codebase's own rule is that a valid field
     * in the wrong context is worse than an invented one.
     */
    const { ctx } = fakeContext();
    const answer = structured(
      await useToolTool.run({ name: "planfly_context", arguments: {} }, ctx),
    );
    assert.notEqual(answer.error, "invalid_arguments");
  });

  it("runs the routed tool's own scope check, and hands back its own refusal", async () => {
    /*
     * The property the whole design rests on. A credential that cannot open an
     * account by name must not be able to open one through here — and what it
     * gets back must name the scope it lacks, not a sentence about routing.
     */
    class Refused extends Error {}
    const { ctx, calls } = fakeContext({
      requireScope: (scope: string) => {
        throw new Refused(scope);
      },
    });

    const answer = structured(await useToolTool.run({ name: "planfly_account", arguments: {} }, ctx));

    assert.equal(answer.ok, false);
    assert.match(
      String(answer.thrown),
      /accounts:write/,
      "the refusal did not name the scope the account tool asked for, which means the gateway " +
        "either checked something else or checked nothing",
    );
    assert.deepEqual(calls, []);
  });
});
