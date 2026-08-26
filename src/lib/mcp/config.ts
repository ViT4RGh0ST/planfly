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

/** Host header allowlist; ports are intentionally ignored by the SDK helper. */
export const mcpAllowedHosts = [mcpResourceUrl.hostname];
