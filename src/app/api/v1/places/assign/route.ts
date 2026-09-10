import { NextResponse } from "next/server";

import { normalizeLocale } from "@/i18n/config";
import { getTranslator } from "@/i18n/translator";
import { withToken, rejectIdentityKeys, rejectUnknownKeys } from "@/lib/api/handler";
import { placeUnplaced } from "@/lib/services/manage-payees";
import { resolvePayee } from "@/lib/services/resolve-entities";
import { assignPlaceSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

/**
 * Putting a place on every entry that carries exactly one description.
 *
 * Its own route rather than another branch of `/places`, because it writes to a
 * different table and carries a different risk: `/places` edits a shop, this
 * relabels the ledger. Forty rows at once, and «how much do I spend at
 * Farmatodo» answers differently from the moment it returns.
 *
 * It writes `payee_id` and nothing else, which is why it does not go through
 * `updateTransaction`: no amount, no rate, no account, no date — nothing that
 * could move a figure. Running the whole recalculation over forty rows to set
 * one column would risk far more than it protects.
 *
 * The description is matched EXACTLY as it was grouped by `?view=unplaced`, so
 * what gets written is the set that was counted and shown, never a wider one a
 * resemblance swept in. Copy it back letter by letter; do not retype it.
 */
export const POST = withToken("catalog:write", async ({ principal, req }) => {
  const t = getTranslator(normalizeLocale(principal.locale));
  const body = await req.json();
  rejectIdentityKeys(body);
  rejectUnknownKeys(body, assignPlaceSchema);
  const input = assignPlaceSchema.parse(body);

  const match = await resolvePayee(principal.householdId, input.place);
  if (!match) {
    return NextResponse.json(
      {
        ok: false,
        error: "payee_not_found",
        message: t("api.places.notFound", { input: input.place }),
      },
      { status: 404 },
    );
  }

  const result = await placeUnplaced(principal.householdId, input.description, match.id);

  /*
   * Nothing matched is a refusal, not a success with a zero in it.
   *
   * `{"ok": true, "n": 0}` is the answer a model reports as done — it did what
   * it was told and the server said yes. The description was mistyped, or those
   * entries already have a place, and either way the person is told their forty
   * purchases were labelled when none were.
   */
  if (result.n === 0) {
    return NextResponse.json(
      {
        ok: false,
        error: "nothing_matched",
        message: t("api.places.nothingMatched", { description: input.description }),
      },
      { status: 422 },
    );
  }

  return NextResponse.json({ ok: true, place: match.name, ...result });
});
