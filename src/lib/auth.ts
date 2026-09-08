import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { jwt } from "better-auth/plugins";
import { cimd } from "@better-auth/cimd";
import { fetchClientMetadataResource } from "@better-auth/cimd/node";
import { mcp } from "@better-auth/mcp";

import { db } from "@/db";
import { lazy } from "@/lib/lazy";
import { mcpResource } from "@/lib/mcp/config";
import * as schema from "@/db/schema";

/**
 * What an OAuth client may ask this planfly for.
 *
 * The same names the static `plfy_` tokens carry, on purpose: a tool checks one
 * scope and does not care which door the credential came through. Two
 * vocabularies would mean a tool that is reachable one way and not the other,
 * and the difference would be found by whoever hit it.
 */
export const MCP_SCOPES = ["context:read", "reports:read", "transactions:write"] as const;

/**
 * Authenticating people.
 *
 * Email + password, with no OAuth providers: this runs on your machine alone and
 * there is no sense in depending on a third party to get in. Hashing uses scrypt
 * from `node:crypto`, so it drags in no native module — which matters on this
 * machine, which has no C compiler.
 *
 * Form sign-up is CLOSED (`disableSignUp`). There is no sign-up screen and there
 * must not be: accounts are created from the machine, with `npm run db:seed` for
 * the first and `npm run scan:user` for the scanning one. Adding someone is a
 * decision taken at the terminal, not a form anyone reaching the port can submit.
 *
 * Note: the openclaw plugin does NOT authenticate through here. Machines use the
 * `tokens_api` table (see src/lib/api-token.ts), which is revocable, carries
 * scopes and leaves a trail of which token wrote each row.
 */
/**
 * Built on first use, not on importing this module.
 *
 * better-auth 1.7 touches the Drizzle adapter's database while it is being
 * constructed, where 1.6 waited for the first query. `betterAuth(...)` runs at
 * module scope and this module is reached from the root layout — through
 * `@/i18n/request` → `@/lib/session` — so every route in the build imported it,
 * woke the connection pool, and died on «DATABASE_URL is missing». The build
 * does not have one and must not: see `@/lib/lazy`.
 */
export const auth = lazy(() => betterAuth({
  database: drizzleAdapter(db, { provider: "pg", schema }),
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: process.env.BETTER_AUTH_URL ?? "http://localhost:3000",
  /**
   * The app is reached through several doors: straight at the port, via
   * `*.localhost` if there is a proxy in front, or through whichever domain each
   * person gives it. better-auth compares the Origin header against `baseURL` to
   * protect against CSRF, so the others have to be declared or login fails from
   * them.
   *
   * The local ones are fixed; yours go in `AUTH_TRUSTED_ORIGINS`, comma
   * separated. It is a closed list on purpose: each entry is an origin whose
   * login form is accepted, so it grows only with what you actually use.
   */
  trustedOrigins: [
    "http://planfly.localhost",
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    ...(process.env.AUTH_TRUSTED_ORIGINS ?? "")
      .split(",")
      .map((o) => o.trim())
      .filter(Boolean),
  ],
  emailAndPassword: {
    enabled: true,
    /*
     * Without this, sign-up was open despite what the comment above said: rows
     * could be created in `user` without authenticating and you could find out
     * which emails exist. It granted no access — a new user belongs to no
     * household and `requireSession` bounces them — but whoever deploys this
     * reads "closed" and never looks again.
     */
    disableSignUp: true,
    // No email verification: there is no mail server and the only user is
    // whoever administers the machine.
    requireEmailVerification: false,
    minPasswordLength: 10,
  },
  session: {
    expiresIn: 60 * 60 * 24 * 30, // 30 days — it is a personal tool
    updateAge: 60 * 60 * 24,
  },
  plugins: [
    /*
     * Without these three, the OAuth half of MCP does not exist.
     *
     * The `.well-known` routes forward to `auth.handler`, and it is the `mcp()`
     * plugin that teaches it those paths — it is the authorization server AND,
     * as the resource server, what serves the RFC 9728 document. With no plugin
     * mounted both answered 404 while `/api/mcp` went on emitting a 401 whose
     * `WWW-Authenticate` pointed at one of them. A client did not fail to
     * connect: it followed our own instruction to a dead end.
     */
    // Access tokens signed and audience-bound to exactly this MCP endpoint.
    // Separate from planfly's own revocable machine tokens.
    jwt(),
    mcp({
      loginPage: "/login",
      consentPage: "/mcp/consent",
      resource: mcpResource,
      scopes: ["openid", "profile", "email", "offline_access", ...MCP_SCOPES],
      accessTokenExpiresIn: 15 * 60,
      refreshTokenExpiresIn: 30 * 24 * 60 * 60,
      codeExpiresIn: 5 * 60,
      // A client gets the resources it registered for and no others: this
      // household's ledger is the only thing behind this authorization server,
      // so a token minted for something else has no business reaching it.
      enforcePerClientResources: true,
      resources: [
        { identifier: mcpResource, name: "Planfly MCP", allowedScopes: [...MCP_SCOPES] },
      ],
      clientRegistrationDefaultResources: [mcpResource],
    }),
    cimd({
      fetchClientMetadataResource,
      metadataProfile: "mcp-2026-07-28",
      // It fetches a URL the CLIENT chose, so the limits are the point: an
      // unbounded fetcher pointed at a machine that only ever serves one
      // household is a way to make it knock on somebody else's door.
      metadataFetchPolicy: {
        maximumConcurrentFetches: 8,
        maximumConcurrentFetchesPerOrigin: 2,
        maximumFetchesPerMinute: 60,
        maximumFetchesPerOriginPerMinute: 10,
      },
    }),
  ],
}));

export type Sesion = typeof auth.$Infer.Session;
