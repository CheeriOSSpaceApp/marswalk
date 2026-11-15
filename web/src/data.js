// data.js — single loader for every contract file. Swap 'mock' -> 'jezero' and nothing else changes.
// Usage: const site = await loadSite('mock'); site.layers.slope[i]  (i = row * width + col)

// Folders under web/public/data/:
//   <site>/  = terrain + places of ONE site (mock, jezero): meta, rasters, PNGs, targets, photos, env, rover traverse
//   common/  = mission config shared by every site: suit.json (Marco), params.json (Ana), alerts.json (Marco + Ana)
// IMPORTANT (deploy, 12:05): inside the Web Worker, relative URLs resolve against the WORKER script
// (/marswalk/assets/...), not the page. So the page passes an absolute base (plannerClient -> init).
let ROOT = `${import.meta.env?.BASE_URL ?? '/'}data/`;
const BASE = (site) => `${ROOT}${site}/`;
const COMMONDIR = () => `${ROOT}common/`;

async function getJSON(url, fallback = null) {
  const r = await fetch(url);
  if (!r.ok) { console.warn('missing', url); return fallback; }
  return r.json();
}

async function getBin(url, Type) {
  const r = await fetch(url);
  if (!r.ok) { console.warn('missing', url); return null; }
  // Float32Array/Uint8Array use platform endianness; every browser we target is little-endian.
  return new Type(await r.arrayBuffer());
}

export async function loadSite(site = 'mock', baseUrl = null) {
  if (baseUrl) ROOT = new URL('data/', baseUrl).href;   // absolute, works from the worker
  const b = BASE(site);
  const meta = await getJSON(b + 'meta.json');
  const [elevation, slope, roughness, hazard, viewshed] = await Promise.all([
    getBin(b + 'elevation.f32', Float32Array),
    getBin(b + 'slope.f32', Float32Array),
    getBin(b + 'roughness.f32', Float32Array),
    getBin(b + 'hazard.u8', Uint8Array),
    getBin(b + 'viewshed.u8', Uint8Array),
  ]);
  const [targets, suit, params, alerts] = await Promise.all([
    getJSON(b + 'targets.geojson', { type: 'FeatureCollection', features: [] }),
    getJSON(COMMONDIR() + 'suit.json', {}),
    getJSON(COMMONDIR() + 'params.json', {}),
    getJSON(COMMONDIR() + 'alerts.json', []),
  ]);
  // Optional: stations placed by pipeline/calcstations.py (Gabriel). Merged into targets so the planner treats
  // caches / safe points like any shelter. Missing file = no stations (Vite dev may answer HTML -> caught).
  try {
    const r = await fetch(b + 'stations.geojson');
    if (r.ok && !(r.headers.get('content-type') || '').includes('text/html')) {
      const st = await r.json();
      for (const f of st.features || []) targets.features.push({ ...f, properties: { kind: 'shelter', ...f.properties, station: true } });
    }
  } catch { /* no stations */ }
  const n = meta.width * meta.height;
  for (const [k, v] of Object.entries({ elevation, slope, roughness, hazard, viewshed }))
    if (v && v.length !== n) console.error(`${k}: expected ${n} cells, got ${v.length}`);
  return { meta, layers: { elevation, slope, roughness, hazard, viewshed }, targets, suit, params, alerts };
}

// Grid <-> geo helpers (equirectangular, row 0 = north, col 0 = west)
export function lonLatToCell(meta, lon, lat) {
  const [lonMin, latMin, lonMax, latMax] = meta.bbox;
  const col = Math.floor((lon - lonMin) / (lonMax - lonMin) * meta.width);
  const row = Math.floor((latMax - lat) / (latMax - latMin) * meta.height);
  return { row, col, i: row * meta.width + col };
}

export function cellToLonLat(meta, i) {
  const [lonMin, latMin, lonMax, latMax] = meta.bbox;
  const row = Math.floor(i / meta.width), col = i % meta.width;
  return [lonMin + (col + 0.5) / meta.width * (lonMax - lonMin),
          latMax - (row + 0.5) / meta.height * (latMax - latMin)];
}
