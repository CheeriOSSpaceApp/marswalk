// Site loader (same return shape as Eric's loadSite() in data.js, plus url(file), fellBack, missing).
//   suit.json / params.json / alerts.json : data/common/ first (contract), then <site>/, then mock/
//   everything else (terrain, images, targets, photos): data/<site>/. Falls back to mock/ ONLY if the site has no meta.json
//   (mock terrain is a different place, so mixing it with a real site's bbox would draw it in the wrong spot).
// Same return shape as Eric's loadSite() (src/data.js, untouched), plus `url(file)` and `fellBack` (files taken from mock).
const BASE = () => import.meta.env?.BASE_URL ?? '/';
const FALLBACK = 'mock';
const FILES = ['meta.json', 'elevation.f32', 'slope.f32', 'roughness.f32', 'hazard.u8', 'viewshed.u8', 'targets.geojson', 'suit.json',
               'params.json', 'alerts.json', 'env.json', 'photos.json', 'rover_traverse.geojson', 'hillshade.png', 'ortho.png', 'slope.png',
               'stations.geojson', 'presets.json'];
const urlIn = (dir, file) => `${BASE()}data/${dir}/${file}`;

// A file "exists" if the server answers OK and it is not an HTML page (Vite's dev server answers unknown paths with index.html)
async function exists(dir, file) {
  try {
    const r = await fetch(urlIn(dir, file), { method: 'HEAD' });
    return r.ok && !(r.headers.get('content-type') || '').includes('text/html');
  } catch { return false; }
}

export async function loadSite(site = 'jezero') {
  const COMMON = ['suit.json', 'params.json', 'alerts.json'];
  const hasMeta = site === FALLBACK || await exists(site, 'meta.json');
  const dirs = site === FALLBACK ? [FALLBACK] : hasMeta ? [site] : [site, FALLBACK];
  const where = {};                                   // file -> directory it was found in
  await Promise.all(FILES.map(async f => {
    const look = COMMON.includes(f) ? ['common', site, FALLBACK] : dirs;
    for (const d of look) if (await exists(d, f)) { where[f] = d; return; }
  }));
  const url = f => (where[f] ? urlIn(where[f], f) : null);
  const fellBack = site === FALLBACK ? [] : FILES.filter(f => where[f] === FALLBACK);
  const missing = FILES.filter(f => !where[f]);

  const json = async (f, fb) => { const u = url(f); if (!u) return fb; const r = await fetch(u); return r.ok ? r.json() : fb; };
  const bin = async (f, T) => { const u = url(f); if (!u) return null; const r = await fetch(u); return r.ok ? new T(await r.arrayBuffer()) : null; };

  const meta = await json('meta.json');
  const [elevation, slope, roughness, hazard, viewshed] = await Promise.all([
    bin('elevation.f32', Float32Array), bin('slope.f32', Float32Array), bin('roughness.f32', Float32Array),
    bin('hazard.u8', Uint8Array), bin('viewshed.u8', Uint8Array)]);
  const [targets, suit, params, alerts] = await Promise.all([
    json('targets.geojson', { type: 'FeatureCollection', features: [] }), json('suit.json', {}), json('params.json', {}), json('alerts.json', [])]);

  // Stations (Gabriel, Tier 2): optional; merged into targets exactly like data.js loadSite() does for the planner
  const st = await json('stations.geojson', null);
  for (const f of st?.features || []) targets.features.push({ ...f, properties: { kind: 'shelter', ...f.properties, station: true } });
  if (meta) {
    const n = meta.width * meta.height;
    for (const [k, v] of Object.entries({ elevation, slope, roughness, hazard, viewshed }))
      if (v && v.length !== n) console.error(`${k}: expected ${n} cells, got ${v.length}`);
  }
  if (fellBack.length) console.warn(`[site] "${site}" is missing ${fellBack.length} file(s); using ${FALLBACK}/ for: ${fellBack.join(', ')}`);
  if (missing.filter(f => !['stations.geojson', 'presets.json'].includes(f)).length) console.warn(`[site] not found in ${dirs.join('/ or ')}/: ${missing.join(', ')}`);
  return { name: site, meta, layers: { elevation, slope, roughness, hazard, viewshed }, targets, suit, params, alerts, url, fellBack, missing };
}
