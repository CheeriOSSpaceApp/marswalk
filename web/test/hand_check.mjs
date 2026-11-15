// hand_check.mjs — Compare planner stats against a HAND calculation on terrain simple enough
// to do with a calculator. Run from web/:  node test/hand_check.mjs
// The "hand" column re-derives everything from the formulas below, independently of cost.js/planner.js.
import fs from 'node:fs';
import { plan } from '../src/planner.js';

const read = (f) => JSON.parse(fs.readFileSync(new URL(`../public/data/common/${f}`, import.meta.url)));
const params = read('params.json'), suit = read('suit.json');
const W = 1000, H = 1000, N = W * H;
const meta = { site: 'hand', bbox: [77.423321, 18.424692, 77.476679, 18.475308], width: W, height: H, cell_m: 3 };
const cellLL = (row, col) => [meta.bbox[0] + (col + 0.5) / W * (meta.bbox[2] - meta.bbox[0]), meta.bbox[3] - (row + 0.5) / H * (meta.bbox[3] - meta.bbox[1])];
const start = cellLL(500, 100), goal = cellLL(500, 433); // straight east, 333 cells × 3 m = 999 m
meta.habitat = start;

function site(slopeDeg, rough) {
  return {
    meta, suit, params, alerts: [],
    targets: { type: 'FeatureCollection', features: [] },
    layers: {
      elevation: new Float32Array(N), slope: new Float32Array(N).fill(slopeDeg),
      roughness: new Float32Array(N).fill(rough), hazard: new Uint8Array(N), viewshed: new Uint8Array(N).fill(1),
    },
  };
}

// ---------- HAND CALCULATION (same equations as the README / Ana's model) ----------
function hand(slopeDeg, rough, dist, taskMin) {
  const p = params;
  const tan = Math.tan(slopeDeg * Math.PI / 180);
  const V = Math.min(p.tobler_a * Math.exp(-p.tobler_b * Math.abs(tan + p.tobler_offset)) / 3.6, p.V_cap); // m/s
  const G = Math.max(0, 100 * tan);                                         // grade %
  const eta = p.eta_min + (p.eta_max - p.eta_min) * Math.min(rough / p.rough_ref, 1);
  const M = p.gRatio * (1.5 * p.W + 2 * (p.W + p.L) * (p.L / p.W) ** 2 + eta * (p.W + p.L) * (1.5 * V ** 2 + 0.35 * V * G)); // W
  const perM = M / (V * 60 * p.P_nom);                                       // O2-min per meter
  const walkO2 = perM * dist, walkMin = dist / V / 60;
  const o2Total = suit.o2_hours.value * 60, usable = o2Total * (1 - suit.reserve_pct.value / 100);
  const taskO2 = taskMin;                                                     // 1 O2-min per min at P_nom
  return {
    V_ms: V, G_pct: G, eta, M_W: M, cost_per_m: perM,
    distance_m: dist, duration_min: walkMin + taskMin,
    o2_used_pct: 100 * (walkO2 + taskO2) / o2Total,
    o2_margin_min: usable - (walkO2 + taskO2 + walkO2), // worst point = goal: spent + return (same cost back)
    dose_mSv: p.gcr_mSv_per_h * (walkMin + taskMin) / 60,
    walkback_max_m: dist,
  };
}

let fails = 0;
const cases = [
  { name: 'R1 flat, smooth, 999 m', slope: 0, rough: 0, task: 0 },
  { name: 'R2 5° slope, rough 0.25 m, 999 m + 30 min task at goal', slope: 5, rough: 0.25, task: 30 },
];
for (const c of cases) {
  const h = hand(c.slope, c.rough, 999, c.task);
  const r = plan(site(c.slope, c.rough), { start, goal, task_min: [c.task] });
  if (r.error) { console.log('ERROR', r); fails++; continue; }
  console.log(`\n${c.name}`);
  console.log(`  intermediate (hand): V=${h.V_ms.toFixed(4)} m/s  G=${h.G_pct.toFixed(3)}%  eta=${h.eta.toFixed(3)}  M=${h.M_W.toFixed(1)} W  cost=${h.cost_per_m.toFixed(5)} O2-min/m`);
  console.log('  stat              planner      hand        diff');
  for (const k of ['distance_m', 'duration_min', 'o2_used_pct', 'o2_margin_min', 'dose_mSv', 'walkback_max_m']) {
    const a = r.stats[k], b = h[k];
    const tol = { duration_min: 0.6, o2_used_pct: 0.06, o2_margin_min: 0.15, dose_mSv: 0.00006, distance_m: 0.6, walkback_max_m: 0.6 }[k];
    const ok = Math.abs(a - b) <= tol;
    if (!ok) fails++;
    console.log(`  ${ok ? '✓' : '✗'} ${k.padEnd(15)} ${String(a).padStart(9)}  ${b.toFixed(4).padStart(10)}  ${(a - b).toFixed(4)}`);
  }
}
console.log(fails ? `\n${fails} mismatch(es)` : '\nAll stats match the hand calculation (within display rounding).');
process.exit(fails ? 1 : 0);
