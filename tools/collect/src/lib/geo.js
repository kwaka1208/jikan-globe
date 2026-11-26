// 国の判定（アプリと同じ countries.json と d3-geo を使う）
import fs from 'node:fs';
import path from 'node:path';
import { geoContains, geoBounds, geoCentroid, geoDistance, geoArea } from 'd3-geo';
import { feature } from 'topojson-client';
import { ROOT_DIR } from './config.js';

const rings = (g) => (g.type === 'Polygon' ? g.coordinates : g.coordinates.flat());

export function loadCountries() {
  const app = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'app/countries.json'), 'utf8'));
  // world-atlas の id（ISO 3166-1 数字コード）を国名で引けるようにする
  const topo = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'node_modules/world-atlas/countries-110m.json'), 'utf8'));
  const isoByName = new Map(feature(topo, topo.objects.countries).features.map((f) => [f.properties.name, f.id]));

  const list = app.map((c) => {
    const f = { type: 'Feature', geometry: c.g, properties: {} };
    // 代表点：一番大きな陸地の重心（フランスの海外領土などで重心がずれないように）
    let main = f;
    if (c.g.type === 'MultiPolygon') {
      const polys = c.g.coordinates.map((p) => ({ type: 'Feature', geometry: { type: 'Polygon', coordinates: p } }));
      main = polys.reduce((a, b) => (geoArea(b) > geoArea(a) ? b : a));
    }
    const [lng, lat] = geoCentroid(main);
    return { name: c.n, iso: isoByName.get(c.n) ?? null, feature: f, bounds: geoBounds(f), center: { lat, lng } };
  });
  // 判定用の細かい国境（50m）。アプリの国名（110m）と同じ名前のものだけ使う。
  // 110m にない沖縄本島などの島を拾うため。香港など 50m にしかない地域は使わない
  const appNames = new Set(app.map((c) => c.n));
  const fineTopo = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'node_modules/world-atlas/countries-50m.json'), 'utf8'));
  const fine = feature(fineTopo, fineTopo.objects.countries).features
    .filter((f) => appNames.has(f.properties.name))
    .map((f) => ({ name: f.properties.name, feature: f, bounds: geoBounds(f) }));
  const byName = new Map(list.map((c) => [c.name, c]));

  const byIso = new Map(list.filter((c) => c.iso).map((c) => [String(Number(c.iso)), c]));

  const inBounds = ([[w, s], [e, n]], lng, lat) =>
    lat >= s - 0.5 && lat <= n + 0.5 && (w <= e ? lng >= w - 0.5 && lng <= e + 0.5 : lng >= w - 0.5 || lng <= e + 0.5);

  return {
    list,
    // 点が入っている国
    containing(lat, lng) {
      for (const c of list) {
        if (inBounds(c.bounds, lng, lat) && geoContains(c.feature, [lng, lat])) return c;
      }
      return null;
    },
    // 110m で見つからない小さな島などを、50m の国境で探す
    containingFine(lat, lng) {
      for (const c of fine) {
        if (inBounds(c.bounds, lng, lat) && geoContains(c.feature, [lng, lat])) return byName.get(c.name);
      }
      return null;
    },
    // ISO 数字コード（"392" や "036"）から
    byIso(iso) {
      return iso == null ? null : byIso.get(String(Number(iso))) || null;
    },
    // 国境線が一番近い国（110m の国境データにない小さな島など）
    nearest(lat, lng) {
      let best = null, bd = Infinity;
      for (const c of list) {
        for (const ring of rings(c.feature.geometry)) {
          for (const pt of ring) {
            const d = geoDistance([lng, lat], pt);
            if (d < bd) { bd = d; best = c; }
          }
        }
      }
      return best;
    },
  };
}
