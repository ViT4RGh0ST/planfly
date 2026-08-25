"use client";

import { Plus, X } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatAmount, parseAmountToMinor } from "@/lib/money";
import { cn } from "@/lib/utils";

export type ItemRow = {
  description: string;
  quantity: string;
  unit: string;
  total: string;
};

export const emptyRow = (): ItemRow => ({ description: "", quantity: "", unit: "", total: "" });

/**
 * An invoice's breakdown: what you bought inside the purchase.
 *
 * **The total rules and the breakdown informs.** The lines do not have to add up
 * to the total — a receipt carries VAT, discounts and line items the OCR did not
 * read — so instead of blocking, it says how much is missing. That figure is the
 * only quality check there is on what the camera read.
 *
 * It travels as JSON in a hidden field: a variable-length list inside a FormData
 * forces inventing indexed names and reassembling them on the other side.
 */
export function ItemsEditor({
  rows,
  onChange,
  currency,
  totalMinor,
  disabled,
}: {
  rows: ItemRow[];
  onChange: (rows: ItemRow[]) => void;
  currency: string;
  /** The entry's total, so we can say how much is left unitemised. */
  totalMinor: number | null;
  disabled?: boolean;
}) {
  const t = useTranslations();
  const set = (i: number, patch: Partial<ItemRow>) =>
    onChange(rows.map((r, j) => (i === j ? { ...r, ...patch } : r)));

  const covered = rows.reduce((sum, r) => {
    if (!r.total.trim()) return sum;
    try {
      return sum + Math.abs(parseAmountToMinor(r.total, currency));
    } catch {
      // Mid-typing, "1.2" is not a number yet. It neither adds nor shouts.
      return sum;
    }
  }, 0);

  const filled = rows.filter((r) => r.description.trim() && r.total.trim()).length;
  const gap = totalMinor != null ? totalMinor - covered : null;

  return (
    <div className="grid gap-2">
      {/* Headers once only, not a label per cell: four fields per row each
          with its own caption would turn ten lines into forty.

          And on narrow too, not only on wide. There the row breaks in two — the
          product above, the three figures below — and with no header there were
          four stacked fields carrying only the placeholder, which disappears the
          moment you type: the `aria-label` saved the screen reader and left the
          eye with nothing. */}
      {rows.length > 0 && (
        <div className="grid grid-cols-[1fr_3rem_3rem_5rem_2rem] gap-2 px-1 text-xs text-muted-foreground sm:grid-cols-[1fr_4rem_3.5rem_6rem_2rem]">
          <span>{t("ui.items.what")}</span>
          <span>{t("ui.items.quantity")}</span>
          <span>{t("ui.items.unit")}</span>
          <span className="text-right">{t("ui.items.total")}</span>
          <span className="sr-only">{t("ui.items.remove")}</span>
        </div>
      )}

      <ul className="grid gap-2">
        {rows.map((row, i) => (
          <li
            key={i}
            className="grid grid-cols-[1fr_3rem_3rem_5rem_2rem] gap-2 sm:grid-cols-[1fr_4rem_3.5rem_6rem_2rem]"
          >
            <Input
              aria-label={t("ui.items.productOfLine", { n: i + 1 })}
              value={row.description}
              onChange={(e) => set(i, { description: e.target.value })}
              placeholder="HARINA PAN 1KG"
              disabled={disabled}
              className="h-9"
            />
            <Input
              aria-label={t("ui.items.quantityOfLine", { n: i + 1 })}
              inputMode="decimal"
              value={row.quantity}
              onChange={(e) => set(i, { quantity: e.target.value })}
              placeholder="1"
              disabled={disabled}
              className="h-9"
            />
            <Input
              aria-label={t("ui.items.unitOfLine", { n: i + 1 })}
              value={row.unit}
              onChange={(e) => set(i, { unit: e.target.value })}
              placeholder="kg"
              disabled={disabled}
              className="h-9"
            />
            <Input
              aria-label={t("ui.items.totalOfLine", { n: i + 1 })}
              inputMode="decimal"
              value={row.total}
              onChange={(e) => set(i, { total: e.target.value })}
              placeholder="80,00"
              disabled={disabled}
              className="h-9 text-right tabular-nums"
            />
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="h-9 w-9"
              disabled={disabled}
              aria-label={t("ui.items.removeLine", { n: i + 1 })}
              onClick={() => onChange(rows.filter((_, j) => j !== i))}
            >
              <X className="size-4" />
            </Button>
          </li>
        ))}
      </ul>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={() => onChange([...rows, emptyRow()])}
        >
          <Plus className="size-4" />
          {t("ui.items.addLine")}
        </Button>

        {/* What is left to break down, which is the only thing that checks
            whether the camera read right. It never blocks: a receipt carries VAT
            and discounts. */}
        {filled > 0 && (
          <p className="text-xs text-muted-foreground">
            {t("ui.items.filled", { n: filled })} ·{" "}
            <span className="tabular-nums">{formatAmount(covered, currency)}</span>
            {gap != null && gap !== 0 && (
              <>
                {t("ui.items.of")}
                <span className="tabular-nums">{formatAmount(totalMinor!, currency)}</span>
                {" · "}
                <span className={cn("tabular-nums", gap < 0 && "text-caution")}>
                  {gap > 0
                    ? t("ui.items.short", { amount: formatAmount(gap, currency) })
                    : t("ui.items.over", { amount: formatAmount(-gap, currency) })}
                </span>
              </>
            )}
            {gap === 0 && t("ui.items.exact")}
          </p>
        )}
      </div>

      <input type="hidden" name="items" value={JSON.stringify(rows)} />
    </div>
  );
}
