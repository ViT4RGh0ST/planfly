import Link from "next/link";
import { TrendingDown, TrendingUp } from "lucide-react";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDay } from "@/lib/dates";
import { formatAmount, formatPercent } from "@/lib/money";
import { cn } from "@/lib/utils";
import type { ProductSummary } from "@/lib/services/products";
import { useLocale, useTranslations } from "next-intl";

/**
 * The catalogue, sorted by what moved most.
 *
 * The variation goes first because it is the question: a product you bought
 * twelve times that did not change does not need your attention, and one that
 * went up 40% does. What has only been bought once has no variation and says so,
 * instead of showing a 0% that would suggest it was checked.
 */
export function ProductTable({
  products,
  baseCurrency,
  valuation,
}: {
  products: ProductSummary[];
  baseCurrency: string;
  valuation: "bcv" | "p2p";
}) {
  const locale = useLocale();
  const t = useTranslations();
  // The ones that moved on top, and among them the biggest mover. The ones with
  // nothing to compare against yet go last, where they get in the way least.
  const sorted = [...products].sort((a, b) => {
    if (a.changePercent == null && b.changePercent == null) return a.name.localeCompare(b.name);
    if (a.changePercent == null) return 1;
    if (b.changePercent == null) return -1;
    return Math.abs(b.changePercent) - Math.abs(a.changePercent);
  });

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead scope="col">{t("ui.products.column.product")}</TableHead>
          <TableHead scope="col" className="hidden sm:table-cell">
            {t("ui.products.column.lastSeen")}
          </TableHead>
          <TableHead scope="col" className="text-right">
            {t("ui.products.column.price")}
          </TableHead>
          <TableHead scope="col" className="text-right">
            ≈ {baseCurrency}{" "}
            <span className={valuation === "bcv" ? "text-bcv" : "text-p2p"}>
              {valuation === "bcv" ? "BCV" : "P2P"}
            </span>
          </TableHead>
          <TableHead scope="col" className="text-right">
            {t("ui.products.column.change")}
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {sorted.map((p) => {
          const up = p.changePercent != null && p.changePercent > 0;
          const Trend = up ? TrendingUp : TrendingDown;
          return (
            <TableRow key={p.id}>
              <TableCell className="max-w-[16rem]">
                <Link
                  href={`/products/${p.id}`}
                  className="block truncate underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                  title={p.name}
                >
                  {p.name}
                </Link>
                <span className="text-xs text-muted-foreground">
                  {t(`domain.unit.perUnit.${p.baseUnit}`)} ·{" "}
                  {t("ui.products.purchases", { n: p.timesBought })}
                </span>
              </TableCell>
              <TableCell className="hidden text-sm text-muted-foreground sm:table-cell">
                {p.lastSeenOn ? formatDay(p.lastSeenOn, locale) : "—"}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {p.lastUnitPriceMinor != null && p.currency
                  ? formatAmount(p.lastUnitPriceMinor, p.currency)
                  : "—"}
              </TableCell>
              <TableCell className="text-right text-sm tabular-nums text-muted-foreground">
                {p.lastUnitPriceBaseMinor != null
                  ? formatAmount(p.lastUnitPriceBaseMinor, baseCurrency)
                  : t("ui.products.noRate")}
              </TableCell>
              <TableCell className="text-right">
                {p.changePercent == null ? (
                  // A 0% would say "it was checked and did not change", which is different from
                  // "there is nothing to compare against yet".
                  <span className="text-xs text-muted-foreground">
                    {p.timesBought > 1 ? t("ui.products.noRate") : t("ui.products.firstTime")}
                  </span>
                ) : (
                  <span
                    className={cn(
                      "inline-flex items-center justify-end gap-1 text-sm tabular-nums",
                      // The icon as well as the colour: a 40% rise cannot depend on telling red
                      // from green.
                      up ? "text-negative" : "text-positive",
                    )}
                  >
                    <Trend aria-hidden className="size-3.5" />
                    {up ? "+" : ""}
                    {formatPercent(p.changePercent)} %
                  </span>
                )}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
