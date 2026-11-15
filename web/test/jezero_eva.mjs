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
// Same as data.js loadSite: stations.geojson (Gabriel's O2 caches) is merged into the targets
const stations = has('stations.geojson') ? json(dir, 'stations.geojson').features.map((f) => ({ ...f, properties: { kind: 'shelter', ...f.properties, station: true } })) : [];
const tg = json(dir, 'targets.geojson');
let fails = 0;
const expect = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${extra}`); if (!ok) fails++; };
const S = {
  meta, targets: { ...tg, features: [...tg.features, ...stations] }, suit: json(com, 'suit.json'), params: json(com, 'params.json'), alerts: json(com, 'alerts.json'),
  layers: { elevation: bin('elevation.f32', Float32Array), slope: bin('slope.f32', Float32Array), roughness: bin('roughness.f32', Float32Array),
    hazard: bin('hazard.u8', Uint8Array), viewshed: has('viewshed.u8') ? bin('viewshed.u8', Uint8Array) : null },
};
const F = S.targets.features, by = (k) => F.filter((f) => f.properties.kind === k && !f.properties.station);
const hab = by('habitat')[0].geometry.coordinates;
const depots = by('depot').map((f) => f.geometry.coordinates);
const sci = by('science').map((f) => f.geometry.coordinates);

let t = performance.now();
const eva = plan(S, { start: hab, stops: [...depots, ...sci], goal: hab });
const ms = Math.round(performance.now() - t);
if (eva.error) { console.log('ERROR', eva); process.exit(1); }
console.log(`EVA-1 on real Jezero terrain (${depots.length} depot tubes + ${sci.length} science target), first plan ${ms} ms (includes cost grid + 2 Dijkstras)`);
console.log(eva.stats);
expect('EVA-1 is safe and GO from 09:00', eva.stats.safe && plan(S, { start: hab, stops: [...depots, ...sci], goal: hab, start_lmst: 9 }).stats.go === 'GO');
console.log('legs:', eva.segments.map((s) => `${s.stats.distance_m}m/${s.stats.task_min}min`).join('  '));

const coords = eva.path.geometry.coordinates, mid = coords[Math.floor(coords.length * 0.6)];
const used = (eva.stats.o2_used_min * 0.6);
for (const a of S.alerts) {
  t = performance.now();
  const r = replan(S, { current: mid, alert: a, o2_used_min: used });
  console.log(`\nALERT ${a.type} at 60% of EVA -> ${r.error ?? r.replan.destination} in ${Math.round(performance.now() - t)} ms:`,
    r.error ? '' : `${r.stats.distance_m} m, ${r.stats.duration_min} min, O2 ${r.stats.o2_used_pct}%, dose ${r.stats.dose_mSv} mSv, safe=${r.stats.safe}`);
}

// ===== Tier 1 scenarios on real terrain (for the video / project page) =====
import { adapt } from '../src/planner.js';
console.log('\n--- Day/night: EVA-1 starting 09:00 LMST');
const d1 = plan(S, { start: hab, stops: [...depots, ...sci], goal: hab, start_lmst: 9 });
console.log(`  ${d1.stats.start_lmst_hhmm} -> ${d1.stats.end_lmst_hhmm} (sunset ${d1.stats.sunset_lmst_hhmm}): ${d1.stats.go}, ${d1.stats.daylight_margin_min} min of daylight left`);
const d2 = plan(S, { start: hab, stops: [...depots, ...sci], goal: hab, start_lmst: 15.5 });
console.log(`  same EVA starting 15:30 -> ${d2.stats.end_lmst_hhmm}: ${d2.stats.go}`);

console.log('\n--- Live map update: astronaut reports a boulder field on the way to Wildcat Ridge');
const legW = eva.segments.at(-2);   // depot -> Wildcat
const path = eva.path.geometry.coordinates;
const k = path.findIndex((p) => Math.hypot(p[0] - sci[0][0], p[1] - sci[0][1]) < 0.0012);
const obP = path[Math.max(0, k - 20)];
const ob = { id: 'ob-1', lon: obP[0], lat: obP[1], radius_m: 45, kind: 'blocked', source: 'astronaut', note: 'boulder field' };
t = performance.now();
const a1 = adapt(S, { current: depots.at(-1), stops: sci, state: { obstacles: [ob] }, o2_used_min: 150, now_lmst: 11.5 });
console.log(`  adapt in ${Math.round(performance.now() - t)} ms -> ${a1.adapt.decision}, ${a1.stats.distance_m} m, safe=${a1.stats.safe}, home ${a1.stats.end_lmst_hhmm}`);

console.log('\n--- Overtime: depot tubes took 40 min longer than planned');
t = performance.now();
const a2 = adapt(S, { current: depots.at(-1), stops: sci, o2_used_min: 150 + 40, now_lmst: 12.2 });
console.log(`  adapt in ${Math.round(performance.now() - t)} ms -> ${a2.adapt.decision}${a2.adapt.dropped.length ? ' dropped ' + a2.adapt.dropped.map((d) => d.name + ' (' + d.reason + ')').join(', ') : ''}; O2 margin ${a2.stats.o2_margin_min} min`);
const a3 = adapt(S, { current: depots.at(-1), stops: sci, o2_used_min: 330, now_lmst: 12.2 });
console.log(`  with 330 O2-min already used -> ${a3.adapt.decision}${a3.adapt.dropped.length ? ': dropped ' + a3.adapt.dropped.map((d) => d.name.split(' - ')[0] + ' (' + d.reason + ')').join(', ') : ''}`);

console.log('\n--- Shelters: astronaut at Wildcat Ridge when each alert arrives (three different behaviours)');
for (const a of S.alerts) {
  const r = replan(S, { current: sci[0], alert: a, o2_used_min: 150 });
  console.log(`  ${a.type.padEnd(4)} (${a.action}) -> ${r.replan.destination.split(' - ')[0]}  |  ` +
    r.replan.considered.map((c) => `${c.name.split(' - ')[0]}: ${c.minutes ?? '–'} min${c.chosen ? ' ✓' : ''}${!c.eligible ? ' ✗ ' + c.why : ''}`).join('  ·  '));
}

console.log(`\n--- Tier 2: Gabriel's real O2 caches (stations.geojson: ${stations.map((f) => f.properties.id).join(', ') || 'none'})`);
const spe = replan(S, { current: sci[0], alert: S.alerts.find((a) => a.action === 'shelter'), o2_used_min: 150 });
expect('SPE at Wildcat -> SEV rover (radiation shelter), not Hawksbill', spe.replan.destination_id === 'shelter-sev-rover-01', spe.replan.destination);
const directH = plan(S, { start: sci[0], goal: hab, start_task_min: 0 });
const leak = S.alerts.find((a) => a.action === 'resupply');
for (const extra of [-30, 0, 8]) {
  // used so that going home directly needs (usable - used) + extra: extra > 0 = can't make it home directly
  const usedHigh = 393.6 - directH.stats.o2_used_min * (leak.effect?.o2_x ?? 1) + extra;
  const r = replan(S, { current: sci[0], alert: leak, o2_used_min: usedHigh });
  console.log(`  O2 leak at Wildcat (${usedHigh.toFixed(0)} O2-min used): ` + (r.error || r.replan.considered.map((c) => `${c.name.split(' - ')[0]}: ${c.why}${c.chosen ? ' ✓' : ''}`).join(' · ')));
  if (extra > 0) expect('O2 leak, home out of reach -> rescued via a real cache, safe', !r.error && r.replan.via_cache && r.stats.o2_return_ok, r.error || `${r.replan.destination}, refilled ${r.stats.o2_refilled_min}, margin ${r.stats.o2_margin_min}`);
}

console.log(fails ? `\n${fails} demo fact(s) BROKEN` : '\nAll demo facts hold.');
process.exit(fails ? 1 : 0);
