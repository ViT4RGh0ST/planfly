"use client";

import { useActionState, useEffect, useRef } from "react";
import { useTransition } from "react";
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
import { deleteRuleAction, saveRuleAction, type ActionState } from "@/app/(app)/actions";
import { useTranslations } from "next-intl";

export type Rule = {
  id: string;
  pattern: string;
  field: string;
  operator: string;
  priority: number;
  category: string | null;
};

/**
 * The rules that categorise only what is imported.
 *
 * It lives in /import and not on a screen of its own because that is where they
 * are used: you upload a statement, see what was left uncategorised, and write
 * the rule for next time. Moving it somewhere of its own would turn it into
 * configuration nobody visits.
 */
export function RulesManager({ rules, categories }: { rules: Rule[]; categories: string[] }) {
  const t = useTranslations();
  const [state, action, pending] = useActionState<ActionState, FormData>(saveRuleAction, null);
  const formRef = useRef<HTMLFormElement>(null);
  const [borrando, startTransition] = useTransition();

  useEffect(() => {
    if (!state) return;
    if (state.ok) {
      toast.success(state.message);
      formRef.current?.reset();
    }
  }, [state]);

  return (
    <section aria-labelledby="reglas" className="mt-12">
      <h2
        id="reglas"
        className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground"
      >
        {t("ui.rules.title")}
      </h2>
      <p className="mt-1 max-w-[62ch] text-sm text-muted-foreground">
        {t("ui.rules.hint")}
      </p>

      {/* A sentence, not a form with loose labels: "If the description
          contains «farmatodo», file it under Salud". The captions are there only
          for whoever navigates with a screen reader; on screen, the words
          between the controls do that job and also say what each one means. */}
      <form
        ref={formRef}
        action={action}
        className="mt-6 flex flex-wrap items-center gap-x-2 gap-y-3 text-sm"
      >
        <span className="text-muted-foreground">{t("ui.rules.if")}</span>

        <Label htmlFor="field" className="sr-only">
          {t("ui.rules.fieldLabel")}
        </Label>
        <Select name="field" defaultValue="description">
          <SelectTrigger id="field" className="h-9 w-[10.5rem]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="description">{t("domain.rule.field.description")}</SelectItem>
            <SelectItem value="payee">{t("domain.rule.field.payee")}</SelectItem>
          </SelectContent>
        </Select>

        <Label htmlFor="operator" className="sr-only">
          {t("ui.rules.operatorLabel")}
        </Label>
        <Select name="operator" defaultValue="contains">
          <SelectTrigger id="operator" className="h-9 w-[9.5rem]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="contains">{t("domain.rule.operator.contains")}</SelectItem>
            <SelectItem value="equals">{t("domain.rule.operator.equals")}</SelectItem>
            <SelectItem value="regex">{t("domain.rule.operator.regex")}</SelectItem>
          </SelectContent>
        </Select>

        <Label htmlFor="pattern" className="sr-only">
          {t("ui.rules.patternLabel")}
        </Label>
        <Input
          id="pattern"
          name="pattern"
          required
          autoComplete="off"
          placeholder={t("ui.rules.patternPlaceholder")}
          className="h-9 w-44"
        />

        <span className="text-muted-foreground">{t("ui.rules.then")}</span>

        <Label htmlFor="category" className="sr-only">
          {t("ui.rules.categoryLabel")}
        </Label>
        <Input
          id="category"
          name="category"
          required
          autoComplete="off"
          list="categorias-regla"
          placeholder={t("ui.rules.categoryPlaceholder")}
          className="h-9 w-40"
        />
        <datalist id="categorias-regla">
          {categories.map((c) => (
            <option key={c} value={c} />
          ))}
        </datalist>

        <Button type="submit" disabled={pending} className="h-9">
          {pending ? t("ui.form.saving") : t("ui.rules.add")}
        </Button>

        {state && !state.ok && (
          <p role="alert" className="w-full text-xs text-destructive">
            {state.message}
          </p>
        )}
      </form>

      {rules.length > 0 ? (
        <ul className="mt-6 divide-y divide-border">
          {rules.map((r) => (
            <li key={r.id} className="flex items-center justify-between gap-4 py-2">
              <p className="min-w-0 text-sm">
                {t("ui.rules.rule", {
                  field: t(`domain.rule.field.${r.field}`),
                  operator: t(`domain.rule.operator.${r.operator}`),
                  pattern: r.pattern,
                })}
                <span className="font-medium">{r.category ?? "—"}</span>
              </p>
              <Button
                variant="ghost"
                size="sm"
                className="h-9 shrink-0"
                disabled={borrando}
                aria-label={t("ui.rules.deleteNamed", { pattern: r.pattern })}
                onClick={() =>
                  startTransition(async () => {
                    const result = await deleteRuleAction(r.id);
                    if (result?.ok) toast.success(result.message);
                    else if (result) toast.error(result.message);
                  })
                }
              >
                {t("ui.rules.delete")}
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-6 text-sm text-muted-foreground">
          {t("ui.rules.empty")}
        </p>
      )}
    </section>
  );
}
