import { and, asc, eq, isNull } from "drizzle-orm";
import { getTranslations } from "next-intl/server";

import { AddPayee, UnarchivePayee } from "@/components/payee-actions";
import { PayeeList } from "@/components/payee-list";
import { PlaceMap } from "@/components/place-map";
import { UnplacedGroups } from "@/components/unplaced-groups";
import { db } from "@/db";
import { categories as categoriesTable } from "@/db/schema";
import { requireSession } from "@/lib/session";
import { archivedPayees, payeeTree, unplacedGroups } from "@/lib/services/manage-payees";

export const dynamic = "force-dynamic";

/**
 * THESIS. A price with no place is half a price.
 *
 * WORLD. Every purchase already knows where it happened — `transactions` has
 * carried a `payee_id` since the beginning — and nothing could be done with it.
 * The rows were written by the bot off a receipt and could never be corrected,
 * so «Farmatodo» and «FARMATODO C.A.» were two shops and neither knew what
 * anything cost.
 *
 * FORM. The same list as /categories, because it is the same job. Branches hang
 * under their brand: a chain is not one shop — two branches price the same
 * product differently — but its total is still a thing you want.
 *
 * FIRST GLANCE. Which places have priced purchases and which do not. A place
 * with entries and no line items is one you never photographed a receipt at, and
 * that is exactly why its prices are missing from the products screen.
 *
 * STORY. «Where is the harina cheapest?» → the answer needs the shops to be one
 * row each, which is what this screen is for.
 */
export default async function PlacesPage() {
  const ctx = await requireSession();
  const t = await getTranslations();

  const [tree, archived, unplaced, categories] = await Promise.all([
    payeeTree(ctx.householdId),
    archivedPayees(ctx.householdId),
    unplacedGroups(ctx.householdId),
    db
      .select({ id: categoriesTable.id, name: categoriesTable.name })
      .from(categoriesTable)
      .where(
        and(
          eq(categoriesTable.householdId, ctx.householdId),
          eq(categoriesTable.kind, "expense"),
          isNull(categoriesTable.archivedAt),
        ),
      )
      .orderBy(asc(categoriesTable.name)),
  ]);

  // Only the top level can be a brand: two levels, so that a chain's total sees
  // the whole tree one step down.
  const brands = tree.map((node) => ({ id: node.id, name: node.name }));

  // Every place that knows where it is, branches included. A brand with branches
  // is not itself a point on a map: its shops are.
  const points = [...tree, ...tree.flatMap((node) => node.branches)]
    .filter((node) => node.lat && node.lon)
    .map((node) => ({ id: node.id, name: node.name, lat: node.lat!, lon: node.lon! }));

  // The tile source is a server setting; the map that draws it runs in the
  // browser. It travels as a prop rather than being read twice.
  const tiles = process.env.MAP_TILES_URL?.trim() || null;
  const attribution = process.env.MAP_TILES_ATTRIBUTION?.trim() || null;
  // Whether an address can be turned into a point at all. The service is named
  // on the server; the screen only needs to know if there is one.
  const geocoder = Boolean(process.env.GEOCODER_URL?.trim());

  return (
    <div className="mx-auto max-w-3xl px-6 py-10">
      <header className="mb-10 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-medium tracking-tight">{t("ui.places.title")}</h1>
          <p className="mt-1 max-w-[62ch] text-sm text-muted-foreground">{t("ui.places.hint")}</p>
        </div>
        <AddPayee
          brands={brands}
          categories={categories}
          tiles={tiles}
          attribution={attribution}
          geocoder={geocoder}
        />
      </header>

      {points.length > 0 && (
        <div className="mb-8">
          <PlaceMap points={points} tiles={tiles} attribution={attribution} />
        </div>
      )}

      <PayeeList
        payees={tree}
        brands={brands}
        categories={categories}
        tiles={tiles}
        attribution={attribution}
        geocoder={geocoder}
      />

      {/* What was bought somewhere nobody wrote down. It goes under the list and
          not on a screen of its own: the answer to «which shop was that» is the
          list right above it. */}
      <UnplacedGroups
        groups={unplaced.groups}
        total={unplaced.total}
        places={[...tree, ...tree.flatMap((node) => node.branches)].map((node) => ({
          id: node.id,
          name: node.name,
        }))}
        brands={brands}
        categories={categories}
        tiles={tiles}
        attribution={attribution}
        geocoder={geocoder}
      />

      {/* Archiving does not delete. With nowhere to see them, a place archived by
          mistake could only be recovered from psql. */}
      {archived.length > 0 && (
        <section className="mt-10" aria-labelledby="archived">
          <h2
            id="archived"
            className="mb-2 text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground"
          >
            {t("ui.places.archived")}
          </h2>
          <ul className="divide-y divide-border">
            {archived.map((payee) => (
              <li key={payee.id} className="flex items-center justify-between gap-4 py-2">
                <span className="text-sm text-muted-foreground">{payee.name}</span>
                <UnarchivePayee id={payee.id} name={payee.name} />
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
