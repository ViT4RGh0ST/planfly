import {
  ArrowRight,
  Camera,
  FileSpreadsheet,
  Pencil,
  PenLine,
  Repeat,
  Send,
  Terminal,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { TransactionActions } from "@/components/transaction-actions";
import { formatAmount, formatRate } from "@/lib/money";
import { formatDay } from "@/lib/dates";
import { RateLine } from "@/components/rate-line";
import { cn } from "@/lib/utils";
import { useLocale, useTranslations } from "next-intl";

export type TransactionRow = {
  id: string;
  kind: string;
  occurredOn: string;
  description: string;
  source: string;
  needsReview: boolean;
  confidence: number | null;
  amountMinor: number;
  currency: string;
  amountText: string;
  baseBcvMinor: number | null;
  baseP2pMinor: number | null;
  baseManualMinor: number | null;
  rateSourceUsed: string;
  account: string;
  category: string | null;
  categoryColor: string | null;
  /** The other leg, transfers only. */
  toAccount: string | null;
  toAmountMinor: number | null;
  toCurrency: string | null;
  /** Voided: it stays in the history so as not to leave a hole, but it does not add. */
  voided: boolean;
  voidReason: string | null;
  toAmountText: string | null;
};

/**
 * The provenance icon is what tells you at a glance whether a row was written by
 * the bot, by you, by a CSV or from a photo. It carries a name as well as a
 * shape: for a screen reader — and for anyone who doesn't know the six glyphs by
 * heart — provenance did not exist, even though the product calls it part of the
 * datum.
 */
/**
 * How a row got here, said in words.
 *
 * An unknown provenance falls back to its own raw value rather than to a
 * translation: it is a datum from the database that no catalogue can know, and
 * printing the key would say less than printing the value.
 */
function sourceName(t: (key: string) => string, source: string): string {
  const known = ["telegram", "form", "csv", "ocr", "api", "recurring"];
  return known.includes(source) ? t(`domain.source.${source}`) : source;
}

/** The icon per provenance. Its name is looked up in `domain.source`. */
const SOURCES: Record<string, React.ComponentType<{ className?: string }>> = {
  telegram: Send,
  form: PenLine,
  csv: FileSpreadsheet,
  ocr: Camera,
  api: Terminal,
  recurring: Repeat,
};

/**
 * What is derived from a row, in one place.
 *
 * The table and the narrow list paint the same thing in different shapes; if
 * each computed its own version, they would end up disagreeing about which rate
 * was used.
 */
function describe(t: TransactionRow, valuation: "bcv" | "p2p") {
  const Icon = SOURCES[t.source] ?? Terminal;
  // A hand-corrected rate beats both automatic ones: it is the one the user
  // decided was the truth for this line.
  const fixedByHand =
    t.rateSourceUsed === "manual" && t.baseManualMinor != null;
  const inBase = fixedByHand
    ? t.baseManualMinor
    : valuation === "bcv"
      ? t.baseBcvMinor
      : t.baseP2pMinor;
  // A transfer is not money lost: it is the same money somewhere else.
  const isTransfer = t.kind === "transfer" && t.toAccount != null;
  // When the two legs are in different currencies, the rate you actually got
  // comes from dividing them.
  const effectiveRate =
    isTransfer &&
    t.toCurrency !== t.currency &&
    t.toAmountMinor != null &&
    t.amountMinor !== 0
      ? Math.abs(t.toAmountMinor / t.amountMinor)
      : null;

  return {
    Icon,
    fixedByHand,
    inBase,
    isTransfer,
    effectiveRate,
  };
}

/**
 * The base-currency equivalent.
 *
 * BOTH valuations, not just the active one. With a 13% spread between BCV and
 * P2P, seeing only one forced you to flip the selector and look again to know
 * what something cost "the other way" — and the product stores both on every
 * line precisely so you don't have to choose when recording.
 */
function BaseAmount({
  t,
  inBase,
  fixedByHand,
  baseCurrency,
  valuation,
}: {
  t: TransactionRow;
  inBase: number | null;
  fixedByHand: boolean;
  baseCurrency: string;
  valuation: "bcv" | "p2p";
}) {
  const tr = useTranslations();
  // A line already in the household's currency has nothing to convert.
  if (t.currency === baseCurrency) return <>—</>;

  // A hand-set rate is the decision of whoever set it: it replaces both
  // automatic ones rather than living alongside them, which is what "manual" means.
  if (fixedByHand && inBase != null) {
    return (
      <span className="inline-flex items-center gap-1" title={tr("ui.transactions.handSetRate")}>
        {formatAmount(inBase, baseCurrency)}
        {/* A drawn icon, not a Unicode glyph: `✎` changes shape and weight
            with the installed font, and does not match the rest of the set. */}
        <Pencil aria-hidden className="size-3 text-caution" />
        <span className="sr-only">{tr("ui.transactions.handSetRateLabel")}</span>
      </span>
    );
  }

  if (t.baseBcvMinor == null && t.baseP2pMinor == null) return <>{tr("ui.transactions.noRate")}</>;

  return (
    <span className="flex flex-col items-end leading-tight">
      {/* P2P on top, as in the selector and in the summary: one and the same
          pair of figures cannot change order depending on where you look. */}
      <RateLine
        label="P2P"
        value={t.baseP2pMinor}
        baseCurrency={baseCurrency}
        active={valuation === "p2p"}
      />
      <RateLine
        label="BCV"
        value={t.baseBcvMinor}
        baseCurrency={baseCurrency}
        active={valuation === "bcv"}
      />
    </span>
  );
}

export function TransactionsTable({
  transactions,
  baseCurrency,
  valuation,
  categories,
  accounts,
  todayDate,
  filtered = false,
}: {
  transactions: TransactionRow[];
  baseCurrency: string;
  valuation: "bcv" | "p2p";
  /** For the recategorise dropdown. Without them the table is read-only. */
  categories?: string[];
  /** They enable the full correction form, the only one that reaches the amount. */
  accounts?: { name: string; currency: string }[];
  todayDate?: string;
  /** Empty by filters or genuinely empty: they are not explained the same way. */
  filtered?: boolean;
}) {
  const tr = useTranslations();
  const locale = useLocale();
  if (transactions.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        {filtered ? tr("ui.transactions.emptyFiltered") : tr("ui.transactions.empty")}
      </p>
    );
  }

  return (
    <>
      {/* On narrow the table measured 680px inside 310: two thirds of the
          width sat behind a horizontal scroll with no affordance at all, and the
          first thing to disappear was the dollar equivalent — the product's
          whole differential. Here the same information goes stacked. */}
      <ul className="divide-y divide-border lg:hidden">
        {transactions.map((t) => {
          const {
            Icon,
            fixedByHand,
            inBase,
            isTransfer,
            effectiveRate,
          } = describe(t, valuation);
          return (
            <li
              key={t.id}
              className={cn(
                "flex items-start gap-3 py-3",
                t.needsReview && !t.voided && "bg-caution/10",
                t.voided && "opacity-55",
              )}
            >
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-2">
                  <span
                    title={tr("ui.transactions.recordedVia", { source: sourceName(tr, t.source) })}
                    className="flex shrink-0"
                  >
                    <Icon
                      aria-hidden
                      className="size-3.5 text-muted-foreground"
                    />
                    <span className="sr-only">
                      {tr("ui.transactions.recordedViaLabel", { source: sourceName(tr, t.source) })}
                    </span>
                  </span>
                  {/* It wraps, it does not clip. `truncate` is a table habit:
                      here the row is a stacked card with height to spare, so
                      cutting "consulta oncológic…" loses information in exchange
                      for nothing. In the desktop table it does clip, because
                      there the column's width really is scarce. */}
                  <span className="min-w-0 font-medium">{t.description}</span>
                  {t.voided && <Badge variant="outline">{tr("ui.transactions.voided")}</Badge>}
                  {t.needsReview && !t.voided && (
                    <Badge
                      variant="outline"
                      className="border-caution/40 text-caution"
                    >
                      {tr("ui.transactions.review")}
                    </Badge>
                  )}
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {formatDay(t.occurredOn, locale)} · {t.account}
                  {isTransfer && (
                    <>
                      <span aria-hidden> → </span>
                      <span className="sr-only">{tr("ui.transactions.toAccount")}</span>
                      {t.toAccount}
                    </>
                  )}
                  {t.category && ` · ${t.category}`}
                  {!t.category && !isTransfer && tr("ui.transactions.noCategory")}
                  {isTransfer && tr("ui.transactions.transfer")}
                </p>
              </div>

              <div className="shrink-0 text-right leading-tight">
                <p
                  className={cn(
                    "tabular-nums",
                    isTransfer || t.amountMinor === 0
                      ? "text-muted-foreground"
                      : t.amountMinor < 0
                        ? "text-negative"
                        : "text-positive",
                  )}
                >
                  {isTransfer ? t.toAmountText : t.amountText}
                </p>
                <p className="text-xs text-muted-foreground tabular-nums">
                  {isTransfer ? (
                    <>
                      {tr("ui.transactions.from", {
                        amount: formatAmount(Math.abs(t.amountMinor), t.currency),
                      })}
                      {effectiveRate != null &&
                        ` · ${formatRate(effectiveRate)}`}
                    </>
                  ) : (
                    <>
                      <span className="sr-only">{tr("ui.transactions.equivalentInLabel", { base: baseCurrency })}</span>
                      <BaseAmount
                        t={t}
                        inBase={inBase}
                        fixedByHand={fixedByHand}
                        baseCurrency={baseCurrency}
                        valuation={valuation}
                      />
                    </>
                  )}
                </p>
              </div>

              {categories && (
                <TransactionActions
                  id={t.id}
                  description={t.description}
                  currency={t.currency}
                  baseCurrency={baseCurrency}
                  voided={t.voided}
                  categories={categories}
                  accounts={accounts}
                  todayDate={todayDate}
                />
              )}
            </li>
          );
        })}
      </ul>

      <Table className="hidden lg:table">
        <TableHeader>
          <TableRow>
            <TableHead scope="col" className="w-24">
              {tr("ui.transactions.column.date")}
            </TableHead>
            <TableHead scope="col">{tr("ui.transactions.column.description")}</TableHead>
            <TableHead scope="col" className="hidden xl:table-cell">
              {tr("ui.transactions.column.category")}
            </TableHead>
            <TableHead scope="col">{tr("ui.transactions.column.account")}</TableHead>
            <TableHead scope="col" className="text-right">
              {tr("ui.transactions.column.amount")}
            </TableHead>
            {/* This header used to carry the active valuation, because the
              column showed one only and, without saying so, the same row was
              worth 13% more or less. Now it shows both, each with its own tag in
              the cell itself, and the header does not have to choose. */}
            <TableHead scope="col" className="w-32 text-right">
              ≈ {baseCurrency}
            </TableHead>
            {categories && (
              <TableHead scope="col" className="w-12 text-right sr-only">
                {tr("ui.transactions.actions")}
              </TableHead>
            )}
          </TableRow>
        </TableHeader>
        <TableBody>
          {transactions.map((t) => {
            const {
              Icon,
              fixedByHand,
              inBase,
              isTransfer,
              effectiveRate,
            } = describe(t, valuation);
            return (
              <TableRow
                key={t.id}
                className={cn(
                  // At 5% the highlight was indistinguishable from the background; the
                  // only thing saving the row was the text badge.
                  t.needsReview && !t.voided && "bg-caution/10",
                  t.voided && "opacity-55",
                )}
              >
                <TableCell className="text-muted-foreground tabular-nums">
                  {formatDay(t.occurredOn, locale)}
                </TableCell>
                {/* `truncate` did nothing: TableCell brings `whitespace-nowrap`,
                  so a long description widened the table and pushed the dollar
                  equivalent out of the panel. With a max width and `min-w-0` on
                  the flex child, now it does clip. */}
                <TableCell className="max-w-[22rem]">
                  <span className="flex items-center gap-2">
                    <span
                      title={tr("ui.transactions.recordedVia", { source: sourceName(tr, t.source) })}
                      className="flex shrink-0"
                    >
                      <Icon
                        aria-hidden
                        className="size-3.5 text-muted-foreground"
                      />
                      <span className="sr-only">
                        {tr("ui.transactions.recordedViaLabel", {
                          source: sourceName(tr, t.source),
                        })}
                      </span>
                    </span>
                    <span className="min-w-0 truncate" title={t.description}>
                      {t.description}
                    </span>
                    {t.voided && (
                      <Badge
                        variant="outline"
                        title={t.voidReason ?? undefined}
                      >
                        {tr("ui.transactions.voided")}
                      </Badge>
                    )}
                    {t.needsReview && !t.voided && (
                      <Badge
                        variant="outline"
                        className="border-caution/40 text-caution"
                      >
                        {tr("ui.transactions.review")}
                        {t.confidence != null && (
                          // Confidence reached the component and was never painted,
                          // even though the product calls it part of the datum.
                          <span className="tabular-nums">
                            {" "}
                            {Math.round(t.confidence * 100)}%
                          </span>
                        )}
                      </Badge>
                    )}
                  </span>
                </TableCell>
                {/* `whitespace-normal` against the `nowrap` TableCell brings as
                  standard: these two columns would rather wrap than push the
                  dollar equivalent out of the panel. */}
                <TableCell className="hidden whitespace-normal xl:table-cell">
                  {t.category ? (
                    <span className="flex items-center gap-1.5 text-sm">
                      <span
                        className="size-2 shrink-0 rounded-full"
                        style={{ background: t.categoryColor ?? "#94a3b8" }}
                      />
                      {t.category}
                    </span>
                  ) : isTransfer ? (
                    // `kind` reached the component and was never read: a
                    // transfer looked the same as an uncategorised expense.
                    <span className="text-sm text-muted-foreground">
                      {/* Its own key, not the other one with the separator cut
                          off: trimming a translation is a bug waiting for a
                          language. */}
                      {tr("ui.transactions.transferBare")}
                    </span>
                  ) : (
                    <span className="text-sm text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell className="whitespace-normal text-sm text-muted-foreground">
                  {isTransfer ? (
                    <span className="flex flex-col leading-tight">
                      {t.account}
                      <span className="flex items-center gap-1">
                        <ArrowRight aria-hidden className="size-3 shrink-0" />
                        <span className="sr-only">{tr("ui.transactions.toAccount")}</span>
                        {t.toAccount}
                      </span>
                    </span>
                  ) : (
                    t.account
                  )}
                </TableCell>
                <TableCell
                  className={cn(
                    "text-right tabular-nums",
                    // An amount of 0 is not money coming in: painting it green
                    // was saying it is.
                    isTransfer || t.amountMinor === 0
                      ? "text-muted-foreground"
                      : t.amountMinor < 0
                        ? "text-negative"
                        : "text-positive",
                  )}
                >
                  {isTransfer ? (
                    // Two lines and not one: on a single line, a cross-currency
                    // transfer widened the row and pushed the equivalent column
                    // out of the panel — precisely the one carrying the product's
                    // differentiator.
                    <span className="flex flex-col items-end leading-tight">
                      <span>{t.toAmountText}</span>
                      <span className="text-xs text-muted-foreground">
                        <span className="sr-only">{tr("ui.transactions.convertedFrom")}</span>
                        {formatAmount(Math.abs(t.amountMinor), t.currency)}
                        {effectiveRate != null && (
                          <>
                            <span aria-hidden> · </span>
                            <span className="sr-only">{tr("ui.transactions.atRateOf")}</span>
                            {formatRate(effectiveRate)}
                          </>
                        )}
                      </span>
                    </span>
                  ) : (
                    t.amountText
                  )}
                </TableCell>
                <TableCell className="text-right text-sm text-muted-foreground tabular-nums">
                  <BaseAmount
                    t={t}
                    inBase={inBase}
                    fixedByHand={fixedByHand}
                    baseCurrency={baseCurrency}
                    valuation={valuation}
                  />
                </TableCell>
                {categories && (
                  <TableCell className="py-1 text-right">
                    <TransactionActions
                      id={t.id}
                      description={t.description}
                      currency={t.currency}
                      baseCurrency={baseCurrency}
                      voided={t.voided}
                      categories={categories}
                      accounts={accounts}
                      todayDate={todayDate}
                    />
                  </TableCell>
                )}
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </>
  );
}
