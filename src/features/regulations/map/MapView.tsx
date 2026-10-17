"use client";

// Ported from old_repo/src/components/map/MapView.tsx (lines 19-280)
// The Leaflet map: OpenStreetMap tiles with the attribution their policy requires (the old map switched it off), count-sized markers coloured by the most urgent band, fly-to on a selection, the
// key. `leaflet` loads only here, only on the /map route, and only in the browser. Markers keep their count as their text, which is their accessible name; zoom controls are 44 px (map.module.css).
import "leaflet/dist/leaflet.css";
import { useEffect, useRef, useState } from "react";
import type { LayerGroup, Map as LeafletMap } from "leaflet";

import { BAND_ORDER, type UrgencyBandKey } from "@/core/lists";

import { markerSize } from "./marker";
import styles from "./map.module.css";

export interface MapMarker {
  key: string;
  label: string;
  count: number;
  tone: UrgencyBandKey;
  lat: number;
  lng: number;
}
const HEX = Object.fromEntries(BAND_ORDER.map((b) => [b.key, b.hex])) as Record<UrgencyBandKey, string>;

export function MapView({ markers, selectedKey, selectNonce, onMarkerClick }: { markers: MapMarker[]; selectedKey: string | null; selectNonce: number; onMarkerClick: (key: string) => void }) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<LeafletMap | null>(null);
  const layer = useRef<LayerGroup | null>(null);
  const lib = useRef<typeof import("leaflet") | null>(null);
  const click = useRef(onMarkerClick);
  const [ready, setReady] = useState(false);
  useEffect(() => void (click.current = onMarkerClick), [onMarkerClick]);

  useEffect(() => {
    let cancelled = false;
    void import("leaflet").then(({ default: L }) => {
      if (cancelled || !el.current || map.current) return;
      const m = L.map(el.current, { center: [20, 0], zoom: 2, minZoom: 2, maxZoom: 8, worldCopyJump: true, zoomControl: false, scrollWheelZoom: true });
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' }).addTo(m);
      L.control.zoom({ position: "topright" }).addTo(m);
      lib.current = L;
      map.current = m;
      layer.current = L.layerGroup().addTo(m);
      setReady(true);
    });
    return () => {
      cancelled = true;
      map.current?.remove();
      map.current = null;
      layer.current = null;
      setReady(false);
    };
  }, []);

  useEffect(() => {
    const L = lib.current;
    if (!ready || !L || !layer.current) return;
    layer.current.clearLayers();
    for (const mk of markers) {
      const size = markerSize(mk.count);
      const hit = Math.max(size, 44);
      const icon = L.divIcon({
        className: styles.marker ?? "",
        html: `<div class="${styles.hit}" style="width:${hit}px;height:${hit}px"><div class="${styles.dot}" style="width:${size}px;height:${size}px;background:${HEX[mk.tone]};font-size:${size >= 48 ? 16 : 12}px">${mk.count}</div></div>`,
        iconSize: [hit, hit],
        iconAnchor: [hit / 2, hit / 2],
      });
      L.marker([mk.lat, mk.lng], { icon, zIndexOffset: 100, title: `${mk.label}: ${mk.count}` }).on("click", () => click.current(mk.key)).addTo(layer.current);
    }
  }, [markers, ready]);

  useEffect(() => {
    const at = selectedKey ? markers.find((m) => m.key === selectedKey) : null;
    if (at && ready && map.current) map.current.flyTo([at.lat, at.lng], 5, { duration: 0.8 });
  }, [selectedKey, selectNonce, markers, ready]);

  return (
    <div className={styles.frame}>
      <div ref={el} className={styles.map} />
      <div data-map-legend className={styles.legend}>
        <div className={styles.legendTitle}>Key</div>
        {BAND_ORDER.map((b) => (
          <div key={b.key} className={styles.legendRow}>
            <span className={styles.swatch} style={{ background: b.hex }} />
            <span>{b.label} present</span>
          </div>
        ))}
      </div>
    </div>
  );
}
