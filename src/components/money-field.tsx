"use client";

import { useState } from "react";

import { formatDay } from "@/lib/dates";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatAmount, formatRate, minorUnit, parseAmountToMinor } from "@/lib/money";
import { cn } from "@/lib/utils";
import { useLocale, useTranslations } from "next-intl";

export type Rates = Record<string, { rate: string; effectiveOn: string; stale: boolean }>;
export type RateChoice = "bcv" | "p2p";

/**
 * Typing an amount in the currency you think in, not the one you pay in.
 *
 * Many purchases here are thought of in dollars — petrol costs $15,50, the
 * groceries $40 — and paid in bolívares at the day's rate. Forcing someone to
 * multiply 761,22 in their head, or to go hunting for the rate on another screen
 * and come back, is asking the person for work the system has already done.
 *
 * It lives apart and not inside a form because two need it — recording an entry
 * and recording an installment purchase — and two copies of this logic would end
 * up disagreeing about which rate was applied.
 */

/**
 * Which rate it was converted with, if it was converted at all.
 *
 * It travels to the server as `rate_source` so the line is valued with it.
 * Without that, typing $40 at BCV and then seeing $35 in the history would make
 * you distrust a figure you derived yourself.
 *
 * **One per currency, not one per form.** The price and the down payment of the
 * same purchase are in the same currency and come from the same rate, so they
 * share an `entry`. The two legs of a cross-currency transfer do not: each is
 * derived on its own, and sharing it made converting one paint «converted at
 * BCV» over the other without it having been touched.
 */
export function useMoneyEntry() {
  const [convertedWith, setConvertedWith] = useState<RateChoice | null>(null);
  return { convertedWith, setConvertedWith };
}

export type MoneyEntry = ReturnType<typeof useMoneyEntry>;

/**
 * A money field with its conversion.
 *
 * When you type in the base currency, what travels to the server is NOT what you
 * see: the visible field becomes a display and the converted amount goes in a
 * hidden field, along with the rate source used.
 */
