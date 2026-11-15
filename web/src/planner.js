// planner.js — Pure planning logic (no DOM, no worker). Testable in Node.
// Concept: global costmap + global planner, same idea as ROS Nav2.
//
//   layers --(cellCost per cell)--> costGrid (Float32Array, O2-min per meter)
//   costGrid --(A* per leg)--> path cells --> GeoJSON + stats

import { MinHeap } from './heap.js';
import * as costModel from './cost.js';
import * as radiation from './radiation.js'; // Ana: doseTotal(segments, params), rate in params.gcr_mSv_per_h

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
//
// Speed trick (00:45): cellCost (Ana) = physiology only and does NOT depend on the alert state,
// so it's evaluated ONCE per terrain+params (buildBaseO2, the expensive 1M calls).
// An alert only multiplies/penalizes that base (applyState, a cheap pass).
export function buildBaseO2(layers, meta, params, cellCost = defaultCellCost, suit = null) {
  const n = meta.width * meta.height;
  const o2 = new Float32Array(n);
  const maxSlope = suit?.max_slope_deg?.value ?? Infinity;
  for (let i = 0; i < n; i++) {
    // Hard safety limit from suit.json enforced here too (defense in depth)
    let c = layers.slope[i] > maxSlope ? Infinity : cellCost(i, layers, params, {});
    if (!(c >= 0)) c = Infinity; // NaN or negative (bad data / bug) -> impassable
    o2[i] = c;
  }
  return { o2, W: meta.width, H: meta.height, cellM: meta.cell_m, meta };
}

// ---------- Live map updates (Tier 1 A, 11:30) ----------
// state.obstacles: [{id, lon, lat, radius_m, kind: 'blocked'|'caution', source: 'astronaut'|'rover'|'drone'|'console', note}]
// 'blocked' -> impassable (O2 and routing = Infinity). 'caution' -> routing ×(1 + w_obstacle_caution), O2 unchanged.
// The same mechanism serves an astronaut report, a rover/drone image, or a console edit (idea #1 + #13).
function obstacleCells(meta, ob) {
  const { row: r0, col: c0 } = lonLatToCell(meta, ob.lon, ob.lat);
  const R = Math.max(0, Math.ceil((ob.radius_m ?? 10) / meta.cell_m));
  const out = [];
  for (let dr = -R; dr <= R; dr++) for (let dc = -R; dc <= R; dc++) {
    const r = r0 + dr, c = c0 + dc;
    if (r < 0 || r >= meta.height || c < 0 || c >= meta.width) continue;
    if ((dr * dr + dc * dc) * meta.cell_m * meta.cell_m <= (ob.radius_m ?? 10) ** 2 + 1e-9) out.push(r * meta.width + c);
  }
  return out;
}

export function applyState(base, layers, params, state = {}) {
  const n = base.o2.length;
  const o2x = state.o2_x ?? 1;          // suit failure: consumption ×1.5
  const vis = state.visibility ?? 1;    // dust: 1 = clear, 0.3 = poor
  const wNoComms = params?.w_nocomms ?? 0.2;
  // Avoid yellow (hazard = 1) zones: routing-only penalty, NOT oxygen (Pandolf already charges slope/terrain).
  // params.w_caution (Ana) or state.w_caution (UI toggle) overrides the default.
  const wCaution = state.w_caution ?? pval(params?.w_caution) ?? 0.5;
  const obstacles = state.obstacles || [];
  const o2 = o2x === 1 && !obstacles.length ? base.o2 : new Float32Array(n);
  const copyO2 = o2 !== base.o2;
  const cost = new Float32Array(n);
  let minCost = Infinity;
  for (let i = 0; i < n; i++) {
    const phys = copyO2 ? (o2[i] = base.o2[i] * o2x) : base.o2[i];
    let r = phys;
    if (r < Infinity) {
      if (layers.viewshed && layers.viewshed[i] === 0) r *= 1 + wNoComms;
      if (wCaution && layers.hazard[i] === 1) r *= 1 + wCaution;
      if (vis < 1) r *= 1 + (1 - vis) * (layers.slope[i] / 10 + layers.roughness[i]); // avoid steep/rough when you can't see
    }
    cost[i] = r;
  }
  if (obstacles.length && base.meta) {
    const wObs = pval(params?.w_obstacle_caution) ?? 2.0;
    for (const ob of obstacles) for (const i of obstacleCells(base.meta, ob)) {
      if ((ob.kind ?? 'blocked') === 'blocked') { cost[i] = Infinity; o2[i] = Infinity; }
      else if (cost[i] < Infinity) cost[i] *= 1 + wObs;
    }
  }
  for (let i = 0; i < n; i++) if (cost[i] < minCost) minCost = cost[i];
  return { cost, o2, minCost, W: base.W, H: base.H, cellM: base.cellM };
}

