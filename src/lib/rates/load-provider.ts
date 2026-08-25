import { pathToFileURL } from "node:url";

import { fetchP2pRate } from "./binance-p2p";
import { quoteFromP2p, topAds } from "./p2p-quote";
import type { RateProvider, RateProviderContext, RateReader, RateSlot } from "./provider";

/**
 * Where each slot's source comes from.
 *
 * External ones are loaded at RUN time, reading a file from disk the bundler
 * never sees. It is what lets `npm ci` and `next build` work on a clean clone
 * with no source installed at all: there is nothing to resolve at compile time.
 *
 * No function here throws. A slot with no source, or with one that fails to
 * load, simply stays empty — and the app already knows how to live with that:
 * you write the rate by hand in /rates.
 */

const ENV_BY_SLOT: Record<RateSlot, string> = {
  bcv: "RATES_PROVIDER_BCV",
  p2p: "RATES_PROVIDER_P2P",
};

/** The built-in parallel-market reader. It is a public, documented API. */
const BUILTIN: Partial<Record<RateSlot, RateProvider>> = {
  p2p: {
    id: "p2p",
    async read({ base, quote, date, timeoutMs }: RateProviderContext) {
      const result = await fetchP2pRate({ fiat: quote, timeoutMs });
      return {
        capturedAt: result.capturedAt,
        // What you'd be paid to sell right now, from the first on the list. See
        // p2p-quote.ts for why the first and not the median.
        quotes: [quoteFromP2p(result, { base, quote }, date)],
        // The top five travel to the `raw` column, which is where the screen
        // takes them from: a rate you can check against is worth more than one
        // you have to take on faith.
        raw: { ...result, top: topAds(result) },
      };
    },
  },
};

export function providerSpecifier(slot: RateSlot): string | null {
  const raw = process.env[ENV_BY_SLOT[slot]]?.trim();
  return raw ? raw : null;
}

/**
 * `none` switches the slot off entirely, built-in reader included.
 *
 * It is needed because the parallel-market reader comes plugged in out of the
 * box and goes out to the internet on its own. Whoever doesn't want it — because
 * they don't live where that means anything, or because they self-host precisely
 * so nothing leaves their machine — had to be able to switch it off, and before
 * there was no way: any value was read as a file path and failed on every heartbeat.
 */
const DISABLED = "none";

/** Only looks at the environment. Lets the screen tell "no answer" from "none". */
export function isSlotConfigured(slot: RateSlot): boolean {
  const spec = providerSpecifier(slot);
  if (spec === DISABLED) return false;
  return spec !== null || BUILTIN[slot] !== undefined;
}

/**
 * Three forms, resolved in this order:
 *
 *   official                      →  <cwd>/providers/official/index.mjs
 *   ./my-sources/x.mjs            →  relative to the working directory
 *   /app/providers/x/index.mjs    →  as-is
 *
 * The first is the recommended one, on purpose: the same value `official` works
 * in `next dev` (cwd = repo root) and inside the container (cwd = /app). With
 * absolute paths you would need two different values in two env files, which is
 * exactly what falls out of sync and nobody notices until a rate is missing.
 */
function resolveSpecifier(spec: string): string {
  /*
   * `process.cwd()` goes by index and not by dot.
   *
   * Turbopack traces `path.resolve(process.cwd(), …)`, concludes the whole
   * project directory is a dependency and starts walking it looking for what to
   * include. On a normal install that is merely slow; with the Postgres volume
   * inside the project — and owned by root — it blows up the build with a
   * permission denied. None of this belongs in the bundle: the path is resolved
   * at start-up, reading the disk.
   */
  const cwd = process["cwd"]();
  if (spec.startsWith("/")) return spec;
  if (spec.startsWith(".")) return `${cwd}/${spec.replace(/^\.\//, "")}`;
  return `${cwd}/providers/${spec}/index.mjs`;
}

/**
 * Importing for real at run time, opaque to the bundler.
 *
 * `import(variable)` does not work here even with the magic comments: Turbopack
 * ignored them and treated the call as a directory reference, walking the whole
 * project looking for candidates — the Postgres data directory included, which
 * back then lived in here and was owned by root — until the build blew up with a
 * permission denied. And even if it hadn't, bundling the source would be exactly
 * the opposite of the point.
 *
 * Building the function with `new Function` keeps it out of static analysis. And
 * the string is split because Turbopack finds the `import(` even inside a text
 * literal: with the whole word it kept trying to resolve it.
 *
 * It is ugly on purpose, and that is why it carries this comment above it. If
 * the bundler ever offers a declared way to say «this loads at run time», this
 * gets replaced by it.
 */
const importAtRuntime = new Function(
  "u",
  // The name is assembled at run time. Splitting the string in two is not even
  // enough: Turbopack folds constants and finds the word again.
  `return ${String.fromCharCode(105, 109, 112, 111, 114, 116)}(u)`,
) as (url: string) => Promise<Record<string, unknown>>;

const cache = new Map<RateSlot, RateProvider | null>();

export async function providerFor(slot: RateSlot): Promise<RateProvider | null> {
  const cached = cache.get(slot);
  if (cached !== undefined) return cached;

  const spec = providerSpecifier(slot);
  if (spec === DISABLED) {
    cache.set(slot, null);
    return null;
  }
  if (!spec) {
    const builtin = BUILTIN[slot] ?? null;
    cache.set(slot, builtin);
    return builtin;
  }

  const file = resolveSpecifier(spec);
  try {
    const mod = await importAtRuntime(pathToFileURL(file).href);
    const read = (mod?.default ?? mod?.read) as RateReader | undefined;
    if (typeof read !== "function") {
      console.warn(`[rates] ${file} exports no function (default or read); slot ${slot} left empty.`);
      return null;
    }
    const provider: RateProvider = { id: slot, read };
    cache.set(slot, provider);
    return provider;
  } catch (err) {
    // Telling "could not be read" from "none configured": with a read-only
    // mount, a badly set permission looks exactly like an empty slot, and that
    // is half an hour spent looking in the wrong place.
    /*
     * The failure is NOT cached, unlike the success.
     *
     * The module arrives through a volume mounted at the same time the container
     * starts, so the first attempt may fail on races that resolve themselves.
     * And fixing a syntax error and saving ought to be enough. Caching the
     * failure left the slot dead until a restart, with the screen saying "no
     * answer" forever.
     */
    console.warn(
      `[rates] could not load the ${slot} source from ${file}: ${(err as Error).message}`,
    );
    return null;
  }
}

/** For the tests and for `rates:check` only, which re-read after changing the env. */
export function forgetProviders(): void {
  cache.clear();
}
