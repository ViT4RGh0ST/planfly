import { NextResponse } from "next/server";

import { withToken, rejectIdentityKeys, rejectUnknownKeys, idFromUrl } from "@/lib/api/handler";
import { toggleRecurringSchema } from "@/lib/validation";
import { removeRecurringRule, setRecurringActive } from "@/lib/services/recurring";

export const dynamic = "force-dynamic";

/**
 * Pausing or resuming a recurrence.
 *
 * Being able to create them and not to stop them was the ugly asymmetry: a badly
 * configured rule records on its own every month, and until now it could only be
 * stopped from the web. Resuming recomputes the next date from today, so the
 * pause does not end up catching up in one go with what the pause said you did
 * not want.
 */
export const PATCH = withToken("recurring:write", async ({ principal, req }) => {
  const body = await req.json();
  rejectIdentityKeys(body);
  rejectUnknownKeys(body, toggleRecurringSchema);
  const input = toggleRecurringSchema.parse(body);

  const result = await setRecurringActive(
    principal.householdId,
    idFromUrl(req.url),
    input.active,
    principal.timezone,
    principal.locale,
  );
  return NextResponse.json({ ok: true, ...result });
});

/** Deleting it. What it already recorded stays: it happened. */
export const DELETE = withToken("recurring:write", async ({ principal, req }) => {
  const result = await removeRecurringRule(principal.householdId, idFromUrl(req.url), principal.locale);
  return NextResponse.json({ ok: true, ...result });
});
