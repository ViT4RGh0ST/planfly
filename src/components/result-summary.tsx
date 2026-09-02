import Link from "next/link";

import { formatAmount } from "@/lib/money";
import { cn } from "@/lib/utils";
import { useTranslations } from "next-intl";

/**
 * The answer, before the list.
 *
 * «How much did I spend on groceries in July?» is answered with a figure. The
 * screen had the data summed in the database and still forced you to add it up
 * in your head by reading rows.
 *
 * **Both valuations** are given, not the active one alone: the same expense is
 * worth 13% more or less depending on the rate, and showing only one here would
 * be the half-truth the product already refuses to tell about net worth. The
 * chosen one weighs more; the other stays readable.
 *
 * Transfers stay out: moving money between your own accounts is not spending,
 * and adding them would inflate the total with money that never left the house.
 */
export function ResultSummary({
  count,
  shown,
  periodLabel,
  officialMinor,
  parallelMinor,
  unvalued,
  currency,
  valuation,
  transfersExcluded,
}: {
  count: number;
  /** How many rows are actually painted, when fewer than the total. */
  shown: number;
  periodLabel: string | null;
  officialMinor: number;
  parallelMinor: number;
  /** Entries in the set that could not be valued. */
  unvalued: number;
  currency: string;
  valuation: "official" | "parallel";
  transfersExcluded: number;
}) {
  const t = useTranslations();
  if (count === 0) return null;

  // P2P first, same as the selector above and as the dashboard net worth.
  // With the orders crossed, picking the rate on the left highlighted the figure
  // on the right: the gesture and its effect pointed in opposite directions.
  const options = [
    // The slot, not the institution: this summary is shown for whatever currency
    // was just recorded.
    { key: "parallel" as const, label: t("domain.rateSlotShort.parallel"), minor: parallelMinor, accent: "text-parallel" },
    { key: "official" as const, label: t("domain.rateSlotShort.official"), minor: officialMinor, accent: "text-official" },
  ];

  return (
    <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-3">
      <div>
        <p className="text-sm text-muted-foreground">
          {/* The number keeps its own styling, so only the noun is translated:
              it agrees in number in both languages and goes after the figure in
              both, which is the whole reason it can be split at all. */}
          <span className="tabular-nums text-foreground">{count}</span>{" "}
          {t("ui.resultSummary.countNoun", { n: count })}
          {periodLabel && ` · ${periodLabel}`}
          {/* Cutting the list without saying so makes the count and what is on
              screen disagree, and whoever notices stops trusting both. */}
          {shown < count && t("ui.resultSummary.shown", { n: shown })}
        </p>
        {transfersExcluded > 0 && (
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t("ui.resultSummary.transfersExcluded", { n: transfersExcluded })}
          </p>
        )}
      </div>

      <div className="flex items-end gap-6">
        {options.map((option) => {
          const isActive = option.key === valuation;
          return (
            <p
              key={option.key}
              className={cn(
                "text-right leading-tight",
                isActive ? "text-foreground" : "text-muted-foreground",
              )}
            >
              <span className={cn("block text-[0.6875rem]", option.accent)}>{option.label}</span>
              <span
                className={cn(
                  "block tabular-nums",
                  isActive ? "text-2xl font-semibold tracking-tight" : "text-base",
                )}
              >
                {formatAmount(option.minor, currency)}
              </span>
            </p>
          );
        })}
      </div>

      {unvalued > 0 && (
        <p className="w-full text-xs text-caution">
          {t("ui.resultSummary.unvalued", { n: unvalued })}{" "}
          <Link
            href="/review"
            className="underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            {t("ui.resultSummary.reviewThem")}
          </Link>
        </p>
      )}
    </div>
  );
}
