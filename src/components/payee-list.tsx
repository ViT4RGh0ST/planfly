import { useTranslations } from "next-intl";

import { PayeeActions } from "@/components/payee-actions";
import type { BrandOption, CategoryOption } from "@/components/payee-form";
import type { PayeeNode } from "@/lib/services/manage-payees";
import { formatTaxId } from "@/lib/tax-id";
import { cn } from "@/lib/utils";

/**
 * The places, with their branches under them.
 *
 * A place has no balance and no price of its own, so what carries the eye is
 * what makes it useful: the fiscal id that identifies it on a receipt, and
 * whether anything priced has ever come from there.
 *
 * That second one is the whole point of the screen. A place with purchases but
 * **no line items** is one you have never photographed a receipt at — so none of
 * its prices are on the products screen, and «where is this cheaper» cannot
 * include it. Saying so on the row is what makes somebody take the photo.
 */
export function PayeeList({
  payees,
  brands,
  categories,
  tiles,
  attribution,
}: {
  payees: PayeeNode[];
  brands: BrandOption[];
  categories: CategoryOption[];
  tiles: string | null;
  attribution: string | null;
}) {
  const t = useTranslations();

  if (payees.length === 0) {
    return <p className="text-sm text-muted-foreground">{t("ui.places.empty")}</p>;
  }

  return (
    <ul className="divide-y divide-border">
      {payees.map((payee) => (
        <li key={payee.id}>
          <Row payee={payee} brands={brands} categories={categories}
          tiles={tiles}
          attribution={attribution} />
          {payee.branches.length > 0 && (
            <ul className="mb-1 ml-3 border-l border-border pl-4">
              {payee.branches.map((branch) => (
                <li key={branch.id}>
                  <Row payee={branch} brands={brands} categories={categories}
          tiles={tiles}
          attribution={attribution} nested />
                </li>
              ))}
            </ul>
          )}
        </li>
      ))}
    </ul>
  );
}

function Row({
  payee,
  brands,
  categories,
  tiles,
  attribution,
  nested = false,
}: {
  payee: PayeeNode;
  brands: BrandOption[];
  categories: CategoryOption[];
  tiles: string | null;
  attribution: string | null;
  nested?: boolean;
}) {
  const t = useTranslations();
  // The branch's totals, because a chain's total is the point of having a brand.
  const entries = payee.entriesInTree;
  const items = payee.itemsInTree;
  const unused = entries === 0;

  const details = [formatTaxId(payee.taxId), payee.address, payee.defaultCategory].filter(Boolean);
  /*
   * A branch IS a location.
   *
   * Two branches of one chain with no address between them are the same row
   * twice as far as anybody reading can tell — including whoever is about to
   * write the third one.
   */
  const placeless = nested && !payee.address;

  return (
    <div className={cn("flex items-start justify-between gap-4 py-3", nested && "py-2")}>
      <div className="min-w-0">
        <p className={cn("truncate text-sm", unused && "text-muted-foreground")}>{payee.name}</p>
        <p className="truncate text-xs text-muted-foreground">
          {details.length > 0 ? details.join(" · ") : t("ui.places.noDetails")}
          {placeless && (
            <span className="text-caution/80">
              {details.length > 0 ? " · " : ""}
              {t("ui.places.branchNeedsAddress")}
            </span>
          )}
        </p>
        {payee.aliases.length > 0 && (
          <p className="truncate text-xs text-muted-foreground/70">{payee.aliases.join(" · ")}</p>
        )}
      </div>

      <div className="flex shrink-0 items-start gap-1">
        <div className="mt-1.5 text-right">
          <p className="text-xs tabular-nums text-muted-foreground">
            {entries > 0 && t("ui.places.entries", { n: entries })}
          </p>
          {entries > 0 && (
            <p className="text-xs tabular-nums text-muted-foreground">
              {items > 0 ? (
                t("ui.places.items", { n: items })
              ) : (
                /* No priced line items means this place contributes nothing to
                   «where is this cheaper». It is a hole worth naming. */
                <span className="text-caution/80">{t("ui.places.noItems")}</span>
              )}
            </p>
          )}
        </div>
        <PayeeActions id={payee.id} name={payee.name} brands={brands} categories={categories}
          tiles={tiles}
          attribution={attribution} />
      </div>
    </div>
  );
}
