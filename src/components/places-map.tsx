import { getTranslations } from "next-intl/server";

/**
 * Where you shop, on a map.
 *
 * Two decisions carry this component, and both are about what leaves the
 * machine rather than about how it looks.
 *
 * **It is off until somebody names a tile server.** A map tile is an outbound
 * request to a third party, and the coordinates in that request are the places
 * this household buys food and medicine. This application promises that its
 * entries do not leave the machine, so the promise is kept by default and
 * broken only on purpose: with `MAP_TILES_URL` unset there is no map, and the
 * screen says why rather than showing an empty box. OpenStreetMap's own tile
 * policy forbids an application leaning on `tile.openstreetmap.org`, so
 * choosing a source is a decision the operator has to make anyway.
 *
 * **There is no map library.** Leaflet from a CDN would be a second outbound
 * host and a dependency for something that is, at this size, twenty lines of
 * arithmetic: the slippy-map projection is fixed and public. What this draws is
 * a still picture with the places marked on it — the question is «where are my
 * shops», not «let me explore the city».
 */

/** The Web-Mercator pixel of a coordinate at a zoom, in a 256px tile grid. */
function project(lat: number, lon: number, zoom: number) {
  const n = 2 ** zoom;
  const radians = (lat * Math.PI) / 180;
  return {
    x: ((lon + 180) / 360) * n * 256,
    y:
      ((1 - Math.log(Math.tan(radians) + 1 / Math.cos(radians)) / Math.PI) / 2) *
      n *
      256,
  };
}

export type MapPoint = { id: string; name: string; lat: string; lon: string };

const WIDTH = 720;
const HEIGHT = 260;
const TILE = 256;

export async function PlacesMap({ points }: { points: MapPoint[] }) {
  const t = await getTranslations();
  const template = process.env.MAP_TILES_URL?.trim();

  if (points.length === 0) return null;

  if (!template) {
    return (
      <p className="mb-8 max-w-prose text-sm text-muted-foreground">
        {t("ui.places.mapOff", { n: points.length })}
      </p>
    );
  }

  const lats = points.map((p) => Number(p.lat));
  const lons = points.map((p) => Number(p.lon));
  const centre = {
    lat: (Math.min(...lats) + Math.max(...lats)) / 2,
    lon: (Math.min(...lons) + Math.max(...lons)) / 2,
  };

  /*
   * The closest zoom at which every place still fits.
   *
   * Fixing the zoom would frame one household's four shops in a neighbourhood
   * and another's two cities apart with the same rectangle, and one of the two
   * would be looking at an empty green square.
   */
  let zoom = 17;
  for (; zoom > 2; zoom--) {
    const corners = points.map((p) => project(Number(p.lat), Number(p.lon), zoom));
    const spanX = Math.max(...corners.map((c) => c.x)) - Math.min(...corners.map((c) => c.x));
    const spanY = Math.max(...corners.map((c) => c.y)) - Math.min(...corners.map((c) => c.y));
    // A margin, so a marker never sits on the very edge of the frame.
    if (spanX < WIDTH - 80 && spanY < HEIGHT - 80) break;
  }

  const middle = project(centre.lat, centre.lon, zoom);
  const left = middle.x - WIDTH / 2;
  const top = middle.y - HEIGHT / 2;

  const firstTile = { x: Math.floor(left / TILE), y: Math.floor(top / TILE) };
  const lastTile = {
    x: Math.floor((left + WIDTH) / TILE),
    y: Math.floor((top + HEIGHT) / TILE),
  };

  const tiles: { key: string; url: string; x: number; y: number }[] = [];
  const limit = 2 ** zoom;
  for (let x = firstTile.x; x <= lastTile.x; x++) {
    for (let y = firstTile.y; y <= lastTile.y; y++) {
      // Off the top or bottom of the world there is no tile; around the side
      // there is, and it wraps.
      if (y < 0 || y >= limit) continue;
      const wrapped = ((x % limit) + limit) % limit;
      tiles.push({
        key: `${x}-${y}`,
        url: template
          .replace("{z}", String(zoom))
          .replace("{x}", String(wrapped))
          .replace("{y}", String(y)),
        x: x * TILE - left,
        y: y * TILE - top,
      });
    }
  }

  return (
    <figure className="mb-8">
      <div
        className="relative overflow-hidden rounded-lg border border-border bg-muted"
        style={{ height: HEIGHT }}
        role="img"
        aria-label={t("ui.places.mapLabel", { n: points.length })}
      >
        {/* The frame is computed at a fixed width and the column it sits in is
            narrower on a phone, so it is CENTRED rather than pinned left: what
            the frame loses it loses evenly on both sides, and the margin the
            zoom leaves keeps every marker inside. Pinned left, a shop on the
            eastern edge simply disappeared on a narrow screen. */}
        <div
          className="absolute left-1/2 -translate-x-1/2"
          style={{ width: WIDTH, height: HEIGHT }}
        >
          {tiles.map((tile) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={tile.key}
              src={tile.url}
              alt=""
              aria-hidden
              width={TILE}
              height={TILE}
              loading="lazy"
              className="absolute max-w-none"
              style={{ left: tile.x, top: tile.y }}
            />
          ))}

          {points.map((point) => {
            const at = project(Number(point.lat), Number(point.lon), zoom);
            return (
              <span
                key={point.id}
                title={point.name}
                className="absolute size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-background bg-foreground shadow"
                style={{ left: at.x - left, top: at.y - top }}
              />
            );
          })}
        </div>
      </div>
      {/* Whoever draws the map is owed the credit, and the person looking is
          owed knowing whose server just saw where they shop. */}
      <figcaption className="mt-1.5 text-xs text-muted-foreground">
        {t("ui.places.mapCredit", { host: new URL(template.replace(/\{[zxy]\}/g, "0")).host })}
      </figcaption>
    </figure>
  );
}
