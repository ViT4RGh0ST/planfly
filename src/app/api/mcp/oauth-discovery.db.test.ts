import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { pool } from "@/db";
import { hasDb, prepareDb } from "@/test/db";

/**
 * That an MCP client following our own instructions arrives somewhere.
 *
 * `/api/mcp` answers an unauthenticated call with a 401 whose
 * `WWW-Authenticate` names a discovery document, per RFC 9728. That header was
 * being emitted while both discovery routes answered 404, because `auth.ts`
 * mounted no plugins and the routes forward to `auth.handler`, which knew
 * nothing of those paths. The client did not fail to connect — it followed a
 * pointer of ours to a dead end, which is the harder failure to diagnose.
 *
 * Nothing caught it. Every MCP test used a `plfy_` token, so the whole OAuth
 * half could be absent and the suite stayed green. Hence this file, and hence
 * the last test: it ties the pointer to the thing pointed at, which is the
 * relationship that actually broke.
 */
describe("MCP OAuth discovery", { skip: hasDb() ? false : "no Postgres available" }, () => {
  before(async () => {
    await prepareDb();
  });
  after(() => pool.end());

  /** The origin the routes compare against; anything else is deliberately 404. */
  const ORIGIN = "http://localhost:3000";

  async function get(path: string) {
    const { GET } =
      path.startsWith("/.well-known/oauth-protected-resource")
        ? await import("@/app/.well-known/oauth-protected-resource/[...resource]/route")
        : await import("@/app/.well-known/oauth-authorization-server/[...issuer]/route");
    return GET(new Request(`${ORIGIN}${path}`));
  }

  it("publishes where this resource's authorization server is", async () => {
    const response = await get("/.well-known/oauth-protected-resource/api/mcp");
    assert.equal(response.status, 200, "RFC 9728 metadata must exist, or the 401 points nowhere");

    const body = (await response.json()) as {
      resource: string;
      authorization_servers: string[];
    };
    assert.match(body.resource, /\/api\/mcp$/, "it has to name the endpoint it protects");
    assert.ok(
      body.authorization_servers?.length,
      "and at least one authorization server, or a client has nowhere to go next",
    );
  });

  it("publishes the endpoints and the scopes a client has to ask for", async () => {
    const response = await get("/.well-known/oauth-authorization-server/api/auth");
    assert.equal(response.status, 200);

    const body = (await response.json()) as Record<string, unknown> & {
      scopes_supported?: string[];
    };
    for (const key of ["issuer", "authorization_endpoint", "token_endpoint", "jwks_uri"]) {
      assert.ok(body[key], `RFC 8414 metadata without ${key} cannot be used`);
    }

    /*
     * The same scope names the tools check.
     *
     * Two vocabularies — one for OAuth, one for the `plfy_` tokens — would make a
     * tool reachable through one door and refused at the other, and the
     * difference would be found by whoever hit it.
     */
    for (const scope of ["context:read", "reports:read", "transactions:write"]) {
      assert.ok(
        body.scopes_supported?.includes(scope),
        `${scope} is enforced by the tools but never advertised: a client cannot request it`,
      );
    }
  });

  it("points its own challenge at a document that exists", async () => {
    // The whole failure in one assertion: the header was right and the target
    // was missing, so each half looked fine on its own.
    const { POST } = await import("./route");
    const rejected = await POST(
      new Request(`${ORIGIN}/api/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Host: "localhost:3000" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      }),
    );
    assert.equal(rejected.status, 401);

    const challenge = rejected.headers.get("www-authenticate") ?? "";
    const url = challenge.match(/resource_metadata="([^"]+)"/)?.[1];
    assert.ok(url, `the challenge must name the metadata document: ${challenge}`);

    const followed = await get(new URL(url).pathname);
    assert.equal(followed.status, 200, `the challenge sent the client to ${url}, which 404s`);
  });
});
