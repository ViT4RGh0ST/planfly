import { normalizeLocale } from "@/i18n/config";

/**
 * Dates in the household's timezone.
 *
 * Caracas is UTC-4 with no daylight saving. A 21:00 expense recorded with
 * `new Date().toISOString().slice(0,10)` lands on the NEXT day — that is, "how
 * much did I spend today?" is wrong every night. That is why no domain date is
 * computed in UTC: they all come through here.
 */

const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function formatter(timezone: string): Intl.DateTimeFormat {
  let f = FORMATTERS.get(timezone);
  if (!f) {
    // en-CA formats exactly as YYYY-MM-DD.
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    FORMATTERS.set(timezone, f);
  }
  return f;
}

/** 'YYYY-MM-DD' of the given instant, read in the household's timezone. */
export function dateInTimezone(timezone: string, instant: Date = new Date()): string {
  return formatter(timezone).format(instant);
}

export function today(timezone: string): string {
  return dateInTimezone(timezone);
}

/** First day of an ISO date's month. */
export function startOfMonth(isoDate: string): string {
  return `${isoDate.slice(0, 7)}-01`;
}

/** First day of the next month — a monthly range's exclusive upper bound. */
export function startOfNextMonth(isoDate: string): string {
  const year = Number(isoDate.slice(0, 4));
  const month = Number(isoDate.slice(5, 7));
  const next = month === 12 ? { y: year + 1, m: 1 } : { y: year, m: month + 1 };
  return `${next.y}-${String(next.m).padStart(2, "0")}-01`;
}

/** The zone's offset from UTC, in milliseconds, at a given instant. */
function offsetMs(timezone: string, at: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);

  const p: Record<string, string> = {};
  for (const part of parts) p[part.type] = part.value;

  // `hour` may come back as "24" at midnight depending on the engine.
  const asUtc = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour) % 24,
    Number(p.minute),
    Number(p.second),
  );
  return asUtc - at.getTime();
}

/**
 * The real instant corresponding to a wall-clock time in a zone.
 *
 * `instantAt("2026-08-10", 8, 0, "America/Caracas")` gives the exact moment when
 * it is 8:00 there. The offset is estimated and corrected once, which is exact
 * in zones without daylight saving — Caracas is one (fixed UTC−4).
 */
export function instantAt(
  isoDate: string,
  hour: number,
  minute: number,
  timezone: string,
): Date {
  const [year, month, day] = isoDate.split("-").map(Number);
  const guess = new Date(Date.UTC(year, month - 1, day, hour, minute));
  return new Date(guess.getTime() - offsetMs(timezone, guess));
}

