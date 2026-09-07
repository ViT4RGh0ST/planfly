import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";

import { db } from "@/db";
import { lazy } from "@/lib/lazy";
import * as schema from "@/db/schema";

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
}));

export type Sesion = typeof auth.$Infer.Session;
