import { NextResponse } from "next/server";

import { withToken, rejectIdentityKeys, rejectUnknownKeys } from "@/lib/api/handler";
import { mergeProductsSchema, splitProductSchema } from "@/lib/validation";
import { formatAmount } from "@/lib/money";
import { formatDay } from "@/lib/dates";
import {
  mergeProducts,
  productCatalog,
  productHistory,
  productRawTexts,
  splitProduct,
} from "@/lib/services/products";
import { resolveProduct } from "@/lib/services/products";
import { InvalidTransactionError } from "@/lib/services/record-transaction";
import { normalizeLocale } from "@/i18n/config";
import { getTranslator } from "@/i18n/translator";

export const dynamic = "force-dynamic";

/**
 * Price history, over chat.
 *
 * «What was flour going for last time?» is one of the most asked questions and
 * was the only thing from the web with no presence in the bot at all. It goes in
 * the base currency: a bolívar curve always rises and does not tell «this got
 * dearer» from «the rate moved», which call for opposite decisions.
 */
export const GET = withToken("reports:read", async ({ principal, req }) => {
  const t = getTranslator(normalizeLocale(principal.locale));
  const url = new URL(req.url);
  const name = url.searchParams.get("product");
  const valuation = url.searchParams.get("rate") === "official" ? "official" : "parallel";

  if (!name) {
    const catalog = await productCatalog(principal.householdId, valuation);
    return NextResponse.json({
      ok: true,
      summary:
        catalog.length === 0
          ? t("api.products.none")
          : catalog
              .map((p) =>
                t("api.products.line", {
                  name: p.name,
                  unit: p.baseUnit,
                  price:
                    p.lastUnitPriceMinor != null && p.currency
                      ? formatAmount(p.lastUnitPriceMinor, p.currency)
                      : "—",
                  change:
                    p.changePercent == null
                      ? t("api.products.firstTime")
                      : `${p.changePercent > 0 ? "+" : ""}${Math.round(p.changePercent)}%`,
                  n: p.timesBought,
                }),
              )
              .join("\n"),
      products: catalog.map((p) => ({
        name: p.name,
        unit: p.baseUnit,
        times_bought: p.timesBought,
        last_seen_on: p.lastSeenOn,
        last_price: p.lastUnitPriceMinor != null && p.currency
          ? formatAmount(p.lastUnitPriceMinor, p.currency)
          : null,
        change_percent: p.changePercent,
      })),
    });
  }

  // `create: false`: looking up a price must never seed the catalogue.
  const match = await resolveProduct(principal.householdId, name, "unit", false);
  if (!match) {
    return NextResponse.json(
      {
        ok: false,
        error: "product_not_found",
        message: t("api.products.noneLike", { name }),
      },
      { status: 404 },
    );
  }

  const [history, lineItems] = await Promise.all([
    productHistory(principal.householdId, match.id),
    productRawTexts(principal.householdId, match.id),
  ]);
  if (!history) {
    return NextResponse.json({ ok: false, error: "product_not_found" }, { status: 404 });
  }

  const detail: string[] = [];
  if (history.points.length === 0) {
    detail.push(t("api.products.noPrices", { product: history.name }));
  } else {
    detail.push(t("api.products.head", { product: history.name, unit: history.baseUnit }));
    for (const p of history.points) {
      const inBase = valuation === "official" ? p.unitPriceOfficialMinor : p.unitPriceParallelMinor;
      detail.push(
        `· ${formatDay(p.occurredOn, principal.locale)}: ${formatAmount(p.unitPriceMinor, p.currency)}` +
          (inBase != null ? ` (${formatAmount(inBase, principal.baseCurrency)})` : ""),
      );
    }
    if (lineItems.length > 1) {
      detail.push("", t("api.products.rawTexts"));
      for (const r of lineItems) {
        detail.push(t("api.products.rawTextLine", { text: r.rawText, n: r.count }));
      }
      detail.push(t("api.products.splitHint"));
    }
  }

  return NextResponse.json({
    ok: true,
    summary: detail.join("\n"),
    product: history.name,
    unit: history.baseUnit,
    /*
     * Which names it has arrived under. It goes here and not on a separate route
     * because it is the only thing that makes `split` usable: `raw_text` has to
     * be the receipt's literal line item, and without seeing them the caller can
     * only invent it.
     *
     * With only one it is omitted: there is nothing to split, and a
     * single-element list invites trying anyway.
     */
    raw_texts:
      lineItems.length > 1
        ? lineItems.map((r) => ({ text: r.rawText, times: r.count }))
        : undefined,
    points: history.points.map((p) => ({
      date: p.occurredOn,
      date_text: formatDay(p.occurredOn, principal.locale),
      description: p.description,
      unit_price: formatAmount(p.unitPriceMinor, p.currency),
      unit_price_base:
        (valuation === "official" ? p.unitPriceOfficialMinor : p.unitPriceParallelMinor) != null
          ? formatAmount(
              (valuation === "official" ? p.unitPriceOfficialMinor : p.unitPriceParallelMinor)!,
              principal.baseCurrency,
            )
          : null,
    })),
  });
});

/**
 * Fixing what fuzzy matching got wrong, in both directions.
 *
 * **Merge** when it split in two what is one: «HARINA PAN 1KG» and «Harina Pan»
 * are the same, and until they are joined there are two price series and neither
 * tells the truth. **Split** when it joined two different things sharing a first
 * word — «NECTAR DE MANZANA» and «NECTAR DE PERA» — which leaves a single series
 * describing neither.
 *
 * Both in the same POST and not on two routes because they are the same
 * operation with the sign flipped, and whoever comes to fix a match does not
 * know beforehand which way it goes. They are told apart by `raw_text`: if it
 * arrives, it splits.
 */
export const POST = withToken("transactions:write", async ({ principal, req }) => {
  const t = getTranslator(normalizeLocale(principal.locale));
  const body = await req.json();
  rejectIdentityKeys(body);

  const separar = body != null && typeof body === "object" && "raw_text" in body;
  if (separar) {
    rejectUnknownKeys(body, splitProductSchema);
    const input = splitProductSchema.parse(body);
    const product = await resolveProduct(principal.householdId, input.product, "unit", false);
    if (!product) {
      throw new InvalidTransactionError(
        t("api.products.notFound", { name: input.product }),
        "product_not_found",
      );
    }
    return NextResponse.json(
      await splitProduct(principal.householdId, product.id, input.raw_text),
    );
  }

  rejectUnknownKeys(body, mergeProductsSchema);
  const input = mergeProductsSchema.parse(body);

  const [from, into] = await Promise.all([
    resolveProduct(principal.householdId, input.from, "unit", false),
    resolveProduct(principal.householdId, input.into, "unit", false),
  ]);
  if (!from) {
    throw new InvalidTransactionError(
      t("api.products.notFound", { name: input.from }),
      "product_not_found",
    );
  }
  if (!into) {
    throw new InvalidTransactionError(
      t("api.products.notFound", { name: input.into }),
      "product_not_found",
    );
  }
  if (from.id === into.id) {
    throw new InvalidTransactionError(t("api.products.same"), "same_product");
  }

  const result = await mergeProducts(principal.householdId, from.id, into.id);
  return NextResponse.json(result);
});
