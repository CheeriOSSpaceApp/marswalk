// Run from web/:  node test/planner.test.mjs [site]
// Loads the contract files from disk (no browser) and checks the planner.
import fs from 'node:fs';
import { plan, replan, adapt, astar, buildCostGrid, dijkstraFrom, getCostToHome, getGrid, usableO2min } from '../src/planner.js';

const site = process.argv[2] || 'mock';
const dir = new URL(`../public/data/${site}/`, import.meta.url);
const json = (f) => JSON.parse(fs.readFileSync(new URL(f, dir)));
const common = (f) => JSON.parse(fs.readFileSync(new URL(`../public/data/common/${f}`, import.meta.url)));
const bin = (f, T) => { const b = fs.readFileSync(new URL(f, dir)); return new T(b.buffer, b.byteOffset, b.byteLength / T.BYTES_PER_ELEMENT); };

const meta = json('meta.json');
const S = {
  meta, targets: json('targets.geojson'), alerts: common('alerts.json'), suit: common('suit.json'), params: common('params.json'),
  layers: {
    elevation: bin('elevation.f32', Float32Array), slope: bin('slope.f32', Float32Array),
    roughness: bin('roughness.f32', Float32Array), hazard: bin('hazard.u8', Uint8Array),
    viewshed: bin('viewshed.u8', Uint8Array),
  },
};
const T = Object.fromEntries(json('targets.geojson').features.map((f) => [f.properties.id, f.geometry.coordinates]));
let fails = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${extra}`); if (!ok) fails++; };

// 1. Habitat -> depot
let r = plan(S, { start: T.habitat, goal: T.depot });
check('habitat->depot found', !r.error, JSON.stringify(r.timing_ms));
console.log('      stats', r.stats);
check('fast enough (<1000 ms total)', r.timing_ms.cost_grid + r.timing_ms.astar < 1000);

// 2. Never steps on a forbidden cell
const W = meta.width, [lonMin, latMin, lonMax, latMax] = meta.bbox;
const cells = r.path.geometry.coordinates.map(([lo, la]) =>
  Math.floor((latMax - la) / (latMax - latMin) * meta.height) * W + Math.floor((lo - lonMin) / (lonMax - lonMin) * W));
check('no forbidden cells on path', cells.every((i) => S.layers.hazard[i] !== 2));

// 3. Path is at least the straight-line distance (sanity)
check('path >= straight line', r.stats.distance_m >= Math.hypot(
  (T.depot[0] - T.habitat[0]) * 59270 * Math.cos(meta.bbox[1] * Math.PI / 180),
  (T.depot[1] - T.habitat[1]) * 59270) * 0.98);

// 4. Full EVA with stops
r = plan(S, { start: T.habitat, stops: [T.depot, T.sci1, T.sci2], goal: T.habitat });
check('EVA loop with 3 stops', !r.error, JSON.stringify(r.timing_ms));
console.log('      stats', r.stats);

// 5. Optimality vs Dijkstra (h = 0) on one leg: A* must give the same cost
const grid = buildCostGrid(S.layers, meta, S.params, {});
const a = astar(grid, 850 * W + 150, 200 * W + 600);
const d = astar({ ...grid, minCost: 0 }, 850 * W + 150, 200 * W + 600); // minCost 0 -> h = 0 -> Dijkstra
const costOf = (p) => p.slice(1).reduce((s, i, k) => { const q = p[k]; const diag = (q % W) !== (i % W) && Math.floor(q / W) !== Math.floor(i / W); return s + 0.5 * (grid.cost[q] + grid.cost[i]) * (diag ? Math.SQRT2 : 1) * meta.cell_m; }, 0);
check('A* cost == Dijkstra cost (optimal)', Math.abs(costOf(a) - costOf(d)) < 1e-3, `${costOf(a).toFixed(3)} vs ${costOf(d).toFixed(3)}`);

// 6. Alert state changes the result (suit failure: O2 x1.5)
r = plan(S, { start: T.habitat, goal: T.depot, state: { o2_x: 1.5 } });
check('suit alert raises O2 use', !r.error, `o2 ${r.stats.o2_used_pct}%`);

// 7. costToHome: 0 at habitat, symmetric with A* cost, timing
let t = performance.now();
const home = 850 * W + 150, depot = 200 * W + 600;
const o2grid = { ...grid, cost: grid.o2, minCost: grid.o2.reduce((m, v) => (v < m ? v : m), Infinity) };
const cth = dijkstraFrom(o2grid, home);
const tD = Math.round(performance.now() - t);
check('costToHome[habitat] == 0', cth[home] === 0, `(dijkstra full grid ${tD} ms)`);
const aO2 = astar(o2grid, home, depot);
const o2Of = (p) => p.slice(1).reduce((s, i, k) => { const q = p[k]; const diag = (q % W) !== (i % W) && Math.floor(q / W) !== Math.floor(i / W); return s + 0.5 * (grid.o2[q] + grid.o2[i]) * (diag ? Math.SQRT2 : 1) * meta.cell_m; }, 0);
check('costToHome[depot] == optimal O2 cost habitat->depot', Math.abs(cth[depot] - o2Of(aO2)) < 1e-2, `${cth[depot].toFixed(3)} vs ${o2Of(aO2).toFixed(3)}`);
check('routing penalties never reduce cost (cost >= o2)', grid.cost.every((v, i) => v >= grid.o2[i]));
check('forbidden cells are Infinity', cth.every((v, i) => S.layers.hazard[i] !== 2 || v === Infinity));

// 8. Suit rules (Marco's suit.json)
const WB = S.suit.walkback_m.value, MAXS = S.suit.max_slope_deg.value;
r = plan(S, { start: T.habitat, stops: [T.shelter1], goal: T.habitat });
check('near EVA (shelter, <1 km): O2 rule + walkback OK', r.stats.o2_return_ok && r.stats.walkback_ok,
  `o2 margin ${r.stats.o2_margin_min} min, max walkback ${r.stats.walkback_max_m} m <= ${WB}`);
r = plan(S, { start: T.habitat, stops: [T.depot], goal: T.habitat });
check(`far EVA (depot): walkback fails if > ${WB} m`, r.stats.walkback_ok === (r.stats.walkback_max_m <= WB) && r.stats.o2_return_ok,
  `max walkback ${r.stats.walkback_max_m} m -> walkback_ok=${r.stats.walkback_ok}, safe=${r.stats.safe}`);
check('battery check present', r.stats.battery_used_pct > 0 && r.stats.battery_used_pct < 100, `${r.stats.battery_used_pct}%`);
const pathCells = (res) => res.path.geometry.coordinates.map(([lo, la]) =>
  Math.floor((latMax - la) / (latMax - latMin) * meta.height) * W + Math.floor((lo - lonMin) / (lonMax - lonMin) * W));
check(`no cell on path steeper than ${MAXS} deg`, pathCells(r).every((i) => S.layers.slope[i] <= MAXS), `max ${r.stats.max_slope_deg}`);
const S2 = { ...S, suit: { ...S.suit, o2_hours: { value: 0.5 } } };
r = plan(S2, { start: T.habitat, stops: [T.depot], goal: T.habitat });
check('30-min tank: O2 rule fails and gives a turnaround point', r.stats.o2_return_ok === false && Array.isArray(r.turnaround_point),
  `margin ${r.stats.o2_margin_min} min, turnaround ${JSON.stringify(r.turnaround_point)}`);

// 9. Replanning: astronaut is halfway habitat -> depot when each alert arrives
const out = plan(S, { start: T.habitat, goal: T.depot });
const mid = out.path.geometry.coordinates[Math.floor(out.path.geometry.coordinates.length / 2)];
const A = Object.fromEntries([...S.alerts].reverse().map((a) => [a.type, a]));   // first alert of each type wins
const end = (res) => res.path.geometry.coordinates.at(-1);
const near = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 1e-4;

let rp = replan(S, { current: mid, alert: A.SPE, o2_used_min: 20 });
check('SPE -> goes to a shelter', !rp.error && ['Shelter A (mock)', 'Habitat'].includes(rp.replan.destination),
  `-> ${rp.replan?.destination} in ${rp.stats?.duration_min} min, ${rp.replan?.total_ms} ms`);
check('SPE -> starts at current position', near(rp.path.geometry.coordinates[0], mid));
check('SPE -> dose multiplied', rp.state.dose_x === A.SPE.effect.dose_x);

rp = replan(S, { current: mid, alert: A.dust });
{ const el = rp.replan.considered.filter((c) => c.eligible && c.minutes != null), m = Math.min(...el.map((c) => c.minutes));
  check('dust (safe_point) -> fastest of habitat / safe points', !rp.error && rp.replan.considered.find((c) => c.chosen).minutes === m && near(end(rp), rp.path.geometry.coordinates.at(-1)), `${rp.replan.destination} ${m} min, ${rp.replan.total_ms} ms`); }

const r0 = plan(S, { start: mid, goal: T.habitat });
rp = replan(S, { current: mid, alert: A.suit });
check('suit -> same route home but more O2', rp.stats.o2_used_pct > r0.stats.o2_used_pct, `${r0.stats.o2_used_pct}% -> ${rp.stats.o2_used_pct}%`);

const clearHome = plan(S, { start: mid, goal: T.habitat }).path.geometry.coordinates;
const dustHome = replan(S, { current: mid, alert: A.dust }).path.geometry.coordinates;
check('dust changes the route home (avoids steep/rough)', JSON.stringify(clearHome) !== JSON.stringify(dustHome), `${clearHome.length} vs ${dustHome.length} cells`);
const rp2 = replan(S, { current: mid, alert: A.dust, state: rp.state });
check('alerts stack (suit x dust)', Math.abs(rp2.state.o2_x - A.suit.effect.o2_x * A.dust.effect.o2_x) < 1e-9 && rp2.state.visibility === A.dust.effect.visibility, `o2_x ${rp2.state.o2_x}`);
check('replan < 1 s', rp.replan.total_ms < 1000 && rp2.replan.total_ms < 1000, `${rp.replan.total_ms}, ${rp2.replan.total_ms} ms`);

// 10. Snap: a click on a forbidden cell is moved to the nearest walkable cell
const forb = S.layers.hazard.findIndex((v, i) => v === 2 && S.layers.hazard[i + 1] !== 2);
const fp = [meta.bbox[0] + ((forb % W) + 0.5) / W * (meta.bbox[2] - meta.bbox[0]), meta.bbox[3] - (Math.floor(forb / W) + 0.5) / meta.height * (meta.bbox[3] - meta.bbox[1])];
r = plan(S, { start: fp, goal: T.habitat });
check('start on a rock gets snapped', !r.error);

// 11. Points outside the map are rejected (Marco's Jezero targets inside the mock map would do this)
r = plan(S, { start: [77.4136, 18.4537], goal: T.habitat });
check('point outside bbox -> error, not garbage', r.error === 'point_outside_map');

// 12. Task time at stops counts in duration, O2 and the O2 return rule
const noTask = plan(S, { start: T.habitat, stops: [T.shelter1], goal: T.habitat, task_min: [0, 0] });
const withTask = plan(S, { start: T.habitat, stops: [T.shelter1], goal: T.habitat, task_min: [60, 0] });
check('task time adds to duration', withTask.stats.duration_min - noTask.stats.duration_min === 60, `${noTask.stats.duration_min} -> ${withTask.stats.duration_min} min`);
check('task time adds O2 (60 min at P_nom = 12.5%)', Math.abs((withTask.stats.o2_used_pct - noTask.stats.o2_used_pct) - 12.5) < 0.15, `+${(withTask.stats.o2_used_pct - noTask.stats.o2_used_pct).toFixed(2)}%`);
check('task time reduces O2 margin by 60 min', Math.abs((noTask.stats.o2_margin_min - withTask.stats.o2_margin_min) - 60) < 0.2, `${noTask.stats.o2_margin_min} -> ${withTask.stats.o2_margin_min}`);
const long = plan(S, { start: T.habitat, stops: [T.shelter1], goal: T.habitat, task_min: [400, 0] });
check('400 min of work at a target -> O2 rule fails', long.stats.o2_return_ok === false, `margin ${long.stats.o2_margin_min}`);

// 13. SPE never sends you to a shelter that doesn't protect from radiation
const noRad = { ...S, targets: { ...S.targets, features: S.targets.features.map((f) => ({ ...f, properties: { ...f.properties, radiation_shelter: false } })) } };
rp = replan(noRad, { current: mid, alert: A.SPE });
check('SPE ignores non-radiation shelter -> habitat', rp.replan.destination_kind === 'habitat', `-> ${rp.replan.destination}`);

// 14. Speed trick is exact: scaled costToHome (×o2_x) == Dijkstra recomputed on the ×o2_x grid
const gx = buildCostGrid(S.layers, meta, S.params, { o2_x: 1.5 }, undefined, S.suit);
const direct = dijkstraFrom({ ...gx, cost: gx.o2 }, home);
const scaled = getGrid(S, S.params, { o2_x: 1.5 }).costToHome;
let maxErr = 0; for (let i = 0; i < direct.length; i++) if (direct[i] < Infinity) maxErr = Math.max(maxErr, Math.abs(direct[i] - scaled[i]) / Math.max(1, direct[i]));
check('scaled costToHome == recomputed (o2_x 1.5)', maxErr < 1e-5, `max rel err ${maxErr.toExponential(1)}`);

// 15. Ana's task model (params.task_min): egress + depot setup once + per tube + science + ingress
const TM = S.params.task_min, v = (x) => x.value;
r = plan(S, { start: T.habitat, stops: [T.depot, T.sci2], goal: T.habitat });
const expTask = v(TM.habitat_egress) + v(TM.depot_setup) + v(TM.depot_per_tube) + v(TM.science) + v(TM.habitat_ingress);
check('EVA task time = egress + depot setup + 1 tube + science + ingress', r.stats.task_min === expTask, `${r.stats.task_min} min (expected ${expTask})`);
const r2 = plan(S, { start: T.habitat, stops: [T.depot, T.depot], goal: T.habitat });
check('depot setup charged once for 2 tubes', r2.stats.task_min === v(TM.habitat_egress) + v(TM.depot_setup) + 2 * v(TM.depot_per_tube) + v(TM.habitat_ingress), `${r2.stats.task_min} min`);
const walkDose = S.params.gcr_mSv_per_h * (r.stats.walk_min + r.stats.task_min - v(TM.habitat_egress) - v(TM.habitat_ingress)) / 60;
check('airlock time (egress/ingress) has no dose', Math.abs(r.stats.dose_mSv - walkDose) < 0.0006, `${r.stats.dose_mSv} vs ${walkDose.toFixed(4)} mSv`);

// 16. Replan while still at the habitat: no second egress (bug seen in the console, 11:10)
rp = replan(S, { current: T.habitat, alert: A.SPE });
check('replan at habitat charges no egress', rp.stats.task_min === S.params.task_min.habitat_ingress.value, `task ${rp.stats.task_min} min`);

// ===== Tier 1 (11:30) =====
const cellOf = (ll) => Math.floor((latMax - ll[1]) / (latMax - latMin) * meta.height) * W + Math.floor((ll[0] - lonMin) / (lonMax - lonMin) * W);
const llOf = (r, c) => [lonMin + (c + 0.5) / W * (lonMax - lonMin), latMax - (r + 0.5) / meta.height * (latMax - latMin)];
console.log('--- A. live map updates (obstacles)');
const base0 = plan(S, { start: T.habitat, goal: T.depot });
const pc = base0.path.geometry.coordinates, obPt = pc[Math.floor(pc.length / 2)];
const ob = { id: 'ob1', lon: obPt[0], lat: obPt[1], radius_m: 40, kind: 'blocked', source: 'astronaut', note: 'rock fall' };
const withOb = plan(S, { start: T.habitat, goal: T.depot, state: { obstacles: [ob] } });
const obCells = new Set(getGrid(S, S.params, { obstacles: [ob] }).grid.cost.map((v, i) => (v === Infinity ? i : -1)).filter((i) => i >= 0));
check('A: route avoids a reported obstacle', !withOb.error && withOb.path.geometry.coordinates.every((ll) => {
  const d = Math.hypot((ll[0] - ob.lon) * 59270 * Math.cos(ob.lat * Math.PI / 180), (ll[1] - ob.lat) * 59270); return d > ob.radius_m - 3; }),
  `${base0.stats.distance_m} -> ${withOb.stats.distance_m} m`);
const cthOb = getCostToHome(S, { state: { obstacles: [ob] } }).costToHome;
check('A: costToHome is Infinity inside the obstacle', cthOb[cellOf(obPt)] === Infinity);
const cautionOb = plan(S, { start: T.habitat, goal: T.depot, state: { obstacles: [{ ...ob, kind: 'caution' }] } });
check('A: caution obstacle keeps the route possible', !cautionOb.error);
const onStop = plan(S, { start: T.habitat, stops: [T.sci2], goal: T.habitat, state: { obstacles: [{ ...ob, lon: T.sci2[0], lat: T.sci2[1], radius_m: 60 }] } });
check('A: obstacle on top of a stop -> error names the stop', onStop.error === 'point_in_forbidden_zone' && onStop.point === 1);

console.log('--- B. adaptive mission');
let ad = adapt(S, { current: T.habitat, stops: [T.shelter1, T.sci2], o2_used_min: 0 });
check('B: nothing wrong -> continue', ad.adapt.decision === 'continue' && ad.stats.safe, `${ad.adapt.total_ms} ms`);
ad = adapt(S, { current: T.habitat, stops: [T.shelter1, T.sci2], o2_used_min: 330 });
check('B: overtime (330 O2-min used) -> drops low-value stops until safe', ad.adapt.decision !== 'continue' && ad.stats.safe && ad.adapt.dropped.length >= 1,
  `${ad.adapt.decision}, dropped ${ad.adapt.dropped.map((d) => d.name + ' (v' + d.science_value + ')').join(', ')}`);
check('B: drops the LOWEST science value first (shelter v1 before crater rim v3)', ad.adapt.dropped[0].science_value === 1);
ad = adapt(S, { current: T.habitat, stops: [T.shelter1, T.sci2], state: { obstacles: [{ ...ob, lon: T.sci2[0], lat: T.sci2[1], radius_m: 60 }] } });
check('B: stop buried by an obstacle -> dropped as unreachable', ad.adapt.dropped.some((d) => d.reason.startsWith('unreachable')) && ad.stats.safe, ad.adapt.dropped.map((d) => d.name + ': ' + d.reason).join('; '));

console.log('--- E. day / night');
r = plan(S, { start: T.habitat, stops: [T.shelter1], goal: T.habitat, start_lmst: 9 });
check('E: 09:00 start, short EVA -> GO', r.stats.go === 'GO', `${r.stats.start_lmst_hhmm} -> ${r.stats.end_lmst_hhmm}, margin ${r.stats.daylight_margin_min} min`);
r = plan(S, { start: T.habitat, stops: [T.shelter1], goal: T.habitat, start_lmst: 16.5 });
check('E: 16:30 start, home 17:46 (< 30 min before sunset) -> CAUTION, still safe', r.stats.go === 'CAUTION' && r.stats.safe, `end ${r.stats.end_lmst_hhmm}, margin ${r.stats.daylight_margin_min} min`);
r = plan(S, { start: T.habitat, stops: [T.shelter1], goal: T.habitat, start_lmst: 17.2 });
check('E: 17:12 start -> home after sunset -> NO-GO, not safe', r.stats.go === 'NO-GO' && r.stats.safe === false, `end ${r.stats.end_lmst_hhmm}`);
r = plan(S, { start: T.habitat, stops: [T.shelter1], goal: T.habitat, start_lmst: 5 });
check('E: leaving before sunrise -> NO-GO', r.stats.go === 'NO-GO');
ad = adapt(S, { current: T.habitat, stops: [T.shelter1, T.sci2], now_lmst: 16.6 });
check('E+B: late in the sol -> adapt drops stops to be home before sunset', ad.adapt.decision !== 'continue' && ad.stats.go !== 'NO-GO', `${ad.adapt.decision}: ${ad.adapt.dropped.map((d) => d.reason).join('; ')}, home ${ad.stats.end_lmst_hhmm}`);
const g0 = getGrid(S, S.params, {}).grid, gNo = getGrid(S, S.params, { w_caution: 0 }).grid;
let yc = 0; for (let i = 0; i < g0.cost.length; i++) if (S.layers.hazard[i] === 1 && g0.cost[i] < Infinity) { yc++; if (!(g0.cost[i] > gNo.cost[i])) { yc = -1e9; break; } }
check('E: yellow (caution) cells cost more to route through; O2 unchanged', yc > 0 && g0.o2.every((v, i) => v === gNo.o2[i] || (isNaN(v) && isNaN(gNo.o2[i]))));

console.log('--- F. storm -> nearest safe point');
const P = llOf(520, 420);
const dust = { ...A.dust, action: 'return' };   // fallback logic applies to 'return' alerts
const toShel = plan(S, { start: P, goal: T.shelter1, state: { visibility: dust.effect.visibility, o2_x: dust.effect.o2_x }, start_task_min: 0 });
const toHab = plan(S, { start: P, goal: T.habitat, state: { visibility: dust.effect.visibility, o2_x: dust.effect.o2_x }, start_task_min: 0 });
const usable = usableO2min(S.suit);
const used = usable - (toShel.stats.o2_used_min + toHab.stats.o2_used_min) / 2;   // enough for the shelter, not for home
rp = replan(S, { current: P, alert: dust, o2_used_min: used });
check('F: dust, not enough O2 for home -> nearest safe point', rp.replan.fallback_to_safe_point && rp.replan.destination_kind === 'shelter',
  `shelter ${toShel.stats.o2_used_min} vs home ${toHab.stats.o2_used_min} O2-min, used ${used.toFixed(0)} -> ${rp.replan.destination}`);
rp = replan(S, { current: P, alert: dust, o2_used_min: 0 });
check('F: dust with plenty of O2 -> still the habitat', !rp.replan.fallback_to_safe_point && rp.replan.destination_kind === 'habitat');

console.log('--- shelters (12:10): three behaviours');
const nearShel = llOf(560, 380);            // close to Shelter A (600,350), far from the habitat (850,150)
rp = replan(S, { current: nearShel, alert: A.dust });
check('dust (safe_point) near a shelter -> the SHELTER, not the habitat', rp.replan.destination_kind === 'shelter',
  rp.replan.considered.map((c) => `${c.name} ${c.minutes} min${c.chosen ? ' ✓' : ''}`).join(' · '));
rp = replan(S, { current: nearShel, alert: A.suit });
check('suit failure -> habitat only, shelter listed as not eligible', rp.replan.destination_kind === 'habitat' && rp.replan.considered.some((c) => c.kind === 'shelter' && !c.eligible));
rp = replan(noRad, { current: nearShel, alert: A.SPE });
check('SPE with a non-shielded shelter nearby -> habitat, and the UI can say why', rp.replan.destination_kind === 'habitat' &&
  rp.replan.considered.some((c) => c.why === 'not radiation-protected'), rp.replan.considered.map((c) => `${c.name} ${c.minutes} min (${c.why})${c.chosen ? ' ✓' : ''}`).join(' · '));
rp = replan(S, { current: nearShel, alert: A.SPE });
check('SPE with a radiation shelter nearby -> that shelter', rp.replan.destination_kind === 'shelter');

console.log('--- Tier 2: emergency caches (O2 refill + inventory)');
const cacheLL = llOf(540, 400);
const cacheF = { type: 'Feature', geometry: { type: 'Point', coordinates: cacheLL },
  properties: { id: 'cache-1', name: 'Cache 1 (mock)', kind: 'shelter', station_type: 'cache', radiation_shelter: false, science_value: 1, supplies: { o2_min: 120 } } };
const SC = { ...S, targets: { ...S.targets, features: [...S.targets.features, cacheF] } };
const plainR = plan(SC, { start: T.habitat, stops: [T.sci2], goal: T.habitat, o2_used_min: 200 });
const viaC = plan(SC, { start: T.habitat, stops: [cacheLL, T.sci2], goal: T.habitat, o2_used_min: 200 });
check('T2: stopping at a cache refills O2 and raises the return margin', viaC.stats.o2_refilled_min > 0 && viaC.stats.o2_margin_min > plainR.stats.o2_margin_min,
  `refill ${viaC.stats.o2_refilled_min} min, margin ${plainR.stats.o2_margin_min} -> ${viaC.stats.o2_margin_min}`);
check('T2: refill never exceeds the cache supply', viaC.refills.every((r) => r.o2_min <= 120));
const viaC2 = plan(SC, { start: T.habitat, stops: [cacheLL, T.sci2], goal: T.habitat, o2_used_min: 200, state: { cache_used: { 'cache-1': 110 } } });
check('T2: inventory — a used-up cache gives only what is left', viaC2.stats.o2_refilled_min <= 10.01, `left 10 -> refilled ${viaC2.stats.o2_refilled_min}`);
const leak = { id: 'leak1', type: 'suit', action: 'resupply', effect: { o2_x: 1.0, dose_x: 1, visibility: 1 } };
const farP = T.sci2;
const usableC = usableO2min(S.suit);
const directHome = plan(SC, { start: farP, goal: T.habitat, start_task_min: 0 });
rp = replan(SC, { current: farP, alert: leak, o2_used_min: usableC - directHome.stats.o2_used_min + 5 });   // can't make it home directly
check('T2: O2 emergency -> goes via the cache, refills, and gets home safely', rp.replan.via_cache && rp.stats.o2_return_ok,
  rp.replan.considered.map((c) => `${c.name}: ${c.why}${c.chosen ? ' ✓' : ''}`).join(' · '));
ad = adapt(SC, { current: T.habitat, stops: [T.sci2], o2_used_min: 280 });   // direct: margin < 0; via cache (+120): safe
check('T2: adapt tries a refill detour before dropping science', ad.adapt.decision === 'refill' && ad.adapt.dropped.length === 0 && ad.stats.safe,
  `${ad.adapt.decision} via ${ad.adapt.via_cache?.name}`);
rp = replan(SC, { current: cacheLL, alert: A.dust });
ad = adapt(SC, { current: T.habitat, stops: [T.sci2], o2_used_min: 330 });
check('T2: when even a refill cannot save it, adapt still drops science (no false hope)', ad.adapt.decision !== 'refill' && ad.adapt.dropped.length > 0);
const noCache = getGrid(S, S.params, {}).costToHome;
check('T2: with no caches, cost-to-safety == cost-to-home (old behaviour unchanged)', getCostToHome(S, {}).costToSafety === null);
check('T2: a cache shrinks the cost-to-safety field (bigger safe exploration zone)', (() => { const f = getCostToHome(SC, {}).costToSafety; let less = 0; for (let i = 0; i < f.length; i += 97) if (f[i] < noCache[i] - 1e-3) less++; return less > 0; })());
{ const SC2 = { ...S, targets: { ...S.targets, features: [...S.targets.features,
    { type: 'Feature', geometry: { type: 'Point', coordinates: T.shelter1 }, properties: { id: 'cache-co', name: 'Co-located cache', kind: 'shelter', station_type: 'cache', supplies: { o2_min: 60 } } }] } };
  const r = plan(SC2, { start: T.habitat, stops: [T.shelter1], goal: T.habitat, o2_used_min: 100 });
  check('T2: cache placed AT another target is still used (refill)', r.stats.o2_refilled_min > 0, `refilled ${r.stats.o2_refilled_min}`); }
check('T2: a cache also counts as a safe point in a dust storm', rp.replan.destination_kind === 'shelter');

process.exit(fails ? 1 : 0);
