import { and, eq, or, sql } from "drizzle-orm";

import { db } from "@/db";
import { currencies, exchangeRates } from "@/db/schema";
import { DEFAULT_LOCALE, normalizeLocale } from "@/i18n/config";
import { getTranslator } from "@/i18n/translator";
import { daysBetween } from "@/lib/dates";
import { providerFor } from "./load-provider";
import { normalizeReading, type RateSlot } from "./provider";

/** How many days apart we accept before distrusting a rate. */
const STALE_TOLERANCE_DAYS = 3;

export type ResolvedRate = {
  id: string;
  value: string; // NUMERIC as a string, never a float
  effectiveOn: string;
  stale: boolean;
  /** A person wrote it in /rates; it came from no source. */
  manual: boolean;
  /**
   * Whether this pair's rate goes out of date at all.
   *
   * `STALE_TOLERANCE_DAYS` is calibrated for the bolívar, which moves every
   * day. Applied to a pair that does not move — a dollar stablecoin against the
   * dollar — it calls «old» something that cannot age, and the entry lands in
   * the review tray asking for a rate that would always be the same number.
   *
   * It is a property of the pair, and it lives on the quote currency because
   * there is one base per installation. `currencies.rate_ages`.
   */
  ages: boolean;
};

export type DailyRates = {
  bcv: ResolvedRate | null;
  p2p: ResolvedRate | null;
};

/** Stores (or updates) a rate. Idempotent by (pair, source, variant, date). */
export async function saveRate(params: {
  baseCurrency: string;
  quoteCurrency: string;
  source: "bcv" | "p2p" | "manual";
  variant?: string;
  value: number | string;
  effectiveOn: string;
  raw?: unknown;
}): Promise<string> {
  const variant = params.variant ?? "default";
  // The value goes as a string into a NUMERIC: putting it through a float would
  // lose decimals exactly where they matter most.
  const value = typeof params.value === "number" ? params.value.toFixed(10) : params.value;

  const [row] = await db
    .insert(exchangeRates)
    .values({
      baseCurrency: params.baseCurrency,
      quoteCurrency: params.quoteCurrency,
      source: params.source,
      variant,
      rate: value,
      effectiveOn: params.effectiveOn,
      raw: params.raw ?? null,
    })
    .onConflictDoUpdate({
      target: [
        exchangeRates.baseCurrency,
        exchangeRates.quoteCurrency,
        exchangeRates.source,
        exchangeRates.variant,
        exchangeRates.effectiveOn,
      ],
      set: { rate: value, observedAt: new Date(), raw: params.raw ?? null },
    })
    .returning({ id: exchangeRates.id });

  return row.id;
}

/**
 * Looks up a source's rate for a date in the database.
 *
 * The one with the CLOSEST value date is picked, preferring earlier ones or the
 * same day. The forward tie-break is not a whim: **the BCV publishes with a
 * future value date**. On a Tuesday afternoon Wednesday's is already out, and on
 * Friday Monday's is published. With a plain `<= date`, the first expense of the
 * day on a fresh install would find no BCV rate at all, even though we had just
 * downloaded it.
 *
 * It never invents or interpolates: an approximate rate stamped onto a real
 * entry is worse than admitting we don't have one.
 */
/**
 * Whether a currency's rate against the base goes out of date.
 *
 * Read from the row and not from a list in the code: which currencies move is a
 * property of the world, not of this file, and a list here would be a second
 * place to keep in step with the `currencies` table.
 *
 * An unknown currency ages, which is the safe answer: at worst it asks for a
 * rate that already exists.
 */
async function rateAges(quoteCurrency: string): Promise<boolean> {
  const [row] = await db
    .select({ ages: currencies.rateAges })
    .from(currencies)
    .where(eq(currencies.code, quoteCurrency))
    .limit(1);
  return row?.ages ?? true;
}

