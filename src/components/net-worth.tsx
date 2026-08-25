"use client";

import { useOptimistic, useTransition } from "react";
import Link from "next/link";
import { useQueryState } from "nuqs";

import { formatAmount, formatPercent } from "@/lib/money";
import { formatDay } from "@/lib/dates";
import type { Committed as CommittedReport, Coverage, Valuation } from "@/lib/services/reports";
import { cn } from "@/lib/utils";
import { useLocale, useTranslations } from "next-intl";

/**
 * The net position, with **both valuations at once**.
 *
 * It is the piece carrying the product's differentiator. In Venezuela the
 * question "how much do I have?" has two legitimate answers at the same time —
 * at the official rate and at the parallel one — and hiding one behind a
 * selector would turn planfly into one more finance app. That is why both
 * figures are on screen and both are readable; the chosen one merely weighs more.
 *
 * The control IS the content: you switch valuation by clicking the figure, not
 * through a separate toggle that forces you to look elsewhere to know what you
 * are seeing. The selection lives in the URL so the view can be reloaded and
 * bookmarked.
 *
 * And it prints no figure it cannot stand behind: with no accounts it says there
 * is nothing to add up, and when it is missing a rate to convert something, it
 * either confesses under the total or — if it could value nothing at all —
 * shows a dash instead of a zero that would read as "you have nothing".
 */
