import { useTranslations } from "next-intl";

import { formatAmount } from "@/lib/money";
import { cn } from "@/lib/utils";

/**
 * An amount read at ONE of the two rates, with its label.
 *
 * It lives here and not inside the entries table because the P2P/BCV pair is
 * already painted in three places, and the order and the contrast are what make
 * them comparable at a glance: if one screen put BCV on top, reading two screens
 * in a row would force checking which is which every time.
 */
export function RateLine({
  label,
  value,
  baseCurrency,
  active,
}: {
  label: "BCV" | "P2P";
  value: number | null;
  baseCurrency: string;
  /** The one selected above, and therefore the one the totals add up. */
  active: boolean;
}) {
  const t = useTranslations();
  return (
    <span
      className={cn(
        "flex items-baseline justify-end gap-1.5",
        // The active one at full contrast and the other dimmed: both are visible, but
        // it is still clear which one the totals are adding.
        active ? "text-foreground" : "text-muted-foreground",
      )}
    >
      <span className={cn("text-[0.6875rem]", label === "BCV" ? "text-bcv" : "text-p2p")}>
        {label}
      </span>
      {value == null ? t("ui.transactions.noRate") : formatAmount(value, baseCurrency)}
    </span>
  );
}

/**
 * The two readings of the same amount, P2P on top.
 *
 * An amount already in the household's currency has nothing to convert, and
 * saying so with a dash is more honest than repeating the same figure twice.
 */
export function BothRates({
  bcvMinor,
  p2pMinor,
  baseCurrency,
  valuation,
  className,
}: {
  bcvMinor: number | null;
  p2pMinor: number | null;
  baseCurrency: string;
  valuation: "bcv" | "p2p";
  className?: string;
}) {
  const t = useTranslations();
  if (bcvMinor == null && p2pMinor == null) {
    return <span className="text-xs text-muted-foreground">{t("ui.transactions.noRate")}</span>;
  }

  return (
    <span className={cn("flex flex-col items-end text-xs leading-tight", className)}>
      {/* P2P on top, as in the selector and in the summary: one and the same
          pair of figures cannot change order depending on where you look. */}
      <RateLine
        label="P2P"
        value={p2pMinor}
        baseCurrency={baseCurrency}
        active={valuation === "p2p"}
      />
      <RateLine
        label="BCV"
        value={bcvMinor}
        baseCurrency={baseCurrency}
        active={valuation === "bcv"}
      />
    </span>
  );
}
