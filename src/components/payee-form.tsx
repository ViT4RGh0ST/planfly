"use client";

import { useActionState, useEffect, useState } from "react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";

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
import {
  createPayeeAction,
  editPayeeAction,
  payeeForEdit,
  type ActionState,
  type EditablePayee,
} from "@/app/(app)/actions";
import { PlaceMap } from "@/components/place-map";
import { formatCoordinates, parseCoordinates } from "@/lib/coordinates";
import { formatTaxId } from "@/lib/tax-id";

/** A place that can be a brand: top level and unarchived. */
export type BrandOption = { id: string; name: string };
export type CategoryOption = { id: string; name: string };

/** What a `<select>` sends for «none». An empty value is a choice, not a gap. */
const NONE = "none";

/**
 * Creating and correcting a place.
 *
 * Four fields do different jobs and it is worth knowing which is which. The
 * **other names** are what the bot matches a receipt on. The **fiscal id** is
 * what identifies the company behind the shop, and the only thing about it that
 * does not change. The **brand** is what makes two branches add up together
 * without averaging their prices into one. The address is for the person.
 */
export function PayeeForm({
  brands,
  categories,
  payeeId,
  defaultName,
  tiles,
  attribution,
  open,
  onOpenChange,
}: {
  brands: BrandOption[];
  categories: CategoryOption[];
  /** If given, that place is edited; if not, a new one is created. */
  payeeId?: string;
  /**
   * The name to start from.
   *
   * It comes from the reconciliation list, where the shop's name is the very
   * text being grouped: «Compra en MI SUPER, C.A». Retyping what is already on
   * screen is the kind of small friction that stops somebody halfway down a
   * list of forty.
   */
  defaultName?: string;
  /** The tile source, so the picker can draw something to click on. */
  tiles: string | null;
  attribution: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations();
  const editing = Boolean(payeeId);
  const [data, setData] = useState<EditablePayee | null>(null);
  const [failed, setFailed] = useState(false);

  const [parentId, setParentId] = useState<string>(NONE);
  const [categoryId, setCategoryId] = useState<string>(NONE);
  /*
   * The point, held here rather than left to the input alone.
   *
   * It is written from two places — clicking the map and typing in the field —
   * and they have to agree: clicking has to fill the field, and pasting a link
   * has to move the pin. One value, two ways in.
   */
  const [coordinates, setCoordinates] = useState("");

  const [state, action, pending] = useActionState(
    async (prev: ActionState, form: FormData) => {
      const result = editing
        ? await editPayeeAction(prev, form)
        : await createPayeeAction(prev, form);
      if (result?.ok) {
        toast.success(result.message);
        onOpenChange(false);
      }
      return result;
    },
    null,
  );

  useEffect(() => {
    if (!open || !payeeId) return;
    let alive = true;
    payeeForEdit(payeeId)
      .then((result) => {
        if (!alive) return;
        if (!result) {
          setFailed(true);
          return;
        }
        setData(result);
        setParentId(result.parentId ?? NONE);
        setCategoryId(result.defaultCategoryId ?? NONE);
        setCoordinates(result.coordinates);
      })
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [open, payeeId]);

  /*
   * The way past the refusal, offered only once it has happened.
   *
   * A repeated fiscal id is almost always the same shop written twice, and
   * silently accepting it splits that shop's price history in two. But a
   * franchise genuinely gives two branches two companies, and only the person
   * knows which case this is. So the service says no, names the place in the
   * way, and the box appears — never before, or it would read as an option.
   */
  const sharedTaxId = state?.code === "duplicate_tax_id";

  const available = brands.filter((brand) => brand.id !== payeeId);
  // Whatever is in the field right now, if it is a point at all: that is what
  // the pin shows, so typing and clicking never disagree.
  const pinned = parseCoordinates(coordinates);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby="payee-help">
        <DialogHeader>
          <DialogTitle>
            {editing ? t("ui.places.form.titleEdit") : t("ui.places.form.titleNew")}
          </DialogTitle>
          <DialogDescription id="payee-help">{t("ui.places.form.help")}</DialogDescription>
        </DialogHeader>

        {failed && (
          <p role="alert" className="text-sm text-destructive">
            {t("ui.places.form.failed")}
          </p>
        )}

        {editing && !data && !failed && (
          <p className="py-6 text-center text-sm text-muted-foreground">{t("ui.edit.loading")}</p>
        )}

        {(!editing || data) && (
          <form action={action} className="grid gap-4">
            {payeeId && <input type="hidden" name="id" value={payeeId} />}
            <input type="hidden" name="parent_id" value={parentId === NONE ? "" : parentId} />
            <input
              type="hidden"
              name="default_category_id"
              value={categoryId === NONE ? "" : categoryId}
            />

            <div className="grid gap-2">
              <Label htmlFor="payee-name">{t("ui.places.form.name")}</Label>
              <Input
                id="payee-name"
                name="name"
                defaultValue={data?.name ?? defaultName}
                placeholder={t("ui.places.form.namePlaceholder")}
                required
                autoFocus={!editing}
              />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid min-w-0 gap-2">
                <Label htmlFor="payee-tax-id">
                  {t("ui.places.form.taxId")}{" "}
                  <span className="text-muted-foreground">{t("ui.form.optional")}</span>
                </Label>
                <Input
                  id="payee-tax-id"
                  name="tax_id"
                  defaultValue={formatTaxId(data?.taxId)}
                  placeholder="J-30012345-6"
                  aria-describedby="payee-tax-help"
                />
                <p id="payee-tax-help" className="text-xs text-muted-foreground">
                  {t("ui.places.form.taxIdHelp")}
                </p>
              </div>

              <div className="grid min-w-0 gap-2">
                <Label htmlFor="payee-parent">
                  {t("ui.places.form.brand")}{" "}
                  <span className="text-muted-foreground">{t("ui.form.optional")}</span>
                </Label>
                <Select
                  value={parentId}
                  onValueChange={setParentId}
                  // A place with branches of its own cannot become one: that
                  // would be a third level, and no total looks that deep.
                  disabled={data?.hasBranches}
                >
                  <SelectTrigger
                    id="payee-parent"
                    className="w-full"
                    aria-describedby={data?.hasBranches ? "brand-locked" : "payee-brand-help"}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>{t("ui.places.form.noBrand")}</SelectItem>
                    {available.map((brand) => (
                      <SelectItem key={brand.id} value={brand.id}>
                        {brand.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p
                  id={data?.hasBranches ? "brand-locked" : "payee-brand-help"}
                  className="text-xs text-muted-foreground"
                >
                  {data?.hasBranches
                    ? t("ui.places.form.brandLocked")
                    : t("ui.places.form.brandHelp")}
                </p>
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid min-w-0 gap-2">
                <Label htmlFor="payee-address">
                  {t("ui.places.form.address")}{" "}
                  <span className="text-muted-foreground">{t("ui.form.optional")}</span>
                </Label>
                <Input
                  id="payee-address"
                  name="address"
                  defaultValue={data?.address}
                  placeholder={t("ui.places.form.addressPlaceholder")}
                />
              </div>

              {/* Nobody knows their shop's latitude. What they do is open a map,
                  find the branch and copy — so this takes the numbers or the
                  whole URL, and there is no geocoding: turning an address into a
                  point would mean sending every shop you visit to a stranger. */}
              <div className="grid min-w-0 gap-2">
                <Label htmlFor="payee-coordinates">
                  {t("ui.places.form.coordinates")}{" "}
                  <span className="text-muted-foreground">{t("ui.form.optional")}</span>
                </Label>
                <Input
                  id="payee-coordinates"
                  name="coordinates"
                  value={coordinates}
                  onChange={(e) => setCoordinates(e.target.value)}
                  placeholder="10.4806, -66.9036"
                  aria-describedby="payee-coordinates-help"
                />
                <p id="payee-coordinates-help" className="text-xs text-muted-foreground">
                  {t("ui.places.form.coordinatesHelp")}
                </p>
              </div>
            </div>

            {/* Click the map and the field fills; paste into the field and the
                pin moves. Nobody knows their shop's latitude, but everybody can
                point at where it is. */}
            <PlaceMap
              points={pinned ? [{ id: "pin", name: t("ui.places.form.thisPlace"), ...pinned }] : []}
              tiles={tiles}
              attribution={attribution}
              height={200}
              pick
              onPick={(lat, lon) => setCoordinates(formatCoordinates(lat, lon))}
            />

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid min-w-0 gap-2">
                <Label htmlFor="payee-category">
                  {t("ui.places.form.category")}{" "}
                  <span className="text-muted-foreground">{t("ui.form.optional")}</span>
                </Label>
                <Select value={categoryId} onValueChange={setCategoryId}>
                  <SelectTrigger id="payee-category" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>{t("ui.places.form.noCategory")}</SelectItem>
                    {categories.map((category) => (
                      <SelectItem key={category.id} value={category.id}>
                        {category.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="grid min-w-0 gap-2">
                <Label htmlFor="payee-aliases">
                  {t("ui.places.form.aliases")}{" "}
                  <span className="text-muted-foreground">{t("ui.form.optional")}</span>
                </Label>
                <Input
                  id="payee-aliases"
                  name="aliases"
                  defaultValue={data?.aliases}
                  placeholder={t("ui.places.form.aliasesPlaceholder")}
                />
              </div>
            </div>
            <p className="-mt-2 text-xs text-muted-foreground">
              {t("ui.places.form.aliasesHelp")}
            </p>

            {state && !state.ok && (
              <div className="grid gap-2">
                <p role="alert" className="text-sm text-destructive">
                  {state.message}
                </p>
                {sharedTaxId && (
                  <label className="flex items-start gap-2 text-sm">
                    <input
                      type="checkbox"
                      name="allow_shared_tax_id"
                      className="mt-0.5 size-4 shrink-0 accent-foreground"
                    />
                    <span className="text-muted-foreground">
                      {t("ui.places.form.sharedTaxId")}
                    </span>
                  </label>
                )}
              </div>
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
                {pending
                  ? t("ui.form.saving")
                  : editing
                    ? t("ui.edit.saveChanges")
                    : t("ui.places.form.create")}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
