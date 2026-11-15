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

// ---------- 2b. Dijkstra from one source over the WHOLE grid ----------
// costToHome[i] = cheapest O2-minutes to walk from cell i back to the habitat.
// Why running it FROM the habitat works: our edge cost is symmetric
// (avg(cost[a], cost[b]) * dist is the same in both directions), so
// cost(i -> home) == cost(home -> i). If Ana later makes cost direction-dependent
// (uphill != downhill), this must run on reversed edges ("reverse Dijkstra").
// Same loop as A* but: no heuristic (h = 0) and no goal (expand everything).
export function dijkstraFrom(grid, source) {
  const { cost, W, H, cellM } = grid;
  const n = W * H;
  const dist = new Float32Array(n).fill(Infinity);
  const closed = new Uint8Array(n);
  const open = new MinHeap(1 << 20);
  if (!(cost[source] < Infinity)) return dist;
  dist[source] = 0;
  open.push(0, source);
  while (open.size > 0) {
    const cur = open.pop();
    if (closed[cur]) continue;
    closed[cur] = 1;
    const r = Math.floor(cur / W), c = cur % W, dc = dist[cur];
    for (let d = 0; d < 8; d++) {
      const nr = r + DIRS[d][0], nc = c + DIRS[d][1];
      if (nr < 0 || nr >= H || nc < 0 || nc >= W) continue;
      const nb = nr * W + nc;
      if (closed[nb] || !(cost[nb] < Infinity)) continue;
      const diagonal = d >= 4;
      if (diagonal && (!(cost[r * W + nc] < Infinity) || !(cost[nr * W + c] < Infinity))) continue;
      const nd = dc + 0.5 * (cost[cur] + cost[nb]) * (diagonal ? SQRT2 * cellM : cellM);
      if (nd < dist[nb]) { dist[nb] = nd; open.push(nd, nb); }
    }
  }
  return dist;
}

// O2 the astronaut may spend, in minutes, keeping the mandatory reserve.
export function usableO2min(suit) {
  const total = (suit?.o2_hours?.value ?? 8) * 60;
  return total * (1 - (suit?.reserve_pct?.value ?? 20) / 100);
}

// Walkback check: at EVERY point k of the route,
//   O2 already used up to k + costToHome[k] <= usable O2
// margin = worst (smallest) slack along the route, in O2-minutes.
export function walkbackCheck(cells, grid, costToHome, usable) {
  const W = grid.W;
  let used = 0, margin = Infinity, worstIdx = 0;
  for (let k = 0; k < cells.length; k++) {
    const i = cells[k];
    if (k > 0) {
      const p = cells[k - 1];
      const diag = Math.floor(p / W) !== Math.floor(i / W) && p % W !== i % W;
      used += 0.5 * (grid.cost[p] + grid.cost[i]) * (diag ? SQRT2 : 1) * grid.cellM;
    }
    const slack = usable - (used + costToHome[i]);
    if (slack < margin) { margin = slack; worstIdx = k; }
  }
  return { ok: margin >= 0, margin_min: +margin.toFixed(1), worst_point: worstIdx };
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
    walkback_ok: null, // filled by plan() with walkbackCheck (needs the whole route)
    comms_pct: Math.round((100 * comms) / cells.length),
  };
}

// ---------- 4. Public API: plan() ----------
// req: { start:[lon,lat], stops:[[lon,lat],...], goal:[lon,lat], params?, state? }
let cache = { key: null, grid: null, costToHome: null };

// Cost grid + costToHome depend only on (params, state). Recompute only when those change
// (i.e. when an alert arrives) — that's why replanning is cheap.
export function getGrid(site, params, state) {
  const key = JSON.stringify([params, state, site.meta.habitat]);
  if (cache.key !== key) {
    const grid = buildCostGrid(site.layers, site.meta, params, state);
    const home = lonLatToCell(site.meta, ...site.meta.habitat).i;
    cache = { key, grid, costToHome: dijkstraFrom(grid, home) };
  }
  return cache;
}

