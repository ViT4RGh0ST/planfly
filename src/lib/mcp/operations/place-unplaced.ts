import { NextRequest } from "next/server";
import { z } from "zod";

import { POST as assignRoute } from "@/app/api/v1/places/assign/route";
import { GET as placesRead } from "@/app/api/v1/places/route";
import { normalizeLocale } from "@/i18n/config";
import { getTranslator } from "@/i18n/translator";
import { withInternalPrincipal } from "@/lib/api/handler";
import type { Principal } from "@/lib/api-token";
import type { McpOperation } from "@/lib/mcp/operation";
import { RouteRefusal } from "@/lib/mcp/tools/context";
import { resolvePayee } from "@/lib/services/resolve-entities";
import { assignPlaceSchema } from "@/lib/validation";

/**
 * Labelling forty entries at once, behind the gate.
 *
 * The two criteria the budget tool settles gates by — does it move money, can it
 * silently duplicate — both say no here. This one introduces a third: **it
 * cannot be undone from any door.** Putting the wrong place on forty entries
 * takes forty corrections to reverse, each with a full recalculation, and there
 * is no bulk unplace. And every answer to «how much do I spend at Farmatodo» is
 * wrong from the moment it returns, with nothing failing anywhere.
 *
 * So the person sees the name, the count and the date range before the yes, and
 * the fingerprint is over exactly that: if three more entries with the same
 * description arrived between the preview and the yes, the yes was for a
 * different forty.
 *
 * Not `retryable`. The write itself is one atomic UPDATE whose WHERE demands
 * `payee_id IS NULL`, so it cannot duplicate anything — but a retry after a
 * write that committed and then failed on the way back would find nothing left
 * to place and answer «nothing matched», which reads as failure for something
 * that succeeded. A stranded approval costs one more preview and says so out
 * loud; that would be a lie.
 */

const PLACES = "/api/v1/places";

const previewSchema = z.object({
  operation: z.literal("place_unplaced"),
  /** The place's own name, not what was typed: the yes is for what was resolved. */
  place: z.string(),
  description: z.string(),
  entries: z.number(),
  items: z.number(),
  first_on: z.string(),
  last_on: z.string(),
});

export type PlaceUnplacedPreview = z.infer<typeof previewSchema>;

type UnplacedGroupRow = {
  description: string;
  entries: number;
  items: number;
  first_on: string;
  last_on: string;
};

/**
 * The group as the route reports it, read again on the way to the write.
 *
 * Through the route rather than the service so the refresh is checked against
 * the credential a second time, exactly as the products operation does: the gate
 * does not get to trust that whoever staged the confirmation still may.
 */
async function unplacedGroup(
  principal: Principal,
  description: string,
): Promise<UnplacedGroupRow | null> {
  const response = await placesRead(
    withInternalPrincipal(
      new NextRequest(`http://planfly.internal${PLACES}?view=unplaced`),
      principal,
    ),
  );
  const payload = (await response.json()) as Record<string, unknown>;
  if (!response.ok) throw new RouteRefusal(payload, response.status);

  const groups = (payload.groups ?? []) as UnplacedGroupRow[];
  // Exactly, never fuzzily: the set that gets written has to be the set that was
  // counted, and a resemblance here would sweep in entries nobody saw.
  return groups.find((group) => group.description === description) ?? null;
}

export const placeUnplacedOperation: McpOperation = {
  run: async (principal, input, _confirmationId, dryRun) => {
    // Parsed again on the confirm path: `input` there came out of a jsonb column
    // and is not what the tool validated.
    const draft = assignPlaceSchema.parse(input);

    if (!dryRun) {
      const response = await assignRoute(
        withInternalPrincipal(
          new NextRequest(`http://planfly.internal${PLACES}/assign`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(draft),
          }),
          principal,
        ),
      );
      const payload = (await response.json()) as Record<string, unknown>;
      if (!response.ok) throw new RouteRefusal(payload, response.status);
      return payload;
    }

    // The household's own words for both refusals, the same ones the route
    // uses: a preview that refuses in another language than the write is two
    // products as far as the person reading it is concerned.
    const t = getTranslator(normalizeLocale(principal.locale));

    const place = await resolvePayee(principal.householdId, draft.place);
    if (!place) {
      throw new RouteRefusal(
        {
          ok: false,
          error: "payee_not_found",
          message: t("api.places.notFound", { input: draft.place }),
        },
        404,
      );
    }

    const group = await unplacedGroup(principal, draft.description);
    if (!group) {
      throw new RouteRefusal(
        {
          ok: false,
          error: "nothing_matched",
          message: t("api.places.nothingMatched", { description: draft.description }),
        },
        422,
      );
    }

    return {
      operation: "place_unplaced",
      place: place.name,
      description: group.description,
      entries: group.entries,
      items: group.items,
      first_on: group.first_on,
      last_on: group.last_on,
    } satisfies PlaceUnplacedPreview;
  },

  fingerprint: (preview) => {
    const read = previewSchema.safeParse(preview);
    /*
     * A stored preview of another shape is not comparable, and answering
     * «equal» for it would let a confirmation through with no gate at all.
     */
    if (!read.success) {
      throw new Error("The stored preview is not a place_unplaced preview.");
    }
    const p = read.data;

    // `jsonb` does not preserve key order, so the fields are picked and ordered
    // explicitly: this compares by value, not by serialization.
    return JSON.stringify({
      place: p.place,
      description: p.description,
      entries: p.entries,
      items: p.items,
      firstOn: p.first_on,
      lastOn: p.last_on,
    });
  },
};
