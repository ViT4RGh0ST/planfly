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

const CONFIG = {
  bcv: { label: "BCV", color: "var(--chart-1)" },
  p2p: { label: "P2P", color: "var(--chart-2)" },
} satisfies ChartConfig;

export function RatesChart({
  data,
}: {
  data: Array<{ date: string; bcv?: number; p2p?: number }>;
}) {
  const t = useTranslations();
  const locale = useLocale();
  if (data.length < 2) {
    return (
      <div className="flex h-[300px] items-center justify-center text-sm text-muted-foreground">
        {t("ui.rates.chart.needsTwoDays")}
      </div>
    );
  }

  return (
    <ChartContainer config={CONFIG} className="h-[300px] w-full">
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
          dataKey="bcv"
          stroke="var(--color-bcv)"
          dot={false}
          strokeWidth={2}
          connectNulls
          isAnimationActive={false}
        />
        <Line
          dataKey="p2p"
          stroke="var(--color-p2p)"
          dot={false}
          strokeWidth={2}
          connectNulls
          isAnimationActive={false}
        />
      </LineChart>
    </ChartContainer>
  );
}
