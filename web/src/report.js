// report.js — Mission report (Tier 1 C: ideas #2, #9, #11, #12). Pure functions, no DOM.
//
// The TABLET records a mission log while the EVA runs (Santiago), then calls buildReport(log, site).
// log = {
//   mission_id, site, crew: ['name', ...], start_lmst?: number (Mars local time, hours),
//   planned: <the plan() result the EVA started with>,
//   events: [{ t_min, type, ...payload }]   // t_min = minutes since EVA start (simulated clock)
// }
// event types:
//   phase          {phase: 'prep'|'outbound'|'working'|'transit'|'returning'|'ingress'|'done'}
//   position       {lon, lat, o2_used_min, dose_mSv}             (sample every ~30 s of mission time)
//   arrive         {id, name}
//   task_done      {id, name, planned_min, actual_min}
//   alert          {alert_type, destination, destination_kind}
//   adapt          {decision, dropped: [{name, reason}]}
//   obstacle       {id, lon, lat, radius_m, kind, source, note}    (live map update)
//   map_correction {lon, lat, was, now, note}                      ("map said free, it's blocked")
//   note           {template, text}
//   msg            {from: 'console'|'tablet', text}
//   checklist      {task_id, item, done}
import { lonLatToCell } from './data.js';

const PHASES = ['prep', 'outbound', 'working', 'transit', 'returning', 'ingress'];
const R_MARS = 3389500;
const meters = (a, b) => {
  const toR = Math.PI / 180, dLat = (b[1] - a[1]) * toR, dLon = (b[0] - a[0]) * toR * Math.cos(((a[1] + b[1]) / 2) * toR);
  return Math.hypot(dLat, dLon) * R_MARS;
};
const pval = (x) => (x && typeof x === 'object' ? x.value : x);
const r1 = (x) => (Number.isFinite(x) ? Math.round(x * 10) / 10 : null);

export function buildReport(log, site) {
  const ev = [...(log.events || [])].sort((a, b) => a.t_min - b.t_min);
  const of = (t) => ev.filter((e) => e.type === t);
  const track = of('position');
  const last = track.at(-1) || {};
  const endT = ev.length ? ev.at(-1).t_min : 0;

  // Distance actually walked (from the track, not the plan)
  let walked = 0;
  for (let i = 1; i < track.length; i++) walked += meters([track[i - 1].lon, track[i - 1].lat], [track[i].lon, track[i].lat]);

  // Phases (idea #9): time spent in each, from phase-change events
  const phaseMin = Object.fromEntries(PHASES.map((p) => [p, 0]));
  const ph = of('phase');
  for (let i = 0; i < ph.length; i++) {
    const to = i + 1 < ph.length ? ph[i + 1].t_min : endT;
    if (ph[i].phase in phaseMin) phaseMin[ph[i].phase] += Math.max(0, to - ph[i].t_min);
  }

  // Terrain actually crossed (hazards encountered), sampled from the track
  let cautionN = 0, maxSlope = 0, noComms = 0;
  const L = site?.layers, meta = site?.meta;
  if (L && meta) for (const p of track) {
    const { i } = lonLatToCell(meta, p.lon, p.lat);
    if (L.hazard?.[i] === 1) cautionN++;
    if (L.slope?.[i] > maxSlope) maxSlope = L.slope[i];
    if (L.viewshed && L.viewshed[i] === 0) noComms++;
  }

  // Resources
  const suit = site?.suit || {};
  const o2Total = (pval(suit.o2_hours) ?? 8) * 60;
  const battWh = pval(suit.battery_Wh) ?? null, powerW = pval(suit.base_power_W) ?? null;
  const usedWh = powerW != null ? (powerW * endT) / 60 : null;

  // Tasks (idea #12): planned vs actual, overtime
  const tasks = of('task_done').map((t) => ({ name: t.name, planned_min: t.planned_min, actual_min: r1(t.actual_min), delta_min: r1(t.actual_min - t.planned_min) }));

  const planned = log.planned?.stats || {};
  const MARS_H = 88775.244 / 24 / 60;
  const lmst = (h) => (h == null ? null : `${String(Math.floor(((h % 24) + 24) % 24)).padStart(2, '0')}:${String(Math.floor((((h % 24) + 24) % 24 % 1) * 60)).padStart(2, '0')}`);

  return {
    mission_id: log.mission_id ?? null, site: log.site ?? meta?.site ?? null, crew: log.crew || [],
    time: { duration_min: r1(endT), start_lmst: lmst(log.start_lmst), end_lmst: log.start_lmst != null ? lmst(log.start_lmst + endT / MARS_H) : null },
    summary: {
      distance_walked_m: Math.round(walked), duration_min: r1(endT),
      o2_used_min: r1(last.o2_used_min), o2_used_pct: last.o2_used_min != null ? r1((100 * last.o2_used_min) / o2Total) : null,
      battery_used_Wh: r1(usedWh), battery_used_pct: usedWh != null && battWh ? r1((100 * usedWh) / battWh) : null,
      dose_mSv: last.dose_mSv != null ? +last.dose_mSv.toFixed(4) : null,
    },
    plan_vs_actual: {
      distance_m: { planned: planned.distance_m ?? null, actual: Math.round(walked) },
      duration_min: { planned: planned.duration_min ?? null, actual: r1(endT) },
      o2_used_pct: { planned: planned.o2_used_pct ?? null, actual: last.o2_used_min != null ? r1((100 * last.o2_used_min) / o2Total) : null },
    },
    phases_min: Object.fromEntries(Object.entries(phaseMin).map(([k, v]) => [k, r1(v)])),
    terrain: { samples: track.length, caution_pct: track.length ? r1((100 * cautionN) / track.length) : null, max_slope_deg: r1(maxSlope),
      no_comms_pct: track.length && L?.viewshed ? r1((100 * noComms) / track.length) : null },
    tasks,
    overtime_min: r1(tasks.reduce((s, t) => s + Math.max(0, t.delta_min || 0), 0)),
    alerts: of('alert').map((a) => ({ t_min: a.t_min, type: a.alert_type, destination: a.destination })),
    adaptations: of('adapt').map((a) => ({ t_min: a.t_min, decision: a.decision, dropped: (a.dropped || []).map((d) => `${d.name} (${d.reason})`) })),
    map_updates: of('obstacle').map((o) => ({ t_min: o.t_min, kind: o.kind, source: o.source, radius_m: o.radius_m, at: [o.lon, o.lat], note: o.note || '' })),
    map_corrections: of('map_correction').map((c) => ({ t_min: c.t_min, at: [c.lon, c.lat], was: c.was, now: c.now, note: c.note || '' })),
    notes: of('note').map((n) => ({ t_min: n.t_min, template: n.template || 'free', text: n.text })),
    messages: of('msg').length,
  };
}