async function findStored(
  baseCurrency: string,
  quoteCurrency: string,
  slot: RateSlot,
  date: string,
  ages: boolean,
): Promise<ResolvedRate | null> {
  const [row] = await db
    .select({
      id: exchangeRates.id,
      value: exchangeRates.rate,
      effectiveOn: exchangeRates.effectiveOn,
      source: exchangeRates.source,
    })
    .from(exchangeRates)
    .where(
      and(
        eq(exchangeRates.baseCurrency, baseCurrency),
        eq(exchangeRates.quoteCurrency, quoteCurrency),
        // A slot is filled two ways: with what the source brought
        // (`source = slot`) or with what someone wrote by hand for that same
        // slot (`source = 'manual'`, anchored by `variant`).
        or(
          eq(exchangeRates.source, slot),
          and(eq(exchangeRates.source, "manual"), eq(exchangeRates.variant, slot)),
        ),
      ),
    )
    .orderBy(
      // 0 = same date or earlier (the normal case), 1 = later (a forward value
      // date, which some official sources publish). Within each group, the one
      // closest to the entry's date.
      sql`CASE WHEN ${exchangeRates.effectiveOn} <= ${date} THEN 0 ELSE 1 END`,
      sql`abs(${exchangeRates.effectiveOn} - ${date}::date)`,
      // On the same date the hand-written one rules: someone set it while looking
      // at the screen, and the automatic one is a guess. It comes LAST on purpose —
      // a manual one from three days ago does not beat today's automatic.
      sql`CASE WHEN ${exchangeRates.source} = 'manual' THEN 0 ELSE 1 END`,
      // And with everything equal, by variant name: without this Postgres returns
      // whichever comes up by physical order, and a source publishing two figures
      // for the same day — buy and sell — would change the figure between reloads.
      exchangeRates.variant,
    )
    .limit(1);

  if (!row) return null;

  return {
    id: row.id,
    value: row.value,
    effectiveOn: row.effectiveOn,
    // A pair that does not move is never «from another day»: the badge, the
    // review reason and the flag all read this one field.
    stale: ages && row.effectiveOn !== date,
    manual: row.source === "manual",
    ages,
  };
}

/**
 * Fetches a slot's rate and stores it. Returns null if there is no source or if
 * it fails — **it never throws**.
 *
 * That soft contract is deliberate and holds up everything else: a source being
 * down must never stop an expense being recorded. Upstream it is already written
 * what to do with the hole — the entry is stored without an equivalent and gets
 * flagged for review — so an empty slot is a normal state, not a breakdown.
 */
export async function refreshSlot(
  slot: RateSlot,
  date: string,
  pair: { base: string; quote: string } = { base: "USD", quote: "VES" },
): Promise<ResolvedRate | null> {
  const provider = await providerFor(slot);
  // With no source configured there is nothing to report: the heartbeat comes
  // through here every 15 minutes and one warning per pass would be noise.
  if (!provider) return null;

  const timeoutMs = 15_000;

  try {
    const ctx = { ...pair, date, timeoutMs };
    // A timer of our own ON TOP of the one passed in: a third-party source that
    // does not honour its own would hang the heartbeat, and with it the
    // installment reminders and the recurrences, which run on the same tick.
    // The timer is cleared on the good path too: `resolveRates` comes through
    // here on every entry recorded, and leaving a 16 s timer pending per pass is
    // a slow leak nobody would connect to this.
    let cutoff: ReturnType<typeof setTimeout> | undefined;
    const reading = await Promise.race([
      Promise.resolve(provider.read(ctx)),
      new Promise<never>((_, reject) => {
        cutoff = setTimeout(
          () => reject(new Error(`no answer in ${timeoutMs} ms`)),
          timeoutMs + 1_000,
        );
      }),
    ]).finally(() => clearTimeout(cutoff));

    const quotes = normalizeReading(reading, ctx);

    let mine: ResolvedRate | null = null;
    for (const q of quotes) {
      const id = await saveRate({
        baseCurrency: q.base,
        quoteCurrency: q.quote,
        source: slot,
        variant: q.variant,
        value: q.value,
        effectiveOn: q.effectiveOn,
        raw: (reading as { raw?: unknown }).raw ?? reading,
      });
      /*
       * ALL of them are stored — if it publishes five currencies, all five —
       * because a rate's history cannot be reconstructed afterwards. Only the
       * requested pair is returned.
       *
       * And if it sends several variants of the same pair, the one marked
       * `preferred` wins rather than the last to arrive: with no rule, the entry
       * being recorded now and the net worth looked at later could be valued
       * with different figures from the same day, and change between reloads.
       */
      const isOurs = q.base === pair.base && q.quote === pair.quote;
      if (isOurs && (mine === null || q.preferred)) {
        mine = { id, value: q.value, effectiveOn: q.effectiveOn, stale: false, manual: false, ages: true };
      }
    }
    return mine;
  } catch (err) {
    console.warn(`[rates] the ${slot} source failed:`, (err as Error).message);
    return null;
  }
}