export function buildCostGrid(layers, meta, params, state, cellCost = defaultCellCost, suit = null) {
  return applyState(buildBaseO2(layers, meta, params, cellCost, suit), layers, params, state);
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

// Multi-source Dijkstra: seeds = [{cell, value}] (initial cost at each source). Used for the cost-to-SAFETY field.
export function dijkstraMulti(grid, seeds) {
  const { cost, W, H, cellM } = grid;
  const n = W * H, dist = new Float32Array(n).fill(Infinity), closed = new Uint8Array(n), open = new MinHeap(1 << 20);
  for (const sd of seeds) if (sd.cell >= 0 && cost[sd.cell] < Infinity && sd.value < dist[sd.cell]) { dist[sd.cell] = sd.value; open.push(sd.value, sd.cell); }
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

// Tier 2: cost to SAFETY (12:45). Safe = the habitat, OR a cache with enough O2 that, after refilling there, the
// crew can still get home. Seed of a cache c = max(0, refill task O2 + costToHome[c] − O2 available at c):
// "what I'd still be missing after refilling". One multi-source Dijkstra over the physical O2 grid.
// Without caches this is exactly costToHome. The O2 rule uses this field.
function safetyField(site, params, state, e) {
  const caches = (site.targets?.features || []).filter((f) => f.properties?.station_type === 'cache');
  const avail = (f) => Math.max(0, (pval(f.properties.supplies?.o2_min) ?? 0) - (state.cache_used?.[f.properties.id] ?? 0));
  const live = caches.filter((f) => avail(f) > 0);
  if (!live.length) return e.costToHome;
  const key = JSON.stringify(live.map((f) => [f.properties.id, avail(f)]));
  if (e.safetyKey === key) return e.safety;
  const workFactor = pval(params.work_metabolic_factor) ?? 1, o2x = state.o2_x ?? 1;
  const refillO2 = (pval(params.task_min?.cache_refill) ?? 10) * workFactor * o2x;
  const g = { ...e.grid, cost: e.grid.o2 };
  const seeds = live.map((f) => {
    const cell = snapToPassable(g, lonLatToCell(site.meta, ...f.geometry.coordinates).i);
    return { cell, value: cell >= 0 ? Math.max(0, refillO2 + e.costToHome[cell] - avail(f)) : Infinity };
  });
  const viaCaches = dijkstraMulti(g, seeds);
  const out = new Float32Array(viaCaches.length);
  for (let i = 0; i < out.length; i++) out[i] = Math.min(e.costToHome[i], viaCaches[i]);
  e.safety = out; e.safetyKey = key;
  return out;
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
// refillAt: Map(path index -> max O2-min available at a cache stop). used0 = O2 already used before the plan.
// At a cache the crew tops the suit back up: used drops by min(available, total used so far).
export function walkbackCheck(cells, grid, costToHome, usable, extraO2 = new Map(), refillAt = new Map(), used0 = 0) {
  const W = grid.W;
  let used = 0, margin = Infinity, worstIdx = 0, turnaround = -1;
  const refills = [];
  for (let k = 0; k < cells.length; k++) {
    const i = cells[k];
    if (k > 0) {
      const p = cells[k - 1];
      const diag = Math.floor(p / W) !== Math.floor(i / W) && p % W !== i % W;
      used += 0.5 * (grid.o2[p] + grid.o2[i]) * (diag ? SQRT2 : 1) * grid.cellM; // physical O2
    }
    used += extraO2.get(k) || 0; // task done at this stop: must still be able to get home AFTER it
    if (refillAt.has(k)) {        // Tier 2: cache refill (after the refill task)
      const amount = Math.max(0, Math.min(refillAt.get(k), used0 + used));
      used -= amount; refills.push({ index: k, amount: +amount.toFixed(1) });
    }
    const slack = usable - (used + costToHome[i]);
    if (slack < margin) { margin = slack; worstIdx = k; }
    if (slack < 0 && turnaround === -1) turnaround = Math.max(0, k - 1);
  }
  return { ok: margin >= 0, margin_min: +margin.toFixed(1), worst_point: worstIdx, turnaround, refills };
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
    walk_min_exact: +(seconds / 60).toFixed(3),
    o2_used_min: +o2min.toFixed(2), // physical O2-min (exact-ish), avoids double rounding of %
    o2_used_pct: +((100 * o2min) / o2Total).toFixed(1),
    dose_mSv: +doseOf([{ minutes: seconds / 60, doseX: state.dose_x }], params).toFixed(4),
    max_slope_deg: +maxSlope.toFixed(1),
    walkback_ok: null, // filled by plan() (needs costToHome / distToHome)
    comms_pct: Math.round((100 * comms) / cells.length),
  };
}

// ---------- 4. Public API: plan() ----------
// req: { start:[lon,lat], stops:[[lon,lat],...], goal:[lon,lat], params?, state? }
// Cache per TERRAIN (WeakMap keyed by the layers object) and, inside it, per (params, state).
// Bug found by the hand check (00:30): a single global cache ignored the terrain, so switching
// site (mock -> jezero) reused the old cost grid.
const caches = new WeakMap(); // layers -> { key, grid, costToHome, distToHome }

// Cost grid + costToHome depend only on (params, state). Recompute only when those change
// (i.e. when an alert arrives) — that's why replanning is cheap.
export function getGrid(site, params, state) {
  // Level 1 (expensive, once per terrain + params): base O2, costToHome at o2_x = 1, distToHome
  const baseKey = JSON.stringify([params, site.meta, site.suit?.max_slope_deg?.value]);
  let c = caches.get(site.layers);
  if (!c || c.baseKey !== baseKey) {
    const base = buildBaseO2(site.layers, site.meta, params, defaultCellCost, site.suit);
    const g0 = applyState(base, site.layers, params, {});
    const home = snapToPassable(g0, lonLatToCell(site.meta, ...site.meta.habitat).i);
    c = {
      baseKey, base, home, byState: new Map(),
      costToHomeBase: dijkstraFrom({ ...g0, cost: g0.o2 }, home), // physical O2-min home
      distToHome: dijkstraFrom(unitGrid(g0), home),               // meters home (state-independent)
    };
    caches.set(site.layers, c);
  }
  // Level 2 (cheap, per alert state): routing grid + scaled costToHome.
  // A uniform factor o2_x scales every path equally, so the cheapest way home costs exactly ×o2_x.
  const sk = JSON.stringify(state || {});
  let e = c.byState.get(sk);
  if (!e) {
    const grid = applyState(c.base, site.layers, params, state || {});
    const o2x = state?.o2_x ?? 1;
    let costToHome = c.costToHomeBase, distToHome = c.distToHome;
    if (state?.obstacles?.length) {
      // Obstacles change WHICH cells are walkable -> scaling isn't enough, recompute (~2 × 150 ms)
      costToHome = dijkstraFrom({ ...grid, cost: grid.o2 }, c.home);
      distToHome = dijkstraFrom(unitGrid(grid), c.home);
    } else if (o2x !== 1) { costToHome = new Float32Array(c.costToHomeBase.length); for (let i = 0; i < costToHome.length; i++) costToHome[i] = c.costToHomeBase[i] * o2x; }
    e = { grid, costToHome, distToHome };
    if (c.byState.size >= 8) c.byState.clear();
    c.byState.set(sk, e);
  }
  return e;
}

export function plan(site, req) {
  const t0 = performance.now();
  const params = { ...site.params, ...(req.params || {}) };
  const state = req.state || {};
  const gridEntry = getGrid(site, params, state);
  const { grid, costToHome, distToHome } = gridEntry;
  const costToSafety = safetyField(site, params, state, gridEntry);   // == costToHome when there are no caches
  const tCost = performance.now();

  const pts = [req.start, ...(req.stops || []), req.goal];
  // Points outside the map would map to garbage cell indices -> reject explicitly
  const [lonMin, latMin, lonMax, latMax] = site.meta.bbox;
  const outside = pts.findIndex(([lon, lat]) => !(lon >= lonMin && lon <= lonMax && lat >= latMin && lat <= latMax));
  if (outside >= 0) return { error: 'point_outside_map', point: pts[outside], bbox: site.meta.bbox };
  // Snap clicks/GPS positions that land on a forbidden cell (e.g. a rock) to the nearest walkable one
  const cellsOf = pts.map(([lon, lat], k) => snapToPassable(grid, lonLatToCell(site.meta, lon, lat).i, k === 0 ? 40 : 10));
  const bad = cellsOf.findIndex((c) => c < 0);
  if (bad >= 0) return { error: 'point_in_forbidden_zone', point: bad, coords: pts[bad] }; // point: 0 = start, k = stop k-1

  // Work time at each stop/goal (the real limit of EVA-1 per Marco): minutes standing at a target
  // doing the task. Source, in priority: req.task_min[k-1] > target.properties.task_min > params.task_min[kind].
  const ctx = {};
  const last = pts.length - 1;
  const taskMin = pts.map((p, k) => {
    if (k > 0 && typeof req.task_min?.[k - 1] === 'number') return req.task_min[k - 1]; // explicit override
    if (k === 0 && typeof req.start_task_min === 'number') return req.start_task_min;
    return taskMinutesAt(site, params, p, k === 0 ? 'start' : k === last ? 'end' : 'stop', ctx);
  });
  // Work metabolic rate relative to P_nom (Ana: work_metabolic_factor = 1.0, conservative)
  const workFactor = pval(params.work_metabolic_factor) ?? (params.task_W ? params.task_W / (params.P_nom ?? 351.7) : 1);
  const taskO2 = taskMin.map((m) => m * workFactor * (state.o2_x ?? 1));

  const all = [], segments = [], extraO2 = new Map(); // path index -> task O2 spent there
  const refillAt = new Map(), refillInfo = new Map();   // Tier 2: caches the route STOPS at (start/end excluded)
  const cacheLeft = (f) => Math.max(0, (pval(f.properties.supplies?.o2_min) ?? 0) - (state.cache_used?.[f.properties.id] ?? 0));
  if (taskO2[0] > 0) extraO2.set(0, taskO2[0]); // egress at the start (suit O2 already flowing)
  const doseSegs = []; // one per leg (walk + task), for radiation.doseTotal
  // Assumption: egress/ingress happen in the habitat airlock (shielded) -> they cost O2 and time, not dose.
  const inAirlock = pts.map((p) => targetAt(site, p)?.properties?.kind === 'habitat');
  for (let k = 0; k < cellsOf.length - 1; k++) {
    const leg = astar(grid, cellsOf[k], cellsOf[k + 1]);
    if (!leg) return { error: 'unreachable', leg: k, from: pts[k], to: pts[k + 1] };
    const legStats = pathStats(leg, site, grid, params, state);
    legStats.task_min = taskMin[k + 1];
    const exposedMin = legStats.walk_min_exact + (inAirlock[k + 1] ? 0 : taskMin[k + 1]);
    legStats.dose_mSv = +doseOf([{ minutes: exposedMin, doseX: state.dose_x }], params).toFixed(4);
    doseSegs.push({ minutes: exposedMin, doseX: state.dose_x });
    segments.push({ from: pts[k], to: pts[k + 1], stats: legStats });
    all.push(...(k === 0 ? leg : leg.slice(1)));
    if (taskO2[k + 1] > 0) extraO2.set(all.length - 1, taskO2[k + 1]);
    if (k + 1 < pts.length - 1) {
      const f = targetAt(site, pts[k + 1]);
      if (f?.properties?.station_type === 'cache' && cacheLeft(f) > 0) { refillAt.set(all.length - 1, cacheLeft(f)); refillInfo.set(all.length - 1, f.properties); }
    }
  }
  const stats = pathStats(all, site, grid, params, state);
  const taskTotal = taskMin.reduce((a, b) => a + b, 0);
  const taskO2Total = taskO2.reduce((a, b) => a + b, 0);
  const o2Total = (site.suit?.o2_hours?.value ?? 8) * 60;
  stats.walk_min = stats.duration_min;
  stats.task_min = Math.round(taskTotal);
  stats.duration_min = Math.round(stats.walk_min + taskTotal);
  stats.o2_used_min = +(stats.o2_used_min + taskO2Total).toFixed(2);
  stats.o2_used_pct = +((100 * stats.o2_used_min) / o2Total).toFixed(1); // round ONCE, from exact minutes
  stats.dose_mSv = +doseOf(doseSegs, params).toFixed(4); // Ana's model, per leg (walk + task)
  // req.o2_used_min: O2 already spent before this plan starts (used by replan mid-EVA)
  const wb = walkbackCheck(all, grid, costToSafety, usableO2min(site.suit) - (req.o2_used_min || 0), extraO2, refillAt, req.o2_used_min || 0);
  // Tier 2: what was taken from each cache (the console adds it to state.cache_used -> inventory for resupply planning)
  const refills = wb.refills.map((r) => ({ id: refillInfo.get(r.index).id, name: refillInfo.get(r.index).name, o2_min: r.amount }));
  stats.o2_refilled_min = +refills.reduce((s, r) => s + r.o2_min, 0).toFixed(1);
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
  // Day/night (idea #3 + #10): only if the caller says when the EVA starts (Mars local time, LMST hours)
  if (typeof req.start_lmst === 'number') {
    Object.assign(stats, daylightCheck(params, req.start_lmst, stats.duration_min));
    if (stats.go === 'NO-GO') stats.safe = false;
  }
  return {
    path: {
      type: 'Feature',
      properties: {},
      geometry: { type: 'LineString', coordinates: all.map((i) => cellToLonLat(site.meta, i)) },
    },
    stats,
    o2_worst_point: cellToLonLat(site.meta, all[wb.worst_point]),
    refills,
    turnaround_point: wb.turnaround >= 0 ? cellToLonLat(site.meta, all[wb.turnaround]) : null,
    segments,
    timing_ms: { cost_grid: Math.round(tCost - t0), astar: Math.round(performance.now() - tCost) },
  };
}

// ---------- Task time (Ana's params.task_min, each entry {value, source, assumption}) ----------
const pval = (x) => (x && typeof x === 'object' ? x.value : x);

// Target feature within ~2.5 cells of a point, or null.
export function targetAt(site, [lon, lat]) {
  // Nearest target within ~2.5 cells. If several coincide (e.g. an O2 cache placed AT the Hawksbill safe point),
  // the cache wins: it's the one that changes the plan (refill). Bug found 12:55.
  const tol = 2.5 * site.meta.cell_m;
  const mPerDegLat = 59270, mPerDegLon = mPerDegLat * Math.cos((lat * Math.PI) / 180);
  let best = null, bestD = Infinity;
  for (const f of site.targets?.features || []) {
    const [tl, ta] = f.geometry.coordinates;
    const d = Math.hypot((tl - lon) * mPerDegLon, (ta - lat) * mPerDegLat);
    if (d > tol) continue;
    const isCache = f.properties?.station_type === 'cache';
    if (d < bestD - 0.5 || (Math.abs(d - bestD) <= 0.5 && isCache)) { best = f; bestD = d; }
  }
  return best;
}

// Minutes of work at a point. role: 'start' | 'stop' | 'end'. ctx carries depot setup (charged once).
//   depot   -> depot_per_tube (+ depot_setup the first time the EVA reaches the depot)
//   science -> science;  shelter -> shelter
//   habitat -> habitat_egress if the EVA starts there, habitat_ingress if it ends there
// A target's own properties.task_min (number) overrides the defaults.
export function taskMinutesAt(site, params, point, role = 'stop', ctx = {}) {
  const f = targetAt(site, point);
  if (!f) return 0;
  const p = f.properties || {};
  if (typeof p.task_min === 'number') return p.task_min;
  const T = params.task_min || {};
  switch (p.kind) {
    case 'depot': {
      let m = pval(T.depot_per_tube) ?? pval(T.depot) ?? 0;
      if (!ctx.depotSetupDone) { m += pval(T.depot_setup) ?? 0; ctx.depotSetupDone = true; }
      return m;
    }
    case 'science': return pval(T.science) ?? 0;
    case 'shelter':
      if (p.station_type === 'cache' && role === 'stop') return pval(T.cache_refill) ?? 10;   // swap/top-up O2 (assumption)
      return role === 'stop' || role === 'end' ? pval(T.shelter) ?? 0 : 0;
    case 'habitat':
      if (role === 'start') return pval(T.habitat_egress) ?? 0;
      if (role === 'end') return pval(T.habitat_ingress) ?? pval(T.habitat) ?? 0;
      return 0;
    default: return 0;
  }
}

// Dose via Ana's radiation.js. segments: [{minutes, doseX}]. Never crash the UI on bad params.
function doseOf(segments, params) {
  try {
    return radiation.doseTotal(segments, params);
  } catch (e) {
    console.warn('[planner] radiation.doseTotal failed, using RAD 0.67 mSv/day fallback:', e.message);
    return segments.reduce((s, g) => s + (0.67 / 24) * (g.minutes / 60) * (g.doseX ?? 1), 0);
  }
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
  // start_task_min 0: a replan starts where the astronaut IS; it's not a new egress even if standing at the habitat
  const base = { start: req.current, stops: [], params: req.params, state, o2_used_min: req.o2_used_min, start_task_min: 0, start_lmst: req.now_lmst };
  const habitat = site.meta.habitat;
  // Same identity for the habitat whatever the alert (UI should use destination_id / destination_kind, not the name)
  const habF = site.targets?.features?.find((f) => f.properties?.kind === 'habitat');
  const habitatCandidate = { id: habF?.properties.id ?? 'habitat', kind: 'habitat', name: habF?.properties.name ?? 'Habitat', coords: habitat };

  // Three behaviours (12:10):
  //   'shelter'    (SPE)          -> fastest RADIATION-SAFE place: habitat or shelter with radiation_shelter: true
  //   'safe_point' (dust storm)   -> fastest of habitat or ANY shelter / safe point: get out of the storm now
  //   'return'     (suit failure) -> the habitat only (repair equipment is there)
  // Every candidate is reported in replan.considered (minutes, eligible, why) so the UI can SHOW the choice.
  const allShelters = site.targets.features.filter((f) => f.properties.kind === 'shelter');
  const considered = [];
  let candidates;
  if (req.alert.action === 'resupply') {
    // O2 emergency: go home directly, or via the cache that makes the return safe. Judged by the O2 rule.
    const caches = site.targets.features.filter((f) => f.properties.station_type === 'cache');
    let bestR = null;
    const tryOne = (stops, target) => {
      const p = plan(site, { ...base, stops, goal: habitat });
      considered.push({ id: target.id, name: target.name, kind: target.kind, eligible: !p.error && p.stats.o2_return_ok,
        minutes: p.error ? null : p.stats.duration_min, why: p.error ? p.error : p.stats.o2_return_ok ? (stops.length ? `refill ${p.stats.o2_refilled_min} min O2 then home` : 'direct') : 'not enough O2' });
      if (p.error) return;
      const score = (p.stats.o2_return_ok ? 1e6 : 0) + p.stats.o2_margin_min - p.stats.duration_min / 100;
      if (!bestR || score > bestR.score) bestR = { plan: p, target, score };
    };
    tryOne([], habitatCandidate);
    for (const f of caches) tryOne([f.geometry.coordinates], { id: f.properties.id, kind: 'cache', name: f.properties.name, coords: f.geometry.coordinates });
    if (!bestR) return { error: 'no_safe_destination', alert: req.alert.id, state };
    return { ...bestR.plan, state, replan: { alert: req.alert.id, type: req.alert.type, action: 'resupply', destination: bestR.target.name,
      destination_id: bestR.target.id, destination_kind: bestR.target.kind, via_cache: bestR.target.kind === 'cache', fallback_to_safe_point: false,
      considered: considered.map((c) => ({ ...c, chosen: c.id === bestR.target.id })), total_ms: Math.round(performance.now() - t0) } };
  }
  if (req.alert.action === 'safe_point') {
    candidates = [habitatCandidate, ...allShelters.map((f) => ({ id: f.properties.id, kind: 'shelter', name: f.properties.name, coords: f.geometry.coordinates }))];
  } else if (req.alert.action === 'shelter') {
    // SPE: only places that actually protect from radiation. A shelter must declare
    // properties.radiation_shelter === true (Marco's muster point does NOT -> SPE goes to the habitat).
    candidates = site.targets.features
      .filter((f) => f.properties.kind === 'habitat' || (f.properties.kind === 'shelter' && f.properties.radiation_shelter === true))
      .map((f) => ({ id: f.properties.id, kind: f.properties.kind, name: f.properties.name, coords: f.geometry.coordinates }));
  } else {
    candidates = [habitatCandidate];
  }
  if (!candidates.length) candidates = [habitatCandidate];

  let best = null;
  for (const c of candidates) {
    const p = plan(site, { ...base, goal: c.coords });
    considered.push({ id: c.id, name: c.name, kind: c.kind, eligible: !p.error, minutes: p.error ? null : p.stats.walk_min,
      why: p.error ? p.error : 'candidate' });
    if (p.error) continue;
    if (!best || p.stats.walk_min < best.plan.stats.walk_min) best = { plan: p, target: c };   // by WALKING time (exposure)
  }
  // Shelters that were NOT eligible for this alert are listed too (e.g. "not radiation-protected" during an SPE)
  if (req.alert.action === 'shelter') for (const f of allShelters) if (f.properties.radiation_shelter !== true) {
    const p = plan(site, { ...base, goal: f.geometry.coordinates });
    considered.push({ id: f.properties.id, name: f.properties.name, kind: 'shelter', eligible: false, minutes: p.error ? null : p.stats.walk_min, why: 'not radiation-protected' });
  }
  if (req.alert.action === 'return') for (const f of allShelters) considered.push({ id: f.properties.id, name: f.properties.name, kind: 'shelter', eligible: false, minutes: null, why: 'suit failure: repair needs the habitat' });
  // Tier 1 F (idea #15): 'return' (dust, suit) but the habitat is NOT safely reachable (O2 / daylight) ->
  // go to the fastest SAFE shelter / safe point instead (any kind: it's about getting out of the storm).
  // A safe point is judged by "I reach it without touching the reserve" (that's what it's for), not by the
  // reach-home-from-everywhere rule. Only triggers when the habitat itself doesn't fit (O2 or daylight).
  let fallback = false;
  const usable = usableO2min(site.suit), used0 = req.o2_used_min || 0;
  const fits = (p) => !p.error && used0 + p.stats.o2_used_min <= usable && p.stats.go !== 'NO-GO';
  if (req.alert.action !== 'shelter' && (!best || !fits(best.plan))) {
    let alt = null;
    for (const f of site.targets.features.filter((f) => f.properties.kind === 'shelter')) {
      const p = plan(site, { ...base, goal: f.geometry.coordinates });
      if (!fits(p)) continue;
      if (!alt || p.stats.duration_min < alt.plan.stats.duration_min)
        alt = { plan: p, target: { id: f.properties.id, kind: 'shelter', name: f.properties.name, coords: f.geometry.coordinates } };
    }
    if (alt) { best = alt; fallback = true; best.plan.stats.reaches_destination_with_reserve = true;
      considered.push({ id: alt.target.id, name: alt.target.name, kind: 'shelter', eligible: true, minutes: alt.plan.stats.walk_min, why: 'fallback: habitat not reachable with O2/daylight' }); }
  }
  if (!best) return { error: 'no_safe_destination', alert: req.alert.id, state };
  return {
    ...best.plan,
    state, // the tablet keeps this and sends it back on the next replan (alerts stack)
    replan: {
      alert: req.alert.id, type: req.alert.type, action: req.alert.action,
      destination: best.target.name, destination_id: best.target.id, destination_kind: best.target.kind,
      candidates: candidates.length, fallback_to_safe_point: fallback,
      considered: considered.map((c) => ({ ...c, chosen: c.id === best.target.id })).sort((a, b) => (a.minutes ?? 1e9) - (b.minutes ?? 1e9)),
      total_ms: Math.round(performance.now() - t0),
    },
  };
}

// ---------- Day / night (Tier 1 E) ----------
// Mars solar day (sol) = 88 775 s = 24 Mars hours of 61.65 Earth minutes. Times are LMST (local mean solar time).
// sunrise/sunset come from params (Ana/Gabriel, from the Mars Climate Database at Jezero for the chosen Ls).
export const EARTH_MIN_PER_MARS_HOUR = 88775.244 / 24 / 60; // 61.649
const fmtLmst = (h) => { const x = ((h % 24) + 24) % 24; return `${String(Math.floor(x)).padStart(2, '0')}:${String(Math.floor((x % 1) * 60)).padStart(2, '0')}`; };
export function daylightCheck(params, startLmst, durationMin) {
  const sunrise = pval(params?.sunrise_lmst) ?? 6.0, sunset = pval(params?.sunset_lmst) ?? 18.0;
  const buffer = pval(params?.night_buffer_min) ?? 30;                 // Earth minutes before sunset we want to be home
  const endLmst = startLmst + durationMin / EARTH_MIN_PER_MARS_HOUR;
  const marginMin = (sunset - endLmst) * EARTH_MIN_PER_MARS_HOUR;      // + = home before sunset
  let go = marginMin >= buffer ? 'GO' : marginMin >= 0 ? 'CAUTION' : 'NO-GO';
  if (startLmst < sunrise) go = 'NO-GO';                                 // leaving in the dark
  return {
    start_lmst: +startLmst.toFixed(3), end_lmst: +endLmst.toFixed(3),
    start_lmst_hhmm: fmtLmst(startLmst), end_lmst_hhmm: fmtLmst(endLmst), sunset_lmst_hhmm: fmtLmst(sunset),
    daylight_margin_min: Math.round(marginMin), go,
  };
}

// ---------- Adaptive mission (Tier 1 B, idea #12; also used after a map update, idea #1/#13) ----------
// "Something took longer / the map changed: can I still do the rest?"
// req: { current:[lon,lat], stops:[[lon,lat]...] (remaining, in order), goal?:[lon,lat] (default habitat),
//        state?, o2_used_min?, now_lmst?, params? }
// Plans current -> remaining stops -> goal. If not safe (O2 rule, walkback, battery, daylight) or a stop became
// unreachable, drops stops one at a time — lowest science_value first; among ties the one whose removal leaves
// the biggest O2 margin — until the plan is safe. decision: 'continue' | 'skip' | 'return'.
export function adapt(site, req) {
  const t0 = performance.now();
  const goal = req.goal ?? site.meta.habitat;
  const mk = (stops) => plan(site, { start: req.current, stops, goal, params: req.params, state: req.state, o2_used_min: req.o2_used_min,
    start_task_min: 0, start_lmst: req.now_lmst });
  let kept = (req.stops || []).map((p, i) => {
    const f = targetAt(site, p);
    return { p, i, id: f?.properties.id ?? `stop-${i}`, name: f?.properties.name ?? 'Custom point', value: f?.properties.science_value ?? 3 };
  });
  const dropped = [];
  const ok = (r) => !r.error && r.stats.safe;
  let res = mk(kept.map((k) => k.p));
  // Tier 2: if unsafe only because of O2, first try a detour to a cache (refill) before dropping any science
  let viaCache = null;
  if (!ok(res) && !res.error && res.stats.go !== 'NO-GO') {
    for (const f of site.targets.features.filter((f) => f.properties.station_type === 'cache')) {
      const r = mk([f.geometry.coordinates, ...kept.map((k) => k.p)]);
      if (ok(r) && (!viaCache || r.stats.duration_min < viaCache.r.stats.duration_min)) viaCache = { f, r };
    }
    if (viaCache) res = viaCache.r;
  }
  let guard = 0;
  while (!ok(res) && kept.length && guard++ < 50) {
    let victims;
    if (res.error === 'unreachable' && res.leg < kept.length) victims = [kept[res.leg]];   // that stop is cut off
    else if (res.error === 'point_in_forbidden_zone' && res.point >= 1 && res.point <= kept.length) victims = [kept[res.point - 1]]; // obstacle on top of it
    else { const minV = Math.min(...kept.map((k) => k.value)); victims = kept.filter((k) => k.value === minV); }
    let best = null;
    for (const v of victims) {
      const trial = kept.filter((k) => k !== v);
      const r = mk(trial.map((k) => k.p));
      const score = r.error ? -Infinity : (r.stats.safe ? 1e6 : 0) + r.stats.o2_margin_min + (r.stats.daylight_margin_min ?? 0);
      if (!best || score > best.score) best = { v, trial, r, score };
    }
    dropped.push({ id: best.v.id, name: best.v.name, science_value: best.v.value,
      reason: res.error ? 'unreachable (map update)' : !res.error && res.stats.go === 'NO-GO' ? 'not enough daylight' : 'not enough O2 / walkback margin' });
    kept = best.trial; res = best.r;
  }
  const decision = viaCache ? 'refill' : !dropped.length ? 'continue' : kept.length ? 'skip' : 'return';
  if (res.error) return { error: res.error, adapt: { decision: 'return', dropped, kept: [] } };
  return {
    ...res,
    adapt: {
      decision, dropped, kept: kept.map((k) => ({ id: k.id, name: k.name, science_value: k.value })),
      via_cache: viaCache ? { id: viaCache.f.properties.id, name: viaCache.f.properties.name } : null,
      safe: res.stats.safe, total_ms: Math.round(performance.now() - t0),
    },
  };
}

// For the tablet's "no-return ring": the raw costToHome raster (O2-min, Infinity = unreachable).
// Tablet logic: cell i is beyond no-return if costToHome[i] > O2 remaining now.
export function getCostToHome(site, req = {}) {
  const params = { ...site.params, ...(req.params || {}) };
  const e = getGrid(site, params, req.state || {});
  const { costToHome, distToHome } = e;
  const costToSafety = safetyField(site, params, req.state || {}, e);
  return {
    costToHome: costToHome.slice(), distToHome: distToHome.slice(), costToSafety: costToSafety === costToHome ? null : costToSafety.slice(),
    usable_o2_min: usableO2min(site.suit), walkback_m: site.suit?.walkback_m?.value ?? null,
  };
}
