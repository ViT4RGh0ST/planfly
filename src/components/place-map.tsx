"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import type { Map as LeafletMap, Marker } from "leaflet";

import "leaflet/dist/leaflet.css";

/**
 * The map, which does both jobs: putting a place on it and looking at them.
 *
 * There is one implementation and not two. It began as a still picture drawn on
 * the server with the slippy projection written out by hand — no JavaScript, no
 * dependency — and that was right while the map only had to be LOOKED at. The
 * moment it also has to be clicked, hand-rolling drag, wheel zoom, touch and
 * inertia is rebuilding a wheel with edge cases, and keeping the hand-rolled one
 * alongside would leave two things that draw tiles and would drift apart.
 *
 * Leaflet is bundled, not fetched: the map's code comes from this machine like
 * the rest of the application. The tiles cannot be — those are the pictures —
 * which is why the whole thing stays dark until somebody names a tile server.
 *
 * The marker is a `divIcon`, drawn in CSS. Leaflet's default one pulls PNGs off
 * a path that has to be configured for a bundler, and a coloured dot is what
 * this needs anyway.
 */

export type MapPoint = { id: string; name: string; lat: string; lon: string };

export function PlaceMap({
  points,
  tiles,
  attribution,
  pick,
  onPick,
  height = 260,
}: {
  /** What to draw. In `pick` mode the first one is the marker that moves. */
  points: MapPoint[];
  /** The tile template. Without it there is no map at all, on purpose. */
  tiles: string | null;
  attribution: string | null;
  /** Turns clicking into choosing, rather than just looking. */
  pick?: boolean;
  onPick?: (lat: string, lon: string) => void;
  height?: number;
}) {
  const t = useTranslations();
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<LeafletMap | null>(null);
  const marker = useRef<Marker | null>(null);
  const picker = useRef(onPick);
  const [failed, setFailed] = useState(false);

  /*
   * The callback kept in a ref, refreshed in its own effect.
   *
   * The map is built once and its click handler lives as long as it does; if it
   * closed over the first `onPick` it would keep writing into a state setter
   * from a render that is long gone. Assigning during render is what React
   * forbids, so it happens after.
   */
  useEffect(() => {
    picker.current = onPick;
  }, [onPick]);

  useEffect(() => {
    if (!tiles || !container.current || map.current) return;
    let alive = true;

    /*
     * Loaded here and not at the top of the file.
     *
     * Leaflet reaches for `window` as it initialises, and a client component is
     * still rendered once on the server: importing it up there breaks the page
     * before it ever reaches a browser.
     */
    void (async () => {
      const L = await import("leaflet");
      if (!alive || !container.current || map.current) return;

      const instance = L.map(container.current, {
        // A map inside a form must not swallow the page's scroll: you reach it
        // by scrolling past it far more often than you mean to zoom it.
        scrollWheelZoom: false,
        attributionControl: false,
      });
      map.current = instance;

      L.tileLayer(tiles, { maxZoom: 19 }).addTo(instance);

      const dot = L.divIcon({
        className: "",
        html: '<span class="block size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-background bg-foreground shadow"></span>',
        iconSize: [0, 0],
      });

      const drawn = points.filter((p) => p.lat && p.lon);
      for (const point of drawn) {
        const at = L.marker([Number(point.lat), Number(point.lon)], { icon: dot });
        at.bindTooltip(point.name);
        at.addTo(instance);
        if (pick) marker.current = at;
      }

      if (drawn.length === 1) {
        instance.setView([Number(drawn[0].lat), Number(drawn[0].lon)], 16);
      } else if (drawn.length > 1) {
        instance.fitBounds(
          L.latLngBounds(drawn.map((p) => [Number(p.lat), Number(p.lon)] as [number, number])),
          { padding: [40, 40] },
        );
      } else {
        /*
         * Nothing to centre on.
         *
         * The country is NOT hard-coded here: Venezuela is where this started,
         * not what it is for. So the first place of all opens on the whole world
         * and is found by zooming — which happens once, and after that every new
         * place opens framed on the ones that already exist.
         */
        instance.setView([0, 0], 2);
      }

      /*
       * Inside a dialog the box is still growing when the map is built.
       *
       * Leaflet measures its container once and lays the tiles out against that
       * measurement, so a map created mid-animation draws a strip in the corner
       * and leaves the rest grey. Measuring again on the next frame is the
       * standard cure, and it costs nothing where the box was already still.
       */
      requestAnimationFrame(() => instance.invalidateSize());

      if (pick) {
        instance.on("click", (event) => {
          const { lat, lng } = event.latlng;
          if (marker.current) marker.current.setLatLng([lat, lng]);
          else marker.current = L.marker([lat, lng], { icon: dot }).addTo(instance);
          // Six decimals is about ten centimetres. More is noise the map cannot
          // draw and the field cannot show.
          picker.current?.(lat.toFixed(6), lng.toFixed(6));
        });
      }
    })().catch(() => alive && setFailed(true));

    return () => {
      alive = false;
      map.current?.remove();
      map.current = null;
      marker.current = null;
    };
    // Deliberately mounted once: the map owns its own state from then on, and
    // re-running this on every render would throw away the pan the person did.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tiles]);

  if (!tiles) {
    return (
      <p className="text-sm text-muted-foreground">
        {pick ? t("ui.places.mapOffPick") : t("ui.places.mapOff", { n: points.length })}
      </p>
    );
  }

  return (
    <figure>
      <div
        ref={container}
        style={{ height }}
        className="w-full overflow-hidden rounded-lg border border-border bg-muted [&_.leaflet-container]:bg-muted"
        role="application"
        aria-label={pick ? t("ui.places.mapPickLabel") : t("ui.places.mapLabel", { n: points.length })}
      />
      {failed && (
        <p role="alert" className="mt-1.5 text-xs text-destructive">
          {t("ui.places.mapFailed")}
        </p>
      )}
      {/* Whoever draws the map is owed the credit, and the person looking is
          owed knowing whose server just saw where they shop. Two debts, both
          paid. */}
      <figcaption className="mt-1.5 text-xs text-muted-foreground">
        {attribution && <>{attribution} · </>}
        {t("ui.places.mapCredit", { host: hostOf(tiles) })}
      </figcaption>
    </figure>
  );
}

function hostOf(template: string): string {
  try {
    return new URL(template.replace(/\{[zxys]\}/g, "0")).host;
  } catch {
    return template;
  }
}
