// validate_data.mjs — Checks a site folder against CONTRACTS.md before anyone builds on it.
// Run from web/:  node test/validate_data.mjs mock     |     node test/validate_data.mjs jezero
// Exit code 1 if any ERROR. WARN = works, but a human should look at it.
import fs from 'node:fs';
import { buildCostGrid, dijkstraFrom, unitGrid } from '../src/planner.js';
import { lonLatToCell } from '../src/data.js';

const site = process.argv[2] || 'mock';
const dir = new URL(`../public/data/${site}/`, import.meta.url);
let errors = 0, warns = 0;
const ok = (m) => console.log('  OK    ' + m);
const warn = (m) => { warns++; console.log('  WARN  ' + m); };
const err = (m) => { errors++; console.log('  ERROR ' + m); };
const has = (f) => fs.existsSync(new URL(f, dir));
const json = (f) => { try { return JSON.parse(fs.readFileSync(new URL(f, dir))); } catch (e) { err(`${f}: ${e.message}`); return null; } };
const bin = (f, T) => { const b = fs.readFileSync(new URL(f, dir)); return new T(b.buffer, b.byteOffset, b.byteLength / T.BYTES_PER_ELEMENT); };
const close = (a, b, tol) => Math.abs(a - b) <= tol;

console.log(`\nValidating web/public/data/${site}/\n`);

// ---- meta.json
console.log('meta.json');
const meta = json('meta.json');
if (!meta) process.exit(1);
for (const k of ['site', 'bbox', 'width', 'height', 'cell_m', 'habitat']) if (meta[k] == null) err(`missing ${k}`);
const [lonMin, latMin, lonMax, latMax] = meta.bbox;
if (!(lonMin < lonMax && latMin < latMax)) err(`bbox must be [lonMin, latMin, lonMax, latMax], got ${meta.bbox}`);
if (lonMin < 0 || lonMax > 360) err('longitude must be 0–360 E (Jezero ≈ 77.4)');
const R = 3396190, latC = ((latMin + latMax) / 2) * Math.PI / 180;
const hM = (latMax - latMin) * Math.PI / 180 * R, wM = (lonMax - lonMin) * Math.PI / 180 * R * Math.cos(latC);
const cellH = hM / meta.height, cellW = wM / meta.width;
if (close(cellH, meta.cell_m, meta.cell_m * 0.05) && close(cellW, meta.cell_m, meta.cell_m * 0.05))
  ok(`bbox ${(wM / 1000).toFixed(2)} × ${(hM / 1000).toFixed(2)} km matches cell_m=${meta.cell_m}`);
else warn(`bbox implies cells of ${cellW.toFixed(2)} × ${cellH.toFixed(2)} m but cell_m=${meta.cell_m}`);
const [hx, hy] = meta.habitat;
if (hx < lonMin || hx > lonMax || hy < latMin || hy > latMax) err('habitat is outside bbox');

// ---- rasters
console.log('rasters');
const N = meta.width * meta.height;
const L = {};
for (const [f, T, k] of [['elevation.f32', Float32Array, 'elevation'], ['slope.f32', Float32Array, 'slope'],
  ['roughness.f32', Float32Array, 'roughness'], ['hazard.u8', Uint8Array, 'hazard'], ['viewshed.u8', Uint8Array, 'viewshed']]) {
  if (!has(f)) { (k === 'viewshed' ? warn : err)(`${f} missing${k === 'viewshed' ? ' (planner ignores comms)' : ''}`); continue; }
  const a = bin(f, T);
  if (a.length !== N) { err(`${f}: ${a.length} values, expected ${N}`); continue; }
  L[k] = a;
  if (T === Float32Array) {
    let bad = 0, mn = Infinity, mx = -Infinity;
    for (const v of a) { if (!Number.isFinite(v)) bad++; else { if (v < mn) mn = v; if (v > mx) mx = v; } }
    (bad ? warn : ok)(`${f}: range ${mn.toFixed(2)} … ${mx.toFixed(2)}${bad ? `, ${bad} NaN/Inf (planner treats as impassable)` : ''}`);
    if (k === 'elevation' && (mn < -9000 || mx > 22000)) err('elevation outside Mars range — wrong units or nodata (-3.4e38)?');
    if (k === 'slope' && mx > 90) err('slope > 90: is it in percent or radians instead of degrees?');
  } else {
    const counts = {}; for (const v of a) counts[v] = (counts[v] || 0) + 1;
    const keys = Object.keys(counts).map(Number);
    const allowed = k === 'hazard' ? [0, 1, 2] : [0, 1];
    if (keys.some((v) => !allowed.includes(v))) err(`${f}: values ${keys} (allowed ${allowed})`);
    else ok(`${f}: ` + keys.map((v) => `${v}=${(100 * counts[v] / N).toFixed(1)}%`).join(' '));
  }
}

