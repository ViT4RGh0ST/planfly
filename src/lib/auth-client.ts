"use client";

import { createAuthClient } from "better-auth/react";

/**
 * No `baseURL` on purpose: in the browser better-auth uses the origin the page
 * was loaded from.
 *
 * Pinning it to `http://localhost:3000` broke the login when entering through
 * `http://planfly.localhost` (Traefik): the browser made a cross-origin request
 * and CORS blocked it. Since the app serves its own API at `/api/auth`, the same
 * origin is always the right answer, whichever door you come in by.
 */
export const authClient = createAuthClient();

export const { signIn, signOut, useSession } = authClient;
