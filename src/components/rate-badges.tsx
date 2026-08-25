import { formatDay } from "@/lib/dates";
import { formatRate } from "@/lib/money";
import { cn } from "@/lib/utils";
import { useLocale, useTranslations } from "next-intl";

type Rates = Record<string, { rate: string; effectiveOn: string; stale: boolean }>;

/**
 * The two rates of the day, in the header.
 *
 * Each carries its provenance visibly: if the value date is not today's, which
 * one it is gets said. A net worth figure built on a rate from three days ago is
 * still useful, but only if whoever looks at it knows.
 */
export function RateBadges({ rates }: { rates: Rates }) {
  const t = useTranslations();
  const locale = useLocale();
  const items = [
    { key: "bcv", label: "BCV", data: rates.bcv, tone: "text-bcv" },
    { key: "p2p", label: "P2P", data: rates.p2p, tone: "text-p2p" },
  ].filter((item) => item.data);

  if (items.length === 0) {
    return (
      <p className="text-sm text-caution">{t("ui.rates.noneStored")}</p>
    );
  }

  return (
    <dl className="flex items-start gap-6 text-sm">
      {items.map((item) => (
        <div key={item.key}>
          <dt className={cn("text-xs uppercase tracking-[0.12em]", item.tone)}>{item.label}</dt>
          <dd className="tabular-nums">
            {formatRate(item.data!.rate)}{" "}
            <span className="text-xs text-muted-foreground">Bs./$</span>
          </dd>
          {item.data!.stale && (
            <dd className="text-xs text-caution">
              {t("ui.rates.staleFrom", { date: formatDay(item.data!.effectiveOn, locale) })}
            </dd>
          )}
        </div>
      ))}
    </dl>
  );
}
