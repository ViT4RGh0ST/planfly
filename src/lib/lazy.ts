/**
 * An object that is only built when somebody genuinely uses it.
 *
 * It exists for one property this project depends on: **`next build` must not
 * need a database.** The build imports every route to read its configuration,
 * and the Docker image is built with no `DATABASE_URL` — nor should it have one,
 * because baking a connection string into an image is precisely what one does
 * not do.
 *
 * `@/db` was written this way from the start. `@/lib/auth` had to join it when
 * better-auth 1.7 began touching the adapter's database at construction rather
 * than on first query: `betterAuth(...)` runs at module scope, the module is
 * reached from the root layout through `@/i18n/request`, and the build died on
 * «Failed to collect configuration» for whichever route it got to first.
 *
 * It lives here rather than in `@/db` because it is about laziness and not about
 * Postgres, and a second copy in the auth module would be the sort of near-twin
 * that drifts.
 */
export function lazy<T extends object>(resolve: () => T): T {
  return new Proxy({} as T, {
    get(_target, prop, receiver) {
      const real = resolve();
      const value = Reflect.get(real, prop, receiver);
      return typeof value === "function" ? value.bind(real) : value;
    },
    has: (_t, prop) => Reflect.has(resolve(), prop),
  });
}
