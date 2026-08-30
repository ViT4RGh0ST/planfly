"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PayeeForm, type BrandOption, type CategoryOption } from "@/components/payee-form";
import { placeUnplacedAction } from "@/app/(app)/actions";
import type { UnplacedGroup } from "@/lib/services/manage-payees";

/**
 * The entries that never got a place, and the way to give them one.
 *
 * For months no door could set a shop, so the shop stayed where it was written:
 * inside the description, «Compra en MI SUPER, C.A», forty times over. The
 * grouping is the entire value — one by one this is an afternoon, by repeated
 * text it is four decisions.
 *
 * It proposes but never applies. Assigning the wrong shop does not fail: it puts
 * one shop's prices under another and the curve looks perfectly reasonable. So
 * every group is confirmed on its own, with what it is worth in front of it —
 * how many entries, and how many priced items would join that shop's history.
 */
export function UnplacedGroups({
  groups,
  total,
  places,
  brands,
  categories,
  tiles,
  attribution,
  geocoder,
}: {
  groups: UnplacedGroup[];
  /** How many there are in all, so a cut list never reads as the whole list. */
  total: number;
  /** Existing places to assign to. Empty is the normal case on a first visit. */
  places: { id: string; name: string }[];
  brands: BrandOption[];
  categories: CategoryOption[];
  tiles: string | null;
  attribution: string | null;
  geocoder: boolean;
}) {
  const t = useTranslations();
  /*
   * With no places yet this is the MOST useful the screen ever is, and the
   * first version hid it — the section only rendered once somewhere existed to
   * assign to, which is exactly the state nobody starts in. A household opens
   * this page with forty groups and zero shops, and what it needs is not an
   * empty list: it is the button that turns the text into the shop.
   */
  if (groups.length === 0) return null;

  return (
    <section className="mt-12" aria-labelledby="unplaced">
      <h2
        id="unplaced"
        className="mb-1 text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground"
      >
        {t("ui.places.unplacedTitle")}
      </h2>
      <p className="mb-3 max-w-[62ch] text-sm text-muted-foreground">
        {t("ui.places.unplacedHint")}
        {total > groups.length && (
          <> {t("ui.places.unplacedMore", { n: total - groups.length })}</>
        )}
      </p>
      <ul className="divide-y divide-border">
        {groups.map((group) => (
          <Group
            key={group.description}
            group={group}
            places={places}
            brands={brands}
            categories={categories}
          tiles={tiles}
          attribution={attribution}
        geocoder={geocoder}
          
          />
        ))}
      </ul>
    </section>
  );
}

function Group({
  group,
  places,
  brands,
  categories,
  tiles,
  attribution,
  geocoder,
}: {
  group: UnplacedGroup;
  places: { id: string; name: string }[];
  brands: BrandOption[];
  categories: CategoryOption[];
  tiles: string | null;
  attribution: string | null;
  geocoder: boolean;
}) {
  const t = useTranslations();
  const [pending, startTransition] = useTransition();
  const [creating, setCreating] = useState(false);
  /*
   * The suggestion comes pre-selected only when it is a strong one.
   *
   * It goes through the same resolver the bot uses, so a weak resemblance here
   * is the same weak resemblance that would have filed the expense wrongly.
   * Pre-selecting it would turn one careless click into forty wrong rows.
   */
  const suggested = group.suggestion && group.suggestion.score >= 0.9 ? group.suggestion.id : "";
  const [choice, setChoice] = useState(suggested);

  const assign = () =>
    startTransition(async () => {
      const result = await placeUnplacedAction(group.description, choice);
      if (result?.ok) toast.success(result.message);
      else if (result) toast.error(result.message);
    });

  return (
    <li className="flex flex-wrap items-center justify-between gap-3 py-3">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm">{group.description}</p>
        <p className="text-xs text-muted-foreground">
          {t("ui.places.unplacedCount", { n: group.entries })}
          {group.items > 0 && <> · {t("ui.places.unplacedItems", { n: group.items })}</>}
        </p>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {/* The select only exists once there is somewhere to point at. Empty, it
            would be a control that opens onto nothing. */}
        {places.length > 0 && (
          <>
            <Select value={choice} onValueChange={setChoice}>
              <SelectTrigger
                className="w-52"
                aria-label={t("ui.places.unplacedChoose", { description: group.description })}
              >
                <SelectValue placeholder={t("ui.places.unplacedPick")} />
              </SelectTrigger>
              <SelectContent>
                {places.map((place) => (
                  <SelectItem key={place.id} value={place.id}>
                    {place.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button size="sm" variant="outline" disabled={!choice || pending} onClick={assign}>
              {t("ui.places.unplacedAssign")}
            </Button>
          </>
        )}
        <Button
          size="sm"
          variant={places.length > 0 ? "ghost" : "outline"}
          disabled={pending}
          onClick={() => setCreating(true)}
        >
          {t("ui.places.unplacedCreate")}
        </Button>
      </div>

      {creating && (
        <PayeeForm
          brands={brands}
          categories={categories}
          tiles={tiles}
          attribution={attribution}
        geocoder={geocoder}
          
          // The group's own text: the shop's name is what is being grouped by.
          defaultName={group.description}
          open={creating}
          onOpenChange={setCreating}
        />
      )}
    </li>
  );
}