export function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T12:00:00Z`); // midday: immune to zone jumps
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T12:00:00Z`);
  const b = Date.parse(`${to}T12:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

/**
 * A half-open range, plus what period it IS.
 *
 * `ref` and not `label`: naming it is the caller's job, because only the caller
 * knows which language it is answering in. `budgetPeriod` fills it too, so both
 * producers of a range describe it the same way.
 */
export type DateRange = { from: string; to: string; ref: PeriodRef };

/**
 * The fortnight containing that date.
 *
 * The 1st to the 15th and the 16th to month end: it is not an arbitrary split in
 * two, it is the rhythm at which people get paid in Venezuela, and therefore the
 * rhythm at which they spend. A monthly budget for someone paid fortnightly
 * always arrives late: you find out you overspent when there is no fortnight
 * left to correct.
 */
export function biweeklyPeriod(isoDate: string): DateRange {
  const day = Number(isoDate.slice(8, 10));
  const monthStart = startOfMonth(isoDate);

  if (day <= 15) {
    return { from: monthStart, to: addDays(monthStart, 15), ref: { key: "first_fortnight" } };
  }
  return {
    from: addDays(monthStart, 15),
    to: startOfNextMonth(isoDate),
    ref: { key: "second_fortnight" },
  };
}

export type BudgetPeriod = "monthly" | "biweekly" | "yearly" | "custom";

/** A budget's period in force, according to its kind. */
export function budgetPeriod(period: BudgetPeriod, isoDate: string): DateRange {
  if (period === "biweekly") return biweeklyPeriod(isoDate);
  if (period === "yearly") {
    const year = isoDate.slice(0, 4);
    return { from: `${year}-01-01`, to: `${Number(year) + 1}-01-01`, ref: { key: "year", year } };
  }
  // `custom` is not computed: the user chose its dates and they live on the row.
  return { from: startOfMonth(isoDate), to: startOfNextMonth(isoDate), ref: { key: "month" } };
}

/**
 * What a resolved period IS, without saying it in any language.
 *
 * `resolvePeriod` used to return a `label` — "el mes pasado" — and that string
 * travelled all the way into the `summary` the bot repeats. A date library that
 * writes prose is the cause; that its prose ends up inside an API response is
 * only the symptom.
 *
 * The key is what the two consumers translate; the extra fields are what their
 * message interpolates.
 */
export type PeriodRef =
  | { key: "today" | "yesterday" | "week" | "month" | "last_month" }
  // Never returned by `resolvePeriod`: `all` is the absence of a range, and
  // whoever offers it still has to name it on screen.
  | { key: "all" }
  | { key: "first_fortnight" | "second_fortnight" }
  | { key: "year"; year: string }
  | { key: "named_month" | "day"; value: string }
  | { key: "range"; start: string; end: string };

/**
 * The Spanish tokens the API accepted from day one. They stay FOREVER.
 *
 * The installed plugin sends them, and they live inside bot conversations that
 * are already under way. Removing one would not give an error: `resolvePeriod`
 * would fall through to its default and return THE CURRENT MONTH, in silence,
 * for a question about last month. The API would answer 200 with a perfectly
 * formed summary about the wrong month, and the bot would repeat it.
 *
 * That is the most dangerous line in this whole change, because the failure has
 * the right shape. There is a table-driven test asserting that each alias gives
 * a `{from, to}` identical to its canonical key.
 */
const PERIOD_ALIASES: Record<string, string> = {
  hoy: "today",
  ayer: "yesterday",
  semana: "week",
  mes: "month",
  este_mes: "month",
  mes_pasado: "last_month",
  anio: "year",
  "año": "year",
  este_anio: "year",
  todo: "all",
};

/** The canonical keys, for whoever offers them as options. */
export const PERIOD_KEYS = ["today", "week", "month", "last_month", "year", "all"] as const;

/**
 * The canonical form of whatever arrived, alias table applied.
 *
 * `all` is the one token `resolvePeriod` cannot interpret, because it is not a
 * range: it is the absence of one. Whoever offers it has to compare against it
 * BEFORE asking for a range, and this is what lets them compare against one
 * spelling instead of two.
 */
export function canonicalPeriod(period: string | undefined): string {
  const raw = (period ?? "month").trim().toLowerCase();
  return PERIOD_ALIASES[raw] ?? raw;
}

/**
 * Interprets the periods people (and the bot) write and returns a half-open
 * range [from, to). Half-open so nobody has to subtract a day or worry about the
 * time of the last entry.
 *
 * It returns a `ref` and not a label: naming the period is the caller's job,
 * because only the caller knows which language it is answering in.
 */
export function resolvePeriod(period: string | undefined, timezone: string): DateRange {
  const todayIso = today(timezone);
  const p = canonicalPeriod(period);

  if (p === "today") return { from: todayIso, to: addDays(todayIso, 1), ref: { key: "today" } };
  if (p === "yesterday") {
    const yesterday = addDays(todayIso, -1);
    return { from: yesterday, to: todayIso, ref: { key: "yesterday" } };
  }
  if (p === "week") {
    return { from: addDays(todayIso, -6), to: addDays(todayIso, 1), ref: { key: "week" } };
  }
  if (p === "month") {
    return { from: startOfMonth(todayIso), to: startOfNextMonth(todayIso), ref: { key: "month" } };
  }
  if (p === "last_month") {
    const thisMonthStart = startOfMonth(todayIso);
    const dayBefore = addDays(thisMonthStart, -1);
    return { from: startOfMonth(dayBefore), to: thisMonthStart, ref: { key: "last_month" } };
  }
  if (p === "year") {
    const year = todayIso.slice(0, 4);
    return {
      from: `${year}-01-01`,
      to: `${Number(year) + 1}-01-01`,
      ref: { key: "year", year },
    };
  }

  // 'YYYY-MM'
  if (/^\d{4}-\d{2}$/.test(p)) {
    return { from: `${p}-01`, to: startOfNextMonth(`${p}-01`), ref: { key: "named_month", value: p } };
  }
  // 'YYYY-MM-DD..YYYY-MM-DD' (inclusive on the way in, half-open on the way out)
  const range = p.match(/^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/);
  if (range) {
    return {
      from: range[1],
      to: addDays(range[2], 1),
      ref: { key: "range", start: range[1], end: range[2] },
    };
  }
  // a lone 'YYYY-MM-DD'
  if (/^\d{4}-\d{2}-\d{2}$/.test(p)) {
    return { from: p, to: addDays(p, 1), ref: { key: "day", value: p } };
  }

  // No reading possible: the current month is the least surprising default. An
  // empty range would give zero spending, which reads as «you spent nothing»
  // instead of «I did not understand you».
  return { from: startOfMonth(todayIso), to: startOfNextMonth(todayIso), ref: { key: "month" } };
}

/**
 * Which BCP-47 tag each of our languages formats with.
 *
 * `es` alone is not the same as `es-VE`: plain `es` writes "13 ago" and `es-VE`
 * writes "13 ago." — with the abbreviation's dot, which is the one Spanish uses
 * to close a sentence and which `net-worth.tsx` reads to decide whether to add a
 * full stop. Dropping the region silently removed it.
 *
 * English uses `en-GB` and not `en-US`: day before month, the same order as
 * Spanish. Every listing in the app was laid out around that shape, and flipping
 * it per language would move the columns underneath the reader for nothing.
 */
const DATE_TAGS: Record<string, string> = { es: "es-VE", en: "en-GB" };

/**
 * One formatter per language, built on first use.
 *
 * `Intl.DateTimeFormat` is expensive to construct and this runs once per row of
 * every listing, so the instances are kept. The map is keyed by locale and not
 * by anything else: the timezone below is always UTC, deliberately.
 */
const DAY_FORMATS = new Map<string, Intl.DateTimeFormat>();

/**
 * The BCP-47 tag to format with, from whatever the column holds.
 *
 * `households.locale` is `text` on purpose — adding Portuguese tomorrow should
 * be a catalogue file, not a migration — so nothing stops a row saying
 * `english`. `Intl.DateTimeFormat("english")` does not fall back: it throws a
 * `RangeError`, and it would throw from inside the dashboard, the entry table
 * and every correction that reports a date. Normalising here closes it for the
 * three formatters at once, and keeps their caches from being keyed by junk.
 */
function tagFor(locale: string): string {
  return DATE_TAGS[normalizeLocale(locale)];
}

function dayFormat(raw: string): Intl.DateTimeFormat {
  const locale = normalizeLocale(raw);
  const hit = DAY_FORMATS.get(locale);
  if (hit) return hit;
  const made = new Intl.DateTimeFormat(tagFor(locale), {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
  DAY_FORMATS.set(locale, made);
  return made;
}

/**
 * An ISO date as it reads on screen: "13 ago." in Spanish, "13 Aug" in English.
 *
 * It was written five times — financier list, installment list, product list,
 * price chart and net position — with the same formatter and the same trick
 * below, which is the part that actually matters: `new Date("2026-08-13")` is
 * interpreted in UTC but printed in the local zone, and in Caracas (UTC-4) that
 * shows the PREVIOUS day. Splitting the string and composing with `Date.UTC` is
 * what keeps an installment from saying it fell due a day before it did. That
 * `Date.UTC` is not an implementation detail to be tidied away: without it every
 * date in the app slides back one day.
 *
 * The locale is a REQUIRED argument and not a default. With a default, adding a
 * language would silently leave eighty-two call sites formatting in the old one;
 * required, the compiler lists them.
 *
 * Note the asymmetry with money: amounts do not follow the language (see
 * `money.ts`) and dates do. A figure gets compared against a bank statement; a
 * date gets read.
 */
const YEAR_DAY_FORMATS = new Map<string, Intl.DateTimeFormat>();

/**
 * The same date with its year: "13 ago. 2026" / "13 Aug 2026".
 *
 * The product's price history spans years, and there a "13 ago." beside another
 * "13 ago." says nothing. It used to be a private copy inside
 * `products/[id]/page.tsx` with `es-VE` hard-coded and no guard for a
 * non-date — the very copy that made `formatDay` shared in the first place.
 */
export function formatDayYear(isoDate: string, raw: string): string {
  if (!/^\d{4}-\d{2}-\d{2}/.test(String(isoDate))) return String(isoDate);
  const locale = normalizeLocale(raw);
  let made = YEAR_DAY_FORMATS.get(locale);
  if (!made) {
    made = new Intl.DateTimeFormat(tagFor(locale), {
      day: "numeric",
      month: "short",
      year: "numeric",
      timeZone: "UTC",
    });
    YEAR_DAY_FORMATS.set(locale, made);
  }
  const [y, m, d] = isoDate.split("-").map(Number);
  return made.format(new Date(Date.UTC(y, m - 1, d)));
}

const LONG_DAY_FORMATS = new Map<string, Intl.DateTimeFormat>();

/**
 * The same date, written out in full: "domingo, 23 de agosto" / "Sunday, 23 August".
 *
 * The dashboard's header, and the only place it is needed. Same `Date.UTC`
 * trick as `formatDay` and for the same reason: without it the day goes back
 * one in any timezone west of Greenwich.
 */
export function formatLongDay(isoDate: string, raw: string): string {
  const locale = normalizeLocale(raw);
  let made = LONG_DAY_FORMATS.get(locale);
  if (!made) {
    made = new Intl.DateTimeFormat(tagFor(locale), {
      weekday: "long",
      day: "numeric",
      month: "long",
      timeZone: "UTC",
    });
    LONG_DAY_FORMATS.set(locale, made);
  }
  const [y, m, d] = isoDate.split("-").map(Number);
  return made.format(new Date(Date.UTC(y, m - 1, d)));
}

export function formatDay(isoDate: string, locale: string): string {
  // Returns the input as-is if it is not an ISO date. Recharts calls axis
  // formatters with whatever it has to hand, and a `split` over something that
  // is not a date threw: it was not an odd label, the whole chart came down. It
  // happened on /rates and only at 900px, where the axis recomputes its ticks.
  if (!/^\d{4}-\d{2}-\d{2}/.test(String(isoDate))) return String(isoDate);
  const [y, m, d] = isoDate.split("-").map(Number);
  return dayFormat(locale).format(new Date(Date.UTC(y, m - 1, d)));
}
