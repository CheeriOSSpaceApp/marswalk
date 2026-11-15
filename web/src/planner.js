// planner.js — Pure planning logic (no DOM, no worker). Testable in Node.
// Concept: global costmap + global planner, same idea as ROS Nav2.
//
//   layers --(cellCost per cell)--> costGrid (Float32Array, O2-min per meter)
//   costGrid --(A* per leg)--> path cells --> GeoJSON + stats

import { MinHeap } from './heap.js';
import * as costModel from './cost.js';

// Namespace import: if Ana's cost.js doesn't export speedAt, we fall back instead of crashing.
// (A named import of a missing export is a SyntaxError at load time — that was the bug.)
const defaultCellCost = costModel.cellCost;
const MAX_SPEED_MS = 0.9835; // 2.2 mph (NASA ICES-2026-127 nominal walking speed)
// Fallback speed model: Tobler, using Ana's params (tobler_a/b/offset, V_cap) when present,
// so durations match the speed inside her cellCost.
function toblerSpeed(i, layers, params = {}) {
  const tan = Math.tan((layers.slope[i] * Math.PI) / 180);
  const a = params.tobler_a ?? 6, b = params.tobler_b ?? 3.5, off = params.tobler_offset ?? 0.05;
  return Math.min(params.V_cap ?? MAX_SPEED_MS, (a * Math.exp(-b * Math.abs(tan + off))) / 3.6);
}
const speedAt = typeof costModel.speedAt === 'function' ? costModel.speedAt : toblerSpeed;
if (typeof defaultCellCost !== 'function') throw new Error('cost.js must export cellCost(i, layers, params, state)');
if (speedAt === toblerSpeed) console.warn('[planner] cost.js has no speedAt export; using built-in Tobler (cap 2.2 mph)');
import { lonLatToCell, cellToLonLat } from './data.js';

const SQRT2 = Math.SQRT2;
// 8-connected neighbors: [dRow, dCol]
const DIRS = [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [-1, 1], [1, -1], [1, 1]];

// ---------- 1. Cost grid ----------
// Evaluate cellCost ONCE per cell (1M calls, ~20-50 ms) instead of inside A*'s hot loop.
// Replanning after an alert = rebuild this grid with the new state + rerun A*.
// Two grids, on purpose:
//   o2[i]   = PHYSICAL O2-min per meter (Ana's cellCost × alert o2_x). Used for stats, costToHome, O2 rule.
//   cost[i] = ROUTING cost = o2 × penalties that express risk/preference, NOT oxygen
//             (no comms, low visibility in dust). Used only by A* to choose the path.
// Mixing them would make o2_used_pct include fake "comms oxygen".
// cellCost (Ana) = physiology only. Operational modifiers (alerts, comms) are applied HERE.
// Hard safety limit from suit.json enforced here too (defense in depth).
export function buildCostGrid(layers, meta, params, state, cellCost = defaultCellCost, suit = null) {
  const n = meta.width * meta.height;
  const cost = new Float32Array(n);
  const o2 = new Float32Array(n);
  const maxSlope = suit?.max_slope_deg?.value ?? Infinity;
  const o2x = state?.o2_x ?? 1;                       // suit failure: consumption ×1.5
  const vis = state?.visibility ?? 1;                 // dust: 1 = clear, 0.3 = poor
  const wNoComms = params?.w_nocomms ?? 0.2;
  let minCost = Infinity;
  for (let i = 0; i < n; i++) {
    let c = layers.slope[i] > maxSlope ? Infinity : cellCost(i, layers, params, state);
    if (!(c >= 0)) c = Infinity; // NaN or negative (bad data / bug) -> impassable
    const phys = c * o2x;
    o2[i] = phys;
    let r = phys;
    if (r < Infinity) {
      if (layers.viewshed && layers.viewshed[i] === 0) r *= 1 + wNoComms;
      if (vis < 1) r *= 1 + (1 - vis) * (layers.slope[i] / 10 + layers.roughness[i]); // avoid steep/rough when you can't see
    }
    cost[i] = r;
    if (r < minCost) minCost = r;
  }
  return { cost, o2, minCost, W: meta.width, H: meta.height, cellM: meta.cell_m };
}

