"use client";

import { useActionState, useState, useTransition } from "react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  createCurrencyAction,
  removeCurrencyAction,
  toggleCurrencyOfficialAction,
  type ActionState,
} from "@/app/(app)/actions";
import type { CurrencyInUse } from "@/lib/services/manage-currencies";
import { cn } from "@/lib/utils";

/**
 * The currencies this planfly knows.
 *
 * It lives at the foot of the rates screen and not on one of its own: a currency
 * is added twice in a lifetime, and the question that brings somebody here —
 * «why has my peso no rate?» — is asked while looking at the rates.
 *
 * The decimals are shown and cannot be set. `money.ts` keeps its own map of them
 * and cannot read this table, so a row written here takes what that map would
 * use anyway. Offering the field would be offering a way to put every amount in
 * that currency out by a factor of a hundred, silently, in both directions.
 */
export function CurrencyManager({
  currencies,
  baseCurrency,
}: {
  currencies: CurrencyInUse[];
  /** The household's own currency: it has no rate against itself. */
  baseCurrency: string;
}) {
  const t = useTranslations();
  const [adding, setAdding] = useState(false);

  const [state, action, pending] = useActionState(
    async (prev: ActionState, form: FormData) => {
      const result = await createCurrencyAction(prev, form);
      if (result?.ok) {
        toast.success(result.message);
        setAdding(false);
      }
      return result;
    },
    null,
  );

  return (
    <div className="mt-6">
      <ul className="divide-y divide-border">
        {currencies.map((currency) => (
          <Row key={currency.code} currency={currency} baseCurrency={baseCurrency} />
        ))}
      </ul>

      {!adding && (
        <Button
          size="sm"
          variant="outline"
          className="mt-4"
          onClick={() => setAdding(true)}
        >
          {t("ui.currencies.add")}
        </Button>
      )}

      {adding && (
        <form action={action} className="mt-4 grid gap-4 border-t border-border pt-4">
          <div className="grid gap-4 sm:grid-cols-[8rem_1fr]">
            <div className="grid gap-2">
              <Label htmlFor="currency-code">{t("ui.currencies.code")}</Label>
              <Input
                id="currency-code"
                name="code"
                placeholder="PEN"
                maxLength={6}
                required
                autoFocus
                className="uppercase"
              />
            </div>
            <div className="grid min-w-0 gap-2">
              <Label htmlFor="currency-name">{t("ui.currencies.name")}</Label>
              <Input id="currency-name" name="name" placeholder="Peruvian sol" required />
            </div>
          </div>

          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              name="has_official"
              className="mt-0.5 size-4 shrink-0 accent-foreground"
            />
            <span className="text-muted-foreground">{t("ui.currencies.hasOfficialHelp")}</span>
          </label>

          <p className="text-xs text-muted-foreground">{t("ui.currencies.decimalsFixed")}</p>

          {state && !state.ok && (
            <p role="alert" className="text-sm text-destructive">
              {state.message}
            </p>
          )}

          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={pending}>
              {pending ? t("ui.form.saving") : t("ui.currencies.create")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={() => setAdding(false)}
            >
              {t("ui.rowActions.cancel")}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}

function Row({
  currency,
  baseCurrency,
}: {
  currency: CurrencyInUse;
  baseCurrency: string;
}) {
  const t = useTranslations();
  const [pending, startTransition] = useTransition();

  const run = (work: () => Promise<ActionState>) =>
    startTransition(async () => {
      const result = await work();
      if (result?.ok) toast.success(result.message);
      else if (result) toast.error(result.message);
    });

  /*
   * The base currency has no rate against itself, and a currency whose rate does
   * not expire has one written once. Describing either as «official and
   * parallel» is describing a question that is not asked about them.
   */
  const isBase = currency.code === baseCurrency;
  const details = [
    isBase
      ? t("ui.currencies.isBase")
      : !currency.rateAges
        ? t("ui.currencies.doesNotAge")
        : currency.hasOfficial
          ? t("ui.currencies.withOfficial")
          : t("ui.currencies.oneRate"),
    currency.accounts > 0
      ? t("ui.currencies.accounts", { n: currency.accounts })
      : t("ui.currencies.unused"),
  ];

  return (
    <li className="flex flex-wrap items-center justify-between gap-3 py-3">
      <div className="min-w-0">
        <p className="text-sm">
          <span className="font-medium tabular-nums">{currency.code}</span>
          <span className="text-muted-foreground"> · {currency.name}</span>
        </p>
        <p className={cn("text-xs", currency.accounts > 0 ? "text-muted-foreground" : "text-muted-foreground/70")}>
          {details.join(" · ")}
        </p>
      </div>

      <div className="flex shrink-0 items-center gap-1">
        {/* The row above says what it IS; a button says what it would DO. Both
            written as statements, the two contradicted each other on every
            line. */}
        {!isBase && currency.rateAges && (
          <Button
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={() =>
              run(() => toggleCurrencyOfficialAction(currency.code, !currency.hasOfficial))
            }
          >
            {currency.hasOfficial ? t("ui.currencies.dropOfficial") : t("ui.currencies.addOfficial")}
          </Button>
        )}
        {/* Removing is offered only while nothing is held in it. A currency with
            an account cannot go — the foreign key says so anyway, but with a
            database error instead of an answer. */}
        {currency.accounts === 0 && (
          <Button
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={() => run(() => removeCurrencyAction(currency.code))}
          >
            {t("ui.currencies.remove")}
          </Button>
        )}
      </div>
    </li>
  );
}