export function MoneyField({
  name,
  label,
  entry,
  rates,
  nativeCurrency,
  baseCurrency,
  convertible,
  quoteCurrency = "VES",
  rateSourceName,
  showControls = true,
  placeholder,
  required,
  id,
  value,
  onValueChange,
  footer,
}: {
  name: string;
  label: string;
  entry: MoneyEntry;
  rates: Rates;
  /** The account's currency: that is what it is stored in. */
  nativeCurrency: string;
  baseCurrency: string;
  /** Is there a rate to convert this currency? If not, it is not offered. */
  convertible: boolean;
  /** The currency the rates quote: 865,17 Bs per dollar -> "VES". */
  quoteCurrency?: string;
  /** Name of the hidden field carrying the rate source. One per leg. */
  rateSourceName?: string;
  /** The controls are painted once per form, not on every field. */
  showControls?: boolean;
  placeholder?: string;
  required?: boolean;
  id?: string;
  /** Controlled from outside when something else has to be able to fill it — a
   *  financier's rules computing the down payment, for instance. */
  value?: string;
  onValueChange?: (value: string) => void;
  /** Painted under the field: shortcuts belonging to whoever uses it. */
  footer?: React.ReactNode;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const [ownText, setOwnText] = useState("");
  const text = value ?? ownText;
  const setText = onValueChange ?? setOwnText;
  const fieldId = id ?? name;

  /**
   * Which currency it converts from, and in which direction.
   *
   * The rate is quoted-per-base — 865,17 bolívares per dollar — so:
   *
   *   - Bolívar account: you type dollars and it MULTIPLIES.
   *   - Dollar account: you type bolívares and it DIVIDES.
   *
   * Both situations are the same in real life: you know the price in one
   * currency and pay in the other. Here the price is in bolívares and many
   * things are thought of in dollars, and both happen daily.
   */
  const isQuoteAccount = nativeCurrency === quoteCurrency;
  const fromCurrency = isQuoteAccount ? baseCurrency : quoteCurrency;

  /**
   * Replacing what was typed with its conversion.
   *
   * The value is replaced rather than converted underneath so that the figure
   * about to be stored is in plain sight and can still be corrected. And it
   * doubles as a check: if you convert 40 dollars at BCV, the line below has to
   * say $ 40,00 again.
   */
  const convert = (key: RateChoice) => {
    const rate = rates[key]?.rate;
    if (!rate || !text.trim()) return;
    try {
      const fromMinor = Math.abs(parseAmountToMinor(text, fromCurrency));
      if (fromMinor === 0) return;
      const value = fromMinor / 10 ** minorUnit(fromCurrency);
      const converted = isQuoteAccount ? value * Number(rate) : value / Number(rate);
      const nativeMinor = Math.round(converted * 10 ** minorUnit(nativeCurrency));
      if (nativeMinor === 0) return;
      setText(formatAmount(nativeMinor, nativeCurrency, { withSymbol: false }));
      entry.setConvertedWith(key);
    } catch {
      // What is not a number yet cannot be converted.
    }
  };

  const computed = (() => {
    if (!text.trim() || !nativeCurrency) return null;
    try {
      const minor = Math.abs(parseAmountToMinor(text, nativeCurrency));
      if (minor === 0) return null;
      /*
       * BOTH valuations, not one.
       *
       * There is 13% between BCV and P2P: "≈ $ 61,40" does not say whether that
       * is a lot or a little until you know which one it was computed with. And
       * it doubles as a check: if you converted 40 dollars at BCV, the BCV line
       * has to say $ 40,00 again.
       */
      const equivalents = convertible
        ? (["p2p", "bcv"] as const)
            .filter((key) => rates[key])
            .map((key) => {
              const rate = Number(rates[key].rate);
              const value = minor / 10 ** minorUnit(nativeCurrency);
              // Bolívar account -> its dollar equivalent is divided;
              // dollar account -> the bolívares it comes to are multiplied.
              const other = isQuoteAccount ? value / rate : value * rate;
              return {
                key,
                text: formatAmount(
                  Math.round(other * 10 ** minorUnit(fromCurrency)),
                  fromCurrency,
                ),
              };
            })
        : [];
      return { text: formatAmount(minor, nativeCurrency), equivalents };
    } catch {
      // Mid-typing, "31*" is not an error worth shouting about.
      return null;
    }
  })();

  return (
    /*
     * `flex flex-col` and not `grid`.
     *
     * A grid sizes its implicit column to the widest content, so on converting —
     * when the summary below gets longer — the column went from 223px to 336 and
     * the input, which is 100% wide, grew with it and rode over the field next
     * door. A flex column bounds its children to the container's width and lets
     * the text wrap, which is what has to happen.
     */
    <div className="flex min-w-0 flex-col gap-2">
      <Label htmlFor={fieldId}>
        {label} <span className="text-muted-foreground">({nativeCurrency})</span>
      </Label>

      {/* Which rate the figure was derived with. It travels so the entry is
          valued with it and the history gives back the number you typed. */}
      {entry.convertedWith && rateSourceName && (
        <input type="hidden" name={rateSourceName} value={entry.convertedWith} />
      )}

      {/* text and not number: "1.234,56" is what gets typed here, and a
          numeric input would reject it — just as it would reject "31*0,5". */}
      <Input
        id={fieldId}
        name={name}
        inputMode="decimal"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={placeholder}
        required={required}
        aria-describedby={`${fieldId}-hint`}
      />

      {/* You type what it cost in dollars, press the rate, and the field
          becomes the bolívares. The rate is here because it is the datum needed
          at exactly this moment. */}
      {convertible && showControls && (
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="text-xs text-muted-foreground">
            {t("ui.moneyField.convertFrom", { currency: fromCurrency })}
          </span>
          {(["p2p", "bcv"] as const)
            .filter((key) => rates[key])
            .map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => convert(key)}
                disabled={!text.trim()}
                className={cn(
                  "-mx-1 rounded-md px-1 py-0.5 text-xs transition-colors",
                  "hover:bg-secondary disabled:opacity-40 disabled:hover:bg-transparent",
                  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                )}
              >
                <span className={key === "bcv" ? "text-bcv" : "text-p2p"}>
                  {isQuoteAccount ? "×" : "÷"} {key.toUpperCase()}
                </span>{" "}
                <span className="tabular-nums text-muted-foreground">
                  {formatRate(rates[key].rate)}
                </span>
                {/* A stale rate is always said. */}
                {rates[key].stale && (
                  <span className="text-caution">
                    {t("ui.moneyField.staleRate", {
                      date: formatDay(rates[key].effectiveOn, locale),
                    })}
                  </span>
                )}
              </button>
            ))}
        </span>
      )}

      {footer}

      <p id={`${fieldId}-hint`} className="text-xs text-muted-foreground">
        {computed ? (
          <>
            {/* "= Bs." and its figure are one single datum: they cannot be split. */}
            <span className="whitespace-nowrap">
              = <span className="tabular-nums text-foreground">{computed.text}</span>
            </span>
            {computed.equivalents.map((eq) => (
              <span key={eq.key} className="whitespace-nowrap">
                {" · "}
                <span className={eq.key === "bcv" ? "text-bcv" : "text-p2p"}>
                  {eq.key.toUpperCase()}
                </span>{" "}
                <span className="tabular-nums">{eq.text}</span>
              </span>
            ))}
            {entry.convertedWith && (
              <span className="whitespace-nowrap">
                {t("ui.moneyField.convertedTo")}
                {entry.convertedWith.toUpperCase()}
              </span>
            )}
          </>
        ) : (
          t("ui.moneyField.hint")
        )}
      </p>
    </div>
  );
}
