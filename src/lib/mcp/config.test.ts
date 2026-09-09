import assert from "node:assert/strict";
import { describe, it } from "node:test";

/**
 * The names this endpoint answers to.
 *
 * The Host check is what stops a rebound DNS name from pointing a browser at
 * this port, so it cannot simply be widened. But one deployment legitimately has
 * more than one name: planfly is `localhost:3000` from the machine and
 * `planfly:3000` from another container on a shared network, and the second was
 * refused with «Invalid Host: planfly» — correctly, and fatally for the bot.
 *
 * The module reads the environment once at import, so each case re-imports it
 * with a fresh query string. That is the whole reason these are separate `it`s
 * rather than one.
 */
async function configWith(env: Record<string, string | undefined>, nonce: number) {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return (await import(`./config?probe=${nonce}`)) as typeof import("./config");
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe("which hosts the MCP endpoint answers to", () => {
  it("answers to its public name with nothing configured", async () => {
    const c = await configWith(
      { MCP_PUBLIC_URL: "https://planfly.example.com/api/mcp", MCP_ALLOWED_HOSTS: undefined },
      1,
    );
    assert.deepEqual(c.mcpAllowedHosts, ["planfly.example.com"]);
  });

  it("also answers to the names a deployment declares", async () => {
    /*
     * The case that broke: the bot reaches planfly by its Docker service name.
     * The public URL stays the address a client dials from outside — it is the
     * resource identifier OAuth binds tokens to, and pointing that at a name only
     * Docker resolves would send a browser following the discovery documents
     * somewhere it cannot go.
     */
    const c = await configWith(
      {
        MCP_PUBLIC_URL: "https://planfly.example.com/api/mcp",
        MCP_ALLOWED_HOSTS: "planfly, planfly.internal",
      },
      2,
    );
    assert.deepEqual(c.mcpAllowedHosts, ["planfly.example.com", "planfly", "planfly.internal"]);
  });

  it("takes an empty setting as no extra names, not as one blank name", async () => {
    // A blank entry in the allowlist would match a request with no Host at all.
    const c = await configWith(
      { MCP_PUBLIC_URL: "https://planfly.example.com/api/mcp", MCP_ALLOWED_HOSTS: " , ,, " },
      3,
    );
    assert.deepEqual(c.mcpAllowedHosts, ["planfly.example.com"]);
  });
});