export function NetWorth({
  bcvMinor,
  p2pMinor,
  assetsBcvMinor,
  assetsP2pMinor,
  liabilitiesBcvMinor,
  liabilitiesP2pMinor,
  currency,
  spreadPercent,
  accountCount,
  coverage,
  committed,
}: {
  bcvMinor: number;
  p2pMinor: number;
  assetsBcvMinor: number;
  assetsP2pMinor: number;
  liabilitiesBcvMinor: number;
  liabilitiesP2pMinor: number;
  currency: string;
  spreadPercent: number | null;
  /** Accounts that count towards net worth, balance or no balance. */
  accountCount: number;
  coverage: { bcv: Coverage; p2p: Coverage };
  /** Upcoming unpaid installments. Null when there are none. */
  committed: CommittedReport | null;
}) {
  const t = useTranslations();
  const [rate, setRate] = useQueryState("rate", { defaultValue: "p2p", shallow: false });
  const [pending, startTransition] = useTransition();

  /*
   * The gesture that defines the product had no answer: `shallow: false` on a
   * `force-dynamic` page with five queries meant a dead click until the server
   * answered. Both figures are already here as props, so the selection changes
   * instantly and navigation only confirms it; what genuinely depends on the
   * server — the derived sections — dims meanwhile.
   */
  const [active, setOptimistic] = useOptimistic<Valuation>(rate === "bcv" ? "bcv" : "p2p");

  const choose = (option: Valuation) =>
    startTransition(() => {
      setOptimistic(option);
      void setRate(option);
    });

  const assets = active === "bcv" ? assetsBcvMinor : assetsP2pMinor;
  const liabilities = active === "bcv" ? liabilitiesBcvMinor : liabilitiesP2pMinor;
  const missing = coverage[active];
  // Accounts that move the needle. All of them being at zero is not a hole: net
  // worth genuinely is zero, and covering it with a dash would lie the other way.
  const withBalance = missing.valuedCount + missing.unvaluedCount;

  if (accountCount === 0) {
    return (
      <section aria-labelledby="posicion-global">
        <h2
          id="posicion-global"
          className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground"
        >
          {t("ui.netWorth.title")}
        </h2>
        <p className="mt-4 text-3xl font-semibold tracking-tight sm:text-4xl">
          {t("ui.netWorth.noAccounts")}
        </p>
        <p className="mt-3 max-w-prose text-sm text-muted-foreground">
          {t("ui.netWorth.noAccountsHint")}
        </p>
        <Link
          href="/accounts"
          className="mt-4 inline-block text-sm underline-offset-4 transition-colors hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          {t("ui.netWorth.setUpAccounts")}
        </Link>
      </section>
    );
  }

  const options = [
    {
      key: "p2p" as const,
      minor: p2pMinor,
      title: t("ui.netWorth.option.p2pTitle"),
      note: t("ui.netWorth.option.p2pNote"),
      accent: "text-p2p",
      rule: "bg-p2p",
    },
    {
      key: "bcv" as const,
      minor: bcvMinor,
      title: t("ui.netWorth.option.bcvTitle"),
      note: t("ui.netWorth.option.bcvNote"),
      accent: "text-bcv",
      rule: "bg-bcv",
    },
  ];

  return (
    <section aria-labelledby="posicion-global">
      <h2
        id="posicion-global"
        className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground"
      >
        {t("ui.netWorth.title")}
      </h2>

      <div className="mt-4 flex flex-col gap-8 sm:flex-row sm:gap-12">
        {options.map((option) => {
          const isActive = option.key === active;
          // If there are balances but this rate could not convert a single one, the
          // total is not zero: it is unknown, and saying so with a huge zero would be
          // the screen's most expensive lie. With everything at zero it doesn't apply:
          // there, zero is the datum.
          const c = coverage[option.key];
          const blind = c.valuedCount === 0 && c.unvaluedCount > 0;
          return (
            <button
              key={option.key}
              type="button"
              onClick={() => choose(option.key)}
              aria-pressed={isActive}
              className={cn(
                "group -mx-2 cursor-pointer rounded-md px-2 py-1 text-left transition-opacity",
                "focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring",
                // The unchosen one dims, it is never hidden: it is still a valid
                // answer to the same question.
                isActive ? "opacity-100" : "opacity-55 hover:opacity-85",
              )}
            >
              <span
                className={cn(
                  // `transition-[font-size]` animated a property that causes
                  // reflow: the result was a late layout jump instead of an
                  // immediate confirmation. `scale` runs on the compositor, and
                  // is switched off for anyone who asked for less motion.
                  "block origin-left font-semibold tabular-nums tracking-tight",
                  "transition-transform motion-reduce:transition-none",
                  isActive ? "text-4xl sm:text-5xl" : "text-2xl sm:text-3xl",
                )}
              >
                {blind ? "—" : formatAmount(option.minor, currency)}
              </span>

              <span className="mt-2 flex items-center gap-2 text-sm">
                {/* The colour rule marks the selection, but it is not the only
                    thing marking it: size and opacity say it without colour. */}
                <span
                  className={cn(
                    "h-0.5 w-6 rounded-full transition-all",
                    isActive ? option.rule : "bg-muted-foreground/40",
                  )}
                />
                <span className={cn(isActive ? option.accent : "text-muted-foreground")}>
                  {option.title}
                </span>
              </span>
              <span className="mt-0.5 block text-xs text-muted-foreground">
                {blind ? t("ui.netWorth.blind") : option.note}
              </span>
            </button>
          );
        })}
      </div>

      {withBalance === 0 && (
        <p className="mt-4 max-w-prose text-sm text-muted-foreground">
          {t("ui.netWorth.allZero")}{" "}
          <Link
            href="/transactions"
            className="underline underline-offset-4 transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            {t("ui.netWorth.recordEntry")}
          </Link>
        </p>
      )}

      {missing.unvaluedCount > 0 && (
        <p className="mt-4 max-w-prose text-sm text-caution">
          {missing.valuedCount === 0
            ? t("ui.netWorth.noneConverted", { n: missing.unvaluedCount })
            : t("ui.netWorth.someExcluded", { n: missing.unvaluedCount })}
          {t("ui.netWorth.missingRateTail", { currencies: missing.currencies.join(", ") })}{" "}
          <Link
            href="/rates"
            className="underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            {t("ui.netWorth.seeRates")}
          </Link>
        </p>
      )}

      {/* What does depend on the server is dimmed while it arrives, and says
          so: the big figure has already changed, these totals have not yet. */}
      <div
        aria-busy={pending}
        className={cn(
          "mt-6 space-y-2 text-sm text-muted-foreground",
          "transition-opacity motion-reduce:transition-none",
          pending && "opacity-50",
        )}
      >
        <p className="flex flex-wrap items-center gap-x-5 gap-y-1">
          <span>
            {t("ui.netWorth.assets")}{" "}
            <span className="font-medium tabular-nums text-foreground">
              {missing.valuedCount === 0 && missing.unvaluedCount > 0
                ? "—"
                : formatAmount(assets, currency)}
            </span>
          </span>
          {liabilities !== 0 && (
            <span>
              {t("ui.netWorth.liabilities")}{" "}
              <span className="font-medium tabular-nums text-foreground">
                {formatAmount(liabilities, currency)}
              </span>
            </span>
          )}
          {spreadPercent != null && (
            <span>
              {t("ui.netWorth.spread")}{" "}
              <span className="font-medium tabular-nums text-foreground">
                {formatPercent(spreadPercent, 1)} %
              </span>
            </span>
          )}
        </p>

        {committed && (
          <Committed
            committed={committed}
            currency={currency}
            valuation={active}
            /* The sentence leans on the Liabilities figure from the line above,
               which is only painted when it is not zero. */
            showsLiabilities={liabilities !== 0}
          />
        )}
      </div>
    </section>
  );
}

