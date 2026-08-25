import { headers } from "next/headers";
import { getRequestConfig } from "next-intl/server";

import { currentSession } from "@/lib/session";
import { DEFAULT_LOCALE, normalizeLocale, type Locale } from "./config";
import { messagesFor } from "./translator";

/**
 * The language for one render of the React tree.
 *
 * It reuses `currentSession()` rather than running a query of its own: every
 * page already calls it through `requireSession()`, and it is wrapped in React's
 * `cache()` so both calls in the same render hit the database once.
 *
 * There is no `[locale]` segment and no proxy. The language is a household
 * datum, like the timezone and the base currency, so it comes down the same pipe
 * that already carries those — and that pipe reaches the four places that need
 * it, which a URL segment does not: `next/root-params` works in neither server
 * actions nor route handlers.
 */
async function negotiateFromHeaders(): Promise<Locale> {
  try {
    return normalizeLocale((await headers()).get("accept-language"));
  } catch {
    return DEFAULT_LOCALE;
  }
}

export default getRequestConfig(async () => {
  let locale: Locale = DEFAULT_LOCALE;
  let timeZone = "America/Caracas";

  /*
   * It never throws.
   *
   * This runs on every render, /login included — where there is no session at
   * all. If it threw there, the sign-in screen would stop rendering and the
   * owner would be locked out of their own accounting while the heartbeat kept
   * writing behind them. Any failure falls back to a language, because a screen
   * with the wrong words still works and a screen with none does not.
   */
  try {
    const ctx = await currentSession();
    locale = ctx ? normalizeLocale(ctx.locale) : await negotiateFromHeaders();
    if (ctx) timeZone = ctx.timezone;
  } catch {
    locale = DEFAULT_LOCALE;
  }

  return {
    locale,
    messages: messagesFor(locale),
    /*
     * The household's, like every other date in the app — and it really is the
     * household's now: it used to be `America/Caracas` written by hand under a
     * comment that said this. Nothing formats a date through next-intl today,
     * so it was inert; the day somebody adds a `useFormatter`, an installation
     * in another timezone would have printed Caracas time in silence.
     *
     * With no session there is nobody to ask, and the originating case is the
     * only honest guess.
     */
    timeZone,
  };
});
