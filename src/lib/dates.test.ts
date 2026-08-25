import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  addDays,
  canonicalPeriod,
  biweeklyPeriod,
  budgetPeriod,
  dateInTimezone,
  daysBetween,
  formatDay,
  formatDayYear,
  formatLongDay,
  instantAt,
  resolvePeriod,
  startOfMonth,
  startOfNextMonth,
} from "./dates";

describe("formatDay", () => {
  it("writes the date the way it reads in each language", () => {
    assert.equal(formatDay("2026-08-13", "es"), "13 ago.");
    assert.equal(formatDay("2026-08-13", "en"), "13 Aug");
  });

  it("doesn't fall over on something that isn't a date", () => {
    // Recharts calls axis formatters with whatever it has; if this threw, the
    // whole chart would come down and not just one label.
    assert.equal(formatDay("08-13", "es"), "08-13");
    assert.equal(formatDay(123 as unknown as string, "es"), "123");
  });

  it("reads the day in UTC, not in local time", () => {
    // In Caracas (UTC-4), `new Date("2026-08-13")` printed locally gives the 12th.
    // It is checked in both languages because the `Date.UTC` trick is shared, and
    // whoever simplifies it would break every date in the app by one day.
    assert.equal(formatDay("2026-08-01", "es"), "1 ago.");
    assert.equal(formatDay("2026-08-01", "en"), "1 Aug");
  });
})

/**
 * The edges of the periods.
 *
 * Everything this file returns is a **half-open** range `[from, to)`, and from
 * that comes the only way of going wrong that matters: a short `to` discards the
 * last day of the month and that day's spending disappears from the report with
 * nothing failing. The figure comes out credible and smaller.
 */