/**
 * How much of the above is already spoken for, and until when.
 *
 * It does not repeat the debt — that already subtracted from net worth on the
 * day of the purchase — but answers the question no figure on the screen
 * answers: of what you have, how much goes just in the next few weeks.
 *
 * It goes at the same rate as the headline because it is a subtraction against
 * it. And it prints no total it cannot stand behind: if an installment is
 * missing a rate it confesses, just as net worth does with its accounts.
 */
function Committed({
  committed,
  currency,
  valuation,
  showsLiabilities,
}: {
  committed: CommittedReport;
  currency: string;
  valuation: Valuation;
  showsLiabilities: boolean;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const { count, overdueCount, lastDueOn, unvalued } = committed;
  const minor = valuation === "bcv" ? committed.bcvMinor : committed.p2pMinor;
  const blind = unvalued[valuation];
  const shown = count - blind;

  /*
   * The tail of the sentence, and its final stop, come from the catalogue.
   *
   * There used to be a `tail.endsWith(".")` here deciding whether to add one,
   * and no code can decide that: in Spanish «24 ago.» already brings its own —
   * the abbreviation's dot closes the sentence — and in English «24 Aug» does
   * not. Each ending carries the punctuation its own language needs.
   */
  const when =
    overdueCount > 0
      ? // An overdue installment does not "fall due before X": it already passed, and
        // putting it in the future would make it sound less urgent than it is.
        t("ui.netWorth.committed.overdue", { n: overdueCount })
      : shown === 1
        ? t("ui.netWorth.committed.dueOne", { date: formatDay(lastDueOn, locale) })
        : t("ui.netWorth.committed.dueMany", { date: formatDay(lastDueOn, locale) });
  const aside =
    blind > 0
      ? t("ui.netWorth.committed.aside", { n: blind, currencies: unvalued.currencies.join(", ") })
      : "";
  const tail = `${when}${aside}`;

  // Without a single convertible installment, the figure would be a zero that
  // reads as "you owe nothing". The hole is stated and the number not invented.
  if (shown === 0) {
    return (
      <p className="max-w-prose text-caution">
        {t("ui.netWorth.committed.noRate", {
          n: count,
          currencies: unvalued.currencies.join(", "),
        })}{" "}
        <Link
          href="/rates"
          className="underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          {t("ui.netWorth.seeRates")}
        </Link>
      </p>
    );
  }

  /*
   * "Of those liabilities", and not "Already committed".
   *
   * With a single plan the figure matches the Liabilities one two lines above,
   * and whoever reads it has no way to know it is not being counted twice —
   * which is exactly what this piece swears does not happen. Naming where it
   * comes from says so without having to explain it.
   */
  return (
    <p className={cn("max-w-prose", overdueCount > 0 && "text-caution")}>
      {showsLiabilities ? t("ui.netWorth.committed.leadOfLiabilities") : t("ui.netWorth.committed.leadPlain")}
      <span
        className={cn(
          "font-medium tabular-nums",
          overdueCount > 0 ? "text-caution" : "text-foreground",
        )}
      >
        {formatAmount(minor, currency)}
      </span>{" "}
      {showsLiabilities
        ? t("ui.netWorth.committed.restOfLiabilities", { n: shown })
        : t("ui.netWorth.committed.restPlain", { n: shown })}
      {tail}{" "}
      <Link
        href="/financing"
        className="underline underline-offset-4 transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        {t("ui.netWorth.committed.seeInstallments")}
      </Link>
    </p>
  );
}
