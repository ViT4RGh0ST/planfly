import { NextResponse } from "next/server";

import { withToken, rejectIdentityKeys, rejectUnknownKeys } from "@/lib/api/handler";
import { createAccountSchema, patchAccountSchema } from "@/lib/validation";
import {
  archiveAccount,
  createAccount,
  unarchiveAccount,
  updateAccount,
} from "@/lib/services/manage-accounts";
import { REVIEW_THRESHOLD, resolveAccount } from "@/lib/services/resolve-entities";
import { normalizeLocale } from "@/i18n/config";
import { getTranslator } from "@/i18n/translator";

export const dynamic = "force-dynamic";

/**
 * Creating accounts from the bot.
 *
 * The danger here is not the obvious one. Creating one account too many breaks
 * nothing loudly: it splits the ledger in two. «Provincial» next to «Banco
 * Provincial» are different slugs, so the unique index does not see them clash,
 * and from that moment half the expenses go to one and half to the other — both
 * balances are false and so is net worth.
 *
 * That is why before creating we ask the same fuzzy matcher the entry recording
 * uses: if the name already lands on an existing account, nothing is created and
 * we return which one it is, so the agent consults instead of deciding.
 * `confirm: true` is the person's explicit yes, and only then is one really opened.
 */
export const POST = withToken("accounts:write", async ({ principal, req }) => {
  const t = getTranslator(normalizeLocale(principal.locale));
  const body = await req.json();
  rejectIdentityKeys(body);
  rejectUnknownKeys(body, createAccountSchema);
  const input = createAccountSchema.parse(body);
  const confirm = input.confirm === true;

  if (!confirm) {
    // With the currency first, same as when recording: "efectivo" is ambiguous
    // when there is cash in bolívares and in dollars.
    const existing = await resolveAccount(principal.householdId, input.name, input.currency);

    /*
     * It only stops on a resemblance worth trusting, at the same threshold that
     * decides whether an expense goes to the review tray.
     *
     * At the matcher's minimum threshold, "Tarjeta Visa" clashed with "Tarjeta
     * de crédito" at 0,33 resemblance: one word in common is enough for two
     * legitimate accounts to look alike, and a warning that always fires is a
     * warning people learn to ignore — precisely when it genuinely matters.
     */
    if (existing && existing.score >= REVIEW_THRESHOLD) {
      const exact = existing.via !== "similarity";
      return NextResponse.json(
        {
          ok: false,
          error: "account_may_exist",
          message: exact
            ? t("api.accounts.duplicate", { name: existing.name })
            : t("api.accounts.maybeDuplicate", { name: existing.name }),
          existing: { name: existing.name, score: existing.score, via: existing.via },
        },
        { status: 409 },
      );
    }
  }

  const result = await createAccount({
    householdId: principal.householdId,
    locale: principal.locale,
    timezone: principal.timezone,
    name: input.name,
    type: input.type,
    currency: input.currency,
    openingBalance: input.opening_balance,
    institution: input.institution,
    aliases: input.aliases,
  });

  return NextResponse.json(result, { status: 201 });
});


/**
 * Correcting, archiving or unarchiving an account, **by name**.
 *
 * With no id in the path on purpose. This API's principle is that the model
 * sends names and the server resolves them fuzzily: that way it cannot invent a
 * foreign key, and the user says «in cash I have 5.000» without anyone having to
 * show them a uuid.
 *
 * What is genuinely needed from the chat is the **opening balance**: while no
 * account has one, net worth comes out negative, and that is not a calculation
 * bug but a ledger with no starting point.
 */
export const PATCH = withToken("accounts:write", async ({ principal, req }) => {
  const t = getTranslator(normalizeLocale(principal.locale));
  const body = await req.json();
  rejectIdentityKeys(body);
  rejectUnknownKeys(body, patchAccountSchema);
  const input = patchAccountSchema.parse(body);

  const match = await resolveAccount(principal.householdId, input.account);
  if (!match) {
    return NextResponse.json(
      {
        ok: false,
        error: "account_not_found",
        message: t("api.accounts.notFound", { input: input.account }),
      },
      { status: 404 },
    );
  }

  if (input.action === "archive" || input.action === "unarchive") {
    const result =
      input.action === "unarchive"
        ? await unarchiveAccount(principal.householdId, match.id)
        : await archiveAccount(principal.householdId, match.id);
    return NextResponse.json({ ok: true, ...result });
  }

  const result = await updateAccount({
    householdId: principal.householdId,
    locale: principal.locale,
    accountId: match.id,
    name: input.name,
    type: input.type,
    currency: input.currency,
    openingBalance: input.opening_balance,
    institution: input.institution,
    aliases: input.aliases,
  });
  return NextResponse.json({ ok: true, ...result });
});
