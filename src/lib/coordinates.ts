/**
 * A place's coordinates, as somebody actually gets hold of them.
 *
 * Nobody knows their shop's latitude. What they do is open a map, find the
 * branch, and copy either the pair of numbers or the whole URL — so this reads
 * both, and reads them out of the shapes the common maps produce:
 *
 *   10.4806, -66.9036
 *   https://www.openstreetmap.org/#map=19/10.48060/-66.90360
 *   https://maps.google.com/…/@10.4806,-66.9036,17z
 *   https://maps.apple.com/?ll=10.4806,-66.9036
 *
 * There is no geocoding, and that is a decision rather than a gap: turning an
 * address into a point means sending the address of every shop you visit to
 * somebody else's server, and this application promises that its entries do not
 * leave the machine.
 */

export type Coordinates = { lat: string; lon: string };

/** −90..90 and −180..180, kept as text: written down and read back, never computed with. */
function inRange(lat: number, lon: number): boolean {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lon) <= 180 &&
    // 0,0 is in the Gulf of Guinea, and it is what an empty parse looks like.
    !(lat === 0 && lon === 0)
  );
}

/** Six decimals is about ten centimetres. More is noise a map cannot draw. */
function trim(value: number): string {
  return String(Number(value.toFixed(6)));
}

export function parseCoordinates(input: string | undefined | null): Coordinates | null {
  if (!input) return null;
  const text = input.trim();
  if (!text) return null;

  const candidates: [string, string][] = [];

  // The `@lat,lon` of a Google URL, and the `ll=`/`q=` of the others. Read
  // before the bare pair, because a URL also contains numbers that are not it.
  const at = /[@=](-?\d{1,3}(?:\.\d+)?),\s*(-?\d{1,3}(?:\.\d+)?)/.exec(text);
  if (at) candidates.push([at[1], at[2]]);

  // OpenStreetMap writes them separated by slashes, after the zoom.
  const osm = /#map=\d+\/(-?\d{1,3}(?:\.\d+)?)\/(-?\d{1,3}(?:\.\d+)?)/.exec(text);
  if (osm) candidates.unshift([osm[1], osm[2]]);

  const bare = /^(-?\d{1,3}(?:\.\d+)?)\s*[,;\s]\s*(-?\d{1,3}(?:\.\d+)?)$/.exec(text);
  if (bare) candidates.unshift([bare[1], bare[2]]);

  for (const [rawLat, rawLon] of candidates) {
    const lat = Number(rawLat);
    const lon = Number(rawLon);
    if (inRange(lat, lon)) return { lat: trim(lat), lon: trim(lon) };
  }
  return null;
}

/** Back into the field, in the shape it is pasted from. */
export function formatCoordinates(
  lat: string | null | undefined,
  lon: string | null | undefined,
): string {
  if (!lat || !lon) return "";
  return `${Number(lat)}, ${Number(lon)}`;
}
