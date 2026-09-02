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
      [
        "planfly_confirm_transaction",
        "planfly_context",
        "planfly_preview_transaction",
        "planfly_report",
      ],
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