// Same passable cells, but every meter costs 1 -> Dijkstra on it gives WALKING DISTANCE (m).
export function unitGrid(grid) {
  const cost = new Float32Array(grid.cost.length);
  for (let i = 0; i < cost.length; i++) cost[i] = grid.cost[i] < Infinity ? 1 : Infinity;
  return { ...grid, cost, minCost: 1 };
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
// Marco's viability rule. turnaround = last point before the rule first fails (-1 if never fails).
export function walkbackCheck(cells, grid, costToHome, usable, extraO2 = new Map()) {
  const W = grid.W;
  let used = 0, margin = Infinity, worstIdx = 0, turnaround = -1;
  for (let k = 0; k < cells.length; k++) {
    const i = cells[k];
    if (k > 0) {
      const p = cells[k - 1];
      const diag = Math.floor(p / W) !== Math.floor(i / W) && p % W !== i % W;
      used += 0.5 * (grid.o2[p] + grid.o2[i]) * (diag ? SQRT2 : 1) * grid.cellM; // physical O2
    }
    used += extraO2.get(k) || 0; // task done at this stop: must still be able to get home AFTER it
    const slack = usable - (used + costToHome[i]);
    if (slack < margin) { margin = slack; worstIdx = k; }
    if (slack < 0 && turnaround === -1) turnaround = Math.max(0, k - 1);
  }
  return { ok: margin >= 0, margin_min: +margin.toFixed(1), worst_point: worstIdx, turnaround };
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
    seconds += dist / (0.5 * (speedAt(p, layers, params) + speedAt(i, layers, params)));
    o2min += 0.5 * (grid.o2[p] + grid.o2[i]) * dist; // physical O2, not routing cost
  }
  const o2Total = (suit?.o2_hours?.value ?? 8) * 60; // 1 O2-min = 1 min at 352 W (1200 BTU/h)
  const hours = seconds / 3600;
  return {
    distance_m: Math.round(distance),
    duration_min: Math.round(seconds / 60),
    o2_used_pct: +((100 * o2min) / o2Total).toFixed(1),
    dose_mSv: +((params.gcr_mSv_per_h ?? 0.028) * hours * (state.dose_x ?? 1)).toFixed(4),
    max_slope_deg: +maxSlope.toFixed(1),
    walkback_ok: null, // filled by plan() (needs costToHome / distToHome)
    comms_pct: Math.round((100 * comms) / cells.length),
  };
}

// ---------- 4. Public API: plan() ----------
// req: { start:[lon,lat], stops:[[lon,lat],...], goal:[lon,lat], params?, state? }
let cache = { key: null, grid: null, costToHome: null };

// Cost grid + costToHome depend only on (params, state). Recompute only when those change
// (i.e. when an alert arrives) — that's why replanning is cheap.
export function getGrid(site, params, state) {
  const key = JSON.stringify([params, state, site.meta.habitat, site.suit?.max_slope_deg?.value]);
  if (cache.key !== key) {
    const grid = buildCostGrid(site.layers, site.meta, params, state, defaultCellCost, site.suit);
    const home = snapToPassable(grid, lonLatToCell(site.meta, ...site.meta.habitat).i);
    cache = {
      key, grid,
      costToHome: dijkstraFrom({ ...grid, cost: grid.o2 }, home), // physical O2-min home (cheapest)
      distToHome: dijkstraFrom(unitGrid(grid), home), // meters of walking to get home
    };
  }
  return cache;
}

