import { useEffect, useRef } from "react";
import L from "leaflet";
import type { Centre, PackageSummary } from "../lib/api";

/**
 * Centre map on unmodified OpenStreetMap tiles.
 *
 * The tiles are deliberately left as published — no inversion, no greyscale.
 * A recoloured map is harder to read, breaks the familiarity that makes OSM
 * useful in the first place, and quietly misrepresents someone else's data. The
 * map is reference material during an incident; it has to look like the map
 * everyone already knows.
 *
 * Accessibility, since an operations tool cannot assume a particular operator:
 *
 *  - Markers never rely on colour alone. Attention is carried by fill, size and
 *    a white ring as well as hue, so the map reads without colour discrimination.
 *  - Every marker is keyboard reachable and operable with Enter or Space.
 *  - Every marker carries an aria-label naming the centre and its state, so the
 *    map is traversable by screen reader rather than being an opaque image.
 *  - Nothing here is the *only* route to the information. The dashboard tables
 *    carry the same facts in text, which is the real accessibility guarantee —
 *    a map is a visual convenience, never the system of record.
 */

/** Worst-package threshold at which a centre is worth looking at. */
const ATTENTION_AT = 40;

export default function CentreMap({
  centres,
  packages,
  onSelect,
}: {
  centres: Centre[];
  packages: PackageSummary[];
  onSelect?: (packageId: string) => void;
}) {
  const elRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layerRef = useRef<L.LayerGroup | null>(null);

  useEffect(() => {
    if (!elRef.current || mapRef.current) return;
    const map = L.map(elRef.current, {
      zoomControl: true,
      attributionControl: true,
      // Arrow-key panning once the map has focus.
      keyboard: true,
    });
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "© OpenStreetMap contributors",
    }).addTo(map);
    map.setView([26.91, 75.79], 11);
    mapRef.current = map;
    layerRef.current = L.layerGroup().addTo(map);
    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    const layer = layerRef.current;
    if (!map || !layer) return;
    layer.clearLayers();
    if (centres.length === 0) return;

    for (const centre of centres) {
      const own = packages.filter((p) => p.centreId === centre.id);
      const worst = own.reduce((max, p) => Math.max(max, p.riskScore), 0);
      const compromised = own.some((p) => p.observedState === "compromised");
      const needsAttention = compromised || worst >= ATTENTION_AT;

      const fill =
        compromised || worst >= 70 ? "#ff5c5c" :
        worst >= 40 ? "#ff9f43" :
        worst >= 15 ? "#ffd93d" :
        "#3ddc97";

      // The geofence is the radius the access engine actually enforces, so it
      // is drawn to scale rather than as a fixed-pixel halo.
      L.circle([centre.lat, centre.lon], {
        radius: centre.geofenceM,
        color: fill,
        weight: 1,
        opacity: 0.5,
        fillOpacity: 0.08,
        interactive: false,
      }).addTo(layer);

      const marker = L.circleMarker([centre.lat, centre.lon], {
        radius: 8,
        color: fill,
        weight: 2,
        fillColor: fill,
        fillOpacity: 0.55,
      }).addTo(layer);

      const stateSummary = own.length
        ? own
            .map(
              (p) =>
                `${p.observedState.replace(/_/g, " ")}, risk ${p.riskScore}` +
                (p.anomalyCount ? `, ${p.anomalyCount} finding(s)` : ""),
            )
            .join("; ")
        : "no packages";

      const label =
        `${centre.code}. ${needsAttention ? "Needs attention." : "No findings."} ` +
        `${own.length} package(s): ${stateSummary}. ` +
        `Capacity ${centre.capacity}, ${centre.printers} printers` +
        `${centre.hasGenset ? ", generator present" : ", no generator"}.`;

      const rows = own
        .map(
          (p) =>
            `<div style="margin-top:4px">${p.observedState.replace(/_/g, " ")} · risk ${p.riskScore}` +
            `${p.anomalyCount ? ` · ${p.anomalyCount} finding(s)` : ""}</div>`,
        )
        .join("");

      marker.bindPopup(
        `<strong>${centre.code}</strong><br/>` +
          `capacity ${centre.capacity} · ${centre.printers} printers` +
          `${centre.hasGenset ? " · genset" : ""}` +
          `<div style="margin-top:6px;opacity:.8">${own.length} package(s)</div>${rows}`,
      );

      // Hover affordance for sighted mouse users; the aria-label below carries
      // the same content for everyone else.
      marker.bindTooltip(`${centre.code}${needsAttention ? " — needs attention" : ""}`, {
        direction: "top",
        offset: [0, -8],
      });

      // Leaflet renders a circleMarker as a bare SVG <path>, which is neither
      // focusable nor announced. Promote it to a real control.
      const el = marker.getElement();
      if (el) {
        el.setAttribute("tabindex", "0");
        el.setAttribute("role", "button");
        el.setAttribute("aria-label", label);
        el.addEventListener("keydown", (ev) => {
          const key = (ev as KeyboardEvent).key;
          if (key === "Enter" || key === " ") {
            ev.preventDefault();
            marker.openPopup();
          }
        });
      }

      if (onSelect && own[0]) {
        marker.on("dblclick", () => onSelect(own[0]!.id));
      }
    }

    map.fitBounds(
      L.latLngBounds(centres.map((c) => [c.lat, c.lon] as [number, number])),
      { padding: [40, 40], maxZoom: 12 },
    );
  }, [centres, packages, onSelect]);

  const attentionCount = centres.filter((c) => {
    const own = packages.filter((p) => p.centreId === c.id);
    return (
      own.some((p) => p.observedState === "compromised") ||
      own.reduce((m, p) => Math.max(m, p.riskScore), 0) >= ATTENTION_AT
    );
  }).length;

  return (
    <>
      {/*
        `region` rather than `application`. The application role suppresses
        browse mode, which can trap a screen-reader user inside the map with no
        obvious way out. The genuinely accessible path here is Tab to a marker
        and press Enter, plus the packages table carrying the same facts — so
        there is no reason to seize the arrow keys to achieve it.
      */}
      <div
        ref={elRef}
        className="map"
        role="region"
        aria-label={
          `Map of ${centres.length} examination centres. ` +
          `${attentionCount} need attention. ` +
          "Tab to a marker and press Enter for its details. " +
          "The same information is listed in the packages table."
        }
      />
    </>
  );
}
