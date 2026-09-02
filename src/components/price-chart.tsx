"use client";

import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";

import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { formatDay } from "@/lib/dates";
import { useLocale, useTranslations } from "next-intl";

/**
 * A product's price over time, in the base currency.
 *
 * In the base and not in bolívares because a bolívar curve always rises: it does
 * not tell "this got dearer" from "the rate moved", and those are two things
 * calling for opposite decisions.
 *
 * The scale does NOT start at zero. In a price series what you read is the
 * movement — from $3,20 to $4,40 is a third dearer — and forcing zero would
 * squash that difference against the axis until it was invisible.
 */
export function PriceChart({
  points,
  currency,
  valuation,
}: {
  points: Array<{ date: string; value: number }>;
  currency: string;
  valuation: "official" | "parallel";
}) {
  const t = useTranslations();
  const locale = useLocale();
  const config = {
    value: {
      label: t("ui.products.chartLegend", { valuation: valuation.toUpperCase() }),
      color: valuation === "official" ? "var(--bcv)" : "var(--p2p)",
    },
  } satisfies ChartConfig;

  /*
   * How many decimals are needed for the axis not to repeat labels.
   *
   * With two fixed, a series running from 0,04 to 0,06 draws "0,06 · 0,06 · 0,05
   * · 0,05 · 0,04": five ticks at different heights saying three numbers. They
   * are chosen from what the series spans, not from the currency.
   */
  const values = points.map((p) => p.value);
  const span = Math.max(...values) - Math.min(...values);
  const decimals = span === 0 ? 2 : Math.min(4, Math.max(2, Math.ceil(-Math.log10(span)) + 1));

  const format = new Intl.NumberFormat("es-VE", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });

  return (
    <ChartContainer config={config} className="h-[280px] w-full">
      <LineChart
        aria-label={t("ui.products.chartLabel")}
        data={points}
        margin={{ left: 8, right: 16, top: 8 }}
      >
        <CartesianGrid strokeDasharray="3 3" vertical={false} />
        <XAxis
          dataKey="date"
          tickLine={false}
          axisLine={false}
          // Wrapped and not passed by reference: Recharts calls the
          // formatter with (value, index), so the index would arrive
          // as the locale.
          tickFormatter={(v) => formatDay(String(v), locale)}
          tick={{ fontSize: 12 }}
        />
        <YAxis
          tickLine={false}
          axisLine={false}
          width={64}
          domain={["dataMin", "dataMax"]}
          tickFormatter={(v: number) => format.format(v)}
          tick={{ fontSize: 12 }}
        />
        <ChartTooltip
          content={
            <ChartTooltipContent
              labelFormatter={(v) => formatDay(String(v), locale)}
              formatter={(v) => `${currency === "USD" ? "$ " : ""}${format.format(Number(v))}`}
            />
          }
        />
        <Line
          type="monotone"
          dataKey="value"
          stroke="var(--color-value)"
          strokeWidth={2}
          dot={{ r: 3 }}
          // Whoever asked for less motion does not get the animated stroke.
          isAnimationActive={false}
        />
      </LineChart>
    </ChartContainer>
  );
}
