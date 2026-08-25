import { useTranslations } from "next-intl";

import { formatAmount } from "@/lib/money";
import { cn } from "@/lib/utils";

/**
 * The month's income, spending and balance.
 *
 * Deliberately **not** three more cards. They used to be three cards identical
 * to the net position one, and that repetition said all four numbers weighed the
 * same — which is exactly the opposite of what is needed on a screen opened to
 * answer "how much do I have?".
 *
 * Here it is a row of text with a hierarchy of its own: subordinate to the net
 * position, but readable at a glance.
 */
export function MonthFlow({
  incomeMinor,
  expenseMinor,
  balanceMinor,
  incomeCount,
  expenseCount,
  currency,
  period,
}: {
  incomeMinor: number;
  expenseMinor: number;
  balanceMinor: number;
  incomeCount: number;
  expenseCount: number;
  currency: string;
  period: string;
}) {
  const t = useTranslations();
  const nothingYet = incomeCount === 0 && expenseCount === 0;

  // It said "no entries" when there might have been transfers: what there were
  // none of is income or spending, which is what this piece counts.
  if (nothingYet) {
    return (
      <p className="text-sm text-muted-foreground">{t("ui.monthFlow.empty", { period })}</p>
    );
  }

  const items = [
    {
      label: t("ui.monthFlow.income"),
      minor: incomeMinor,
      count: incomeCount,
      tone: "text-positive",
      // The sign is in the text, not in the colour alone: whoever cannot tell green
      // from red has to be able to read the direction just the same.
      sign: "+",
    },
    {
      label: t("ui.monthFlow.expense"),
      minor: expenseMinor,
      count: expenseCount,
      tone: "text-negative",
      sign: "−",
    },
  ];

  return (
    <div className="flex flex-wrap items-baseline gap-x-10 gap-y-4">
      {items.map((item) => (
        <div key={item.label}>
          <p className="text-xs uppercase tracking-[0.12em] text-muted-foreground">{item.label}</p>
          <p className={cn("mt-1 text-xl font-medium tabular-nums", item.tone)}>
            {item.sign}
            {formatAmount(item.minor, currency)}
          </p>
          <p className="text-xs text-muted-foreground">
            {t("ui.monthFlow.count", { n: item.count })}
          </p>
        </div>
      ))}

      <div>
        <p className="text-xs uppercase tracking-[0.12em] text-muted-foreground">
          {t("ui.monthFlow.balance")}
        </p>
        <p
          className={cn(
            "mt-1 text-xl font-medium tabular-nums",
            balanceMinor >= 0 ? "text-positive" : "text-negative",
          )}
        >
          {formatAmount(balanceMinor, currency, { showPlus: true })}
        </p>
        <p className="text-xs text-muted-foreground">{period}</p>
      </div>
    </div>
  );
}
