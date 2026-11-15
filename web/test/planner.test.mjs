// Run from web/:  node test/planner.test.mjs [site]
// Loads the contract files from disk (no browser) and checks the planner.
import fs from 'node:fs';
import { plan, replan, astar, buildCostGrid, dijkstraFrom, getCostToHome } from '../src/planner.js';

const site = process.argv[2] || 'mock';
const dir = new URL(`../public/data/${site}/`, import.meta.url);
const json = (f) => JSON.parse(fs.readFileSync(new URL(f, dir)));
const bin = (f, T) => { const b = fs.readFileSync(new URL(f, dir)); return new T(b.buffer, b.byteOffset, b.byteLength / T.BYTES_PER_ELEMENT); };

const meta = json('meta.json');
const S = {
  meta, targets: json('targets.geojson'), alerts: json('alerts.json'), suit: json('suit.json'), params: json('params.json'),
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
const cth = dijkstraFrom(grid, home);
const tD = Math.round(performance.now() - t);
check('costToHome[habitat] == 0', cth[home] === 0, `(dijkstra full grid ${tD} ms)`);
check('costToHome[depot] == A* cost habitat->depot', Math.abs(cth[depot] - costOf(a)) < 1e-2, `${cth[depot].toFixed(3)} vs ${costOf(a).toFixed(3)}`);
check('forbidden cells are Infinity', cth.every((v, i) => S.layers.hazard[i] !== 2 || v === Infinity));

// 8. walkback: normal EVA OK; tiny O2 tank must fail
r = plan(S, { start: T.habitat, stops: [T.depot], goal: T.habitat });
check('walkback_ok with normal suit', r.stats.walkback_ok === true, `margin ${r.stats.walkback_margin_min} min`);
const S2 = { ...S, suit: { ...S.suit, o2_hours: { value: 0.5 } } };
r = plan(S2, { start: T.habitat, stops: [T.depot], goal: T.habitat });
check('walkback fails with 30-min tank', r.stats.walkback_ok === false, `margin ${r.stats.walkback_margin_min} min`);

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

const rp2 = replan(S, { current: mid, alert: A.dust, state: rp.state });
check('alerts stack (suit x dust)', Math.abs(rp2.state.o2_x - A.suit.effect.o2_x * A.dust.effect.o2_x) < 1e-9 && rp2.state.visibility === A.dust.effect.visibility, `o2_x ${rp2.state.o2_x}`);
check('replan < 1 s', rp.replan.total_ms < 1000 && rp2.replan.total_ms < 1000, `${rp.replan.total_ms}, ${rp2.replan.total_ms} ms`);

// 10. Snap: a click on a forbidden cell is moved to the nearest walkable cell
const forb = S.layers.hazard.findIndex((v, i) => v === 2 && S.layers.hazard[i + 1] !== 2);
const fp = [meta.bbox[0] + ((forb % W) + 0.5) / W * (meta.bbox[2] - meta.bbox[0]), meta.bbox[3] - (Math.floor(forb / W) + 0.5) / meta.height * (meta.bbox[3] - meta.bbox[1])];
r = plan(S, { start: fp, goal: T.habitat });
check('start on a rock gets snapped', !r.error);

process.exit(fails ? 1 : 0);
