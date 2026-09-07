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

/*
 * Never prerendered, and never cached.
 *
 * `next build` tries to work out whether a route handler can be static, and for
 * one that declares nothing it finds out by RUNNING it — which here reaches
 * better-auth, which reaches the database, which is not there at build time and
 * must not be: baking a connection string into an image is precisely what one
 * does not do. The build died on «Failed to collect configuration», and only
 * for these two, because `/api/mcp` already said this and the pages already say
 * it.
 *
 * It is also true on its own terms: this answers with the issuer taken from the
 * request, so a single stored copy would serve one host's metadata to every
 * other.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export { metadata as GET };
