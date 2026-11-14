// planner.js — Pure planning logic (no DOM, no worker). Testable in Node.
// Concept: global costmap + global planner, same idea as ROS Nav2.
//
//   layers --(cellCost per cell)--> costGrid (Float32Array, O2-min per meter)
//   costGrid --(A* per leg)--> path cells --> GeoJSON + stats

import { MinHeap } from './heap.js';
import { cellCost as defaultCellCost, speedAt } from './cost.js';
import { lonLatToCell, cellToLonLat } from './data.js';

const SQRT2 = Math.SQRT2;
// 8-connected neighbors: [dRow, dCol]
const DIRS = [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [-1, 1], [1, -1], [1, 1]];

// ---------- 1. Cost grid ----------
// Evaluate cellCost ONCE per cell (1M calls, ~20-50 ms) instead of inside A*'s hot loop.
// Replanning after an alert = rebuild this grid with the new state + rerun A*.
export function buildCostGrid(layers, meta, params, state, cellCost = defaultCellCost) {
  const n = meta.width * meta.height;
  const cost = new Float32Array(n);
  let minCost = Infinity;
  for (let i = 0; i < n; i++) {
    const c = cellCost(i, layers, params, state);
    cost[i] = c;
    if (c < minCost) minCost = c;
  }
  return { cost, minCost, W: meta.width, H: meta.height, cellM: meta.cell_m };
}

// ---------- 2. A* ----------
// Returns array of cell indices from start to goal, or null if unreachable.
export function astar(grid, start, goal) {
  const { cost, minCost, W, H, cellM } = grid;
  const n = W * H;
  if (!(cost[start] < Infinity) || !(cost[goal] < Infinity)) return null;

  const g = new Float64Array(n).fill(Infinity); // best known cost from start
  const came = new Int32Array(n).fill(-1);      // parent pointer to rebuild path
  const closed = new Uint8Array(n);             // already expanded (final)
  const open = new MinHeap();

  const gr = Math.floor(goal / W), gc = goal % W;
  // Octile distance: exact shortest distance on an 8-connected grid with no obstacles.
  // Multiplied by the cheapest cost/m in the grid -> never overestimates -> ADMISSIBLE
  // -> A* returns the optimal path.
  const h = (i) => {
    const dr = Math.abs(Math.floor(i / W) - gr), dc = Math.abs((i % W) - gc);
    return (dr + dc + (SQRT2 - 2) * Math.min(dr, dc)) * cellM * minCost;
  };

  g[start] = 0;
  open.push(h(start), start);

  while (open.size > 0) {
    const cur = open.pop();
    if (closed[cur]) continue;              // stale duplicate (lazy deletion)
    if (cur === goal) break;
    closed[cur] = 1;

    const r = Math.floor(cur / W), c = cur % W;
    for (let d = 0; d < 8; d++) {
      const nr = r + DIRS[d][0], nc = c + DIRS[d][1];
      if (nr < 0 || nr >= H || nc < 0 || nc >= W) continue;
      const nb = nr * W + nc;
      if (closed[nb] || !(cost[nb] < Infinity)) continue;
      const diagonal = d >= 4;
      // No corner-cutting: can't squeeze diagonally between two forbidden cells
      if (diagonal && (!(cost[r * W + nc] < Infinity) || !(cost[nr * W + c] < Infinity))) continue;
      const dist = diagonal ? SQRT2 * cellM : cellM;
      const ng = g[cur] + 0.5 * (cost[cur] + cost[nb]) * dist;
      if (ng < g[nb]) {
        g[nb] = ng;
        came[nb] = cur;
        open.push(ng + h(nb), nb);
      }
    }
  }
  if (g[goal] === Infinity) return null;

  const path = [];
  for (let i = goal; i !== -1; i = came[i]) path.push(i);
  return path.reverse();
}

// ---------- 3. Stats for a list of cells ----------
export function pathStats(cells, site, grid, params, state = {}) {
  const { layers, meta, suit } = site;
  const W = meta.width, cellM = meta.cell_m;
  let distance = 0, seconds = 0, o2min = 0, maxSlope = 0, comms = 0;
  for (let k = 0; k < cells.length; k++) {
    const i = cells[k];
    maxSlope = Math.max(maxSlope, layers.slope[i]);
    if (layers.viewshed?.[i]) comms++;
    if (k === 0) continue;
    const p = cells[k - 1];
    const diag = Math.floor(p / W) !== Math.floor(i / W) && p % W !== i % W;
    const dist = diag ? SQRT2 * cellM : cellM;
    distance += dist;
    seconds += dist / (0.5 * (speedAt(p, layers) + speedAt(i, layers)));
    o2min += 0.5 * (grid.cost[p] + grid.cost[i]) * dist;
  }
  const o2Total = (suit?.o2_hours?.value ?? 8) * 60;
  const hours = seconds / 3600;
  return {
    distance_m: Math.round(distance),
    duration_min: Math.round(seconds / 60),
    o2_used_pct: +((100 * o2min) / o2Total).toFixed(1),
    dose_mSv: +((params.gcr_mSv_per_h ?? 0.028) * hours * (state.dose_x ?? 1)).toFixed(4),
    max_slope_deg: +maxSlope.toFixed(1),
    walkback_ok: null, // TODO 20:30 block: reverse Dijkstra from habitat (costToHome)
    comms_pct: Math.round((100 * comms) / cells.length),
  };
}

// ---------- 4. Public API: plan() ----------
// req: { start:[lon,lat], stops:[[lon,lat],...], goal:[lon,lat], params?, state? }
let cache = { key: null, grid: null };

export function plan(site, req) {
  const t0 = performance.now();
  const params = { ...site.params, ...(req.params || {}) };
  const state = req.state || {};
  const key = JSON.stringify([params, state]);
  if (cache.key !== key) cache = { key, grid: buildCostGrid(site.layers, site.meta, params, state) };
  const grid = cache.grid;
  const tCost = performance.now();

  const pts = [req.start, ...(req.stops || []), req.goal];
  const cellsOf = pts.map(([lon, lat]) => lonLatToCell(site.meta, lon, lat).i);
  const all = [], segments = [];
  for (let k = 0; k < cellsOf.length - 1; k++) {
    const leg = astar(grid, cellsOf[k], cellsOf[k + 1]);
    if (!leg) return { error: 'unreachable', leg: k, from: pts[k], to: pts[k + 1] };
    segments.push({ from: pts[k], to: pts[k + 1], stats: pathStats(leg, site, grid, params, state) });
    all.push(...(k === 0 ? leg : leg.slice(1)));
  }
  return {
    path: {
      type: 'Feature',
      properties: {},
      geometry: { type: 'LineString', coordinates: all.map((i) => cellToLonLat(site.meta, i)) },
    },
    stats: pathStats(all, site, grid, params, state),
    segments,
    timing_ms: { cost_grid: Math.round(tCost - t0), astar: Math.round(performance.now() - tCost) },
  };
}
