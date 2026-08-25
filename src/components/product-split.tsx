"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { mergeProductsAction, splitProductAction } from "@/app/(app)/actions";
import { useTranslations } from "next-intl";

export type RawTextRow = {
  /** The line item exactly as it came out on the receipt. */
  rawText: string;
  count: number;
  /** Already formatted by the server: date formatting lives in one place. */
  lastSeen: string;
  /** The one giving the product its name. It cannot be pulled out: it is the product. */
  isName: boolean;
};

/**
 * The line items that ended up in this product, and the button to pull one out.
 *
 * This section is the only record of what fuzzy matching joined. It joins by
 * resemblance — it has to, or «H.PAN 1KG» and «H PAN 1 KG» would be two
 * products — and with that it gets the common case right and the rare one wrong:
 * two different things sharing a first word. When it gets it wrong, both price
 * histories are mixed and describe neither.
 *
 * It only appears when there is more than one line item. With a single one there
 * is nothing to split, and showing the control greyed out would be asking about
 * a problem that does not exist.
 */
export function ProductSplit({
  productId,
  rows,
}: {
  productId: string;
  rows: RawTextRow[];
}) {
  const [pending, startTransition] = useTransition();
  const t = useTranslations();
  const [separando, setSeparando] = useState<string | null>(null);

  function separar(rawText: string) {
    setSeparando(rawText);
    startTransition(async () => {
      const r = await splitProductAction(productId, rawText);
      setSeparando(null);
      if (!r?.ok) {
        toast.error(r?.message ?? t("ui.products.split.failed"));
        return;
      }
      toast.success(r.message, {
        /*
         * Undo instead of a confirmation dialog.
         *
         * Splitting moves rows and is not obvious to reverse by hand — merging
         * only exists through the API — so with no way out this would be a click
         * with no return. A prior warning would charge the toll in the good
         * case, which is 100% of the times someone hits this on purpose; undo
         * charges it only when it was needed. It is offered only if the product
         * was created new: if an existing one was reused, merging it back would
         * drag along purchases that never left here.
         */
        action: r.undoable
          ? {
              label: t("ui.products.split.undo"),
              onClick: () =>
                startTransition(async () => {
                  const back = await mergeProductsAction(r.productId!, r.fromId!);
                  if (back?.ok) toast.success(t("ui.products.split.undone"));
                  else toast.error(back?.message ?? t("ui.products.split.undoFailed"));
                }),
            }
          : undefined,
      });
    });
  }

  return (
    <section aria-labelledby="renglones" className="mt-10">
      <h2
        id="renglones"
        className="mb-2 text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground"
      >
        {t("ui.products.split.title")}
      </h2>
      <p className="mb-4 max-w-[62ch] text-sm text-muted-foreground">
        {t("ui.products.split.hint")}
      </p>

      <ul className="divide-y divide-border">
        {rows.map((r) => (
          <li key={r.rawText} className="flex items-center justify-between gap-4 py-3">
            <div className="min-w-0">
              <p className="truncate text-sm">{r.rawText}</p>
              <p className="text-xs text-muted-foreground">
                {t("ui.products.split.count", { n: r.count })}
                {r.count === 1 ? t("ui.products.split.onlySeparator") : t("ui.products.split.until")}
                {r.lastSeen}
              </p>
            </div>
            {r.isName ? (
              // No button, and it is said: it is the line item giving the product its
              // name, so pulling it out would separate it from nothing.
              <p className="shrink-0 text-xs text-muted-foreground">{t("ui.products.split.isTheName")}</p>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                className="h-9 shrink-0"
                disabled={pending}
                aria-label={t("ui.products.split.separateNamed", { rawText: r.rawText })}
                onClick={() => separar(r.rawText)}
              >
                {separando === r.rawText ? t("ui.products.split.separating") : t("ui.products.split.separate")}
              </Button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
