const LOCAL_RESOURCE = "http://localhost:3000/api/mcp";

function parseUrl(value: string, name: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute URL.`);
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname))) {
    throw new Error(`${name} must use HTTPS outside loopback development.`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`${name} cannot contain credentials, a query or a fragment.`);
  }
  return url;
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

/** Canonical RFC 8707 resource identifier. Never derive this from request headers. */
export const mcpResourceUrl = parseUrl(
  process.env.MCP_PUBLIC_URL?.trim() || LOCAL_RESOURCE,
  "MCP_PUBLIC_URL",
);

export const mcpResource = mcpResourceUrl.toString();

const configuredOrigins = (process.env.MCP_ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

/** Origin hostnames allowed to make browser requests. Native clients send none. */
export const mcpAllowedOriginHostnames = [
  mcpResourceUrl.hostname,
  ...configuredOrigins.map((origin) => parseUrl(origin, "MCP_ALLOWED_ORIGINS").hostname),
];

/**
 * Host header allowlist; ports are intentionally ignored by the SDK helper.
 *
 * One deployment legitimately answers to more than one name. planfly is reached
 * at `localhost:3000` from the machine and at `planfly:3000` from another
 * container on a shared network, and the endpoint refused the second with
 * «Invalid Host: planfly» — correctly, since that check is what stops a rebound
 * DNS name pointing a browser at this port.
 *
 * The alternative was to make `MCP_PUBLIC_URL` the container name, and that is
 * worse: it is the resource identifier OAuth binds tokens to and the address the
 * discovery documents publish, so a browser following them would be sent to a
 * name only Docker resolves. The public identity stays truthful, and the extra
 * names are declared — exactly as `MCP_ALLOWED_ORIGINS` already declares extra
 * origins. A closed list either way: each entry is a name whose requests are
 * accepted, so it grows only with what is actually used.
 */
export const mcpAllowedHosts = [
  mcpResourceUrl.hostname,
  ...(process.env.MCP_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((host) => host.trim())
    .filter(Boolean),
];

export type McpMode = "native" | "gateway" | "both";

const MODES: readonly McpMode[] = ["native", "gateway", "both"];

/**
 * How many tools this server lists.
 *
 * `gateway` — the default — lists the four a finance chat uses constantly plus
 * the three discovery tools, and everything else is found through them. `native`
 * lists all of them, which is the way back if a client copes badly with the
 * indirection; `both` lists all of them AND the doors, for comparing the two
 * while moving over.
 *
 * It changes what is LISTED and never what is reachable: `planfly_use_tool`
 * routes over the whole catalogue in every mode, and every tool checks its own
 * scope in every mode.
 */
export const mcpMode: McpMode = ((): McpMode => {
  const configured = process.env.MCP_MODE?.trim().toLowerCase();
  if (!configured) return "gateway";
  if (!MODES.includes(configured as McpMode)) {
    throw new Error(`MCP_MODE must be one of ${MODES.join(", ")}.`);
  }
  return configured as McpMode;
})();
