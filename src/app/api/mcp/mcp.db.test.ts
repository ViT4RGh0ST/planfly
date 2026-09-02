import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { NextRequest } from "next/server";

import { pool } from "@/db";
import { hasDb, prepareDb } from "@/test/db";
import { seedScenario, tokenFor, type Scenario } from "@/test/fixtures";

const DATE = "2026-08-21";
let scenario: Scenario;
let token: string;

function mcpRequest(tokenValue: string, body: unknown) {
  const request = body as { method?: string; params?: { name?: string; _meta?: Record<string, unknown> } };
  const method = request.method ?? "tools/list";
  request.params ??= {};
  request.params._meta = {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientCapabilities": {},
    ...request.params._meta,
  };
  return new NextRequest("http://planfly.test/api/mcp", {
    method: "POST",
    body: JSON.stringify(body),
    headers: {
      Authorization: `Bearer ${tokenValue}`,
      Host: "localhost:3000",
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      "MCP-Protocol-Version": "2026-07-28",
      "MCP-Method": method,
      ...(request.params.name ? { "MCP-Name": request.params.name } : {}),
    },
  });
}

async function mcpBody(response: Response) {
  const text = await response.text();
  if (!response.headers.get("content-type")?.includes("text/event-stream")) return JSON.parse(text);
  const data = text
    .split("\n")
    .find((line) => line.startsWith("data: "))
    ?.slice("data: ".length);
  assert.ok(data, `MCP SSE response did not contain a data frame: ${text}`);
  return JSON.parse(data);
}

describe("the HTTP MCP route against the database", { skip: hasDb() ? false : "no Postgres available" }, () => {
  before(async () => {
    await prepareDb();
    scenario = await seedScenario({ date: DATE, bcvRate: "780.0000000000", p2pRate: "900.0000000000" });
    token = await tokenFor(scenario.home, ["mcp:access", "context:read", "reports:read", "transactions:write"]);
  });
  after(() => pool.end());

  it("requires the dedicated MCP scope and advertises the core tools", async () => {
    const { POST } = await import("./route");
    const noMcpScope = await tokenFor(scenario.home, ["context:read"]);
    const denied = await POST(
      mcpRequest(noMcpScope, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    );
    assert.equal(denied.status, 401);

    const listed = await POST(
      mcpRequest(token, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    );
    assert.equal(listed.status, 200);
    const body = await mcpBody(listed);
    assert.deepEqual(
      body.result.tools.map((tool: { name: string }) => tool.name).sort(),
      /*
       * The exact list, on purpose.
       *
       * What a server advertises is its contract: a tool that quietly stops
       * being registered does not fail, it just stops being offered, and a bot
       * that can no longer open an account will find some other way to record
       * the expense.
       */
      [
        "planfly_confirm_transaction",
        "planfly_context",
        "planfly_preview_transaction",
        "planfly_report",
        "planfly_search_tool",
        "planfly_tool_schema",
        "planfly_use_tool",
      ],
    );
  });

  it("keeps an unlisted tool reachable, and still behind its own scope", async () => {
    /*
     * The whole bargain of gateway mode in one test.
     *
     * `planfly_budget` is deliberately NOT in the list above — that is the point,
     * it costs no tokens until somebody wants it. What must remain true is that
     * it is still there, and that going in through the side door does not skip
     * the lock: this token carries context:read but not budgets:write, and
     * listing caps needs the first while setting one needs the second.
     */
    const { POST } = await import("./route");

    const call = async (id: number, args: Record<string, unknown>) => {
      const response = await POST(
        mcpRequest(token, {
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: { name: "planfly_use_tool", arguments: args },
        }),
      );
      assert.equal(response.status, 200);
      return JSON.parse((await mcpBody(response)).result.content[0].text);
    };

    // Discovery finds what the listing left out.
    const found = await call(20, { name: "planfly_tool_schema" });
    assert.equal(found.error, "unknown_tool", "the doors must not route to each other");

    const listing = await call(21, { name: "planfly_budget", arguments: { action: "list" } });
    assert.equal(listing.ok, true, "a routed read the token IS allowed did not go through");

    const setting = await call(22, {
      name: "planfly_budget",
      arguments: { action: "set", category: "mercado", amount: 200 },
    });
    assert.equal(setting.error, "forbidden");
    assert.equal(
      setting.scope,
      "budgets:write",
      "routing through planfly_use_tool earned a write this credential does not have, " +
        "or refused it without saying which scope was missing",
    );
  });

  it("runs the preview/confirm flow over Streamable HTTP", async () => {
    const { POST } = await import("./route");
    const previewResponse = await POST(
      mcpRequest(token, {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "planfly_preview_transaction",
          arguments: {
            kind: "expense",
            amount: "780,00",
            currency: "VES",
            account: "efectivo",
            category: "mercado",
            occurred_on: DATE,
          },
        },
      }),
    );
    const previewMcpResult = await mcpBody(previewResponse);
    const preview = JSON.parse(previewMcpResult.result.content[0].text);
    assert.equal(preview.ok, true);
    assert.ok(preview.confirmationId);

    const confirmedResponse = await POST(
      mcpRequest(token, {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "planfly_confirm_transaction",
          arguments: { confirmation_id: preview.confirmationId },
        },
      }),
    );
    const confirmedMcpResult = await mcpBody(confirmedResponse);
    const confirmed = JSON.parse(confirmedMcpResult.result.content[0].text);
    assert.equal(confirmed.ok, true);
    assert.equal(confirmed.result.dryRun, false);
    assert.ok(confirmed.result.transactionId);
  });

  it("does not let MCP access bypass a tool's financial scope", async () => {
    const { POST } = await import("./route");
    const readOnlyMcp = await tokenFor(scenario.home, ["mcp:access", "context:read"]);
    const response = await POST(
      mcpRequest(readOnlyMcp, {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: {
          name: "planfly_preview_transaction",
          arguments: { kind: "expense", amount: 1, account: "efectivo" },
        },
      }),
    );
    const result = await mcpBody(response);
    assert.equal(result.result.isError, true);
    assert.deepEqual(JSON.parse(result.result.content[0].text), {
      ok: false,
      error: "forbidden",
      message: "The MCP credential does not grant transactions:write.",
      scope: "transactions:write",
    });
  });
});
