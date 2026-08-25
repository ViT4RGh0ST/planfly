import { NextResponse } from "next/server";

import { withToken } from "@/lib/api/handler";
import { today } from "@/lib/dates";
import { currentRates, dailySnapshot } from "@/lib/rates/service";
import { normalizeLocale } from "@/i18n/config";
import { getTranslator } from "@/i18n/translator";

export const dynamic = "force-dynamic";

export const GET = withToken("reports:read", async ({ principal, req }) => {
  const url = new URL(req.url);
  const date = url.searchParams.get("date") ?? today(principal.timezone);
  const rates = await currentRates(date);

  const t = getTranslator(normalizeLocale(principal.locale));
  const parts: string[] = [];
  for (const source of ["bcv", "p2p"] as const) {
    const rate = rates[source];
    if (!rate) continue;
    parts.push(
      t("api.rates.line", {
        source: source.toUpperCase(),
        rate: Number(rate.rate).toFixed(2),
        stale: rate.stale ? t("api.rates.staleFrom", { date: rate.effectiveOn }) : "",
      }),
    );
  }
  if (rates.bcv && rates.p2p) {
    parts.push(
      t("api.rates.spread", {
        percent: ((Number(rates.p2p.rate) / Number(rates.bcv.rate) - 1) * 100).toFixed(1),
      }),
    );
  }

  return NextResponse.json({
    ok: true,
    date,
    rates,
    summary:
      parts.length > 0
        ? parts.join(" · ")
        : getTranslator(normalizeLocale(principal.locale))("api.rates.none"),
  });
});

/** Forces a refresh of both sources. Neither can bring the route down:
 *  each returns null on failure and which one is reported. */
/*
 * `transactions:write` and not `reports:read`, even though it only triggers a capture.
 *
 * It writes rows into `exchange_rates`, and that table has no household column:
 * whatever is stored here values everyone's entries in the installation. It was
 * the API's only write under a `:read` permission, and SECURITY.md lists
 * «writing with a read-only account» verbatim as a reportable fault — that is,
 * we came with the first report already written.
 */
export const POST = withToken("transactions:write", async ({ principal }) => {
  const date = today(principal.timezone);
  const result = await dailySnapshot(date);

  return NextResponse.json({
    ok: true,
    date,
    bcv: result.bcv ? { rate: result.bcv.value, effective_on: result.bcv.effectiveOn } : null,
    p2p: result.p2p ? { rate: result.p2p.value, effective_on: result.p2p.effectiveOn } : null,
    failures: [result.bcv ? null : "bcv", result.p2p ? null : "p2p"].filter(Boolean),
  });
});