/**
 * Resolves **both** rates for a date. It is the heart of "store both and choose
 * when you look": every bolívar line is stamped with the BCV one and the P2P
 * one, and the dashboard selector only changes which column gets added up.
 *
 * It never throws: a source being down must never stop an expense being recorded.
 */
export async function resolveRates(params: {
  quoteCurrency: string;
  baseCurrency: string;
  date: string;
  isToday: boolean;
}): Promise<DailyRates> {
  const { quoteCurrency, baseCurrency, date, isToday } = params;

  if (quoteCurrency === baseCurrency) return { bcv: null, p2p: null };

  // For now only the USD/VES pair makes sense; other currencies fall to null and
  // the entry gets flagged for review, which is the honest behaviour.
  if (baseCurrency !== "USD" || quoteCurrency !== "VES") {
    const ages = await rateAges(quoteCurrency);
    const [bcv, p2p] = await Promise.all([
      findStored(baseCurrency, quoteCurrency, "bcv", date, ages),
      findStored(baseCurrency, quoteCurrency, "p2p", date, ages),
    ]);
    return { bcv, p2p };
  }

  let [bcv, p2p] = await Promise.all([
    findStored("USD", "VES", "bcv", date, true),
    findStored("USD", "VES", "p2p", date, true),
  ]);

  // We only go out to the network if the entry is from today: backfilling an old
  // date with today's rate would falsify the history.
  if (isToday) {
    const missingBcv = !bcv || bcv.stale;
    const missingP2p = !p2p || p2p.stale;
    if (missingBcv || missingP2p) {
      const [freshBcv, freshP2p] = await Promise.all([
        missingBcv ? refreshSlot("bcv", date) : Promise.resolve(null),
        missingP2p ? refreshSlot("p2p", date) : Promise.resolve(null),
      ]);
      if (freshBcv) bcv = freshBcv;
      if (freshP2p) p2p = freshP2p;
    }
  }

  return { bcv, p2p };
}

/** Is the rate too far from the date to be trusted? */
export function isRateTooStale(rate: ResolvedRate | null, date: string): boolean {
  if (!rate) return true;
  // A pair that does not move cannot be too far from any date.
  if (!rate.ages) return false;
  // Absolute value: a forward value date (the BCV's normal case) must not exceed
  // the margin either, but it is not "old" in the sense of out of date.
  return Math.abs(daysBetween(rate.effectiveOn, date)) > STALE_TOLERANCE_DAYS;
}

/**
 * When a rate was last captured, from whichever source.
 *
 * `observed_at` is what we look at and NOT `effective_on`: the BCV publishes with
 * a future value date, so "there is a row dated today" does not mean "we went out
 * to fetch it today". The second is what we need to know.
 */
