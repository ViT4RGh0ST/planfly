"use client";

import { useActionState, useState } from "react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ChevronRight } from "lucide-react";

import { ItemsEditor, emptyRow, type ItemRow } from "@/components/items-editor";
import { MoneyField, useMoneyEntry, type Rates } from "@/components/money-field";
import { parseAmountToMinor } from "@/lib/money";
import { cn } from "@/lib/utils";
import { createTransaction, type ActionState } from "@/app/(app)/actions";

type Option = { name: string; currency?: string };

export function TransactionForm({
  accounts,
  expenseCategories,
  incomeCategories,
  todayDate,
  suggestedRate,
  suggestedRateStale,
  rates,
  baseCurrency,
  ratedCurrencies,
  onDone,
}: {
  accounts: Option[];
  expenseCategories: Option[];
  incomeCategories: Option[];
  todayDate: string;
  suggestedRate: string | null;
  /** That rate's value date, only when it isn't today's. */
  suggestedRateStale: string | null;
  /** The two rates of the day. Shown in the field so you can convert right there. */
  rates: Rates;
  /** The household's currency: in it there is nothing to convert. */
  baseCurrency: string;
  /** The dialog calls it to close itself once the entry has been stored. */
  onDone?: () => void;
  /** Currencies with a rate against the base today. Only the USD/VES pair is
   *  solved, so offering a rate to a USDT account promised a conversion that
   *  afterwards never happened. */
  ratedCurrencies: string[];
}) {
  const t = useTranslations();
  const [kind, setKind] = useState<"expense" | "income" | "transfer">("expense");
  const [account, setAccount] = useState(accounts[0]?.name ?? "");
  // The conversion state is shared by the whole form, even though today there
  // is only one money field: the moment there are two, they have to convert at
  // the same rate.
  const entry = useMoneyEntry();
  // The amount is controlled from here so we can say how much of the receipt is
  // left unitemised: that figure is the only quality check on what the camera
  // read, and without the total there is nothing to compare it against.
  const [amount, setAmount] = useState("");
  const [showItems, setShowItems] = useState(false);
  const [items, setItems] = useState<ItemRow[]>([]);

  const [state, action, pending] = useActionState(
    async (prev: ActionState, form: FormData) => {
      const result = await createTransaction(prev, form);
      // The error stays on the line below, next to the form that has to be
      // corrected; the toast only confirms what went right and disappears.
      if (result?.ok) {
        toast.success(result.message);
        onDone?.();
      }
      return result;
    },
    null,
  );

  const accountCurrency = accounts.find((a) => a.name === account)?.currency ?? "";

  const totalMinor = (() => {
    if (!amount.trim() || !accountCurrency) return null;
    try {
      return Math.abs(parseAmountToMinor(amount, accountCurrency));
    } catch {
      return null;
    }
  })();
  const categories = kind === "income" ? incomeCategories : expenseCategories;

  // Three situations, not two: the account is already in the base currency and
  // there is nothing to convert; there is a rate and offering to correct it
  // makes sense; or there is no rate for that currency and it has to be said
  const foreign = Boolean(accountCurrency) && accountCurrency !== baseCurrency;
  /*
   * Conversion works in BOTH directions of the resolved pair:
   *
   *   - Bolívar account: you know the dollars and want the bolívares.
   *   - Dollar account: you know the bolívares and want the dollars.
   *
   * Both happen daily here, where prices are in one currency and payment is in
   * the other. What cannot happen is a USDT account: that pair is not resolved
   * and offering it would promise a conversion that does not exist.
   */
  const hasRates = Boolean(rates.bcv || rates.p2p);
  const convertible =
    hasRates &&
    Boolean(accountCurrency) &&
    (accountCurrency === baseCurrency || ratedCurrencies.includes(accountCurrency));
  const unconvertible = foreign && !convertible;

  return (
    <form action={action} className="grid gap-4">
      <input type="hidden" name="kind" value={kind} />
      <input type="hidden" name="currency" value={accountCurrency} />

      {/* It is a radio group, not three loose buttons: with no `role` and no
          `aria-checked`, a screen reader could not tell which one was active —
          the selection existed only as colour. */}
      <div role="radiogroup" aria-label={t("ui.form.kindGroup")} className="flex gap-2">
        {(["expense", "income", "transfer"] as const).map((option) => (
          <Button
            key={option}
            type="button"
            role="radio"
            aria-checked={kind === option}
            variant={kind === option ? "default" : "outline"}
            size="sm"
            onClick={() => setKind(option)}
            className="capitalize"
          >
            {t(`domain.entryKind.${option}`)}
          </Button>
        ))}
      </div>

      <div className="grid gap-4 sm:grid-cols-2 sm:items-start">
        <MoneyField
          id="amount"
          name="amount"
          label={t("ui.form.amount")}
          entry={entry}
          rates={rates}
          nativeCurrency={accountCurrency}
          baseCurrency={baseCurrency}
          convertible={convertible}
          rateSourceName="rate_source"
          placeholder={t("ui.form.amountPlaceholder")}
          required
          value={amount}
          onValueChange={setAmount}
        />

        <div className="grid gap-2">
          <Label htmlFor="account-trigger">
            {kind === "transfer" ? t("ui.form.fromAccount") : t("ui.form.account")}
          </Label>
          <Select name="account" value={account} onValueChange={setAccount}>
            <SelectTrigger id="account-trigger">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {accounts.map((a) => (
                <SelectItem key={a.name} value={a.name}>
                  {a.name} · {a.currency}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {kind === "transfer" ? (
        <div className="grid gap-4 sm:grid-cols-2 sm:items-start">
          <div className="grid gap-2">
            <Label htmlFor="to-account-trigger">{t("ui.form.toAccount")}</Label>
            <Select name="to_account">
              <SelectTrigger id="to-account-trigger">
                <SelectValue placeholder={t("ui.form.toAccountPlaceholder")} />
              </SelectTrigger>
              <SelectContent>
                {accounts
                  .filter((a) => a.name !== account)
                  .map((a) => (
                    <SelectItem key={a.name} value={a.name}>
                      {a.name} · {a.currency}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="to_amount">{t("ui.form.toAmount")}</Label>
            <Input
              id="to_amount"
              name="to_amount"
              inputMode="decimal"
              placeholder={t("ui.form.toAmountPlaceholder")}
            />
          </div>
        </div>
      ) : (
        <div className="grid gap-2">
          <Label htmlFor="category-trigger">{t("ui.form.category")}</Label>
          <Select name="category">
            <SelectTrigger id="category-trigger">
              <SelectValue placeholder={t("ui.form.categoryPlaceholder")} />
            </SelectTrigger>
            <SelectContent>
              {categories.map((c) => (
                <SelectItem key={c.name} value={c.name}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 sm:items-start">
        <div className="grid gap-2">
          <Label htmlFor="description">{t("ui.form.description")}</Label>
          <Input id="description" name="description" placeholder={t("ui.form.descriptionPlaceholder")} />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="occurred_on">{t("ui.form.date")}</Label>
          <Input
            id="occurred_on"
            name="occurred_on"
            type="date"
            defaultValue={todayDate}
            // An entry is recorded when it happened, not when it is going to happen.
            max={todayDate}
          />
        </div>
      </div>

      {/* When typing in dollars the rate has already been chosen above, with
          its number in view: repeating a rate field here would be two controls
          for the same thing in the same form. */}
      {foreign && convertible && (
        <div className="grid gap-2">
          <Label htmlFor="rate">
            {t("ui.form.rate")} <span className="text-muted-foreground">{t("ui.form.optional")}</span>
          </Label>
          <Input
            id="rate"
            name="rate"
            inputMode="decimal"
            placeholder={
              suggestedRate
                ? t("ui.form.ratePlaceholderSuggested", { rate: suggestedRate })
                : t("ui.form.ratePlaceholderPair", {
                    quote: accountCurrency,
                    base: baseCurrency,
                  })
            }
            aria-describedby={suggestedRateStale ? "rate-stale" : undefined}
          />
          {suggestedRateStale && (
            <p id="rate-stale" className="text-xs text-caution">
              {t("ui.form.rateStale", { date: suggestedRateStale })}
            </p>
          )}
          {/* No fixed `rate_source`: always sending it made the server prefer
              "manual", find no manual rate to apply and fall back to P2P by
              elimination, ignoring the household's `default_rate_source`. When
              the field carries a number, `recordTransaction` already works out
              that the rate is a manual one. */}
        </div>
      )}

      {unconvertible && (
        <p className="text-sm text-caution">
          {t("ui.form.unconvertible", { currency: accountCurrency, base: baseCurrency })}
        </p>
      )}

      {/* The breakdown is optional and comes folded: most expenses have no
          products to record, and a line editor that is always open would turn
          "gasté 350 en el mercado" into an inventory form. */}
      {kind !== "transfer" && (
        <div className="grid gap-2">
          <button
            type="button"
            aria-expanded={showItems}
            onClick={() => {
              setShowItems((v) => !v);
              if (!showItems && items.length === 0) setItems([emptyRow()]);
            }}
            className="flex w-fit items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            <ChevronRight
              aria-hidden
              className={cn("size-4 transition-transform", showItems && "rotate-90")}
            />
            {t("ui.form.breakDown")} {items.length > 0 && !showItems && `(${items.length})`}
          </button>

          {showItems && (
            <ItemsEditor
              rows={items}
              onChange={setItems}
              currency={accountCurrency || baseCurrency}
              totalMinor={totalMinor}
            />
          )}
        </div>
      )}

      <Button type="submit" disabled={pending}>
        {pending ? t("ui.form.saving") : t("ui.form.save")}
      </Button>

      {state && !state.ok && (
        <p role="alert" className="text-sm text-destructive">
          {state.message}
        </p>
      )}
    </form>
  );
}
