import { NextRequest, NextResponse } from "next/server";

import { requireSession } from "@/lib/session";
import { parseCoordinates } from "@/lib/coordinates";

/**
 * Turning an address into a point, and a point back into an address.
 *
 * This is the ONE thing in the application that asks a stranger a question, and
 * everything about it follows from that.
 *
 * **It is off unless somebody names a service.** With `GEOCODER_URL` unset the
 * address stays what it always was — text a person writes — and the map still
 * works both ways with the coordinates. Nothing here is required to record a
 * purchase.
 *
 * **It goes through the server, never the browser.** A page calling Nominatim
 * directly would send the household's IP address and the referring URL along
 * with every shop it looks up. From here what leaves is one query from one
 * machine, which is the difference between a stranger learning «somebody asked
 * about this address» and «this person, at this address, shops here».
 *
 * **It is rate-limited on the way out.** Nominatim's policy is one request per
 * second and it is enforced here rather than trusted to the person typing: a
 * field that searches as you type would be twenty requests for one address.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Nominatim's shape, which is what the default URL speaks. */
type GeocodeHit = { lat?: string; lon?: string; display_name?: string };

const MIN_GAP_MS = 1_100;
let lastCall = 0;

async function spaced<T>(work: () => Promise<T>): Promise<T> {
  const wait = Math.max(0, lastCall + MIN_GAP_MS - Date.now());
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastCall = Date.now();
  return work();
}

function serviceUrl(): string | null {
  return process.env.GEOCODER_URL?.trim() || null;
}

export async function GET(req: NextRequest) {
  // A session, not a token: this is a screen's helper, and leaving it open would
  // turn a personal instance into somebody else's free geocoding proxy.
  await requireSession();

  const base = serviceUrl();
  if (!base) return NextResponse.json({ ok: false, error: "geocoder_off" }, { status: 501 });

  const query = req.nextUrl.searchParams.get("q")?.trim() ?? "";
  const at = parseCoordinates(req.nextUrl.searchParams.get("at"));

  if (!query && !at) {
    return NextResponse.json({ ok: false, error: "nothing_to_look_up" }, { status: 400 });
  }

  const url = new URL(at ? `${base.replace(/\/$/, "")}/reverse` : `${base.replace(/\/$/, "")}/search`);
  url.searchParams.set("format", "jsonv2");
  if (at) {
    url.searchParams.set("lat", at.lat);
    url.searchParams.set("lon", at.lon);
    // A shop, not a country: at street level the answer names the building.
    url.searchParams.set("zoom", "18");
  } else {
    url.searchParams.set("q", query);
    url.searchParams.set("limit", "1");
  }

  try {
    const response = await spaced(() =>
      fetch(url, {
        // Nominatim requires an application to identify itself, and refuses the
        // ones that do not.
        headers: { "user-agent": "planfly (self-hosted personal finances)" },
        signal: AbortSignal.timeout(8_000),
      }),
    );
    if (!response.ok) {
      return NextResponse.json({ ok: false, error: "service_failed" }, { status: 502 });
    }

    const body: unknown = await response.json();
    const hit: GeocodeHit | undefined = Array.isArray(body) ? body[0] : (body as GeocodeHit);
    if (!hit?.lat || !hit.lon) {
      return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
    }

    return NextResponse.json({
      ok: true,
      lat: hit.lat,
      lon: hit.lon,
      address: hit.display_name ?? null,
    });
  } catch {
    // A geocoder that is down or slow must never be the reason a place cannot be
    // saved: the field keeps whatever was typed.
    return NextResponse.json({ ok: false, error: "service_failed" }, { status: 502 });
  }
}
