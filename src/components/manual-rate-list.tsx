"use client";

import { useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { deleteManualRate } from "@/app/(app)/actions";
import { formatDay } from "@/lib/dates";
import { formatRate } from "@/lib/money";
import { useLocale, useTranslations } from "next-intl";

export type ManualRateRow = {
  id: string;
  slot: string;
  value: string;
  effectiveOn: string;
};

/**
 * The rates that were set by hand, with their undo button.
 *
 * It exists for one specific reason: typing 87.700 where 877,00 belonged
 * revalues the entire net worth, and until now the only way to fix it would have
 * been opening psql. It only appears if there is one, so as not to leave an
 * empty heading on a screen opened to read two figures.
 */
export function ManualRateList({ rows }: { rows: ManualRateRow[] }) {
  const t = useTranslations();
  const locale = useLocale();
  const [pending, startTransition] = useTransition();

  if (rows.length === 0) return null;

  return (
    <ul className="mt-6 divide-y divide-border">
      {rows.map((row) => (
        <li key={row.id} className="flex items-center justify-between gap-4 py-2">
          <p className="text-sm">
            <span className={row.slot === "official" ? "text-official" : "text-parallel"}>
              {row.slot === "official" ? t("ui.rates.form.officialShort") : t("ui.rates.form.parallelShort")}
            </span>{" "}
            <span className="tabular-nums">{formatRate(row.value)}</span>{" "}
            <span className="text-muted-foreground">· {formatDay(row.effectiveOn, locale)}</span>
          </p>
          <Button
            variant="ghost"
            size="sm"
            className="h-9"
            disabled={pending}
            aria-label={t("ui.rates.deleteFor", { date: formatDay(row.effectiveOn, locale) })}
            onClick={() =>
              startTransition(async () => {
                const result = await deleteManualRate(row.id);
                if (result?.ok) toast.success(result.message);
                else if (result) toast.error(result.message);
              })
            }
          >
            {t("ui.rates.delete")}
          </Button>
        </li>
      ))}
    </ul>
  );
}
