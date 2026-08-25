"use client";

import { useEffect, useState } from "react";
import { Search, X } from "lucide-react";
import { parseAsString, useQueryStates } from "nuqs";
import { useTranslations } from "next-intl";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { canonicalPeriod } from "@/lib/dates";
import { formatAmount } from "@/lib/money";
import { cn } from "@/lib/utils";
import type { Facet } from "@/lib/services/reports";

/**
 * The values are the canonical keys, the same ones the API takes.
 *
 * They used to be the Spanish tokens (`mes_pasado`), which is a wire format
 * shared with the bot. The old spellings keep working — `resolvePeriod` has a
 * permanent alias table — so a bookmarked URL does not change what it shows.
 */
const PERIODS = ["today", "week", "month", "last_month", "year", "all"] as const;

/**
 * The query, as a rail.
 *
 * This screen is opened to look for something specific, and the filters used to
 * be a row of dropdowns above the table: you had to open each one to know what
 * it contained and nothing said where the money was.
 *
 * Here every option carries **its count and its amount**, so «Groceries 12 ·
 * Bs 340.000» answers half the question before you even click. The counts come
 * from the server computed with every filter EXCEPT its own, so that picking a
 * category leaves the others still saying how many they have: otherwise they
 * would all read zero and there would be nowhere to jump.
 *
 * It takes the place the recording form used to have — which in practice is not
 * used from the desktop, because expenses come in over Telegram.
 */
