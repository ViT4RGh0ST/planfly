import { NextResponse } from "next/server";

import { normalizeLocale } from "@/i18n/config";
import { getTranslator } from "@/i18n/translator";
import { withToken, rejectIdentityKeys, rejectUnknownKeys } from "@/lib/api/handler";
import {
  createCurrency,
  listCurrencies,
  removeCurrency,
  updateCurrency,
} from "@/lib/services/manage-currencies";
import { createCurrencySchema, patchCurrencySchema, removeCurrencySchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

/**
 * The currencies this planfly knows, and the only resource here that is global.
 *
 * `currencies` has no household column: it is reference data for the whole
 * installation, and the rate ladder reads it to decide what everything is worth.
 * So the ordinary protection of this API — the household comes from the token,
 * never from the body — has nothing to attach to here, and a member of one
 * household renaming a currency renames it for every household on the same
 * planfly.
 *
 * For a self-hosted product with one household that is the right trade; saying
 * it out loud is what stops it becoming a surprise if a second one is ever
 * added. What it is NOT allowed to do is take one away from under somebody: the
 * service counts the accounts held in it across every household before deleting.
 *
 * It also explains the scope. `rates:write` and not `accounts:write`: what is
 * handed over is not «open an account», it is «decide with which reference data
 * this installation values everything».
 */
export const GET = withToken("context:read", async ({ principal }) => {
  const t = getTranslator(normalizeLocale(principal.locale));
  const rows = await listCurrencies();

  return NextResponse.json({
    ok: true,
    currencies: rows.map((row) => ({
      code: row.code,
      name: row.name,
      symbol: row.symbol,
      minor_unit: row.minorUnit,
      has_official: row.hasOfficial,
      rate_ages: row.rateAges,
      accounts: row.accounts,
    })),
    // The count is the whole answer to «can this one go», so it is worded rather
    // than left for the caller to work out from a number.
    summary: rows
      .map((row) =>
        row.accounts === 0
          ? t("api.currencies.unused", { code: row.code, name: row.name })
          : t("api.currencies.held", { code: row.code, name: row.name, n: row.accounts }),
      )
      .join("\n"),
  });
});

export const POST = withToken("rates:write", async ({ principal, req }) => {
  const body = await req.json();
  rejectIdentityKeys(body);
  rejectUnknownKeys(body, createCurrencySchema);
  const input = createCurrencySchema.parse(body);

  const result = await createCurrency({
    locale: principal.locale,
    code: input.code,
    name: input.name,
    symbol: input.symbol,
    hasOfficial: input.has_official,
    isCrypto: input.is_crypto,
  });
  return NextResponse.json({ ok: true, ...result }, { status: 201 });
});

export const PATCH = withToken("rates:write", async ({ principal, req }) => {
  const body = await req.json();
  rejectIdentityKeys(body);
  rejectUnknownKeys(body, patchCurrencySchema);
  const input = patchCurrencySchema.parse(body);

  const result = await updateCurrency({
    locale: principal.locale,
    code: input.code,
    name: input.name,
    hasOfficial: input.has_official,
  });
  return NextResponse.json({ ok: true, ...result });
});

export const DELETE = withToken("rates:write", async ({ principal, req }) => {
  const body = await req.json();
  rejectIdentityKeys(body);
  rejectUnknownKeys(body, removeCurrencySchema);
  const input = removeCurrencySchema.parse(body);

  const result = await removeCurrency(input.code, principal.locale);
  return NextResponse.json({ ok: true, ...result });
});
