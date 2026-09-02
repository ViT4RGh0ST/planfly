import { useTranslations } from "next-intl";

import { AccountActions } from "@/components/account-actions";
import { formatAmount } from "@/lib/money";
import { cn } from "@/lib/utils";

type AccountRow = {
  id: string;
  name: string;
  type: string;
  nature: string;
  currency: string;
  balanceMinor: number;
  balanceText: string;
  baseOfficialMinor: number | null;
  baseParallelMinor: number | null;
};

/**
 * Balances by account.
 *
 * It is the detailed answer to "how much do I have?", so it reads as a genuine
 * list and not as card filler: a vertical rule per account marks asset or
 * liability, and the base-currency equivalent goes under the native balance
 * instead of competing with it.
 *
 * When the rate is missing it says **why** the equivalent is missing. An
 * unexplained dash reads as zero, and zero is a very different figure from
 * "I don't know".
 */
export function AccountList({
  accounts,
  baseCurrency,
  valuation,
  currencies,
}: {
  accounts: AccountRow[];
  baseCurrency: string;
  valuation: "official" | "parallel";
  /** With no currencies there is no form to offer: the list stays read-only. */
  currencies?: string[];
}) {
  const t = useTranslations();
  if (accounts.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">{t("ui.accountList.empty")}</p>
    );
  }

  return (
    <ul className="divide-y divide-border">
      {accounts.map((account) => {
        const inBase = valuation === "official" ? account.baseOfficialMinor : account.baseParallelMinor;
        const isLiability = account.nature === "liability";
        const empty = account.balanceMinor === 0;

        return (
          <li key={account.id} className="flex items-start justify-between gap-4 py-3">
            <div className="flex min-w-0 items-start gap-3">
              <span
                aria-hidden
                className={cn(
                  "mt-1 h-8 w-px shrink-0 rounded-full",
                  isLiability ? "bg-negative/70" : "bg-positive/60",
                )}
              />
              <div className="min-w-0">
                <p className={cn("truncate text-sm", empty && "text-muted-foreground")}>
                  {account.name}
                </p>
                <p className="text-xs text-muted-foreground">
                  {account.currency}
                  {isLiability && t("ui.accountList.liability")}
                </p>
              </div>
            </div>

            <div className="flex shrink-0 items-start gap-1">
              <div className="text-right">
                <p
                  className={cn(
                    "text-sm tabular-nums",
                    empty ? "text-muted-foreground" : "font-medium",
                  )}
                >
                  {account.balanceText}
                </p>
                {account.currency !== baseCurrency && (
                  <p className="text-xs tabular-nums text-muted-foreground">
                    {inBase != null ? (
                      <>≈ {formatAmount(inBase, baseCurrency)}</>
                    ) : (
                      <span className="text-caution">{t("ui.accountList.noRate")}</span>
                    )}
                  </p>
                )}
              </div>
              {currencies && (
                <AccountActions
                  id={account.id}
                  name={account.name}
                  currencies={currencies}
                  baseCurrency={baseCurrency}
                />
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