// Markdown version (download / copy into the project page). The UI can also render the object directly.
export function reportToMarkdown(R) {
  const L = [];
  const f = (x, u = '') => (x == null ? '–' : `${x}${u}`);
  L.push(`# Mission report — ${R.mission_id ?? 'EVA'} (${R.site ?? ''})`);
  if (R.crew.length) L.push(`Crew: ${R.crew.join(', ')}`);
  L.push(`Duration ${f(R.time.duration_min, ' min')}${R.time.start_lmst ? ` · LMST ${R.time.start_lmst} → ${R.time.end_lmst}` : ''}`, '');
  L.push('## Summary', '| | planned | actual |', '|---|---|---|',
    `| Distance | ${f(R.plan_vs_actual.distance_m.planned, ' m')} | ${f(R.plan_vs_actual.distance_m.actual, ' m')} |`,
    `| Duration | ${f(R.plan_vs_actual.duration_min.planned, ' min')} | ${f(R.plan_vs_actual.duration_min.actual, ' min')} |`,
    `| O₂ used | ${f(R.plan_vs_actual.o2_used_pct.planned, ' %')} | ${f(R.plan_vs_actual.o2_used_pct.actual, ' %')} |`,
    `| Battery | | ${f(R.summary.battery_used_Wh, ' Wh')} (${f(R.summary.battery_used_pct, ' %')}) |`,
    `| Dose | | ${f(R.summary.dose_mSv, ' mSv')} |`, '');
  L.push('## Phases (min)', Object.entries(R.phases_min).map(([k, v]) => `${k} ${v}`).join(' · '), '');
  L.push('## Terrain crossed', `caution ${f(R.terrain.caution_pct, ' %')} of samples · max slope ${f(R.terrain.max_slope_deg, '°')} · no comms ${f(R.terrain.no_comms_pct, ' %')}`, '');
  if (R.tasks.length) L.push('## Tasks', ...R.tasks.map((t) => `- ${t.name}: ${t.actual_min} / ${t.planned_min} min${t.delta_min > 0 ? ` (+${t.delta_min} overtime)` : ''}`), '');
  if (R.alerts.length) L.push('## Alerts', ...R.alerts.map((a) => `- t+${a.t_min} min ${a.type} → ${a.destination}`), '');
  if (R.adaptations.length) L.push('## Re-planning decisions', ...R.adaptations.map((a) => `- t+${a.t_min} min ${a.decision}${a.dropped.length ? ': dropped ' + a.dropped.join(', ') : ''}`), '');
  if (R.map_updates.length) L.push('## Map updates', ...R.map_updates.map((o) => `- t+${o.t_min} min ${o.kind} r=${o.radius_m} m by ${o.source}${o.note ? ' — ' + o.note : ''}`), '');
  if (R.map_corrections.length) L.push('## Map corrections (map vs. reality)', ...R.map_corrections.map((c) => `- t+${c.t_min} min map said "${c.was}", reality "${c.now}"${c.note ? ' — ' + c.note : ''}`), '');
  if (R.notes.length) L.push('## Field notes', ...R.notes.map((n) => `- t+${n.t_min} min [${n.template}] ${n.text}`), '');
  return L.join('\n');
}
