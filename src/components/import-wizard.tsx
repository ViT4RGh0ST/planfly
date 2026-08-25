"use client";

import { useState, useTransition } from "react";
import Papa from "papaparse";
import { Upload } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { commitImportAction, previewImportAction } from "@/app/(app)/import/actions";
import type { ColumnMapping, PreviewRow, RawRow } from "@/lib/services/import";
import { formatAmount } from "@/lib/money";
import { cn } from "@/lib/utils";
import { useTranslations } from "next-intl";

type Step = "file" | "mapping" | "preview";

/** How many rows are painted in the preview. The rest is imported all the same, and said. */
const PREVIEW_ROWS = 200;

/** The statuses come from the service in English; on screen they are said like the counters above. */
export function ImportWizard({
  accounts,
}: {
  accounts: Array<{ name: string; currency: string }>;
}) {
  const t = useTranslations();
  const [step, setStep] = useState<Step>("file");
  const [pending, startTransition] = useTransition();

  const [fileName, setFileName] = useState("");
  const [columns, setColumns] = useState<string[]>([]);
  const [rawRows, setRawRows] = useState<RawRow[]>([]);
  const [account, setAccount] = useState(accounts[0]?.name ?? "");
  const [mapping, setMapping] = useState<ColumnMapping>({
    date: "",
    description: "",
    dateFormat: "dd/mm/yyyy",
  });
  const [twoColumns, setTwoColumns] = useState(false);
  const [preview, setPreview] = useState<PreviewRow[]>([]);

  function loadFile(file: File) {
    Papa.parse<RawRow>(file, {
      header: true,
      skipEmptyLines: true,
      complete: (res) => {
        const fields = res.meta.fields ?? [];
        if (fields.length === 0) {
          toast.error(t("ui.import.noHeaders"));
          return;
        }
        setFileName(file.name);
        setColumns(fields);
        setRawRows(res.data);

        // Guesses the mapping from the column name: it is right on most statements
        // and saves the most tedious step.
        const guess = (...keys: string[]) =>
          fields.find((f) => keys.some((k) => f.toLowerCase().includes(k))) ?? "";

        setMapping({
          date: guess("fecha", "date"),
          description: guess("descrip", "concepto", "referencia", "detalle"),
          amount: guess("monto", "importe", "amount", "valor"),
          debit: guess("debito", "débito", "cargo"),
          credit: guess("credito", "crédito", "abono"),
          dateFormat: "dd/mm/yyyy",
        });
        setStep("mapping");
      },
      error: (err) => toast.error(t("ui.import.readFailed", { error: err.message })),
    });
  }

  function goToPreview() {
    startTransition(async () => {
      const cleaned: ColumnMapping = twoColumns
        ? { ...mapping, amount: undefined }
        : { ...mapping, debit: undefined, credit: undefined };

      const result = await previewImportAction(account, rawRows, cleaned);
      if (!result.ok || !result.rows) {
        toast.error(result.message ?? t("ui.import.previewFailed"));
        return;
      }
      setMapping(cleaned);
      setPreview(result.rows);
      setStep("preview");
    });
  }

  function commit() {
    startTransition(async () => {
      const result = await commitImportAction(account, fileName, rawRows, preview, mapping);
      if (result.ok) {
        toast.success(result.message);
        setStep("file");
        setRawRows([]);
        setPreview([]);
      } else {
        toast.error(result.message);
      }
    });
  }

  const newCount = preview.filter((r) => r.status === "new").length;
  const duplicateCount = preview.filter((r) => r.status === "duplicate").length;
  const errorCount = preview.filter((r) => r.status === "error").length;
  // The statement belongs to an account, and its currency is what gives the
  // figure meaning: without it the preview printed "2300.58" without saying of what.
  const previewCurrency = accounts.find((a) => a.name === account)?.currency ?? "VES";

  if (step === "file") {
    return (
      <div className="grid gap-4">
        <div className="grid gap-2">
          <Label>{t("ui.import.account")}</Label>
          <Select value={account} onValueChange={setAccount}>
            <SelectTrigger>
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

        <div className="grid gap-2">
          <Label htmlFor="csv">{t("ui.import.csvFile")}</Label>
          {/* The native control writes "Choose File / No file chosen" in the
              browser's language, and there is no way to translate it: it is
              user-agent content. It gets hidden — without taking it out of the
              keyboard's focus order — and its label acts as the button, which is
              also the only thing that can activate it without JavaScript. */}
          <input
            id="csv"
            type="file"
            accept=".csv,text/csv"
            className="sr-only"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) loadFile(file);
            }}
          />
          <div className="flex flex-wrap items-center gap-3">
            <Label
              htmlFor="csv"
              className="inline-flex h-9 cursor-pointer items-center gap-2 rounded-md border border-input px-3 text-sm transition-colors hover:bg-accent focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-ring"
            >
              <Upload aria-hidden className="size-4" />
              {t("ui.import.chooseFile")}
            </Label>
            <span className="min-w-0 truncate text-sm text-muted-foreground">
              {fileName || t("ui.import.noFile")}
            </span>
          </div>
          <p className="max-w-[62ch] text-xs text-muted-foreground">
            {t("ui.import.dedupHint")}
          </p>
        </div>
      </div>
    );
  }

  if (step === "mapping") {
    return (
      <div className="grid gap-4">
        <p className="text-sm text-muted-foreground">
          {t("ui.import.rowsIn", { n: rawRows.length })}
          <span className="font-medium">{fileName}</span>
        </p>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="grid gap-2">
            <Label>{t("ui.import.dateColumn")}</Label>
            <Select value={mapping.date} onValueChange={(v) => setMapping({ ...mapping, date: v })}>
              <SelectTrigger>
                <SelectValue placeholder={t("ui.import.choose")} />
              </SelectTrigger>
              <SelectContent>
                {columns.map((c) => (
                  <SelectItem key={c} value={c}>
                    {c}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-2">
            <Label>{t("ui.import.dateFormat")}</Label>
            <Select
              value={mapping.dateFormat}
              onValueChange={(v) =>
                setMapping({ ...mapping, dateFormat: v as ColumnMapping["dateFormat"] })
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="dd/mm/yyyy">{t("ui.import.ddmmyyyy")}</SelectItem>
                <SelectItem value="yyyy-mm-dd">{t("ui.import.yyyymmdd")}</SelectItem>
                <SelectItem value="mm/dd/yyyy">{t("ui.import.mmddyyyy")}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-2 sm:col-span-2">
            <Label>{t("ui.import.descriptionColumn")}</Label>
            <Select
              value={mapping.description}
              onValueChange={(v) => setMapping({ ...mapping, description: v })}
            >
              <SelectTrigger>
                <SelectValue placeholder={t("ui.import.choose")} />
              </SelectTrigger>
              <SelectContent>
                {columns.map((c) => (
                  <SelectItem key={c} value={c}>
                    {c}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={twoColumns}
            onChange={(e) => setTwoColumns(e.target.checked)}
            className="size-4"
          />
          {t("ui.import.twoColumns")}
        </label>

        {twoColumns ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label>{t("ui.import.debit")}</Label>
              <Select
                value={mapping.debit ?? ""}
                onValueChange={(v) => setMapping({ ...mapping, debit: v })}
              >
                <SelectTrigger>
                  <SelectValue placeholder={t("ui.import.choose")} />
                </SelectTrigger>
                <SelectContent>
                  {columns.map((c) => (
                    <SelectItem key={c} value={c}>
                      {c}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label>{t("ui.import.credit")}</Label>
              <Select
                value={mapping.credit ?? ""}
                onValueChange={(v) => setMapping({ ...mapping, credit: v })}
              >
                <SelectTrigger>
                  <SelectValue placeholder={t("ui.import.choose")} />
                </SelectTrigger>
                <SelectContent>
                  {columns.map((c) => (
                    <SelectItem key={c} value={c}>
                      {c}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        ) : (
          <div className="grid gap-2">
            <Label>{t("ui.import.amountColumn")}</Label>
            <Select
              value={mapping.amount ?? ""}
              onValueChange={(v) => setMapping({ ...mapping, amount: v })}
            >
              <SelectTrigger>
                <SelectValue placeholder={t("ui.import.choose")} />
              </SelectTrigger>
              <SelectContent>
                {columns.map((c) => (
                  <SelectItem key={c} value={c}>
                    {c}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        <div className="flex gap-2">
          <Button variant="outline" onClick={() => setStep("file")}>
            {t("ui.import.back")}
          </Button>
          <Button onClick={goToPreview} disabled={pending || !mapping.date || !mapping.description}>
            {pending ? t("ui.import.analysing") : t("ui.import.preview")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap gap-2">
        <Badge variant="outline" className="border-positive/40 text-positive">
          {t("ui.import.new", { n: newCount })}
        </Badge>
        {duplicateCount > 0 && (
          <Badge variant="outline">{t("ui.import.duplicates", { n: duplicateCount })}</Badge>
        )}
        {errorCount > 0 && (
          <Badge variant="outline" className="border-negative/40 text-negative">
            {t("ui.import.errors", { n: errorCount })}
          </Badge>
        )}
      </div>

      {/* The cut is stated. Confirming over a preview that was silently
          truncated while the button counts the total is the same fault the panel
          already fixed with "and N more categories". */}
      {preview.length > PREVIEW_ROWS && (
        <p className="text-xs text-muted-foreground">
          {t("ui.import.truncated", { shown: PREVIEW_ROWS, total: preview.length })}
        </p>
      )}

      <div className="max-h-96 overflow-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-24">{t("ui.import.columnDate")}</TableHead>
              <TableHead>{t("ui.import.columnDescription")}</TableHead>
              <TableHead className="text-right">{t("ui.import.columnAmount")}</TableHead>
              <TableHead className="w-28">{t("ui.import.columnStatus")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {preview.slice(0, PREVIEW_ROWS).map((row) => (
              <TableRow key={row.index} className={cn(row.status !== "new" && "opacity-50")}>
                <TableCell className="tabular-nums">{row.date || "—"}</TableCell>
                <TableCell className="max-w-md truncate">{row.description || row.error}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {/* `!= null` and not truthy: an entry of 0 is a datum, and
                      with a truthy check it was painted as if it were missing. */}
                  {row.amountMinor != null
                    ? formatAmount(row.amountMinor, previewCurrency)
                    : "—"}
                </TableCell>
                <TableCell className="text-xs">{t(`domain.rowStatus.${row.status}`)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <div className="flex gap-2">
        <Button variant="outline" onClick={() => setStep("mapping")}>
          {t("ui.import.back")}
        </Button>
        <Button onClick={commit} disabled={pending || newCount === 0}>
          {pending ? t("ui.import.importing") : t("ui.import.importN", { n: newCount })}
        </Button>
      </div>
    </div>
  );
}
