"use client";

import { useActionState, useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatAmount, parseAmountToMinor } from "@/lib/money";
import {
  accountForEdit,
  createAccountAction,
  editAccountAction,
  type ActionState,
  type EditableAccount,
} from "@/app/(app)/actions";
import { useTranslations } from "next-intl";

/** The types, under the name used in speech and not the enum's. */
/**
 * The order is the product's, not the catalogue's.
 *
 * It is the order the options are read in, and it puts the everyday ones first
 * and the two that are debt next to each other. A JSON object would leave that
 * to whatever order the keys happen to be written in, which is not a decision
 * anybody made.
 */
const TYPES = [
  "cash",
  "bank",
  "crypto",
  "investment",
  "prepaid",
  "credit_card",
  "loan",
  "other",
] as const;

/** The two types that are debt. It is what decides the balance sign. */
const LIABILITIES = ["credit_card", "loan"];

/**
 * Creating and correcting an account.
 *
 * In a dialog and not as a fixed card: an account is created six times in a
 * lifetime, so it does not deserve half a permanent screen, and /accounts reads
 * as the answer to "how much do I have?".
 *
 * It does not ask whether it is an asset or a liability. That is inferred from
 * the type, because having both loose invites marking a card as an asset, and
 * then the debt ADDS to net worth with nothing failing.
 */
