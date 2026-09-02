"use client";

import { useOptimistic, useTransition } from "react";
import { useQueryState } from "nuqs";

import { formatRate } from "@/lib/money";
import { formatDay } from "@/lib/dates";
import { cn } from "@/lib/utils";
import { useLocale, useTranslations } from "next-intl";

/**
 * The two rates of the day, and the choice of which rules, in ONE piece.
 *
 * They used to be two separate controls saying the same thing: some badges with
 * the numbers and, beside them, a «Value at [P2P][BCV]» toggle with the labels
 * loose and without their figures. You had to read both to know what you were
 * looking at, and once every row started showing both valuations the toggle was
 * left with no visible job: it no longer changed any figure in the table.
 *
 * Here the control IS the content, just as in the net position: each rate shows
 * its number with its value date, and clicking one makes it the one that rules.
 * And what it rules is stated — the subtotals — because a toggle whose effect is
 * invisible is a control that teaches distrust.
 */
export function RatePicker({
  rates,
}: {
  rates: Record<string, { rate: string; effectiveOn: string; stale: boolean }>;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const [rate, setRate] = useQueryState("rate", { defaultValue: "parallel", shallow: false });
  const [, startTransition] = useTransition();
  const [active, setOptimistic] = useOptimistic<"official" | "parallel">(rate === "official" ? "official" : "parallel");

  const choose = (option: "official" | "parallel") =>
    startTransition(() => {
      setOptimistic(option);
      void setRate(option);
    });

  const options = [
    // The slot's name from the catalogue: this picker sits above totals that add
    // up every currency the household holds, and «BCV» names one country's bank.
    { key: "parallel" as const, label: t("domain.rateSlotShort.parallel"), accent: "text-parallel", rule: "bg-parallel" },
    { key: "official" as const, label: t("domain.rateSlotShort.official"), accent: "text-official", rule: "bg-official" },
  ].filter((option) => rates[option.key]);

  if (options.length === 0) {
    return (
      <p className="text-sm text-caution">
        {t("ui.rates.picker.noRate")}
      </p>
    );
  }

  return (
    <div role="radiogroup" aria-label={t("ui.rates.picker.label")}>
      <div className="flex items-start gap-6">
        {options.map((option) => {
          const data = rates[option.key];
          const isActive = option.key === active;
          return (
            <button
              key={option.key}
              type="button"
              role="radio"
              aria-checked={isActive}
              onClick={() => choose(option.key)}
              className={cn(
                "-mx-1.5 cursor-pointer rounded-md px-1.5 py-1 text-left transition-opacity",
                "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                isActive ? "opacity-100" : "opacity-60 hover:opacity-90",
              )}
            >
              <span className="flex items-center gap-1.5">
                {/* The colour rule marks the chosen one, but it is not the only
                    thing marking it: opacity and weight say it without colour. */}
                <span
                  className={cn(
                    "h-0.5 w-4 rounded-full",
                    isActive ? option.rule : "bg-muted-foreground/40",
                  )}
                />
                <span className={cn("text-xs", isActive ? option.accent : "text-muted-foreground")}>
                  {option.label}
                </span>
              </span>
              <span
                className={cn(
                  "mt-0.5 block tabular-nums",
                  isActive ? "font-medium" : "text-muted-foreground",
                )}
              >
                {formatRate(data.rate)}{" "}
                <span className="text-xs font-normal text-muted-foreground">Bs./$</span>
              </span>
              {/* A stale rate is said, always: a figure with no visible
                  provenance is worth less than an honest hole. */}
              {data.stale && (
                <span className="mt-0.5 block text-xs text-caution">
                  {t("ui.rates.staleFrom", { date: formatDay(data.effectiveOn, locale) })}
                </span>
              )}
            </button>
          );
        })}
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        {t("ui.rates.picker.totalsUseThis")}
      </p>
    </div>
  );
}
