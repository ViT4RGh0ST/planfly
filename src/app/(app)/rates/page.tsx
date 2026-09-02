import { and, desc, eq, sql } from "drizzle-orm";

import { RefreshRatesButton } from "@/components/refresh-rates-button";
import { CurrencyManager } from "@/components/currency-manager";
import { RatesChart } from "@/components/rates-chart";
import { ManualRateForm } from "@/components/manual-rate-form";
import { ManualRateList } from "@/components/manual-rate-list";
import { db } from "@/db";
import { exchangeRates } from "@/db/schema";
import { requireSession } from "@/lib/session";
import { formatPercent, formatRate } from "@/lib/money";
import { formatDay, today } from "@/lib/dates";
import { currentRates, manualRates, p2pTopOfDay, pairsInUse } from "@/lib/rates/service";
import { listCurrencies } from "@/lib/services/manage-currencies";
import { isSlotConfigured } from "@/lib/rates/load-provider";
import { cn } from "@/lib/utils";
import { getTranslations } from "next-intl/server";

export const dynamic = "force-dynamic";

/**
 * The two rates and their spread.
 *
 * They used to be three cards in a grid, and the detector flagged nested cards
 * in each. Now it is a row of figures with the same hierarchy as the dashboard:
 * the numbers carry the weight, the containers disappear.
 */
