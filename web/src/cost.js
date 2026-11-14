// cost.js — PROVISIONAL cost model. Owner: Ana (she replaces the internals at 19:00).
// The SIGNATURES are the contract; keep them stable.
//
// UNIT DECISION (agree with Ana, then write it in CONTRACTS.md):
//   cellCost(...) returns O2-equivalent MINUTES PER METER walked through cell i.
//   The planner multiplies by distance: edge cost = avg(cost[a], cost[b]) * meters.
//   Infinity = impassable.

const MAX_SPEED_MS = 0.98; // 2.2 mph, Apollo nominal max (NASA, to cite in README)

// Tobler's hiking function: speed (km/h) = 6 * exp(-3.5 * |tan(slope) + 0.05|)
// Uses |slope| because we don't know the walking direction per cell (simplification).
export function speedAt(i, layers) {
  const tan = Math.tan((layers.slope[i] * Math.PI) / 180);
  const kmh = 6 * Math.exp(-3.5 * Math.abs(tan + 0.05));
  return Math.min(MAX_SPEED_MS, kmh / 3.6); // m/s
}

export function cellCost(i, layers, params, state = {}) {
  if (layers.hazard[i] === 2) return Infinity;
  const minPerMeter = 1 / (speedAt(i, layers) * 60);       // time to walk 1 m
  let mult = 1 + layers.slope[i] / 15;                     // effort rises with slope (placeholder for Pandolf)
  if (layers.hazard[i] === 1) mult *= 1.3;                 // caution zone penalty
  if (layers.viewshed && layers.viewshed[i] === 0) mult *= 1 + (params.w_nocomms ?? 0.2);
  mult *= state.o2_x ?? 1;                                 // alert effects (suit failure, etc.)
  if (state.visibility != null && state.visibility < 1)    // dust: rough/steep terrain gets worse
    mult *= 1 + (1 - state.visibility) * (layers.slope[i] / 10 + layers.roughness[i]);
  return minPerMeter * mult;
}
