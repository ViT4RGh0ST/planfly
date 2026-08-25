/**
 * Which languages exist, and how a stored value becomes one of them.
 *
 * The list lives here and nowhere else: adding a third language should be this
 * array plus a catalogue folder, with no migration — which is why
 * `households.locale` is `text` and not a Postgres enum.
 */
export const LOCALES = ["en", "es"] as const;

export type Locale = (typeof LOCALES)[number];

/**
 * English, and not Spanish.
 *
 * It is what a fresh install starts at, so whoever clones the repository can
 * read it. Installations that already existed keep Spanish because the migration
 * wrote it onto their row, not because of this constant.
 */
export const DEFAULT_LOCALE: Locale = "en";

/**
 * Anything that is not a language we have becomes the default.
 *
 * The column is free text and the value also arrives from an `Accept-Language`
 * header on the login page, where there is no session yet. Neither can be
 * trusted to be one of ours, and falling back is the only behaviour that never
 * leaves a screen without words.
 */
export function normalizeLocale(value: string | null | undefined): Locale {
  if (!value) return DEFAULT_LOCALE;
  const head = value.split(",")[0]?.trim().toLowerCase() ?? "";
  const short = head.split("-")[0];
  return (LOCALES as readonly string[]).includes(short) ? (short as Locale) : DEFAULT_LOCALE;
}
