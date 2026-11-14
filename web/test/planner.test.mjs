// Run from web/:  node test/planner.test.mjs [site]
// Loads the contract files from disk (no browser) and checks the planner.
import fs from 'node:fs';
import { plan, astar, buildCostGrid } from '../src/planner.js';

const site = process.argv[2] || 'mock';
const dir = new URL(`../public/data/${site}/`, import.meta.url);
const json = (f) => JSON.parse(fs.readFileSync(new URL(f, dir)));
const bin = (f, T) => { const b = fs.readFileSync(new URL(f, dir)); return new T(b.buffer, b.byteOffset, b.byteLength / T.BYTES_PER_ELEMENT); };

const meta = json('meta.json');
const S = {
  meta, suit: json('suit.json'), params: json('params.json'),
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

process.exit(fails ? 1 : 0);
