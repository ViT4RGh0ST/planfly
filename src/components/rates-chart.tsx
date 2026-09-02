"use client";

import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";

import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { formatDay } from "@/lib/dates";
import { useLocale, useTranslations } from "next-intl";

export function RatesChart({
  data,
}: {
  data: Array<{ date: string; official?: number; parallel?: number }>;
}) {
  const t = useTranslations();
  const locale = useLocale();
  /*
   * The legend named the two institutions — «BCV» and «P2P» — which is right for
   * the bolívar and wrong for every other currency this chart will draw. It is
   * the slot's own name now, in the household's language, and it is built inside
   * the component because it needs the translator.
   */
  const config = {
    official: { label: t("domain.rateSlotShort.official"), color: "var(--chart-1)" },
    parallel: { label: t("domain.rateSlotShort.parallel"), color: "var(--chart-2)" },
  } satisfies ChartConfig;
  if (data.length < 2) {
    return (
      <div className="flex h-[300px] items-center justify-center text-sm text-muted-foreground">
        {t("ui.rates.chart.needsTwoDays")}
      </div>
    );
  }

  return (
    <ChartContainer config={config} className="h-[300px] w-full">
      <LineChart
        aria-label={t("ui.rates.chart.label")}
        data={data}
        margin={{ left: 8, right: 16 }}
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
          domain={["auto", "auto"]}
          tick={{ fontSize: 12 }}
          width={56}
        />
        <ChartTooltip content={<ChartTooltipContent />} />
        <ChartLegend content={<ChartLegendContent />} />
        {/* connectNulls: not every day has both sources (the BCV does not
            publish at weekends), and without this the line breaks into pieces. */}
        {/* No animated drawing, like the other two charts: whoever asked for
            less motion does not get it, and a half-drawn line reads as a series
            that cuts off. */}
        <Line
          dataKey="official"
          stroke="var(--color-official)"
          dot={false}
          strokeWidth={2}
          connectNulls
          isAnimationActive={false}
        />
        <Line
          dataKey="parallel"
          stroke="var(--color-parallel)"
          dot={false}
          strokeWidth={2}
          connectNulls
          isAnimationActive={false}
        />
      </LineChart>
    </ChartContainer>
  );
}
