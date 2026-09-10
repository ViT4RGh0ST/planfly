import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { z } from "zod";

import { NATIVE, essentials, resolve, search } from "@/lib/mcp/catalog";
import { SURFACES, type McpTool } from "@/lib/mcp/registry";
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

/**
 * Tools that still reach a service without going through its route.
 *
 * Debt with a name on it, not a licence. `recurring.ts` calls
 * `setRecurringActive` and `removeRecurringRule` straight, and the routes it
 * should be using — PATCH and DELETE on `/api/v1/recurring/[id]` — already
 * exist: there is no reason for the shortcut beyond the order things were
 * written in.
 */
const DIRECT_SERVICE_CALLS: Array<{ file: string; because: string }> = [
  {
    file: "recurring.ts",
    because:
      "pause/resume/remove call the service instead of PATCH and DELETE on " +
      "/api/v1/recurring/[id], which already exist. The exemption is the whole file, so it " +
      "also covers the reads it does on the way — daysFor and resolveAccount.",
  },
];

/**
 * The service functions a module actually calls.
 *
 * Naming is not reaching. `amend.ts` imports `AGENT_EDITABLE_DAYS` to say in
 * its own description how far back a correction may go, and `context.ts`
 * imports two error classes to recognise them with `instanceof`. Neither writes
 * anything, and putting them in a debt list would teach the next reader that
 * the list is noise. So only an imported name that appears as the callee of a
 * call counts — the same rule `coverage-guard.test.ts` uses, for the same
 * reason.
 */
