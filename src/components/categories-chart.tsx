"use client";

import { Bar, BarChart, CartesianGrid, Cell, XAxis, YAxis } from "recharts";
import { useTranslations } from "next-intl";

import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";

export type CategoryDatum = {
  name: string;
  color: string;
  /** Already in MAJOR units of the base currency: the chart does no arithmetic. */
  total: number;
};

/**
 * Spending by category.
 *
 * It receives the amounts already converted to major units from the server. That
 * is deliberate: amounts live as integers of cents throughout the system and the
 * division happens once, at the edge, not in every component.
 */
export function CategoriesChart({
  data,
  currency,
}: {
  data: CategoryDatum[];
  currency: string;
}) {
  const t = useTranslations();

  if (data.length === 0) {
    return (
      <div className="flex h-[280px] items-center justify-center text-sm text-muted-foreground">
        {t("ui.categoriesChart.empty")}
      </div>
    );
  }

  const config: ChartConfig = { total: { label: t("ui.categoriesChart.legend", { currency }) } };

  return (
    <ChartContainer config={config} className="h-[280px] w-full">
      <BarChart
        aria-label={t("ui.categoriesChart.label")}
        data={data}
        layout="vertical"
        margin={{ left: 8, right: 16 }}
      >
        <CartesianGrid horizontal={false} strokeDasharray="3 3" />
        <XAxis type="number" tickLine={false} axisLine={false} />
        <YAxis
          type="category"
          dataKey="name"
          width={110}
          tickLine={false}
          axisLine={false}
          // Every label, always. By default Recharts skips the ones that do not fit,
          // and with eight categories it discarded two: their bars were still drawn —
          // two pixels wide — but with no name, so the chart showed six rows out of
          // eight without saying two were missing.
          interval={0}
          tick={{ fontSize: 12 }}
        />
        <ChartTooltip
          content={
            <ChartTooltipContent
              formatter={(value) =>
                new Intl.NumberFormat("es-VE", {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                }).format(Number(value))
              }
            />
          }
        />
        {/* No entry animation, same as the price chart. It is not only
            consistency: the bar grows from zero over 1.5 s, so anyone who opens
            the panel and looks — or any screenshot — sees a canvas with correct
            axes and not a single bar, which is exactly the zero this app forbids
            itself to print. */}
        <Bar dataKey="total" radius={4} isAnimationActive={false}>
          {data.map((d) => (
            <Cell key={d.name} fill={d.color} />
          ))}
        </Bar>
      </BarChart>
    </ChartContainer>
  );
}
