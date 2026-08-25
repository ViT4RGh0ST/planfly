/**
 * When it comes round again.
 *
 * Everything is expressed as **days of the month**, the fortnight and the month
 * included:
 *
 *   - monthly       → [1]
 *   - fortnightly   → [15, LAST]
 *   - your own way  → [5, 20] · [1, 10, 20] · whatever
 *
 * One model instead of three. The alternative — «every N days» — was discarded
 * because it is not how people get paid or pay here: the rent is due on the 5th,
 * not every 30 days, and after three months «every 30 days» has already drifted
 * off the calendar.
 */

/** The last day of the month, whichever it is. Stored this way because 28, 30 and 31 vary. */
export const LAST_DAY = -1;

function daysInMonth(year: number, month: number): number {
  // Day 0 of the next month = last of the current one. `month` is 1-12.
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * The days that actually land in THAT month, sorted and without duplicates.
 *
 * Two adjustments that avoid holes and duplicates:
 *
 *   - **It clamps, it doesn't skip.** «The 31st» in February is the 28th: a bill
 *     due at month end is due in February all the same, and skipping the month
 *     would stop charging it. So any day beyond the last is clamped to the last.
 *   - **And that is why duplicates have to go**: [30, 31] in February would
 *     clamp both to the 28th and produce two entries where there was one.
 */
export function daysForMonth(daysOfMonth: number[], year: number, month: number): number[] {
  const last = daysInMonth(year, month);
  const resolved = daysOfMonth.map((d) => (d === LAST_DAY || d > last ? last : Math.max(1, d)));
  return [...new Set(resolved)].sort((a, b) => a - b);
}

function iso(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * The next date it is due, counting from `from` **inclusive**.
 *
 * Inclusive on purpose: if today is the 5th and the rule is the 5th, today is
 * the day. The caller wanting «the next one» passes the day after.
 */
export function nextOccurrence(daysOfMonth: number[], from: string): string | null {
  if (daysOfMonth.length === 0) return null;

  let [year, month, day] = from.split("-").map(Number);

  // Thirteen turns: twelve months cover any combination of days, and the
  // thirteenth is the margin for the current month already under way.
  for (let i = 0; i < 13; i++) {
    for (const candidate of daysForMonth(daysOfMonth, year, month)) {
      if (i > 0 || candidate >= day) return iso(year, month, candidate);
    }
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
    day = 1;
  }
  return null;
}

/**
 * Every date it was due on, from `from` to `to`, both included.
 *
 * It is what makes catching up possible. If the machine was off for two weeks,
 * the two fortnights that passed genuinely happened: the rent was owed all the
 * same, and recording only the last would leave the month short without saying so.
 *
 * The cap exists because a rule created with an old date by mistake would
 * generate hundreds of entries at once; the caller reports what was clamped.
 */
export function occurrencesBetween(
  daysOfMonth: number[],
  from: string,
  to: string,
  limit = 24,
): string[] {
  const out: string[] = [];
  let cursor: string | null = from;

  while (cursor && cursor <= to && out.length < limit) {
    const hit: string | null = nextOccurrence(daysOfMonth, cursor);
    if (!hit || hit > to) break;
    out.push(hit);
    const [y, m, d] = hit.split("-").map(Number);
    cursor = iso(y, m, d + 1 > daysInMonth(y, m) ? d : d + 1);
    // If the day was the last of the month, we have to jump to the next by hand.
    if (cursor === hit) {
      cursor = m === 12 ? iso(y + 1, 1, 1) : iso(y, m + 1, 1);
    }
  }
  return out;
}
