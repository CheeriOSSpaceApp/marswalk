// route.js — turns Eric's plan()/replan() result (docs/INTEGRATION.md §3) into per-vertex arrays
// that the console (coloured ~250 m segments) and the tablet (walk simulation) both use.
//
//   plan.path.geometry.coordinates : [[lon,lat], ...]  (cell centres, one per A* step)
//   plan.segments[k].stats         : one LEG per stop (walk_min_exact, o2_used_min = walking O2,
//                                    dose_mSv = walk + task outside the airlock, task_min = work at the end of the leg)
// Each leg's walking time / O2 / dose is spread over its vertices in proportion to distance.
import { lonLatToCell } from './data.js';
import { dist } from './geo.js';

export function routeModel(plan, site) {
  let c = plan.path.geometry.coordinates;
  if (c.length < 2) c = [c[0], c[0]];                 // replan while standing at the destination: zero-length route
  const n = c.length;
  const cumD = new Float64Array(n);
  for (let i = 1; i < n; i++) cumD[i] = cumD[i - 1] + dist(c[i - 1], c[i]);

  // vertex where each leg ends: nearest vertex to leg.to, searching forward
  const legEnd = []; let from = 0;
  for (const leg of plan.segments) {
    let best = from, bd = Infinity;
    for (let i = from; i < n; i++) { const dd = dist(c[i], leg.to); if (dd <= bd) { bd = dd; best = i; } else if (dd > bd + 60) break; }
    legEnd.push(best); from = best;
  }
  if (legEnd.length) legEnd[legEnd.length - 1] = n - 1;

  const cumT = new Float64Array(n), cumO2 = new Float64Array(n), cumDose = new Float64Array(n);
  let start = 0;
  plan.segments.forEach((leg, k) => {
    const end = legEnd[k], s = leg.stats, D = cumD[end] - cumD[start] || 1;
    const walk = s.walk_min_exact ?? s.duration_min ?? 0, task = s.task_min ?? 0;
    // dose_mSv = walk + task, except tasks in the habitat airlock (no dose, Eric's assumption) -> keep the walking share
    const airlock = dist(leg.to, site.meta.habitat) < 10;
    const walkDose = (s.dose_mSv ?? 0) * (walk / Math.max(1e-9, walk + (airlock ? 0 : task)));
    for (let i = start + 1; i <= end; i++) {
      const f = (cumD[i] - cumD[i - 1]) / D;
      cumT[i] = cumT[i - 1] + walk * f; cumO2[i] = cumO2[i - 1] + (s.o2_used_min ?? 0) * f; cumDose[i] = cumDose[i - 1] + walkDose * f;
    }
    start = end;
  });

  // per-vertex pieces for the console's coloured segments
  const { meta, layers } = site;
  const pieces = [];
  for (let i = 0; i < n - 1; i++) {
    const { i: cell } = lonLatToCell(meta, c[i + 1][0], c[i + 1][1]);
    pieces.push({ distance_m: cumD[i + 1] - cumD[i], time_min: cumT[i + 1] - cumT[i], o2_min: cumO2[i + 1] - cumO2[i], dose_mSv: cumDose[i + 1] - cumDose[i],
      slope_deg: layers.slope?.[cell] ?? 0, comms: layers.viewshed ? layers.viewshed[cell] : 1 });
  }
  const legTask = plan.segments.map(l => l.stats.task_min ?? 0);
  const egress = Math.max(0, (plan.stats.task_min ?? 0) - legTask.reduce((a, b) => a + b, 0));
  return { c, cumD, cumT, cumO2, cumDose, legEnd, legTask, egress, pieces, total: cumD[n - 1] };
}
