
// Dosis de UN tramo, en mSv.
// rateMSvPerH: tasa base (mSv/h), minutes: duración del tramo, doseX: multiplicador de la alerta
export function doseSegment(rateMSvPerH, minutes, doseX) {
  const factor = doseX ?? 1;
  const hr = minutes/60;
  const d = rateMSvPerH*hr*factor
  return d;
}

// Dosis total de una lista de tramos, en mSv.
// segments: [{ minutes, doseX }, ...]
export function doseTotal(segments, params) {
  if (!Number.isFinite(params?.gcr_mSv_per_h) || params.gcr_mSv_per_h <= 0) {
    throw new Error('radiation: params.gcr_mSv_per_h is missing or not a positive number');
  }

  let total = 0
  for (let i = 0; i < segments.length; i++) { 
    total += doseSegment(params.gcr_mSv_per_h, segments[i].minutes, segments[i].doseX) 
  }
  return total;
}