describe("the edges of a period", () => {
  it("a month runs from the 1st to the 1st of the next, without eating the last day", () => {
    assert.equal(startOfMonth("2026-08-21"), "2026-08-01");
    assert.equal(startOfNextMonth("2026-08-21"), "2026-09-01");
    // A 31st of August has to fall INSIDE August: `to` is exclusive.
    assert.ok("2026-08-31" < startOfNextMonth("2026-08-21"));
  });

  it("February and the 30-day months need no special case", () => {
    assert.equal(startOfNextMonth("2026-02-14"), "2026-03-01");
    assert.equal(startOfNextMonth("2028-02-29"), "2028-03-01", "un bisiesto tampoco");
    assert.equal(startOfNextMonth("2026-04-30"), "2026-05-01");
    assert.equal(startOfNextMonth("2026-12-05"), "2027-01-01", "and December changes the year");
  });

  it("adding days crosses months and years without homemade arithmetic", () => {
    assert.equal(addDays("2026-08-31", 1), "2026-09-01");
    assert.equal(addDays("2026-01-01", -1), "2025-12-31");
    assert.equal(addDays("2028-02-28", 1), "2028-02-29");
  });

  it("the distance between two days is in days, not milliseconds", () => {
    assert.equal(daysBetween("2026-08-01", "2026-08-21"), 20);
    assert.equal(daysBetween("2026-08-21", "2026-08-01"), -20, "y tiene signo");
    assert.equal(daysBetween("2026-08-21", "2026-08-21"), 0);
  });

  it("the fortnight splits the month at the 15th, and the second one reaches month end", () => {
    // The rhythm at which people are paid and financed here. It matters that the
    // second ends on the 1st of the next and not on the 30th: in a 31-day month a
    // day's spending would be lost from every fortnightly report.
    const first = biweeklyPeriod("2026-08-07");
    assert.deepEqual([first.from, first.to], ["2026-08-01", "2026-08-16"]);

    const second = biweeklyPeriod("2026-08-21");
    assert.deepEqual([second.from, second.to], ["2026-08-16", "2026-09-01"]);

    // The 15th belongs to the first and the 16th to the second: no shared border.
    assert.equal(biweeklyPeriod("2026-08-15").to, "2026-08-16");
    assert.equal(biweeklyPeriod("2026-08-16").from, "2026-08-16");
  });

  it("a budget's period comes from its kind, not from the calendar", () => {
    // Day 12 is 39% of a month and 80% of a fortnight. Confusing them turns an
    // alarm into calm.
    assert.deepEqual(budgetPeriod("monthly", "2026-08-21").from, "2026-08-01");
    assert.deepEqual(budgetPeriod("biweekly", "2026-08-21").from, "2026-08-16");
    assert.deepEqual(budgetPeriod("yearly", "2026-08-21").from, "2026-01-01");
    assert.deepEqual(budgetPeriod("yearly", "2026-08-21").to, "2027-01-01");
  });

  it("a hand-written period is understood, and the range is given inclusive", () => {
    // Whoever writes it says «from the 1st to the 15th» meaning both included;
    // inside it is stored half-open. Without the +1, the 15th would not count.
    const r = resolvePeriod("2026-08-01..2026-08-15", "America/Caracas");
    assert.deepEqual([r.from, r.to], ["2026-08-01", "2026-08-16"]);

    const month = resolvePeriod("2026-07", "America/Caracas");
    assert.deepEqual([month.from, month.to], ["2026-07-01", "2026-08-01"]);

    const day = resolvePeriod("2026-08-21", "America/Caracas");
    assert.deepEqual([day.from, day.to], ["2026-08-21", "2026-08-22"]);
  });

  it("what can't be parsed falls back to the current month, not to an empty range", () => {
    // An empty range would give zero spending, which reads as «you spent nothing»
    // instead of «I did not understand you».
    const r = resolvePeriod("la semana del pescado", "America/Caracas");
    assert.deepEqual(r.ref, { key: "month" });
    assert.ok(r.from < r.to, "and the range has something in it");
  });

  it("every Spanish token resolves exactly like its canonical key", () => {
    /*
     * The most dangerous line of the whole translation, because the failure has
     * the right shape. The API took these spellings from day one, the installed
     * plugin still sends them, and they live in bot conversations already under
     * way. Losing one would not throw: `resolvePeriod` would fall through to its
     * default and answer about THE CURRENT MONTH, in silence and with a
     * perfectly formed summary, for a question about last month.
     *
     * Hence a table and not a handful of cases: whoever adds a canonical key
     * tomorrow and forgets its alias fails here and not in somebody's chat.
     */
    const ALIASES: Array<[string, string]> = [
      ["hoy", "today"],
      ["ayer", "yesterday"],
      ["semana", "week"],
      ["mes", "month"],
      ["este_mes", "month"],
      ["mes_pasado", "last_month"],
      ["anio", "year"],
      ["año", "year"],
      ["este_anio", "year"],
    ];

    for (const [spanish, canonical] of ALIASES) {
      const old = resolvePeriod(spanish, "America/Caracas");
      const now = resolvePeriod(canonical, "America/Caracas");
      assert.deepEqual(
        old,
        now,
        `«${spanish}» no longer resolves like «${canonical}»: the bot would be ` +
          `answered about a different period without anything failing.`,
      );
    }

    // Written with spaces or in capitals, the way a person types it into the URL.
    assert.deepEqual(resolvePeriod("  MES_PASADO ", "America/Caracas").ref, {
      key: "last_month",
    });

    // `all` is not a range and does not resolve: whoever offers it compares it
    // BEFORE asking for one. The canonical form is what they compare against.
    assert.equal(canonicalPeriod("todo"), "all");
    assert.equal(canonicalPeriod("all"), "all");
    assert.equal(canonicalPeriod(undefined), "month");
  });

  it("today depends on the household's timezone, not the server's", () => {
    // A 21:00 expense in Caracas is 01:00 the next day in UTC. Recorded with the
    // wrong timezone, it lands in the wrong month.
    const nightInCaracas = new Date("2026-08-31T23:30:00-04:00");
    assert.equal(dateInTimezone("America/Caracas", nightInCaracas), "2026-08-31");
    assert.equal(dateInTimezone("UTC", nightInCaracas), "2026-09-01", "el mismo instante, otro mes");
  });

  it("a time of day is anchored in the household's timezone", () => {
    // 9:00 in Caracas is 13:00 UTC. It is what decides when an installment alert
    // goes out, and with the wrong timezone it arrives in the small hours.
    const t = instantAt("2026-08-21", 9, 0, "America/Caracas");
    assert.equal(t.toISOString(), "2026-08-21T13:00:00.000Z");
  });
});

describe("a locale the column should not hold", () => {
  it("does not take the screen down", () => {
    /*
     * `households.locale` is `text` — adding Portuguese tomorrow should be a
     * catalogue file, not a migration — so nothing at the database level stops
     * a row saying «english». `Intl.DateTimeFormat` does not fall back on that:
     * it throws a RangeError, and it would throw from inside the dashboard, the
     * entry table and every correction that reports a date.
     */
    for (const junk of ["english", "", "es_VE", "zz-ZZ"]) {
      assert.doesNotThrow(() => formatDay("2026-08-13", junk), junk || "(empty)");
      assert.doesNotThrow(() => formatDayYear("2026-08-13", junk), junk || "(empty)");
      assert.doesNotThrow(() => formatLongDay("2026-08-13", junk), junk || "(empty)");
    }
    // And it falls back to the default language, not to something unreadable.
    assert.equal(formatDay("2026-08-13", "english"), formatDay("2026-08-13", "en"));
  });
});