export function plan(site, req) {
  const t0 = performance.now();
  const params = { ...site.params, ...(req.params || {}) };
  const state = req.state || {};
  const { grid, costToHome } = getGrid(site, params, state);
  const tCost = performance.now();

  const pts = [req.start, ...(req.stops || []), req.goal];
  // Snap clicks/GPS positions that land on a forbidden cell (e.g. a rock) to the nearest walkable one
  const cellsOf = pts.map(([lon, lat]) => snapToPassable(grid, lonLatToCell(site.meta, lon, lat).i));
  if (cellsOf.some((c) => c < 0)) return { error: 'point_in_forbidden_zone' };
  const all = [], segments = [];
  for (let k = 0; k < cellsOf.length - 1; k++) {
    const leg = astar(grid, cellsOf[k], cellsOf[k + 1]);
    if (!leg) return { error: 'unreachable', leg: k, from: pts[k], to: pts[k + 1] };
    segments.push({ from: pts[k], to: pts[k + 1], stats: pathStats(leg, site, grid, params, state) });
    all.push(...(k === 0 ? leg : leg.slice(1)));
  }
  const stats = pathStats(all, site, grid, params, state);
  // req.o2_used_min: O2 already spent before this plan starts (used by replan mid-EVA)
  const wb = walkbackCheck(all, grid, costToHome, usableO2min(site.suit) - (req.o2_used_min || 0));
  stats.walkback_ok = wb.ok;
  stats.walkback_margin_min = wb.margin_min;
  return {
    path: {
      type: 'Feature',
      properties: {},
      geometry: { type: 'LineString', coordinates: all.map((i) => cellToLonLat(site.meta, i)) },
    },
    stats,
    walkback_worst_point: cellToLonLat(site.meta, all[wb.worst_point]),
    segments,
    timing_ms: { cost_grid: Math.round(tCost - t0), astar: Math.round(performance.now() - tCost) },
  };
}

// Nearest walkable cell within `maxR` cells (square rings outward). -1 if none.
export function snapToPassable(grid, i, maxR = 10) {
  const { cost, W, H } = grid;
  if (cost[i] < Infinity) return i;
  const r0 = Math.floor(i / W), c0 = i % W;
  for (let rad = 1; rad <= maxR; rad++) {
    let best = -1, bestD = Infinity;
    for (let dr = -rad; dr <= rad; dr++) for (let dc = -rad; dc <= rad; dc++) {
      if (Math.max(Math.abs(dr), Math.abs(dc)) !== rad) continue; // only the ring
      const r = r0 + dr, c = c0 + dc;
      if (r < 0 || r >= H || c < 0 || c >= W) continue;
      const j = r * W + c, d = dr * dr + dc * dc;
      if (cost[j] < Infinity && d < bestD) { best = j; bestD = d; }
    }
    if (best >= 0) return best;
  }
  return -1;
}

// ---------- 5. Replanning ----------
// req: { current:[lon,lat], alert: <item of alerts.json>, state?: current state,
//        o2_used_min?: O2 already spent, params? }
// 1) Apply the alert's effect to state (multipliers stack on top of previous alerts)
// 2) Choose destination by alert.action:
//      'shelter' -> nearest SHELTER BY TIME (dose ∝ exposure time), habitat counts as shelter
//      'return'  -> habitat
// 3) plan() from the current position. Cost grid + costToHome are rebuilt automatically
//    because state changed (cache key) -> ~0.3-0.5 s total.
export function applyAlert(state = {}, alert) {
  const e = alert.effect || {};
  return {
    ...state,
    dose_x: (state.dose_x ?? 1) * (e.dose_x ?? 1),
    o2_x: (state.o2_x ?? 1) * (e.o2_x ?? 1),
    visibility: Math.min(state.visibility ?? 1, e.visibility ?? 1),
  };
}

export function replan(site, req) {
  const t0 = performance.now();
  const state = applyAlert(req.state, req.alert);
  const base = { start: req.current, stops: [], params: req.params, state, o2_used_min: req.o2_used_min };
  const habitat = site.meta.habitat;

  let candidates;
  if (req.alert.action === 'shelter') {
    candidates = site.targets.features
      .filter((f) => f.properties.kind === 'shelter' || f.properties.kind === 'habitat')
      .map((f) => ({ name: f.properties.name, coords: f.geometry.coordinates }));
  } else {
    candidates = [{ name: 'Habitat', coords: habitat }];
  }

  let best = null;
  for (const c of candidates) {
    const p = plan(site, { ...base, goal: c.coords });
    if (p.error) continue;
    if (!best || p.stats.duration_min < best.plan.stats.duration_min) best = { plan: p, target: c };
  }
  if (!best) return { error: 'no_safe_destination', alert: req.alert.id, state };
  return {
    ...best.plan,
    state, // the tablet keeps this and sends it back on the next replan (alerts stack)
    replan: {
      alert: req.alert.id, type: req.alert.type, action: req.alert.action,
      destination: best.target.name, candidates: candidates.length,
      total_ms: Math.round(performance.now() - t0),
    },
  };
}

// For the tablet's "no-return ring": the raw costToHome raster (O2-min, Infinity = unreachable).
// Tablet logic: cell i is beyond no-return if costToHome[i] > O2 remaining now.
export function getCostToHome(site, req = {}) {
  const params = { ...site.params, ...(req.params || {}) };
  const { costToHome } = getGrid(site, params, req.state || {});
  return { costToHome: costToHome.slice(), usable_o2_min: usableO2min(site.suit) };
}