export function AccountForm({
  currencies,
  baseCurrency,
  accountId,
  open,
  onOpenChange,
}: {
  currencies: string[];
  baseCurrency: string;
  /** If given, that account is edited; if not, a new one is created. */
  accountId?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations();
  const editing = Boolean(accountId);
  const [data, setData] = useState<EditableAccount | null>(null);
  const [failed, setFailed] = useState(false);

  const [type, setType] = useState("bank");
  const [currency, setCurrency] = useState(baseCurrency);
  const [balance, setBalance] = useState("");

  const [state, action, pending] = useActionState(
    async (prev: ActionState, form: FormData) => {
      const result = editing
        ? await editAccountAction(prev, form)
        : await createAccountAction(prev, form);
      if (result?.ok) {
        toast.success(result.message);
        onOpenChange(false);
      }
      return result;
    },
    null,
  );

  useEffect(() => {
    if (!open || !accountId) return;
    let alive = true;
    accountForEdit(accountId)
      .then((result) => {
        if (!alive) return;
        if (!result) {
          setFailed(true);
          return;
        }
        setData(result);
        setType(result.type);
        setCurrency(result.currency);
        setBalance(result.openingBalance);
      })
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [open, accountId]);

  const isLiability = LIABILITIES.includes(type);

  /**
   * Which balance the account is going to end up at.
   *
   * `opening_date` enters no calculation: the balance is the opening plus ALL
   * the lines. So typing "20.000" on an account with 10.597,98 of spending
   * leaves 9.402,02, and without saying so here the number you type does not
   * resemble the one you see afterwards.
   */
  let resulting: string | null = null;
  if (data && data.movementsMinor !== 0) {
    try {
      const opening = balance.trim() ? parseAmountToMinor(balance, currency) : 0;
      const signed = isLiability ? -Math.abs(opening) : opening;
      resulting = formatAmount(signed + data.movementsMinor, currency);
    } catch {
      // Mid-typing, "1.2" is not a valid number yet. It is not an error worth
      // shouting about: there is simply nothing to anticipate yet.
      resulting = null;
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby="account-help">
        <DialogHeader>
          <DialogTitle>{editing ? t("ui.accounts.form.titleEdit") : t("ui.accounts.form.titleNew")}</DialogTitle>
          <DialogDescription id="account-help">
            {isLiability ? t("ui.accounts.form.helpLiability") : t("ui.accounts.form.help")}
          </DialogDescription>
        </DialogHeader>

        {failed && (
          <p role="alert" className="text-sm text-destructive">
            {t("ui.accounts.form.failed")}
          </p>
        )}

        {editing && !data && !failed && (
          <p className="py-6 text-center text-sm text-muted-foreground">{t("ui.edit.loading")}</p>
        )}

        {(!editing || data) && (
          <form action={action} className="grid gap-4">
            {accountId && <input type="hidden" name="id" value={accountId} />}
            <input type="hidden" name="type" value={type} />
            <input type="hidden" name="currency" value={currency} />

            <div className="grid gap-2">
              <Label htmlFor="account-name">{t("ui.accounts.form.name")}</Label>
              <Input
                id="account-name"
                name="name"
                defaultValue={data?.name}
                placeholder={t("ui.accounts.form.namePlaceholder")}
                required
                autoFocus={!editing}
              />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid min-w-0 gap-2">
                <Label htmlFor="account-type">{t("ui.accounts.form.type")}</Label>
                <Select value={type} onValueChange={setType}>
                  <SelectTrigger id="account-type" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TYPES.map((value) => (
                      <SelectItem key={value} value={value}>
                        {t(`domain.accountType.${value}.label`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {/* The hint below and not inside the item, as in the budget form.
                    Radix copies the chosen item's children onto the trigger, so
                    «Prepagada · la recargas antes de gastar» got painted whole in
                    there; with `w-fit` and `whitespace-nowrap` the control grew
                    until it rode over «Moneda». */}
                {t(`domain.accountType.${type}.hint`) && (
                  <p className="text-xs text-muted-foreground">
                    {t(`domain.accountType.${type}.hint`)}
                  </p>
                )}
              </div>

              <div className="grid min-w-0 gap-2">
                <Label htmlFor="account-currency">{t("ui.accounts.form.currency")}</Label>
                <Select
                  value={currency}
                  onValueChange={setCurrency}
                  // With entries inside, changing the currency would turn
                  // bolívares into dollars by decree.
                  disabled={data?.currencyLocked}
                >
                  <SelectTrigger
                    id="account-currency"
                    aria-describedby={data?.currencyLocked ? "currency-locked" : undefined}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {currencies.map((c) => (
                      <SelectItem key={c} value={c}>
                        {c}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {data?.currencyLocked && (
                  <p id="currency-locked" className="text-xs text-muted-foreground">
                    {t("ui.accounts.form.currencyLocked", { currency: data.currency })}
                  </p>
                )}
              </div>
            </div>

            <div className="grid gap-2">
              <Label htmlFor="account-balance">
                {isLiability ? t("ui.accounts.form.owed") : t("ui.accounts.form.openingBalance")}{" "}
                <span className="text-muted-foreground">({currency})</span>
              </Label>
              {/* text and not number: "1.234,56" is what gets typed here. */}
              <Input
                id="account-balance"
                name="opening_balance"
                inputMode="decimal"
                value={balance}
                onChange={(e) => setBalance(e.target.value)}
                placeholder="0,00"
                aria-describedby={resulting ? "balance-result" : undefined}
              />
              {resulting && data && (
                <p id="balance-result" className="text-xs text-muted-foreground">
                  {t("ui.accounts.form.resulting", {
                    movements: formatAmount(data.movementsMinor, currency, { showPlus: true }),
                  })}
                  <span className="text-foreground tabular-nums">{resulting}</span>.
                </p>
              )}
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid min-w-0 gap-2">
                <Label htmlFor="account-institution">
                  {t("ui.accounts.form.institution")}{" "}
                  <span className="text-muted-foreground">{t("ui.form.optional")}</span>
                </Label>
                <Input
                  id="account-institution"
                  name="institution"
                  defaultValue={data?.institution}
                  placeholder={t("ui.accounts.form.institutionPlaceholder")}
                />
              </div>
              <div className="grid min-w-0 gap-2">
                <Label htmlFor="account-aliases">
                  {t("ui.accounts.form.aliases")}{" "}
                  <span className="text-muted-foreground">{t("ui.form.optional")}</span>
                </Label>
                <Input
                  id="account-aliases"
                  name="aliases"
                  defaultValue={data?.aliases}
                  placeholder={t("ui.accounts.form.aliasesPlaceholder")}
                  aria-describedby="aliases-help"
                />
              </div>
            </div>
            <p id="aliases-help" className="-mt-2 text-xs text-muted-foreground">
              {t("ui.accounts.form.aliasesHelp")}
            </p>

            {state && !state.ok && (
              <p role="alert" className="text-sm text-destructive">
                {state.message}
              </p>
            )}

            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                disabled={pending}
                onClick={() => onOpenChange(false)}
              >
                {t("ui.rowActions.cancel")}
              </Button>
              <Button type="submit" disabled={pending}>
                {pending ? t("ui.form.saving") : editing ? t("ui.edit.saveChanges") : t("ui.accounts.form.create")}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