export function plan(site, req) {
  const t0 = performance.now();
  const params = { ...site.params, ...(req.params || {}) };
  const state = req.state || {};
  const { grid, costToHome, distToHome } = getGrid(site, params, state);
  const tCost = performance.now();

  const pts = [req.start, ...(req.stops || []), req.goal];
  // Points outside the map would map to garbage cell indices -> reject explicitly
  const [lonMin, latMin, lonMax, latMax] = site.meta.bbox;
  const outside = pts.findIndex(([lon, lat]) => !(lon >= lonMin && lon <= lonMax && lat >= latMin && lat <= latMax));
  if (outside >= 0) return { error: 'point_outside_map', point: pts[outside], bbox: site.meta.bbox };
  // Snap clicks/GPS positions that land on a forbidden cell (e.g. a rock) to the nearest walkable one
  const cellsOf = pts.map(([lon, lat]) => snapToPassable(grid, lonLatToCell(site.meta, lon, lat).i));
  if (cellsOf.some((c) => c < 0)) return { error: 'point_in_forbidden_zone' };

  // Work time at each stop/goal (the real limit of EVA-1 per Marco): minutes standing at a target
  // doing the task. Source, in priority: req.task_min[k-1] > target.properties.task_min > params.task_min[kind].
  const taskMin = pts.map((p, k) => (k === 0 ? 0 : taskMinutesAt(site, params, p, req.task_min?.[k - 1])));
  const taskO2 = taskMin.map((m) => m * ((params.task_W ?? params.P_nom ?? 351.7) / (params.P_nom ?? 351.7)) * (state.o2_x ?? 1));

  const all = [], segments = [], extraO2 = new Map(); // path index -> task O2 spent there
  for (let k = 0; k < cellsOf.length - 1; k++) {
    const leg = astar(grid, cellsOf[k], cellsOf[k + 1]);
    if (!leg) return { error: 'unreachable', leg: k, from: pts[k], to: pts[k + 1] };
    const legStats = pathStats(leg, site, grid, params, state);
    legStats.task_min = taskMin[k + 1];
    segments.push({ from: pts[k], to: pts[k + 1], stats: legStats });
    all.push(...(k === 0 ? leg : leg.slice(1)));
    if (taskO2[k + 1] > 0) extraO2.set(all.length - 1, taskO2[k + 1]);
  }
  const stats = pathStats(all, site, grid, params, state);
  const taskTotal = taskMin.reduce((a, b) => a + b, 0);
  const taskO2Total = taskO2.reduce((a, b) => a + b, 0);
  const o2Total = (site.suit?.o2_hours?.value ?? 8) * 60;
  stats.walk_min = stats.duration_min;
  stats.task_min = Math.round(taskTotal);
  stats.duration_min = Math.round(stats.walk_min + taskTotal);
  stats.o2_used_pct = +(stats.o2_used_pct + (100 * taskO2Total) / o2Total).toFixed(1);
  stats.dose_mSv = +((params.gcr_mSv_per_h ?? 0.028) * (stats.duration_min / 60) * (state.dose_x ?? 1)).toFixed(4);
  // req.o2_used_min: O2 already spent before this plan starts (used by replan mid-EVA)
  const wb = walkbackCheck(all, grid, costToHome, usableO2min(site.suit) - (req.o2_used_min || 0), extraO2);
  // Rule 1 (O2): used so far + cheapest return <= usable O2, at every point
  stats.o2_return_ok = wb.ok;
  stats.o2_margin_min = wb.margin_min;
  // Rule 2 (walkback, ICES-2026-127): walking distance home <= walkback_m, at every point
  let maxBack = 0;
  for (const i of all) if (distToHome[i] > maxBack) maxBack = distToHome[i];
  const walkbackM = site.suit?.walkback_m?.value ?? Infinity;
  stats.walkback_max_m = Math.round(maxBack);
  stats.walkback_ok = maxBack <= walkbackM;
  // Battery (suit electronics, NOT metabolism): hours of EVA vs battery_Wh / base_power_W
  const battH = (site.suit?.battery_Wh?.value ?? Infinity) / (site.suit?.base_power_W?.value ?? 1);
  stats.battery_used_pct = +((100 * stats.duration_min) / 60 / battH).toFixed(1);
  stats.safe = stats.o2_return_ok && stats.walkback_ok && stats.battery_used_pct <= 100;
  return {
    path: {
      type: 'Feature',
      properties: {},
      geometry: { type: 'LineString', coordinates: all.map((i) => cellToLonLat(site.meta, i)) },
    },
    stats,
    o2_worst_point: cellToLonLat(site.meta, all[wb.worst_point]),
    turnaround_point: wb.turnaround >= 0 ? cellToLonLat(site.meta, all[wb.turnaround]) : null,
    segments,
    timing_ms: { cost_grid: Math.round(tCost - t0), astar: Math.round(performance.now() - tCost) },
  };
}

// Task minutes at a point: matches a target within ~2 cells.
export function taskMinutesAt(site, params, [lon, lat], override) {
  if (typeof override === 'number') return override;
  const tol = 2.5 * site.meta.cell_m;
  const mPerDegLat = 59270, mPerDegLon = mPerDegLat * Math.cos((lat * Math.PI) / 180);
  for (const f of site.targets?.features || []) {
    const [tl, ta] = f.geometry.coordinates;
    if (Math.hypot((tl - lon) * mPerDegLon, (ta - lat) * mPerDegLat) <= tol) {
      const p = f.properties || {};
      return p.task_min ?? params.task_min?.[p.kind] ?? 0;
    }
  }
  return 0;
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
    // SPE: only places that actually protect from radiation. A shelter must declare
    // properties.radiation_shelter === true (Marco's muster point does NOT -> SPE goes to the habitat).
    candidates = site.targets.features
      .filter((f) => f.properties.kind === 'habitat' || (f.properties.kind === 'shelter' && f.properties.radiation_shelter === true))
      .map((f) => ({ name: f.properties.name, coords: f.geometry.coordinates }));
  } else {
    candidates = [{ name: 'Habitat', coords: habitat }];
  }
  if (!candidates.length) candidates = [{ name: 'Habitat', coords: habitat }];

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
  const { costToHome, distToHome } = getGrid(site, params, req.state || {});
  return {
    costToHome: costToHome.slice(), distToHome: distToHome.slice(),
    usable_o2_min: usableO2min(site.suit), walkback_m: site.suit?.walkback_m?.value ?? null,
  };
}
