import { auth } from "@/lib/auth";

/*
 * RFC 9728 discovery inserts `/.well-known` at the resource origin, while
 * Better Auth is mounted beneath `/api/auth`. Forward only the single Planfly
 * resource path to the provider; this is not an open proxy.
 */
async function metadata(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname !== "/.well-known/oauth-protected-resource/api/mcp") {
    return new Response(null, { status: 404 });
  }
  // The MCP plugin intentionally matches the RFC 9728 path before Better
  // Auth's `/api/auth` mount is applied.
  return auth.handler(new Request(`${url.origin}/.well-known/oauth-protected-resource/api/mcp`, {
    method: request.method,
    headers: request.headers,
  }));
}

export { metadata as GET, metadata as HEAD };
