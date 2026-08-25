import { createTranslator } from "use-intl/core";

import { DEFAULT_LOCALE, type Locale } from "./config";
import enUi from "./messages/en/ui.json";
import enDomain from "./messages/en/domain.json";
import enServices from "./messages/en/services.json";
import enApi from "./messages/en/api.json";
import esUi from "./messages/es/ui.json";
import esDomain from "./messages/es/domain.json";
import esServices from "./messages/es/services.json";
import esApi from "./messages/es/api.json";

/**
 * A translator for everything that is NOT the React tree.
 *
 * Services, API routes, the heartbeat and the seed all need to word a sentence,
 * and none of them has a request to read the language from — the heartbeat runs
 * on a timer with nobody connected. They get the locale handed to them, the same
 * way they already get `baseCurrency` and `timezone`.
 *
 * It goes through `use-intl/core` and not through `next-intl` on purpose.
 * `next-intl`'s `exports` resolves to its client build when there is no
 * `react-server` condition — which is the case under `tsx --test`, under
 * `src/instrumentation.ts` and under `scripts/seed.ts` — so importing it here
 * would drag React into the heartbeat and into the whole test suite. Same
 * catalogue, same ICU engine, no request scope.
 */
const CATALOGUES = {
  en: { ui: enUi, domain: enDomain, services: enServices, api: enApi },
  es: { ui: esUi, domain: esDomain, services: esServices, api: esApi },
} as const;

export type Messages = (typeof CATALOGUES)["en"];

/** Everything a locale has. Used by the translator and by the type augmentation. */
export function messagesFor(locale: Locale): Messages {
  return CATALOGUES[locale] ?? CATALOGUES[DEFAULT_LOCALE];
}

/**
 * What crosses to the browser: `ui` and `domain` only.
 *
 * `services` and `api` are worded on the server and travel already rendered, so
 * shipping them would put ~250 messages into every page's payload for nothing.
 * There is a test that fails if a `"use client"` file imports them.
 */
export function clientMessages(locale: Locale) {
  const { ui, domain } = messagesFor(locale);
  return { ui, domain };
}

const cache = new Map<Locale, ReturnType<typeof createTranslator>>();

/**
 * Synchronous and memoised, so a service stays as synchronous as it is today.
 *
 * The catalogues are imported statically — `resolveJsonModule` is already on —
 * so there is nothing to await and nothing to read from disk at run time.
 */
export function getTranslator(locale: Locale) {
  const hit = cache.get(locale);
  if (hit) return hit;
  const t = createTranslator({ locale, messages: messagesFor(locale) });
  cache.set(locale, t);
  return t;
}
