// env.js — weather from env.json (Mars Climate Database model, CONTRACTS.md): per local solar hour 0–23 and scenario.
// {clear|dusty|storm: [{hour, temp_K, pressure_Pa, wind_ms, tau}], _meta:{source, ...}}
export async function loadEnv(site) {
  const url = site.url('env.json'); if (!url) return null;
  try { const e = await fetch(url).then(r => r.ok ? r.json() : null); return e?.clear ? e : null; } catch { return null; }
}
// scenario from the active alert: a dust alert (visibility < 1) means storm conditions
export const scenarioFor = state => (state?.visibility ?? 1) < 0.5 ? 'storm' : (state?.visibility ?? 1) < 1 ? 'dusty' : 'clear';
export function envAt(env, hour, scenario = 'clear') {
  const rows = env?.[scenario] || env?.clear; if (!rows?.length) return null;
  const h = ((hour % 24) + 24) % 24, i = Math.floor(h), j = (i + 1) % 24, f = h - i;
  const a = rows.find(r => r.hour === i) || rows[i], b = rows.find(r => r.hour === j) || rows[j];
  const mix = k => a[k] + (b[k] - a[k]) * f;            // linear between the hourly values
  return { hour: h, scenario, temp_K: mix('temp_K'), pressure_Pa: mix('pressure_Pa'), wind_ms: mix('wind_ms'), tau: mix('tau') };
}
export const MARS_HOUR_MIN = 88775.244 / 24 / 60;   // 61.649 Earth min per Mars hour (same as planner.js)
export const lmstAt = (startLmst, tMin) => startLmst + (tMin || 0) / MARS_HOUR_MIN;
export const ltst = h => { const hh = ((h % 24) + 24) % 24; return `${String(Math.floor(hh)).padStart(2, '0')}:${String(Math.floor((hh % 1) * 60)).padStart(2, '0')}`; };
export const fmtEnv = e => `${(e.temp_K - 273.15).toFixed(0)} °C · wind ${e.wind_ms.toFixed(1)} m/s · dust τ ${e.tau.toFixed(2)} · ${e.pressure_Pa.toFixed(0)} Pa`;