// ---- suit.json
console.log('suit.json');
const suit = json('suit.json');
if (suit) {
  for (const k of ['o2_hours', 'reserve_pct', 'battery_Wh', 'base_power_W', 'walkback_m', 'max_slope_deg']) {
    const p = suit[k];
    if (!p || typeof p !== 'object') { err(`${k} missing or not {value, source, assumption}`); continue; }
    if (typeof p.value !== 'number') err(`${k}.value must be a number`);
    if (!p.source) warn(`${k}: no source`);
    if (typeof p.assumption !== 'boolean') warn(`${k}: assumption should be true/false`);
  }
  const o2 = suit.o2_hours?.value * 60, usable = o2 * (1 - suit.reserve_pct?.value / 100);
  ok(`O2 budget ${o2} min, reserve ${(o2 - usable).toFixed(0)} min, usable ${usable.toFixed(0)} min`);
  const wb = suit.walkback_m?.value, wbMin = wb / 0.9835 / 60;
  ok(`walkback ${wb} m = ${wbMin.toFixed(1)} min at 2.2 mph`);
  const reserve = o2 - usable;
  (wbMin * 1.5 <= reserve ? ok : warn)(`reserve ${reserve.toFixed(0)} min vs full walkback with suit failure ×1.5 on FLAT ground at max speed: ${(wbMin * 1.5).toFixed(0)} min (real terrain costs more)`);
  const battH = suit.battery_Wh?.value / suit.base_power_W?.value;
  (battH >= suit.o2_hours?.value ? ok : warn)(`battery ${battH.toFixed(1)} h vs O2 ${suit.o2_hours?.value} h → limit is ${battH >= suit.o2_hours?.value ? 'O2' : 'BATTERY'}`);
}

// ---- other JSON
console.log('other files');
const params = has('params.json') ? json('params.json') : (err('params.json missing'), null);
const alerts = has('alerts.json') ? json('alerts.json') : (warn('alerts.json missing'), null);
if (alerts) for (const a of alerts) {
  if (!['SPE', 'dust', 'suit'].includes(a.type)) err(`alert ${a.id}: type ${a.type}`);
  if (!['return', 'shelter'].includes(a.action)) err(`alert ${a.id}: action ${a.action}`);
  if (!a.effect) err(`alert ${a.id}: no effect`);
}
if (alerts) ok(`alerts.json: ${alerts.map((a) => `${a.type}→${a.action}`).join(', ')}`);
const targets = has('targets.geojson') ? json('targets.geojson') : (err('targets.geojson missing'), null);
for (const f of ['hillshade.png', 'ortho.png', 'slope.png', 'photos.json', 'rover_traverse.geojson', 'env.json'])
  if (!has(f)) warn(`${f} missing (needed by the app, not by the planner)`);

// ---- reachability + walkback from habitat to every target
if (targets && L.slope && L.hazard && params) {
  console.log('targets (with the current cost.js + suit limits)');
  const grid = buildCostGrid(L, meta, params, {}, undefined, suit);
  const home = lonLatToCell(meta, ...meta.habitat).i;
  if (!(grid.cost[home] < Infinity)) err('habitat cell is impassable (forbidden/too steep) — move it');
  const dist = dijkstraFrom(unitGrid(grid), home);
  const wb = suit?.walkback_m?.value ?? Infinity;
  const kinds = new Set();
  for (const f of targets.features) {
    const p = f.properties || {}; kinds.add(p.kind);
    const [lo, la] = f.geometry.coordinates;
    if (lo < lonMin || lo > lonMax || la < latMin || la > latMax) { err(`${p.id} "${p.name}" outside bbox`); continue; }
    const c = lonLatToCell(meta, lo, la).i, d = dist[c];
    if (!(grid.cost[c] < Infinity)) warn(`${p.id} "${p.name}" sits on an impassable cell (planner will snap ≤10 cells)`);
    if (d === Infinity) err(`${p.id} "${p.name}" UNREACHABLE from habitat`);
    else (d <= wb ? ok : warn)(`${p.id} "${p.name}" (${p.kind}): ${Math.round(d)} m walking from habitat${d > wb ? ` > walkback ${wb} m` : ''}`);
  }
  for (const k of ['habitat', 'depot', 'science', 'shelter']) if (!kinds.has(k)) warn(`no target of kind "${k}"`);
  const habs = targets.features.filter((f) => f.properties?.kind === 'habitat');
  if (habs.length !== 1) warn(`${habs.length} habitat targets (expected 1)`);
  else {
    const [a, b] = habs[0].geometry.coordinates, d = Math.hypot((a - hx) * 59270 * Math.cos(latC), (b - hy) * 59270);
    (d < 2 * meta.cell_m ? ok : err)(`meta.habitat vs habitat target: ${d.toFixed(1)} m apart`);
  }
  const rad = targets.features.filter((f) => f.properties?.kind === 'shelter' && f.properties.radiation_shelter === true);
  if (!rad.length) warn('no shelter with radiation_shelter: true -> SPE alerts will always return to the habitat');
  const noTask = targets.features.filter((f) => ['depot', 'science'].includes(f.properties?.kind) && f.properties.task_min == null && params.task_min?.[f.properties.kind] == null);
  if (noTask.length) warn(`${noTask.length} depot/science targets have no task time (properties.task_min or params.task_min[kind]) -> EVA duration underestimated`);
  if (has('photos.json')) {
    const photos = json('photos.json') || [], ids = new Set(photos.map((p) => p.id));
    const out = photos.filter((p) => p.lon < lonMin || p.lon > lonMax || p.lat < latMin || p.lat > latMax);
    (out.length ? warn : ok)(`photos.json: ${photos.length} photos${out.length ? `, ${out.length} outside bbox` : ''}`);
    const linked = targets.features.filter((f) => f.properties?.photo_id);
    const broken = linked.filter((f) => !ids.has(f.properties.photo_id));
    if (broken.length) err(`photo_id not found in photos.json: ${broken.map((f) => f.properties.photo_id)}`);
    if (!linked.length && photos.length) warn('no target has photo_id set -> tablet can\'t show POV photos per waypoint');
  }
}

console.log(`\n${errors} error(s), ${warns} warning(s)\n`);
process.exit(errors ? 1 : 0);
