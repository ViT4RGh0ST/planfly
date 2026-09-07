"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

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
import { setManualRate, type ActionState } from "@/app/(app)/actions";
import { useTranslations } from "next-intl";

/**
 * Setting the day's rate by hand.
 *
 * It is what makes planfly useful with no source connected, so it lives in plain
 * sight and not behind a dialog: when it is genuinely needed is exactly when
 * there is no figure on screen, and hiding the one remaining path behind a click
 * would mean staring at three dashes.
 *
 * A single row: the screen exists to read two numbers at a glance, and this
 * cannot compete with them.
 *
 * Which is why the currency is only offered when there is more than one pair to
 * choose between. A household holding bolívares alone sees exactly the form it
 * saw before; the control appears on the day a second currency makes it mean
 * something, and never as a select with one option in it.
 */
export function ManualRateForm({
  today,
  pairs,
}: {
  today: string;
  /** The pairs this household actually holds. Never an invented list. */
  pairs: Array<{ base: string; quote: string }>;
}) {
  const [state, action, pending] = useActionState<ActionState, FormData>(setManualRate, null);
  const t = useTranslations();
  const formRef = useRef<HTMLFormElement>(null);

  /*
   * The pair travels as one value, so the two halves cannot arrive apart.
   *
   * `base` and `quote` are only meaningful together — a rate is «so many of this
   * per one of that» — and two selects would let somebody send a base without
   * its quote and have the schema fill the missing half with USD/VES. That is
   * this codebase's own rule: a valid field in the wrong context is worse than
   * an invented one, because it passes and lands somewhere nobody looks.
   */
  const [pair, setPair] = useState(() =>
    pairs.length > 0 ? `${pairs[0].base}>${pairs[0].quote}` : "USD>VES",
  );
  const [base, quote] = pair.split(">");

  useEffect(() => {
    if (!state) return;
    if (state.ok) {
      toast.success(state.message);
      // Only the value is cleared: the slot and the date usually repeat, and
      // choosing them again on every correction is friction for nothing.
      const input = formRef.current?.elements.namedItem("rate");
      if (input instanceof HTMLInputElement) input.value = "";
    }
  }, [state]);

  return (
    <form ref={formRef} action={action} className="flex flex-wrap items-end gap-3">
      <div className="grow-0">
        <Label htmlFor="slot" className="text-xs text-muted-foreground">
          {t("ui.rates.form.which")}
        </Label>
        <Select name="slot" defaultValue="official">
          <SelectTrigger id="slot" className="mt-1.5 h-9 w-[9.5rem]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="official">{t("ui.rates.form.officialShort")}</SelectItem>
            <SelectItem value="parallel">{t("ui.rates.form.parallelShort")}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Only when there is a choice to make. */}
      {pairs.length > 1 && (
        <div className="grow-0">
          <Label htmlFor="pair" className="text-xs text-muted-foreground">
            {t("ui.rates.form.currency")}
          </Label>
          <Select name="pair" value={pair} onValueChange={setPair}>
            <SelectTrigger id="pair" className="mt-1.5 h-9 w-[8.5rem]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {pairs.map((p) => (
                <SelectItem key={`${p.base}>${p.quote}`} value={`${p.base}>${p.quote}`}>
                  {p.quote}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
      {/* With one pair the select is not drawn, so the value still has to travel. */}
      {pairs.length <= 1 && <input type="hidden" name="pair" value={pair} />}

      <div className="grow-0">
        <Label htmlFor="rate" className="text-xs text-muted-foreground">
          {/* «Bolívares por dólar» named one pair and lied as soon as there was
              a second. It says which two currencies this figure is between. */}
          {t("ui.rates.form.unitsPer", { quote, base })}
        </Label>
        <Input
          id="rate"
          name="rate"
          required
          inputMode="decimal"
          autoComplete="off"
          placeholder="877,00"
          className="mt-1.5 h-9 w-36 tabular-nums"
        />
      </div>

      <div className="grow-0">
        <Label htmlFor="effective_on" className="text-xs text-muted-foreground">
          {t("ui.rates.form.forDay")}
        </Label>
        <Input
          id="effective_on"
          name="effective_on"
          type="date"
          defaultValue={today}
          className="mt-1.5 h-9 w-[10.5rem]"
        />
      </div>

      <Button type="submit" disabled={pending} className="h-9">
        {pending ? t("ui.rates.form.setting") : t("ui.rates.form.set")}
      </Button>

      {state && !state.ok && (
        <p role="alert" className="w-full text-xs text-destructive">
          {state.message}
        </p>
      )}
    </form>
  );
}
