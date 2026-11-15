// jezero_eva.mjs — EVA-1 on the REAL Jezero terrain: habitat -> 10 depot tubes -> Wildcat Ridge -> habitat,
// then each alert injected mid-EVA. Run from web/: node test/jezero_eva.mjs
// Output = the numbers for the project page / video (Dana) and the README (Eric).
import fs from 'node:fs';
import { plan, replan } from '../src/planner.js';

const dir = new URL('../public/data/jezero/', import.meta.url), com = new URL('../public/data/common/', import.meta.url);
const json = (u, f) => JSON.parse(fs.readFileSync(new URL(f, u)));
const bin = (f, T) => { const b = fs.readFileSync(new URL(f, dir)); return new T(b.buffer, b.byteOffset, b.byteLength / T.BYTES_PER_ELEMENT); };
const has = (f) => fs.existsSync(new URL(f, dir));
const meta = json(dir, 'meta.json');
const S = {
  meta, targets: json(dir, 'targets.geojson'), suit: json(com, 'suit.json'), params: json(com, 'params.json'), alerts: json(com, 'alerts.json'),
  layers: { elevation: bin('elevation.f32', Float32Array), slope: bin('slope.f32', Float32Array), roughness: bin('roughness.f32', Float32Array),
    hazard: bin('hazard.u8', Uint8Array), viewshed: has('viewshed.u8') ? bin('viewshed.u8', Uint8Array) : null },
};
const F = S.targets.features, by = (k) => F.filter((f) => f.properties.kind === k);
const hab = by('habitat')[0].geometry.coordinates;
const depots = by('depot').map((f) => f.geometry.coordinates);
const sci = by('science').map((f) => f.geometry.coordinates);

let t = performance.now();
const eva = plan(S, { start: hab, stops: [...depots, ...sci], goal: hab });
const ms = Math.round(performance.now() - t);
if (eva.error) { console.log('ERROR', eva); process.exit(1); }
console.log(`EVA-1 on real Jezero terrain (${depots.length} depot tubes + ${sci.length} science target), first plan ${ms} ms (includes cost grid + 2 Dijkstras)`);
console.log(eva.stats);
console.log('legs:', eva.segments.map((s) => `${s.stats.distance_m}m/${s.stats.task_min}min`).join('  '));

const coords = eva.path.geometry.coordinates, mid = coords[Math.floor(coords.length * 0.6)];
const used = (eva.stats.o2_used_min * 0.6);
for (const a of S.alerts) {
  t = performance.now();
  const r = replan(S, { current: mid, alert: a, o2_used_min: used });
  console.log(`\nALERT ${a.type} at 60% of EVA -> ${r.error ?? r.replan.destination} in ${Math.round(performance.now() - t)} ms:`,
    r.error ? '' : `${r.stats.distance_m} m, ${r.stats.duration_min} min, O2 ${r.stats.o2_used_pct}%, dose ${r.stats.dose_mSv} mSv, safe=${r.stats.safe}`);
}
