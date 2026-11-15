// Run from web/:  node test/planner.test.mjs [site]
// Loads the contract files from disk (no browser) and checks the planner.
import fs from 'node:fs';
import { plan, replan, astar, buildCostGrid, dijkstraFrom, getCostToHome, getGrid } from '../src/planner.js';

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
const A = Object.fromEntries(S.alerts.map((a) => [a.type, a]));
const end = (res) => res.path.geometry.coordinates.at(-1);
const near = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 1e-4;

let rp = replan(S, { current: mid, alert: A.SPE, o2_used_min: 20 });
check('SPE -> goes to a shelter', !rp.error && ['Shelter A (mock)', 'Habitat'].includes(rp.replan.destination),
  `-> ${rp.replan?.destination} in ${rp.stats?.duration_min} min, ${rp.replan?.total_ms} ms`);
check('SPE -> starts at current position', near(rp.path.geometry.coordinates[0], mid));
check('SPE -> dose multiplied', rp.state.dose_x === A.SPE.effect.dose_x);

rp = replan(S, { current: mid, alert: A.dust });
check('dust -> returns to habitat', !rp.error && rp.replan.destination === 'Habitat' && near(end(rp), T.habitat), `${rp.replan.total_ms} ms`);

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
check('SPE ignores non-radiation shelter -> habitat', rp.replan.destination === 'Habitat', `-> ${rp.replan.destination}`);

// 14. Speed trick is exact: scaled costToHome (×o2_x) == Dijkstra recomputed on the ×o2_x grid
const gx = buildCostGrid(S.layers, meta, S.params, { o2_x: 1.5 }, undefined, S.suit);
const direct = dijkstraFrom({ ...gx, cost: gx.o2 }, home);
const scaled = getGrid(S, S.params, { o2_x: 1.5 }).costToHome;
let maxErr = 0; for (let i = 0; i < direct.length; i++) if (direct[i] < Infinity) maxErr = Math.max(maxErr, Math.abs(direct[i] - scaled[i]) / Math.max(1, direct[i]));
check('scaled costToHome == recomputed (o2_x 1.5)', maxErr < 1e-5, `max rel err ${maxErr.toExponential(1)}`);

process.exit(fails ? 1 : 0);
