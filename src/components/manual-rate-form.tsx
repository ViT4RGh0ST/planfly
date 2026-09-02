"use client";

import { useActionState, useEffect, useRef } from "react";
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
 */
export function ManualRateForm({ today }: { today: string }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(setManualRate, null);
  const t = useTranslations();
  const formRef = useRef<HTMLFormElement>(null);

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

      <div className="grow-0">
        <Label htmlFor="rate" className="text-xs text-muted-foreground">
          {t("ui.rates.form.perDollar")}
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