export function TransactionFacets({
  accounts,
  categories,
  currency,
}: {
  accounts: Facet[];
  categories: Facet[];
  /** The currency each facet's amounts are shown in. */
  currency: string;
}) {
  const t = useTranslations();
  const [filters, setFilters] = useQueryStates(
    {
      q: parseAsString.withDefault(""),
      periodo: parseAsString.withDefault("month"),
      account: parseAsString.withDefault(""),
      categoria: parseAsString.withDefault(""),
      anulados: parseAsString.withDefault(""),
    },
    // `shallow: false` because each facet's counts are computed by the server:
    // without going back to it, the rail would lie about what is behind each one.
    { shallow: false },
  );

  // The search box writes into the URL, and every keystroke would fire a query
  // to the server. It waits until you stop typing; the visible value is local
  // meanwhile.
  const [term, setTerm] = useState(filters.q);

  // When the URL changes from outside — the browser back button, or "Clear the
  // query" — the field has to follow it. It is adjusted during the render and
  // not from an effect: syncing state with an effect causes a cascading
  // render, and React documents this very pattern for the case.
  const [lastQuery, setLastQuery] = useState(filters.q);
  if (filters.q !== lastQuery) {
    setLastQuery(filters.q);
    setTerm(filters.q);
  }

  useEffect(() => {
    if (term === filters.q) return;
    const id = setTimeout(() => void setFilters({ q: term || null }), 350);
    return () => clearTimeout(id);
  }, [term, filters.q, setFilters]);

  const set = (patch: Record<string, string | null>) => void setFilters(patch);

  const active =
    filters.q || filters.account || filters.categoria || canonicalPeriod(filters.periodo) !== "month" || filters.anulados;

  return (
    <div className="grid gap-6">
      <div className="grid gap-2">
        <Label htmlFor="facet-search">{t("ui.facets.search")}</Label>
        <div className="relative">
          <Search
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            id="facet-search"
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            placeholder={t("ui.facets.searchPlaceholder")}
            className="pl-9"
          />
        </div>
      </div>

      <FacetGroup
        title={t("ui.facets.period")}
        items={PERIODS.map((value) => ({ value, label: t(`domain.period.option.${value}`) }))}
        selected={canonicalPeriod(filters.periodo)}
        onSelect={(value) => set({ periodo: value })}
        clearable={false}
      />

      <FacetGroup
        title={t("ui.facets.account")}
        items={accounts.map((a) => ({
          value: a.value,
          label: a.value,
          count: a.count,
          amount: facetAmount(a, currency, t("ui.facets.noRate")),
        }))}
        selected={filters.account}
        onSelect={(value) => set({ account: value === filters.account ? null : value })}
      />

      <FacetGroup
        title={t("ui.facets.category")}
        items={categories.map((c) => ({
          value: c.value,
          label: c.value,
          count: c.count,
          amount: facetAmount(c, currency, t("ui.facets.noRate")),
        }))}
        selected={filters.categoria}
        onSelect={(value) => set({ categoria: value === filters.categoria ? null : value })}
      />

      <div className="grid gap-2">
        <button
          type="button"
          role="switch"
          aria-checked={filters.anulados === "1"}
          onClick={() => set({ anulados: filters.anulados === "1" ? null : "1" })}
          className={cn(
            "flex items-center gap-2 rounded-md py-1 text-left text-sm",
            "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
            filters.anulados === "1" ? "text-foreground" : "text-muted-foreground hover:text-foreground",
          )}
        >
          <span
            className={cn(
              "flex h-4 w-7 shrink-0 items-center rounded-full p-0.5 transition-colors",
              filters.anulados === "1" ? "bg-foreground" : "bg-border",
            )}
          >
            <span
              className={cn(
                "size-3 rounded-full bg-background transition-transform",
                filters.anulados === "1" && "translate-x-3",
              )}
            />
          </span>
          {t("ui.facets.showVoided")}
        </button>

        {active && (
          <button
            type="button"
            onClick={() =>
              set({ q: null, periodo: null, account: null, categoria: null, anulados: null })
            }
            className={cn(
              "flex items-center gap-1.5 rounded-md py-1 text-left text-sm text-muted-foreground",
              "transition-colors hover:text-foreground",
              "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
            )}
          >
            <X aria-hidden className="size-3.5" />
            {t("ui.facets.clear")}
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * A facet's amount, or why there isn't one.
 *
 * A "$ 0,00" on Binance reads as "there is nothing here", when the truth is that
 * no USDT/USD rate exists to convert it. An explained hole is worth more than a
 * figure that lies.
 */
function facetAmount(facet: Facet, currency: string, noRate: string): string {
  if (facet.amountMinor === 0 && facet.unvalued > 0) return noRate;
  return formatAmount(facet.amountMinor, currency);
}

type Item = { value: string; label: string; count?: number; amount?: string };

/** A group of the rail. The chosen option is marked by weight and by rule, not by colour alone. */
function FacetGroup({
  title,
  items,
  selected,
  onSelect,
  clearable = true,
}: {
  title: string;
  items: Item[];
  selected: string;
  onSelect: (value: string) => void;
  clearable?: boolean;
}) {
  if (items.length === 0) return null;

  return (
    <section aria-labelledby={`facet-${title}`}>
      <h3
        id={`facet-${title}`}
        className="mb-1.5 text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground"
      >
        {title}
      </h3>
      <ul>
        {items.map((item) => {
          const isSelected = selected === item.value;
          return (
            <li key={item.value}>
              <button
                type="button"
                aria-pressed={clearable ? isSelected : undefined}
                onClick={() => onSelect(item.value)}
                className={cn(
                  "-mx-2 flex w-[calc(100%+1rem)] items-baseline gap-2 rounded-md px-2 py-1 text-left text-sm",
                  "transition-colors hover:bg-secondary/60",
                  "focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring",
                  isSelected ? "font-medium text-foreground" : "text-muted-foreground",
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    "mt-1.5 h-3 w-0.5 shrink-0 rounded-full",
                    isSelected ? "bg-foreground" : "bg-transparent",
                  )}
                />
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
                {item.count != null && (
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                    {item.count}
                  </span>
                )}
              </button>
              {/* The amount goes underneath and not on the same line: in a
                  narrow rail it competed with the name and truncated it.
                  No opacity: `text-muted-foreground/80` left it at 2.6:1 on a
                  light background, below WCAG's 4.5:1. The bare token already
                  gives 4.73:1, and dimming a token calibrated to sit at the
                  limit is the easiest way to break it. */}
              {item.amount && (
                <p className="-mt-0.5 mb-0.5 pl-2 text-xs tabular-nums text-muted-foreground">
                  {item.amount}
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
