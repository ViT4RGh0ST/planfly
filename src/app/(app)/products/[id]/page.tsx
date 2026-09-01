import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";

import { PriceChart } from "@/components/price-chart";
import { requireSession } from "@/lib/session";
import { formatAmount, formatPercent } from "@/lib/money";
import { ProductSplit } from "@/components/product-split";
import { productHistory, productRawTexts } from "@/lib/services/products";
import { toSlug } from "@/lib/services/resolve-entities";
import { formatDayYear } from "@/lib/dates";
import type { Valuation } from "@/lib/services/reports";
import { getTranslations } from "next-intl/server";

export const dynamic = "force-dynamic";

/**
 * A product and its price over time.
 *
 * The chart goes in the base currency and not in bolívares. It is not a
 * preference: a bolívar curve always rises and does not tell "this got dearer"
 * from "the rate moved", which are two things demanding opposite decisions.
 */
export default async function ProductPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ rate?: string }>;
}) {
  const ctx = await requireSession();
  const t = await getTranslations();
  const { id } = await params;
  const query = await searchParams;
  const valuation: Valuation = query.rate === "bcv" ? "bcv" : "p2p";

  const history = await productHistory(ctx.householdId, id);
  if (!history) notFound();

  // With a single line item there is nothing to split, and the section is not drawn.
  const lineItems = await productRawTexts(ctx.householdId, id);
  const name = toSlug(history.name);

  const points = history.points;
  const withRate = points.filter((p) =>
    valuation === "bcv" ? p.unitPriceBcvMinor != null : p.unitPriceP2pMinor != null,
  );
  const first = withRate[0];
  const last = withRate[withRate.length - 1];
  const change =
    first && last && withRate.length > 1
      ? (((valuation === "bcv" ? last.unitPriceBcvMinor! : last.unitPriceP2pMinor!) -
          (valuation === "bcv" ? first.unitPriceBcvMinor! : first.unitPriceP2pMinor!)) /
          (valuation === "bcv" ? first.unitPriceBcvMinor! : first.unitPriceP2pMinor!)) *
        100
      : null;

  /*
   * Where it came out cheapest, and where dearest.
   *
   * In the base currency and never in bolívares: two purchases three months
   * apart at the same shop differ by the rate before they differ by the price,
   * and a comparison in bolívares would crown whichever place you happened to
   * visit earliest. It is the same reason the chart is in base currency.
   *
   * Only with two places or more. With one, «cheapest» is a word for a list of
   * one thing.
   */
  const byPlace = new Map<string, { place: string; minor: number; on: string }>();
  for (const point of withRate) {
    if (!point.place) continue;
    const minor = (valuation === "bcv" ? point.unitPriceBcvMinor : point.unitPriceP2pMinor)!;
    const seen = byPlace.get(point.place);
    // The latest price at each place, not the lowest it ever was: what you can
    // act on is what it costs there now.
    if (!seen || point.occurredOn >= seen.on) {
      byPlace.set(point.place, { place: point.place, minor, on: point.occurredOn });
    }
  }
  const places = [...byPlace.values()].sort((a, b) => a.minor - b.minor);
  const cheapest = places.length > 1 ? places[0] : null;
  const dearest = places.length > 1 ? places[places.length - 1] : null;

  return (
    <div className="mx-auto max-w-3xl px-6 py-10">
      <Link
        href="/products"
        className="mb-6 inline-flex items-center gap-1.5 text-sm text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <ArrowLeft aria-hidden className="size-3.5" />
        {t("ui.products.title")}
      </Link>

      <header className="mb-8">
        <h1 className="text-lg font-medium tracking-tight">{history.name}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("ui.products.pricePer", { unit: t(`domain.unit.perUnit.${history.baseUnit}`) })} ·{" "}
          {t("ui.products.purchases", { n: points.length })}
          {change != null && (
            <>
              {" · "}
              <span className={change > 0 ? "text-negative" : "text-positive"}>
                {t("ui.products.changeSince", {
                  change: `${change > 0 ? "+" : ""}${formatPercent(change)}`,
                })}
              </span>
            </>
          )}
        </p>
      </header>

      {cheapest && dearest && cheapest.minor < dearest.minor && (
        <p className="-mt-4 mb-8 max-w-prose text-sm text-muted-foreground">
          {t("ui.products.cheapestAt", {
            place: cheapest.place,
            amount: formatAmount(cheapest.minor, ctx.baseCurrency),
          })}{" "}
          <span className="text-foreground">
            {t("ui.products.dearestAt", {
              place: dearest.place,
              amount: formatAmount(dearest.minor, ctx.baseCurrency),
            })}
          </span>
        </p>
      )}

      {withRate.length < 2 ? (
        // With a single point there is no curve: saying so is more useful than drawing
        // a straight line that would look like a measurement.
        <p className="mb-8 max-w-prose text-sm text-muted-foreground">
          {points.length < 2 ? t("ui.products.onePurchase") : t("ui.products.noRateToCompare")}
        </p>
      ) : (
        <PriceChart
          points={withRate.map((p) => ({
            date: p.occurredOn,
            value:
              (valuation === "bcv" ? p.unitPriceBcvMinor! : p.unitPriceP2pMinor!) / 100,
          }))}
          currency={ctx.baseCurrency}
          valuation={valuation}
        />
      )}

      <section aria-labelledby="compras" className="mt-10">
        <h2
          id="compras"
          className="mb-2 text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground"
        >
          {t("ui.products.whereItAppeared")}
        </h2>
        <ul className="divide-y divide-border">
          {[...points].reverse().map((p, i) => (
            <li key={`${p.transactionId}-${i}`} className="flex items-start justify-between gap-4 py-3">
              <div className="min-w-0">
                <p className="truncate text-sm">{p.description}</p>
                <p className="text-xs text-muted-foreground">
                  {formatDayYear(p.occurredOn, ctx.locale)} · {p.quantity}{" "}
                  {p.unit ?? t(`domain.unit.bare.${history.baseUnit}`)}
                  {/* The place, when the entry carries one. An entry written by
                      hand often does not, and inventing «unknown» for it would
                      add noise to every row to say nothing. */}
                  {p.place && <> · {p.place}</>}
                </p>
              </div>
              <div className="shrink-0 text-right leading-tight">
                <p className="text-sm tabular-nums">
                  {formatAmount(p.unitPriceMinor, p.currency)}
                </p>
                <p className="text-xs tabular-nums text-muted-foreground">
                  {(valuation === "bcv" ? p.unitPriceBcvMinor : p.unitPriceP2pMinor) != null
                    ? formatAmount(
                        (valuation === "bcv" ? p.unitPriceBcvMinor : p.unitPriceP2pMinor)!,
                        ctx.baseCurrency,
                      )
                    : t("ui.products.noRate")}
                </p>
              </div>
            </li>
          ))}
        </ul>
      </section>

      {lineItems.length > 1 && (
        <ProductSplit
          productId={history.id}
          // The one giving the product its name goes first: it is the anchor the others
          // are read against, and letting it fall into frequency order forces hunting
          // for it to understand what was joined with what.
          rows={lineItems
            .map((r) => ({
              rawText: r.rawText,
              count: r.count,
              lastSeen: formatDayYear(r.lastSeenOn, ctx.locale),
              isName: toSlug(r.rawText) === name,
            }))
            .sort((a, b) => Number(b.isName) - Number(a.isName))}
        />
      )}
    </div>
  );
}