function serviceCallsIn(text: string): string[] {
  const imported: string[] = [];
  const statements = text.matchAll(/import\s+(type\s+)?({[^}]*}|[\w$]+)\s+from\s+"@\/lib\/services\/[^"]+"/g);
  for (const [, typeOnly, clause] of statements) {
    if (typeOnly) continue;
    for (const specifier of clause.replace(/[{}]/g, "").split(",")) {
      const name = specifier.trim().split(/\s+as\s+/).pop()?.trim();
      // `import { type Match, resolveAccount }` — the type half is not reachable.
      if (name && !/^type\s/.test(specifier.trim())) imported.push(name);
    }
  }

  return imported.filter((name) => {
    const called = new RegExp(`(^|[^.\\w$])(new\\s+)?${name}\\s*\\(`, "g");
    for (const [, , constructed] of text.matchAll(called)) {
      if (!constructed) return true; // `new InvalidTransactionError(...)` is not a call to a service.
    }
    return false;
  });
}

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

  it("goes through the v1 routes and not straight to a service", () => {
    /*
     * One write path, and the MCP is not a second one.
     *
     * A tool that imports a service directly skips everything the route does
     * around it — `rejectIdentityKeys`, `rejectUnknownKeys` naming the field it
     * meant, the refusals worded in the household's language — and the two doors
     * start answering differently to the same mistake. That divergence is what
     * the MCP was built to remove, not to reintroduce one import at a time.
     *
     * The list below is debt, not licence. It carries what predates the rule.
     */
    const allowed = new Set(DIRECT_SERVICE_CALLS.map((entry) => entry.file));
    const sources = toolSources();
    const offenders: string[] = [];

    for (const [file, text] of sources) {
      if (allowed.has(file)) continue;
      for (const call of serviceCallsIn(text)) offenders.push(`${file}: ${call}()`);
    }

    assert.deepEqual(
      offenders,
      [],
      "these reach a service without passing through its route. Call the v1 route " +
        "with ctx.callRoute, as account.ts does, or declare the file in " +
        "DIRECT_SERVICE_CALLS with the reason it cannot yet.",
    );

    // And an entry that stopped offending has to go, or the list stops meaning
    // anything the day somebody reads it.
    const stale = DIRECT_SERVICE_CALLS.filter((entry) => {
      const text = sources.get(entry.file);
      return text === undefined || serviceCallsIn(text).length === 0;
    }).map((entry) => entry.file);
    assert.deepEqual(
      stale,
      [],
      "these no longer call a service directly (or no longer exist): delete their line",
    );
  });

  it("keeps the families a filter can actually reach", () => {
    /*
     * A family is added when its first tool is written, never before.
     *
     * `search_tool` publishes `SURFACES` as the values its `surface` parameter
     * takes, so an empty family is an option offered to a model that answers
     * nothing — and «no tools in that family» reads exactly like «planfly
     * cannot do that», which is the sentence a bot repeats to the person.
     */
    for (const surface of SURFACES) {
      assert.ok(
        NATIVE.some((tool) => tool.surface === surface),
        `${surface} is offered as a filter and no tool is in it. Add the family with its first ` +
          "tool, not ahead of it.",
      );
    }

    // `meta` is the three doors. They are always listed and never discovered,
    // so a filter value for them would be one that always comes back empty.
    assert.deepEqual(
      NATIVE.filter((tool) => tool.surface === "meta").map((tool) => tool.name),
      [],
      "a catalogue tool declared itself meta: meta is for the doors, which are not in NATIVE",
    );
  });

  it("narrows to one family without changing what ranked first", () => {
    // The whole matched list, not one page of it: with twenty tools a page of
    // eight could leave out a credit tool and the counts below would differ for
    // an honest reason, which is how a check like this quietly stops checking.
    const wide = search("gasto", 50);
    const narrow = search("gasto", 50, 0, "ledger");

    assert.ok(wide.tools.length > 0, "the fixed rankings below depend on this matching something");
    /*
     * A query that spans families on purpose.
     *
     * «cuota» reads better and proves less: it only ever matched credit, so a
     * filter applied AFTER ranking — which would leave `total_matched` counting
     * the wide list — passed every assertion here. «gasto» matches one tool in
     * `ledger` and one in `reports`, which is the only shape where filtering
     * first and filtering last give different answers.
     */
    assert.ok(
      new Set(wide.tools.map((tool) => tool.surface)).size > 1,
      "this query stopped spanning families, so it can no longer tell the two implementations apart",
    );
    assert.deepEqual(
      [...new Set(narrow.tools.map((tool) => tool.surface))],
      ["ledger"],
      "the filter let another family through",
    );
    // Narrowing has to be a filter and not a different search: the first result
    // of the narrowed list is the first result of the wide one that survives it.
    assert.equal(
      narrow.tools[0]?.name,
      wide.tools.find((tool) => tool.surface === "ledger")?.name,
      "filtering reordered the results, which means it changed the ranking instead of narrowing it",
    );
    // The count has to describe the narrowed list. Filtering after ranking would
    // leave `total_matched` — and with it `next_offset` — counting tools the
    // caller cannot see, and paging would return blank pages.
    assert.equal(
      narrow.total_matched,
      wide.tools.filter((tool) => tool.surface === "ledger").length,
      "total_matched still counts the wide list, so paging a narrowed search would skip results",
    );
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
    /*
     * The whole sentence a person says, not the one keyword out of it.
     *
     * Matching is by substring so that «cuenta» finds «cuentas», which also means
     * an article can score: «pagar una cuota» ranked the ACCOUNT tool first,
     * because «una» is inside «unarchives» in its first sentence. A search that
     * answers with the wrong tool is worse than one that answers nothing — the
     * model calls it, is refused, and improvises.
     */
    const first = (query: string) => search(query, 8).tools[0]?.name;
    assert.equal(first("cuenta"), "planfly_account");
    assert.equal(first("presupuesto"), "planfly_budget");
    assert.equal(first("pagar una cuota"), "planfly_financing");
    assert.equal(first("corregir el ultimo gasto"), "planfly_amend");
    assert.equal(first("el alquiler de todos los meses"), "planfly_recurring");
    assert.equal(first("abrir una cuenta nueva"), "planfly_account");
    assert.equal(first("mismo producto dos veces"), "planfly_product");
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
