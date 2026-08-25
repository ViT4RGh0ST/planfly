import type { PeriodRef } from "@/lib/dates";

/**
 * Naming a period, in the language the caller is answering in.
 *
 * `resolvePeriod` used to return the name already written — «el mes pasado» —
 * and that string travelled into the `summary` the bot repeats out loud. A date
 * library cannot know which language it is being asked in; whoever answers does.
 *
 * `t` is whichever translator the caller already has: `getTranslations()` inside
 * the React tree, `getTranslator(locale)` outside it. Both take the same keys
 * over the same catalogue, so this works on either side without knowing which.
 */
type Translate = (key: string, values?: Record<string, string>) => string;

/** The prose form: «last month», «the last 7 days». Reads inside a sentence. */
export function periodName(t: Translate, ref: PeriodRef): string {
  const key = `domain.period.name.${ref.key}`;
  if (ref.key === "year") return t(key, { year: ref.year });
  if (ref.key === "named_month" || ref.key === "day") return t(key, { value: ref.value });
  if (ref.key === "range") return t(key, { start: ref.start, end: ref.end });
  return t(key);
}
