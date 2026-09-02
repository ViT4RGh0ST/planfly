import Link from "next/link";

import { RatePicker } from "@/components/rate-picker";
import { ProductTable } from "@/components/product-table";
import { requireSession } from "@/lib/session";
import { today } from "@/lib/dates";
import { currentRates } from "@/lib/rates/service";
import { productCatalog } from "@/lib/services/products";
import { valuationFrom, type Valuation } from "@/lib/services/reports";
import { getTranslations } from "next-intl/server";

export const dynamic = "force-dynamic";

/**
 * Products.
 *
 * There is one question people come here to ask: **did this go up?** And in
 * bolívares it has no answer, because they rise from inflation and they rise
 * because the rate moved. That is why the variation is computed over the dollar
 * equivalent of each purchase day, and the bolívar price sits beside it as what
 * you actually paid.
 *
 * The price is always **per base unit** — kilo, litre or unit: buying two kilos
 * instead of one is not cheese doubling.
 */
export default async function ProductsPage({
  searchParams,
}: {
  searchParams: Promise<{ rate?: string }>;
}) {
  const ctx = await requireSession();
  const t = await getTranslations();
  const params = await searchParams;
  const valuation: Valuation = valuationFrom(params.rate);
  const date = today(ctx.timezone);

  const [catalog, rates] = await Promise.all([
    productCatalog(ctx.householdId, valuation),
    currentRates(date),
  ]);

  return (
    <div className="mx-auto max-w-4xl px-6 py-10">
      <header className="mb-8 flex flex-wrap items-start justify-between gap-6">
        <div>
          <h1 className="text-lg font-medium tracking-tight">{t("ui.products.title")}</h1>
          <p className="mt-1 max-w-[62ch] text-sm text-muted-foreground">
            {t("ui.products.hint", { base: ctx.baseCurrency })}
          </p>
        </div>
        <RatePicker rates={rates} />
      </header>

      {catalog.length === 0 ? (
        // The empty state explains: this screen fills itself when the first itemised
        // invoice arrives, not by configuring anything.
        <p className="max-w-prose py-8 text-sm text-muted-foreground">
          {t("ui.products.emptyBefore")}
          <Link
            href="/transactions"
            className="underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            {t("ui.products.emptyLink")}
          </Link>
          {t("ui.products.emptyAfter")}
        </p>
      ) : (
        <ProductTable
          products={catalog}
          baseCurrency={ctx.baseCurrency}
          valuation={valuation}
        />
      )}
    </div>
  );
}
