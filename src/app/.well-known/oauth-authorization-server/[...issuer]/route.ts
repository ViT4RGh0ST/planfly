import { auth } from "@/lib/auth";

/** RFC 8414 path insertion alias for the `/api/auth` issuer. */
async function metadata(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname !== "/.well-known/oauth-authorization-server/api/auth") {
    return new Response(null, { status: 404 });
  }
  return auth.handler(new Request(`${url.origin}/api/auth/.well-known/oauth-authorization-server`, {
    method: request.method,
    headers: request.headers,
  }));
}

export { metadata as GET };