export async function lastSnapshotAt(): Promise<Date | null> {
  const { rows } = await db.execute<{ observed_at: string | null }>(sql`
    SELECT max(observed_at)::text AS observed_at
      FROM exchange_rates
     -- Do NOT include 'manual' here, however consistent it may look with the
     -- rest of the file. This is what the heartbeat reads to decide whether the
     -- slot is already covered: if a hand-written rate counted, the day somebody
     -- writes one it would stop going out for the source's. Nothing would fail;
     -- the real rate would simply stop being stored, and that does not show.
     WHERE source IN ('bcv','p2p')
  `);
  const value = rows[0]?.observed_at;
  return value ? new Date(value) : null;
}

/** Snapshot of both sources. Called by instrumentation.ts and POST /api/v1/rates. */
export async function dailySnapshot(date: string): Promise<DailyRates> {
  const [bcv, p2p] = await Promise.all([refreshSlot("bcv", date), refreshSlot("p2p", date)]);
  return { bcv, p2p };
}

/** Each source's latest known rate, for the dashboard header. */
export async function currentRates(date: string) {
  const { rows } = await db.execute<{
    slot: string;
    rate: string;
    effective_on: string;
    is_manual: boolean;
  }>(sql`
    SELECT DISTINCT ON (slot) slot, rate, effective_on, is_manual, variant
      FROM (
        SELECT rate,
               effective_on,
               source,
               variant,
               source = 'manual' AS is_manual,
               -- The box: what is hand-written is anchored by the variant
               -- column, so 'manual' + 'bcv' counts as that day's official one.
               CASE WHEN source = 'manual' THEN variant ELSE source::text END AS slot
          FROM exchange_rates
         WHERE base_currency = 'USD' AND quote_currency = 'VES'
           AND (source IN ('bcv','p2p')
                OR (source = 'manual' AND variant IN ('bcv','p2p')))
      ) x
    -- Same rule as findStored, and they have to stay the same: value date
    -- earlier than or equal to first, nearest after that, and on a tie the
    -- hand-written one wins.
    ORDER BY slot,
             CASE WHEN effective_on <= ${date} THEN 0 ELSE 1 END,
             abs(effective_on - ${date}::date),
             CASE WHEN source = 'manual' THEN 0 ELSE 1 END,
             -- A stable tie-break between variants of the same day, so the
             -- screen does not change its figure between reloads.
             variant
  `);

  const out: Record<
    string,
    { rate: string; effectiveOn: string; stale: boolean; manual: boolean }
  > = {};
  for (const r of rows) {
    out[r.slot] = {
      rate: r.rate,
      effectiveOn: r.effective_on,
      stale: r.effective_on !== date,
      manual: r.is_manual,
    };
  }
  return out;
}

/**
 * Sets a slot's rate by hand for a day.
 *
 * It is stored as `source: 'manual'` anchored to the slot by `variant`, so that
 * it lives alongside the source's instead of overwriting it: both stay in the
 * history and you can see that a person corrected the other. The table's unique
 * index already tells the two rows apart, so no migration was needed for this.
 */
export async function saveManualRate(params: {
  slot: RateSlot;
  value: string;
  effectiveOn: string;
  baseCurrency?: string;
  quoteCurrency?: string;
  note?: string;
}): Promise<ResolvedRate> {
  const baseCurrency = params.baseCurrency ?? "USD";
  const quoteCurrency = params.quoteCurrency ?? "VES";

  const id = await saveRate({
    baseCurrency,
    quoteCurrency,
    source: "manual",
    variant: params.slot,
    value: params.value,
    effectiveOn: params.effectiveOn,
    // The note goes inside `raw` so as not to demand a new column for a field
    // that will almost always be empty.
    raw: { typedBy: "form", note: params.note ?? null },
  });

  return {
    id,
    value: params.value,
    effectiveOn: params.effectiveOn,
    stale: false,
    manual: true,
    // Written for that exact day, so it is neither old nor does it matter
    // whether the pair moves.
    ages: true,
  };
}

/**
 * Deletes a hand-written rate. Only those: a source's are re-fetched, but one
 * extra zero while typing should not require opening psql.
 */