export default async function RatesPage() {
  const ctx = await requireSession();
  const t = await getTranslations();
  const date = today(ctx.timezone);

  /*
   * Which currencies this household holds, and the figures for each.
   *
   * The screen used to ask about one pair written into the query, so a currency
   * whose rate was captured and stored had nowhere at all to be seen. It asks
   * the accounts now — the same question the heartbeat asks before capturing —
   * so what is drawn and what exists cannot become two lists.
   */
  const pairs = await pairsInUse();
  const rest = pairs.filter((pair) => pair.base !== "USD" || pair.quote !== "VES");

  const [current, others, history, fijadas, top, currencyList] = await Promise.all([
    currentRates(date),
    Promise.all(
      rest.map(async (pair) => ({ pair, rates: await currentRates(date, pair) })),
    ),
    db
      .select({
        source: exchangeRates.source,
        variant: exchangeRates.variant,
        rate: exchangeRates.rate,
        effectiveOn: exchangeRates.effectiveOn,
      })
      .from(exchangeRates)
      .where(and(eq(exchangeRates.baseCurrency, "USD"), eq(exchangeRates.quoteCurrency, "VES")))
      // The hand-written one first within each day, or the chart contradicts
      // the figures above, net worth and findStored, all of which prefer it.
      //
      // With a CASE and not with `asc(source)`: `source` is a Postgres enum and
      // orders by its declaration order — official, parallel, manual — so asking for
      // ascending puts the automatic one first, exactly the wrong way round.
      // Ordering an enum by its name is a silent trap.
      .orderBy(
        desc(exchangeRates.effectiveOn),
        sql`CASE WHEN ${exchangeRates.source} = 'manual' THEN 0 ELSE 1 END`,
      )
      // Two rows per day and box when there is a hand-written one, so the cap
      // covers half the days it used to. 720 keeps the usual ~180.
      .limit(720),
    manualRates(8),
    p2pTopOfDay(date),
    listCurrencies(),
  ]);

  // Grouped by date so the chart has one series per source.
  const byDate = new Map<string, { date: string; official?: number; parallel?: number }>();
  for (const row of history) {
    const entry = byDate.get(row.effectiveOn) ?? { date: row.effectiveOn };
    // The slot, not the source: a hand-set rate fills the same column as the
    // automatic one, and if `source` were looked at here it would vanish from the
    // history exactly on the days it had to be written by hand.
    const slot = row.source === "manual" ? row.variant : row.source;
    // The first to arrive rules, and the query order puts the manual one first.
    if (slot === "official" && entry.official === undefined) entry.official = Number(row.rate);
    if (slot === "parallel" && entry.parallel === undefined) entry.parallel = Number(row.rate);
    byDate.set(row.effectiveOn, entry);
  }
  const series = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));

  const spread =
    current.official && current.parallel
      ? (Number(current.parallel.rate) / Number(current.official.rate) - 1) * 100
      : null;

  const columns = [
    {
      key: "official",
      label: t("ui.rates.official"),
      value: current.official ? formatRate(current.official.rate) : null,
      tone: "text-official",
      note: current.official
        ? current.official.manual
          ? t("ui.rates.setByHandOn", { date: formatDay(current.official.effectiveOn, ctx.locale) })
          : current.official.effectiveOn > date
            ? t("ui.rates.valueDateAhead", { date: formatDay(current.official.effectiveOn, ctx.locale) })
            : t("ui.rates.valueDate", { date: formatDay(current.official.effectiveOn, ctx.locale) })
        : isSlotConfigured("official")
          ? t("ui.rates.sourceSilent")
          : t("ui.rates.noSource"),
      stale: current.official ? current.official.effectiveOn < date : true,
    },
    {
      key: "parallel",
      label: t("ui.rates.parallel"),
      value: current.parallel ? formatRate(current.parallel.rate) : null,
      tone: "text-parallel",
      note: current.parallel
        ? current.parallel.manual
          ? t("ui.rates.setByHandOn", { date: formatDay(current.parallel.effectiveOn, ctx.locale) })
          : t("ui.rates.whatYoudBePaid", { date: formatDay(current.parallel.effectiveOn, ctx.locale) })
        : isSlotConfigured("parallel")
          ? t("ui.rates.sourceSilent")
          : t("ui.rates.noSource"),
      stale: current.parallel?.stale ?? true,
    },
    {
      key: "spread",
      label: t("ui.rates.spread"),
      // One decimal is enough and the space before the % is the Spanish one.
      value: spread == null ? null : `${formatPercent(spread, 1)} %`,
      tone: "text-foreground",
      note: t("ui.rates.spreadNote"),
      stale: false,
    },
  ];

  return (
    <div className="mx-auto max-w-3xl px-6 py-10">
      <header className="mb-10 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-medium tracking-tight">{t("ui.rates.title")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("ui.rates.subtitle", { date: formatDay(date, ctx.locale) })}
          </p>
        </div>
        <RefreshRatesButton />
      </header>

      <p className="mb-3 text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">
        {t("ui.rates.pair", { quote: "VES", base: "USD" })}
      </p>
      <div className="flex flex-wrap gap-x-14 gap-y-8">
        {columns.map((column) => (
          <div key={column.key}>
            <p
              className={cn("text-xs font-medium uppercase tracking-[0.12em]", column.tone)}
            >
              {column.label}
            </p>
            <p className="mt-2 text-3xl font-semibold tabular-nums tracking-tight">
              {column.value ?? "—"}
            </p>
            <p
              className={cn(
                "mt-1 max-w-[24ch] text-xs",
                column.stale ? "text-caution" : "text-muted-foreground",
              )}
            >
              {column.note}
            </p>
          </div>
        ))}
      </div>

      {/* Every other currency the household holds.
          Smaller, and without the chart, the ad list or the hand-set form: those
          belong to a pair that has an official source to compare against and a
          market whose ads are read here. A currency with one rate has one figure,
          and saying so is the point — an empty «official» column beside a real
          number reads like a source that failed rather than a question that does
          not exist in that country. */}
      {others.map(({ pair, rates }) => (
        <section key={pair.quote} className="mt-10" aria-labelledby={`pair-${pair.quote}`}>
          <p
            id={`pair-${pair.quote}`}
            className="mb-3 text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground"
          >
            {t("ui.rates.pair", { quote: pair.quote, base: pair.base })}
          </p>
          <div className="flex flex-wrap gap-x-14 gap-y-8">
            {pair.hasOfficial && (
              <div>
                <p className="text-xs font-medium uppercase tracking-[0.12em] text-official">
                  {t("ui.rates.official")}
                </p>
                <p className="mt-2 text-2xl font-semibold tabular-nums tracking-tight">
                  {rates.official ? formatRate(rates.official.rate) : "—"}
                </p>
              </div>
            )}
            <div>
              <p className="text-xs font-medium uppercase tracking-[0.12em] text-parallel">
                {t("ui.rates.parallel")}
              </p>
              <p className="mt-2 text-2xl font-semibold tabular-nums tracking-tight">
                {rates.parallel ? formatRate(rates.parallel.rate) : "—"}
              </p>
              <p
                className={cn(
                  "mt-1 max-w-[28ch] text-xs",
                  rates.parallel ? "text-muted-foreground" : "text-caution",
                )}
              >
                {rates.parallel
                  ? rates.parallel.manual
                    ? t("ui.rates.setByHandOn", {
                        date: formatDay(rates.parallel.effectiveOn, ctx.locale),
                      })
                    : t("ui.rates.whatYoudBePaid", {
                        date: formatDay(rates.parallel.effectiveOn, ctx.locale),
                      })
                  : t("ui.rates.sourceSilent")}
              </p>
            </div>
            {!pair.hasOfficial && (
              <div className="max-w-[30ch]">
                <p className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">
                  {t("ui.rates.onlyOne")}
                </p>
                <p className="mt-2 text-sm text-muted-foreground">
                  {t("ui.rates.onlyOneNote", { quote: pair.quote })}
                </p>
              </div>
            )}
          </div>
        </section>
      ))}

      {top.length > 0 && (
        <section aria-labelledby="quien-paga" className="mt-10">
          <h2
            id="quien-paga"
            className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground"
          >
            {t("ui.rates.whoPays")}{" "}
            <span className="font-normal text-muted-foreground/70">
              · {t("ui.rates.pair", { quote: "VES", base: "USD" })}
            </span>
          </h2>
          <p className="mt-1 max-w-[62ch] text-sm text-muted-foreground">
            {t("ui.rates.whoPaysHint")}
          </p>
          <ul className="mt-4 divide-y divide-border">
            {/* `ad` and not `t`: `t` is the translator in this file. */}
            {top.map((ad, i) => (
              <li key={ad.nick} className="flex items-baseline justify-between gap-4 py-2">
                <span className="min-w-0 truncate text-sm">
                  <span className="mr-2 tabular-nums text-muted-foreground">{i + 1}</span>
                  {ad.nick}
                </span>
                <span className="flex shrink-0 items-baseline gap-3">
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {t("ui.rates.orders", { n: ad.orders.toLocaleString("es-VE") })}
                  </span>
                  <span className="text-sm tabular-nums">{formatRate(String(ad.rate))}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <hr className="my-10 border-border" />

      <section aria-labelledby="a-mano">
        <h2
          id="a-mano"
          className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground"
        >
          {t("ui.rates.setByHand")}{" "}
          <span className="font-normal text-muted-foreground/70">
            · {t("ui.rates.pair", { quote: "VES", base: "USD" })}
          </span>
        </h2>
        <p className="mt-1 max-w-[62ch] text-sm text-muted-foreground">
          {t("ui.rates.setByHandHint")}
        </p>
        <div className="mt-6">
          <ManualRateForm today={date} />
        </div>
        <ManualRateList rows={fijadas} />
      </section>

      <hr className="my-10 border-border" />

      <section aria-labelledby="historico">
        <h2
          id="historico"
          className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground"
        >
          {t("ui.rates.history")}{" "}
          <span className="font-normal text-muted-foreground/70">
            · {t("ui.rates.pair", { quote: "VES", base: "USD" })}
          </span>
        </h2>
        <p className="mt-1 max-w-[62ch] text-sm text-muted-foreground">
          {t("ui.rates.historyHint")}
        </p>
        <div className="mt-6">
          <RatesChart data={series} />
        </div>
      </section>

      <hr className="my-10 border-border" />

      {/* Adding a currency used to be a migration and a release. It goes last
          because it is done twice in a lifetime — but it goes HERE, because the
          question that brings somebody to it is «why has my peso no rate?», and
          that is asked while looking at this screen. */}
      <section aria-labelledby="monedas">
        <h2
          id="monedas"
          className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground"
        >
          {t("ui.currencies.title")}
        </h2>
        <p className="mt-1 max-w-[62ch] text-sm text-muted-foreground">
          {t("ui.currencies.hint")}
        </p>
        <CurrencyManager currencies={currencyList} baseCurrency={ctx.baseCurrency} />
      </section>
    </div>
  );
}
