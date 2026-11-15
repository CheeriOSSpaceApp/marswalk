// cellCost: metabolic cost of walking through one grid cell.
// Returns minutes of O2 supply per meter, measured at the nominal metabolic
// rate (P_nom = 1200 BTU/hr = 351.7 W), or Infinity if hazard = 2 (forbidden).
// The planner multiplies it by the move distance (cell_m, or sqrt(2) * cell_m on diagonals).

// Model: Pandolf load-carriage equation (Kim et al., IEEE EMBC 2024, eq. 2),
// terrain factor eta from local roughness (Soule & Goldman 1972),
// walking speed from Tobler's hiking function topped at 0.98 m/s (2.2 mph, ICES-2026-127).
// Mars gravity: power scaled by 0.38 (our assumption).
// Downhill: grade is clamped to 0 (v1). The state parameter is not used yet.

export function cellCost(i, layers, params, state) {

  // Si la celda es prohibida, devuelve Infinity
  if (layers.hazard[i] === 2) {
    return Infinity;
  }

  if (!Number.isFinite(layers.slope[i]) || !Number.isFinite(layers.roughness[i])) return Infinity; //evitar que se rompa A* cuendo entren datos reales

  //Pandolf equation
  const slope = layers.slope[i];
  const S = Math.tan(slope * Math.PI / 180);
  const kmh = params.tobler_a * Math.exp(-params.tobler_b * Math.abs(S + params.tobler_offset));
  const V = Math.min(kmh / 3.6, params.V_cap);
  const G = Math.max(0, 100 * S);

  const t1 = 1.5 * params.W;
  const t2 = 2.0*(params.W + params.L)*(params.L/params.W)**2;

  const rough = layers.roughness[i];
  const fraccion = Math.min(rough / params.rough_ref, 1);
  const eta = params.eta_min + (params.eta_max - params.eta_min) * fraccion;
  const t3 = eta * (params.W + params.L) * (1.5*V**2 + 0.35*V*G);


  const M = params.gRatio * (t1 + t2 + t3);   // watts en Marte
  const tiempo = params.cell_m / V;           // segundos para cruzar la celda
  const E = M * tiempo;                       // joules
  const minutes = E / (params.P_nom * 60);
  const perMeter = minutes / params.cell_m;   
  return perMeter;
}