export async function removeManualRate(
  id: string,
  /**
   * The household's language, for the one refusal this function can give.
   *
   * Defaulted rather than required because rates are not per household: the
   * table has no `household_id`, so there is nobody to read it from here.
   */
  locale: string = DEFAULT_LOCALE,
): Promise<boolean> {
  /*
   * If that rate has already valued entries, it is not deleted.
   *
   * The `rate_bcv_id` and `rate_p2p_id` columns point here with `ON DELETE SET
   * NULL`: deleting it would leave the entries with their dollar equivalent
   * already computed but with nothing saying where it came from. The amount
   * would still be right and the provenance would say "none", which is the kind
   * of lie this project avoids on purpose.
   *
   * You correct yourself by setting another rate for the same day: the new one
   * wins and both stay in the history.
   */
  const { rows: uses } = await db.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n
      FROM transaction_entries
     WHERE rate_bcv_id = ${id} OR rate_p2p_id = ${id}
  `);
  if ((uses[0]?.n ?? 0) > 0) {
    throw new Error(
      getTranslator(normalizeLocale(locale))("services.rates.stillInUse", { n: uses[0].n }),
    );
  }

  const rows = await db
    .delete(exchangeRates)
    .where(and(eq(exchangeRates.id, id), eq(exchangeRates.source, "manual")))
    .returning({ id: exchangeRates.id });
  return rows.length > 0;
}

/** The latest hand-written rates, so they can be reviewed and undone. */
export async function manualRates(limit = 10): Promise<
  Array<{
    id: string;
    slot: string;
    value: string;
    effectiveOn: string;
    quoteCurrency: string;
    observedAt: Date;
  }>
> {
  const rows = await db
    .select({
      id: exchangeRates.id,
      slot: exchangeRates.variant,
      value: exchangeRates.rate,
      effectiveOn: exchangeRates.effectiveOn,
      quoteCurrency: exchangeRates.quoteCurrency,
      observedAt: exchangeRates.observedAt,
    })
    .from(exchangeRates)
    .where(
      and(
        eq(exchangeRates.source, "manual"),
        /*
         * The pair the screen is about, and only that one.
         *
         * /rates says «Bolívares por dólar» in its own subtitle and `currentRates`
         * right above only reads that pair, but this list read every manual row
         * of every pair — so a rate for another currency would be painted under
         * that heading with no way to tell, and with a Delete button beside it.
         * The identity row of a currency that does not age is exactly such a
         * row, and deleting it would stop new entries in that currency being
         * valued, in silence.
         */
        eq(exchangeRates.baseCurrency, "USD"),
        eq(exchangeRates.quoteCurrency, "VES"),
      ),
    )
    .orderBy(sql`${exchangeRates.effectiveOn} DESC`, sql`${exchangeRates.observedAt} DESC`)
    .limit(limit);
  return rows;
}

/**
 * The ads backing a day's parallel rate.
 *
 * They come from the `raw` column, where the reader stores the top five. It is
 * not decoration: a figure you can check against who would actually pay it is
 * worth more than one you have to take on faith, and that is the principle
 * ordering this whole screen.
 */
export async function p2pTopOfDay(date: string): Promise<
  Array<{ rate: number; orders: number; nick: string }>
> {
  const [row] = await db
    .select({ raw: exchangeRates.raw })
    .from(exchangeRates)
    .where(
      and(
        eq(exchangeRates.source, "p2p"),
        eq(exchangeRates.quoteCurrency, "VES"),
        eq(exchangeRates.effectiveOn, date),
      ),
    )
    .orderBy(sql`${exchangeRates.observedAt} DESC`)
    .limit(1);

  const top = (row?.raw as { top?: unknown } | null)?.top;
  if (!Array.isArray(top)) return [];

  return top
    .filter((t): t is { rate: number; orders: number; nick: string } =>
      typeof t?.rate === "number" && typeof t?.orders === "number" && typeof t?.nick === "string",
    )
    .slice(0, 5);
}
