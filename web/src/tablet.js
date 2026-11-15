import L from 'leaflet';
import { createSiteMap } from './common.js';
import { onMessage, send } from './bus.js';
import { lonLatToCell } from './data.js';
import { dist, helmetIcon } from './geo.js';
import { createPlanner } from './plannerClient.js';   // only for costToHome (no-return zone), docs/INTEGRATION.md §6
import { routeModel } from './route.js';
import { createRing, liveZone } from './ring.js';
import { loadEnv, envAt, scenarioFor, ltst, lmstAt } from './env.js';

const { map, site, name, bounds } = await createSiteMap();
const { meta, suit, params } = site;
const $ = id => document.getElementById(id);
const val = x => (x && typeof x === 'object' && 'value' in x) ? x.value : x;    // accepts 8 or {value:8, source:…}
const WALKBACK = val(suit.walkback_m) ?? Infinity;       // suit.json limit: farthest allowed distance from the habitat
const O2_MIN = (val(suit.o2_hours) ?? 8) * 60, RESERVE = val(suit.reserve_pct) ?? 20, SPEED = val(params.V_cap) ?? val(params.base_speed_ms) ?? 1;
const USABLE = O2_MIN * (1 - RESERVE / 100);              // same as planner usableO2min()
const GCR = val(params.gcr_mSv_per_h) ?? 0.028;          // mSv/h on the surface
const MARGIN_WARN = 30;                                   // min of O2 margin below which the state is CAUTION (Ana's threshold)
const MARGIN_CRIT = 10;                                   // min of O2 margin left: return NOW (team estimate)
const SPEEDS = [60, 300, 600];
let SIM = 60;
// ?demo=1 (Launch demo): the tablet walks by itself at ×60 and closes each task when its planned time is up
const DEMO = new URLSearchParams(location.search).has('demo');
const DEMO_HOLD_MIN = 20;                          // a replan 'hold' (shelter) has no planned time: wait this long, then stop
const walkLabel = () => `▶ Walk (×${SIM})`;
const R = 3396190, rad = x => x * Math.PI / 180, deg = x => x * 180 / Math.PI;
const env = await loadEnv(site);
let startHour = 9;                                        // EVA start in LMST (Mars hours), from the console
const photos = site.url('photos.json') ? await fetch(site.url('photos.json')).then(r => r.ok ? r.json() : []).catch(() => []) : [];

// ---------- Tasks (Ana's HUD) ----------
// Task minutes come from the planner (params.task_min via taskMinutesAt); here only what to do (shown as one line).
const CHECK = {
  egress:  ['Suit leak check', 'Depressurize airlock', 'Comms check with habitat'],
  depot:   ['Locate the tube', 'In-situ photo', 'Inspect the seal', 'Collect and label'],
  science: ['Stratigraphy photo with scale', 'Photo of abrasion patch', 'Photo of drill holes', 'Field notes'],
  shelter: ['Reach muster point', 'Report position to habitat'],
  hold:    ['Reach the safe point', 'Report position to habitat', 'Hold until the alert clears'],
  habitat: ['Enter airlock', 'Repressurize', 'Stow samples'],
  task:    ['Reach the point', 'Site photo', 'Do the assigned task', 'Report to habitat'],
  cache:   ['Connect O₂ line', 'Refill', 'Disconnect'],
};
const TASK_NOTE = { shelter: 'Muster point', hold: 'Alert: wait here, coordinate with habitat', cache: 'O₂ cache' };
const SAFE_KINDS = new Set(['shelter', 'hold', 'cache']);     // arriving at one of these = safe spot reached
// Is the target at this point a radiation shelter? (targets.geojson properties.radiation_shelter, Dana/Marco)
function targetAtLL(ll) {
  let best = null, bd = 25;
  for (const f of site.targets?.features || []) { const dd = dist(ll, f.geometry.coordinates); if (dd < bd) { bd = dd; best = f; } }
  return best;
}

if (site.url('hillshade.png')) L.imageOverlay(site.url('hillshade.png'), bounds, { opacity: 0.9 }).addTo(map);
L.circleMarker([meta.habitat[1], meta.habitat[0]], { radius: 8, color: '#000', weight: 2, fillColor: '#fff', fillOpacity: 1 }).bindTooltip('Habitat').addTo(map);
const ring = createRing(map, bounds, meta); ring.layer.addTo(map);                       // no-return zone (dark red)
const planner = createPlanner();
const plannerReady = planner.init(name).catch(e => { console.warn('[tablet] planner unavailable, straight-line return estimate', e); });
let ringState = null;
async function refreshRing(state) {                       // costToHome depends on the alert state
  const key = JSON.stringify(state || {}); if (key === ringState) return; ringState = key;
  await plannerReady; try { ring.setData(await planner.costToHome({ state: state || {} })); if (P) render(); } catch (e) { console.warn(e); }
}
refreshRing({});
// Live safe zone (§9.2): dark red = can't go there and still reach safety, amber = tight (< 30 min margin). Includes O₂ caches.
const zone = liveZone(planner, ring, () => eff);
const routeLine = L.polyline([], { color: '#e2603a', weight: 5 }).addTo(map);          // remaining
const doneLine = L.polyline([], { color: '#56ccf2', weight: 6 }).addTo(map);           // already walked
const astro = L.marker(meta.habitat.slice().reverse(), { icon: helmetIcon(), zIndexOffset: 1000 }).bindTooltip('Astronaut').addTo(map);
$('site').textContent = name;

// POV photo: use the target's photo_id if set, otherwise the nearest photo (rover stop) within PHOTO_MAX_M of the waypoint
const PHOTO_MAX_M = 200;
function photoFor(w) {
  const byId = w.photo_id && photos.find(p => p.id === w.photo_id);
  if (byId) return { ...byId, dist_m: dist(w.ll, [byId.lon, byId.lat]) };
  let best = null;
  for (const p of photos) { const dd = dist(w.ll, [p.lon, p.lat]); if (dd <= PHOTO_MAX_M && (!best || dd < best.dist_m)) best = { ...p, dist_m: dd }; }
  return best;
}

let follow = true;
// ---------- Alerts: HIGH priority (red, from the console, replans) / LOW priority (yellow, detected here) ----------
const ALERT_NAMES = { o2low: 'O₂ getting low', o2crit: 'O₂ critical', SPE: 'Solar particle event', dust: 'Dust storm', suit: 'Suit failure', los: 'Loss of line of sight', deviation: 'Route deviation' };
const DEVIATION_M = 25;          // off-route distance that raises a low-priority alert (team estimate, ~8 grid cells)
const DEV_SIM_M = 45;            // demo: lateral drift simulated from the console
const LOS_SIM_MIN = 10;          // demo: EVA minutes without line of sight simulated from the console
function beep(n = 3, freq = 880) {               // high = 3 beeps, low = 1; browsers may block sound until the page has been clicked
  try {
    const ac = new (window.AudioContext || window.webkitAudioContext)(); if (ac.state === 'suspended') ac.resume();
    for (let k = 0; k < n; k++) { const t = k * 0.35, o = ac.createOscillator(), g = ac.createGain(); o.type = 'square'; o.frequency.value = freq;
      g.gain.setValueAtTime(0.15, ac.currentTime + t); g.gain.setValueAtTime(0, ac.currentTime + t + 0.2);
      o.connect(g); g.connect(ac.destination); o.start(ac.currentTime + t); o.stop(ac.currentTime + t + 0.25); }
  } catch {}
}
let openLow = null; const lowQueue = [];
// Alerts are NOT persistent: the popup and the banner show once and close by themselves (or earlier with Acknowledge).
const ALARM_MS = { high: 6000, low: 4000, safe: 6000 };
let alarmTimer = null, bannerTimer = null;
function openAlarm(priority, type, body, customTitle = false) {
  $('alarm').className = priority; openLow = priority === 'low' ? type : null;
  $('alarmTitle').textContent = customTitle ? type : priority === 'safe' ? `SAFE SPOT REACHED · ${type}` : `${priority === 'high' ? 'HIGH' : 'LOW'} PRIORITY · ${ALERT_NAMES[type] || type}`;
  $('alarmBody').textContent = body; $('alarm').hidden = false;
  const bar = $('alarmBar'); bar.style.animation = 'none'; void bar.offsetWidth; bar.style.animation = `alarmTime ${ALARM_MS[priority]}ms linear forwards`;
  clearTimeout(alarmTimer); alarmTimer = setTimeout(closeAlarm, ALARM_MS[priority]);
  beep(priority === 'high' ? 3 : 1, priority === 'high' ? 880 : priority === 'safe' ? 520 : 620);
}
function setBanner(priority, text) {
  const b = $('banner');
  if (priority === 'low' && !b.hidden && b.classList.contains('high')) return;   // a high-priority banner stays on top while it lasts
  b.className = priority; b.textContent = text; b.hidden = false;
  clearTimeout(bannerTimer); bannerTimer = setTimeout(() => { b.hidden = true; b.className = ''; }, ALARM_MS[priority]);
}
function showAlarm(msg) {                         // HIGH: msg = {alert, destination, destination_kind} (bus contract)
  const a = msg.alert || msg, e = a.effect || {};
  const where = msg.fallback ? `Can't make it home: go to ${msg.destination} now.` : msg.destination ? `Go to ${msg.destination_kind === 'habitat' ? 'the habitat' : msg.destination} now.` : a.action === 'return' ? 'Return to the habitat now.' : 'Go to the nearest safe place now.';
  lowQueue.length = 0;
  openAlarm('high', a.name || a.type, `${where}  O₂ use ×${e.o2_x ?? 1} · dose ×${e.dose_x ?? 1}` +
    (e.visibility != null && e.visibility < 1 ? ` · visibility ${Math.round(e.visibility * 100)} %` : '') +
    (msg.considered ? `\nOptions: ${msg.considered}` : ''));
}
function showCritO2(margin, homeMin) {           // HIGH: the astronaut has to leave now
  lowQueue.length = 0;
  openAlarm('high', 'o2crit', `Return to the habitat now. O₂ margin ${Math.max(0, margin).toFixed(0)} min, the way home needs ${homeMin.toFixed(0)} min. A route home is being sent.`);
  setBanner('high', `HIGH · O₂ critical: return to the habitat now (margin ${Math.max(0, margin).toFixed(0)} min)`);
}
function lowAlert(type, body) {                   // LOW: no replan, the walk goes on; the console is told
  send('warning', { priority: 'low', type, message: body, t_min: spentNow.time_min, lon: lastPos?.[0], lat: lastPos?.[1] });
  setBanner('low', `${ALERT_NAMES[type]}: ${body}`);
  if (!$('alarm').hidden) { lowQueue.push([type, body]); return; }               // never cover an open alarm
  openAlarm('low', type, body);
}
function closeAlarm() {
  clearTimeout(alarmTimer);
  if ($('alarm').hidden) return;
  $('alarm').hidden = true;
  if (openLow === 'deviation') drift.target = 0;  // acknowledged: the astronaut heads back to the route
  const n = lowQueue.shift(); if (n) openAlarm('low', ...n);
}
$('alarmOk').onclick = closeAlarm;

// Route deviation (simulated lateral drift) and loss of line of sight (simulated or from viewshed.u8)
const drift = { m: 0, target: 0 };
let losUntil = -1, losArmed = false, simFired = false, devAlerted = false, lastPos = null;
function simulate(kind) {
  if (!P) return;
  if (kind === 'deviation') { drift.target = DEV_SIM_M; if (!playing) drift.m = DEV_SIM_M; }
  if (kind === 'los') { losUntil = spentNow.time_min + LOS_SIM_MIN; simFired = false; }
  render();
}
function offsetPos(p, k) {                        // move p sideways (to the right of the walking direction) by drift.m metres
  if (!drift.m) return p;
  const a = P.c[k], b = P.c[k + 1], cos = Math.cos(rad(p[1]));
  const ex = (b[0] - a[0]) * cos, ny = b[1] - a[1], L0 = Math.hypot(ex, ny) || 1;
  const rx = ny / L0, ry = -ex / L0;              // unit vector to the right (east, north)
  return [p[0] + deg(drift.m * rx / R) / cos, p[1] + deg(drift.m * ry / R)];
}
function offRoute(p, k) {                         // metres from p to the planned route (segments around k)
  let best = Infinity; const cos = Math.cos(rad(p[1]));
  for (let i = Math.max(0, k - 40); i < Math.min(P.c.length - 1, k + 40); i++) {
    const a = P.c[i], b = P.c[i + 1];
    const ax = rad(a[0] - p[0]) * cos * R, ay = rad(a[1] - p[1]) * R, bx = rad(b[0] - p[0]) * cos * R, by = rad(b[1] - p[1]) * R;
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy, t = L2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L2)) : 0;
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
  }
  return best;
}

// ---------- Plan state ----------
let P = null, d = 0, playing = false, last = 0, shownWp = null, shownTask = null;
let eff = { o2_x: 1, dose_x: 1, visibility: 1 };   // effect of the active alert (reset by a fresh plan)

// Tasks: minutes come from the planner (Eric's taskMinutesAt, Ana's params.task_min): leg k ends at waypoint k
function buildTasks(m, wps, replanned) {
  const tasks = [];
  if (!replanned && m.egress > 0) tasks.push({ kind: 'egress', name: 'Habitat egress', at: 0, minutes: m.egress });
  wps.forEach((w, n) => {
    let kind = w.kind, label = w.name;
    const minutes = m.legTask[n] ?? 0;
    if (kind === 'shelter' && replanned) kind = 'hold';
    else if (kind === 'habitat') label = 'Habitat ingress';
    if (!CHECK[kind] || (!minutes && kind !== 'hold')) return;   // custom points (no task): walk straight through
    tasks.push({ kind, name: label, wp: n, at: P.cumD[w.idx], minutes });
  });
  tasks.forEach(t => { t.items = CHECK[t.kind]; t.elapsed = 0; t.done = false; });
  return tasks;
}

let spentNow = { o2_min: 0, dose_mSv: 0, time_min: 0 };   // what the astronaut has used so far (carried into a replan)
function setPlan(payload) {
  if (!payload?.plan?.path) return;                       // old/unknown message
  const replanned = !!payload.replan, wasPlaying = playing;
  if (!replanned && payload.start_hour != null) startHour = +payload.start_hour;
  const m = routeModel(payload.plan, site);
  P = { ...m, base: replanned ? { ...spentNow } : { o2_min: payload.o2_start_used || 0, dose_mSv: 0, time_min: 0 }, extra: { o2_min: 0, dose_mSv: 0, time_min: 0 } };
  const wps = (payload.waypoints || []).slice(0, m.legEnd.length);
  while (wps.length < m.legEnd.length) wps.push({ name: 'Waypoint', ll: m.c[m.legEnd[wps.length]] });
  P.wps = wps.map((w, k) => ({ ...w, idx: m.legEnd[k] }));
  P.tasks = buildTasks(m, P.wps, replanned);
  P.refills = [...(payload.plan.refills || [])];
  P.stats0 = payload.plan.stats; P.replanned = replanned;
  P.sunset = payload.plan.stats?.sunset_lmst_hhmm || null;
  const st = replanned ? payload.state : payload.base_state;   // fresh plan: starting conditions from the test bench, if any
  eff = { o2_x: 1, dose_x: 1, visibility: 1, ...(st || {}) };
  refreshRing(st || {}); zone.invalidate();
  routeLine.setLatLngs(m.c.map(p => [p[1], p[0]]));
  if (m.total > 1) map.fitBounds(routeLine.getBounds(), { padding: [40, 40] });
  d = 0; playing = !!(replanned && wasPlaying); shownWp = null; shownTask = null; $('playBtn').textContent = playing ? '⏸ Pause' : walkLabel();
  if (!replanned) { $('banner').hidden = true; $('banner').className = ''; drift.m = drift.target = 0; losUntil = -1; devAlerted = false; losArmed = false; simFired = false; }   // a fresh plan clears alerts
  $('scrub').max = Math.round(m.total); $('scrub').value = 0;
  $('empty').hidden = true; $('hud').hidden = false; render();
  if (playing) { last = performance.now(); requestAnimationFrame(loop); }
  const st0 = payload.plan.stats || {};
  if (!replanned && st0.go === 'NO-GO') {            // NO-GO plan: warn on arrival (manual and demo); the autopilot never walks it
    setTimeout(() => openAlarm('high', `NO-GO · EVA start ${st0.start_lmst_hhmm || ''}`, noGoText(st0), true), DEMO ? 1500 : 300);
    if (DEMO) return;
  }
  if (DEMO && !replanned) setTimeout(() => {         // autopilot: ×60 (real-time ×60), walk
    if (!P || playing || P.stats0 !== st0) return;
    SIM = 60; $('speedBtn').textContent = '×60'; playing = true; $('playBtn').textContent = '⏸ Pause'; last = performance.now(); requestAnimationFrame(loop);
  }, 2500);
}

const total = () => P.cumD[P.cumD.length - 1];
const activeTask = () => P.tasks.find(t => !t.done && t.at <= d + 0.5);   // astronaut is standing at an unfinished task
const nextGate = () => P.tasks.find(t => !t.done);                         // the walk cannot go past this point

const at = arr => {                                // value of a cumulative array at distance d (linear interpolation)
  const D = P.cumD; let i = 0;
  while (i < D.length - 2 && D[i + 1] <= d) i++;
  const f = D[i + 1] > D[i] ? Math.min(1, (d - D[i]) / (D[i + 1] - D[i])) : 0;
  return arr[i] + (arr[i + 1] - arr[i]) * f;
};
const position = () => {
  const D = P.cumD; let i = 0;
  while (i < D.length - 2 && D[i + 1] <= d) i++;
  const f = D[i + 1] > D[i] ? Math.min(1, (d - D[i]) / (D[i + 1] - D[i])) : 0;
  return [P.c[i][0] + (P.c[i + 1][0] - P.c[i][0]) * f, P.c[i][1] + (P.c[i + 1][1] - P.c[i][1]) * f];
};
function bearing(a, b) {
  const y = rad(b[0] - a[0]) * Math.cos(rad((a[1] + b[1]) / 2)), x = rad(b[1] - a[1]);
  const deg0 = (deg(Math.atan2(y, x)) + 360) % 360;
  return `${deg0.toFixed(0)}° ${['N','NE','E','SE','S','SW','W','NW'][Math.round(deg0 / 45) % 8]}`;
}
const hm = min => `${Math.floor(min / 60)}:${String(Math.floor(min % 60)).padStart(2, '0')}`;

// Comms from viewshed.u8 (1 = line of sight to the habitat). "Weak" = no LOS within ~20 m around.
function comms(pos) {
  if (spentNow.time_min < losUntil) return 'bad';               // simulated loss of line of sight
  const vs = site.layers.viewshed; if (!vs) return null;
  const { row, col } = lonLatToCell(meta, pos[0], pos[1]);
  const inside = (r, c) => r >= 0 && c >= 0 && r < meta.height && c < meta.width;
  if (!inside(row, col) || !vs[row * meta.width + col]) return 'bad';
  const k = Math.max(1, Math.round(20 / (meta.cell_m || 3)));
  for (const [dr, dc] of [[-k, 0], [k, 0], [0, -k], [0, k]]) if (inside(row + dr, col + dc) && !vs[(row + dr) * meta.width + col + dc]) return 'warn';
  return 'ok';
}

// ---------- Safe spot: how long can the astronaut stay, per alert type ----------
// Limits we CAN compute from the data: O₂ (keep enough to walk home + ingress, reserve untouched), suit battery
// (suit.json battery_Wh / base_power_W), daylight (params sunset_lmst − walk home − night buffer).
// SPE outside a radiation shelter: also the dose limit. NASA-STD-3001 Vol. 1 Rev. C (2023), [V1 4031]: protect crew from the
// design-reference SPE to < 250 mSv effective dose. We subtract the dose already taken in this EVA (conservative).
// O₂ while waiting = rest rate (params.rest_metabolic_factor, 0.5 = 600 BTU/h, sources in params.json).
const pv = x => (x && typeof x === 'object' && 'value' in x) ? x.value : x;
const WORK_FACTOR = pv(params.work_metabolic_factor) ?? 1;
const REST_FACTOR = pv(params.rest_metabolic_factor) ?? WORK_FACTOR;  // §9.1: egress/ingress, cache refill, shelter, hold
const REST_TASKS = new Set(params.rest_metabolic_factor?.applies_to || ['habitat_egress', 'habitat_ingress', 'cache_refill', 'shelter', 'hold']);
// base O₂-min per minute of a tablet task (× eff.o2_x when burned)
const taskRate = kind => REST_TASKS.has({ egress: 'habitat_egress', habitat: 'habitat_ingress', cache: 'cache_refill', shelter: 'shelter', hold: 'hold' }[kind]) ? REST_FACTOR : WORK_FACTOR;
const BATT_WH = pv(suit.battery_Wh), BASE_W = pv(suit.base_power_W);
const SPE_DOSE_LIMIT = pv(params.spe_dose_limit_mSv) ?? 250;   // mSv, NASA-STD-3001 V1 Rev C [V1 4031] (Ana can move it to params.json)
const SUNSET = pv(params.sunset_lmst) ?? 18, NIGHT_BUF = pv(params.night_buffer_min) ?? 30, MARS_H = 88775.244 / 24 / 60;
const fmtDur = m => m <= 0 ? 'leave now' : m >= 600 ? '10 h +' : `${Math.floor(m / 60) ? Math.floor(m / 60) + ' h ' : ''}${Math.round(m % 60)} min`;
function stayLimits(ctx, a, radSafe = true) {
  const o2x = Math.max(eff.o2_x, a ? (a.effect?.o2_x ?? 1) : 1);          // that alert active (or the current state if worse)
  const homeO2 = (ctx.cthBase + ctx.ingressMin * REST_FACTOR) * o2x;
  const lim = [
    { k: 'O₂', v: (USABLE - ctx.used - homeO2) / (REST_FACTOR * o2x) },
    { k: 'daylight', v: (SUNSET - ctx.nowLmst) * MARS_H - ctx.walkHomeMin - ctx.ingressMin - NIGHT_BUF },
  ];
  if (BATT_WH && BASE_W) lim.push({ k: 'suit battery', v: (BATT_WH - ctx.evaMin / 60 * BASE_W) / BASE_W * 60 - ctx.walkHomeMin - ctx.ingressMin });
  if (a && (a.action === 'shelter' || a.type === 'SPE') && !radSafe)       // not shielded: dose limit per SPE
    lim.push({ k: `dose limit ${SPE_DOSE_LIMIT} mSv`, v: (SPE_DOSE_LIMIT - ctx.dose) / (GCR * (a.effect?.dose_x ?? 1)) * 60 });
  return lim.reduce((m, x) => x.v < m.v ? x : m);
}
function stayNoteFor(a, radSafe) {
  if (!a) return '';
  if (a.action === 'shelter' || a.type === 'SPE') return radSafe ? 'radiation shelter' : `NOT radiation-protected · ${(GCR * (a.effect?.dose_x ?? 1)).toFixed(2)} mSv/h here`;
  if (a.action === 'return' || a.action === 'resupply') return 'needs the habitat (repair / O₂): go when you can';
  return '';
}
let stayKey = '';
function renderStay(task, ctx) {
  const show = !!task && SAFE_KINDS.has(task.kind);
  $('stayCard').hidden = !show; if (!show) { stayKey = ''; return null; }
  const tf = task.wp != null ? targetAtLL(P.wps[task.wp].ll) : null, radSafe = tf?.properties.radiation_shelter === true;
  const rows = [{ name: 'No alert', a: null }, ...(site.alerts || []).map(a => ({ name: a.name || ALERT_NAMES[a.type] || a.type, a }))]
    .map(r => ({ ...r, lim: stayLimits(ctx, r.a, radSafe), note: stayNoteFor(r.a, radSafe) }));
  const html = rows.map(r => `<div class="srow ${r.lim.v <= 0 ? 'bad' : r.lim.v < 30 ? 'warn' : ''}"><span>${r.name}</span><b>${fmtDur(r.lim.v)}</b>` +
    `<small>limited by ${r.lim.k}${r.note ? ' · ' + r.note : ''}</small></div>`).join('');
  if (html !== stayKey) { stayKey = html; $('stayRows').innerHTML = html; }
  $('stayWhere').textContent = tf?.properties.name?.split(' - ')[0] || task.name;
  $('stayNote').textContent = `O₂ while waiting = rest rate (×${REST_FACTOR} of the walking design rate, params.json). SPE dose limit ${SPE_DOSE_LIMIT} mSv per event (NASA-STD-3001 Vol. 1, [V1 4031]).`;
  return rows[0].lim;
}

// ---------- Report an emergency from the tablet (the console re-plans; if no console answers, the tablet does) ----------
let reportTimer = null, reportPending = null;
(site.alerts || []).forEach(a => {
  const b = document.createElement('button'); b.textContent = a.name || ALERT_NAMES[a.type] || a.type;
  b.onclick = () => { reportPending = a; $('reportQ').textContent = `Report "${b.textContent}" to the habitat? A new route will be sent.`; $('reportConfirm').hidden = false; $('reportBtns').hidden = true; };
  $('reportBtns').appendChild(b);
});
$('reportNo').onclick = () => { reportPending = null; $('reportConfirm').hidden = true; $('reportBtns').hidden = false; };
$('reportYes').onclick = () => {
  const a = reportPending; $('reportConfirm').hidden = true; $('reportBtns').hidden = false; if (!a || !P) return;
  send('alert_request', { alert_id: a.id, lon: lastPos?.[0], lat: lastPos?.[1], o2_used_min: spentNow.o2_min, t_min: spentNow.time_min });
  $('reportStatus').textContent = `Reported: ${a.name || ALERT_NAMES[a.type] || a.type}. Waiting for the habitat…`;
  clearTimeout(reportTimer);
  reportTimer = setTimeout(async () => {                     // nobody at the console: re-plan here with the same planner
    $('reportStatus').textContent = 'No answer from the habitat console: re-planning on the tablet.';
    await plannerReady;
    const r = await planner.replan({ current: lastPos, alert: a, state: eff, o2_used_min: spentNow.o2_min, now_lmst: startHour + spentNow.time_min / MARS_H });
    if (r.error) { $('reportStatus').textContent = 'No safe destination found. Go back toward the habitat.'; return; }
    showAlarm({ alert: a, destination: r.replan.destination, destination_kind: r.replan.destination_kind, fallback: r.replan.fallback_to_safe_point });
    setPlan({ plan: r, waypoints: [{ name: r.replan.destination, ll: r.path.geometry.coordinates.at(-1), kind: r.replan.destination_kind }], replan: true, state: r.state });
    $('reportStatus').textContent = `Re-planned on the tablet → ${r.replan.destination}.`;
  }, 4000);
};

// ---------- Task card ----------
// One button + confirmation (no per-item checklist). The console can also complete it (message 'task_done').
function showConfirm(v) { $('confirmBox').hidden = !v; $('doneBtn').hidden = v || !(P && activeTask()); }
function completeTask(name = null) {
  const t = P && activeTask(); if (!t || (name && name !== t.name)) return false;
  t.done = true; shownTask = null; shownWp = null; showConfirm(false);
  send('task_done', { name: t.name, t_min: spentNow.time_min });
  if (t.kind === 'cache') {                       // Tier 2: the refill comes back to the O₂ used
    const w = P.wps[t.wp], r = (P.refills || []).find(x => x.name === w?.name) || (P.refills || [])[0];
    const amount = r?.o2_min ?? 0;
    if (amount) {
      P.extra.o2_min -= amount; P.refills = P.refills.filter(x => x !== r);
      eff = { ...eff, cache_used: { ...(eff.cache_used || {}), [r.id]: (eff.cache_used?.[r.id] || 0) + amount } }; refreshRing(eff); zone.invalidate();
      send('refill', { id: r.id, name: r.name, o2_min: amount, t_min: spentNow.time_min });
      openAlarm('safe', `O₂ refilled at ${(r.name || '').split(' - ')[0]}`, `+${amount} O₂-min back in the tank. Next: ${(P.wps[t.wp + 1]?.name || 'Habitat').split(' - ')[0]}.`, true);
    }
  }
  render();
  if (playing) { last = performance.now(); requestAnimationFrame(loop); }
  return true;
}
$('doneBtn').onclick = () => { if (P && activeTask()) showConfirm(true); };
$('confirmNo').onclick = () => showConfirm(false);
$('confirmYes').onclick = () => completeTask();

function render() {
  if (!P) return;
  const tot = total(), task = activeTask();
  let k = 0; while (k < P.cumD.length - 2 && P.cumD[k + 1] <= d) k++;               // segment the astronaut is on
  const pathPos = position(), pos = offsetPos(pathPos, k); lastPos = pos;
  const offR = drift.m ? offRoute(pos, k) : 0;
  if (offR > DEVIATION_M && !devAlerted) { devAlerted = true; lowAlert('deviation', `Off route by ${offR.toFixed(0)} m. Head back to the planned route.`); }
  if (offR < DEVIATION_M / 2) devAlerted = false;
  astro.setLatLng([pos[1], pos[0]]);
  if (follow) map.panTo([pos[1], pos[0]], { animate: true, duration: 0.25 });
  if (dist(P.c[k], P.c[k + 1]) > 0.01) { const h = bearing(P.c[k], P.c[k + 1]); $('hdgTxt').textContent = h; $('needle').style.transform = `rotate(${parseFloat(h)}deg)`; }   // direction of travel
  const ll = p => [p[1], p[0]];
  doneLine.setLatLngs([...P.c.slice(0, k + 1).map(ll), ll(pathPos)]);
  routeLine.setLatLngs([ll(pathPos), ...P.c.slice(k + 1).map(ll)]);

  // O2, dose, time = plan up to here + carried-over base + time spent on tasks
  const o2UsedMin = P.base.o2_min + at(P.cumO2) + P.extra.o2_min;
  const o2Left = Math.max(0, 100 - o2UsedMin / O2_MIN * 100), o2LeftMin = o2Left / 100 * O2_MIN;
  const dose = P.base.dose_mSv + at(P.cumDose) + P.extra.dose_mSv, doseTotal = P.base.dose_mSv + P.cumDose[P.cumDose.length - 1] + P.extra.dose_mSv;
  const evaMin = P.base.time_min + at(P.cumT) + P.extra.time_min;
  // Ingress = the LAST habitat task of the route (the first one is the egress). Never negative (overtime).
  const habTasks = P.tasks.filter(t => t.kind === 'habitat'), lastHab = habTasks.length > 1 || (habTasks.length === 1 && P.tasks.indexOf(habTasks[0]) > 0) ? habTasks.at(-1) : null;
  const distHome = dist(pos, meta.habitat), ingress = lastHab && !lastHab.done ? lastHab : null;
  const ingressO2 = (ingress ? Math.max(0, (ingress.minutes || 0) - (ingress.elapsed || 0)) : 0) * REST_FACTOR * eff.o2_x;
  const cth = ring.costAt(pos[0], pos[1]);                                            // planner costToHome (O2-min, real terrain)
  const walkHome = cth ?? distHome / SPEED / 60 * eff.o2_x;                           // fallback: straight line at V_cap
  const homeMin = walkHome + ingressO2;
  let margin = USABLE - o2UsedMin - homeMin;                                          // planner rule: used + return <= usable
  // Tier 2: a rescue via an O₂ cache is safe if the astronaut reaches the cache (the planner already checked cache → home
  // after the refill). While a refill is pending, the margin that matters is O₂ left on arrival at that cache.
  const cacheWp = P.refills?.length ? P.wps.find(w => w.kind === 'cache' && P.cumD[w.idx] > d - 1) : null;
  if (cacheWp) margin = USABLE - o2UsedMin - Math.max(0, P.cumO2[cacheWp.idx] - at(P.cumO2));
  const state = !(margin >= 0) || distHome > WALKBACK ? 'bad' : margin < MARGIN_WARN ? 'warn' : 'ok';
  // Safe spot reached: green popup once + stay-time card while there
  const cthHere = ring.costAt(pos[0], pos[1]);
  const stayCtx = { used: o2UsedMin, evaMin, dose, nowLmst: startHour + evaMin / MARS_H, ingressMin: ingress ? Math.max(0, ingress.minutes - ingress.elapsed) : 0,
    cthBase: cthHere != null && Number.isFinite(cthHere) ? cthHere / eff.o2_x : distHome / SPEED / 60, walkHomeMin: distHome / SPEED / 60 };
  const nominal = renderStay(task, stayCtx);
  if (task && SAFE_KINDS.has(task.kind) && P.safeShown !== task) {
    P.safeShown = task;
    const tf = task.wp != null ? targetAtLL(P.wps[task.wp].ll) : null;
    openAlarm('safe', (tf?.properties.name || task.name).split(' - ')[0],
      `You can stay about ${fmtDur(nominal.v)} with no alert (limited by ${nominal.k}). Check "How long you can stay" for each alert.`);
    send('warning', { priority: 'safe', type: 'safe', message: `reached ${tf?.properties.name || task.name}`, t_min: spentNow.time_min });
  }
  // Low-O2 alerts: once per level per plan. Not while the only thing left is the habitat (already going home).
  const goingHome = !P.tasks.some(t => !t.done && t.kind !== 'habitat' && t.kind !== 'egress') && P.wps.every(w => w.kind === 'habitat' || P.cumD[w.idx] <= d + 1);
  // On the way to a cache refill the route already heads to the O₂: no 'go home' alarms (asking the console again would
  // only send the astronaut back to the same cache). Only if the cache itself is out of reach.
  if (cacheWp && margin < 0 && !P.o2Crit) { P.o2Crit = P.o2Low = true; showCritO2(margin, homeMin); }
  if (Number.isFinite(margin) && !goingHome && !cacheWp && (P.tasks.find(t => t.kind === 'egress')?.done ?? true)) {
    if (margin < MARGIN_CRIT && !P.o2Crit) {
      P.o2Crit = P.o2Low = true;
      showCritO2(margin, homeMin);
      send('o2_return', { margin_min: margin, o2_used_min: o2UsedMin, lon: pos[0], lat: pos[1] });   // console re-plans: route home
    } else if (margin < MARGIN_WARN && !P.o2Low) {
      P.o2Low = true;
      lowAlert('o2low', `Only ${Math.max(0, margin).toFixed(0)} min of O₂ margin left. Finish the current task and head back to the habitat.`);
    }
  }
  const canReturn = state !== 'bad';
  ring.update(USABLE - o2UsedMin - ingressO2);
  zone.refresh(pos, o2UsedMin);

  // Next waypoint (or the one being worked on)
  const wpIdx = task && task.wp != null ? task.wp : P.wps.findIndex(w => P.cumD[w.idx] - d > 1);
  const w = wpIdx >= 0 ? P.wps[wpIdx] : null;
  if (task && task.kind === 'egress') {
    $('wpName').textContent = 'Habitat (egress)'; $('wpDist').textContent = 'ON SITE'; $('wpBrg').textContent = '–'; $('wpEta').textContent = '–'; $('wpN').textContent = '';
  } else if (w) {
    const here = task && task.wp === wpIdx;
    $('wpName').textContent = w.name; $('wpN').textContent = `· ${wpIdx + 1}/${P.wps.length}`;
    $('wpDist').textContent = here ? 'ON SITE' : `${(P.cumD[w.idx] - d).toFixed(0)} m`;
    $('wpBrg').textContent = here ? '–' : bearing(pos, w.ll);
    $('wpEta').textContent = here ? 'task' : `${(P.cumT[w.idx] - at(P.cumT)).toFixed(0)} min`;
    if (shownWp !== w) {
      shownWp = w;
      const ph = photoFor(w);
      $('pov').innerHTML = ph ? `<img src="${ph.url}" alt="" referrerpolicy="no-referrer" onerror="this.replaceWith(document.createTextNode('Photo could not be loaded (NASA server).'))"><div>${ph.camera} · sol ${ph.sol} · <b>rover view from ${ph.dist_m.toFixed(0)} m away</b> — ${ph.caption || ''} <a href="${ph.url}" target="_blank" rel="noopener">open</a></div>` : 'No POV photo near this waypoint yet.';
    }
  } else { $('wpName').textContent = 'EVA complete'; $('wpDist').textContent = '–'; $('wpBrg').textContent = '–'; $('wpEta').textContent = '–'; $('wpN').textContent = ''; }
  const rest = P.wps.slice((wpIdx >= 0 ? wpIdx : P.wps.length) + 1).map(x => x.name.replace('Three Forks Depot - ', '').split(' - ')[0]);
  $('queue').innerHTML = rest.length ? `Then: <b>${rest.slice(0, 3).join('</b> → <b>')}</b>${rest.length > 3 ? ` · +${rest.length - 3}` : ''}` : (w ? 'Last point on the route' : '');

  // Task card: active task (gate) or preview of the next one
  const shown = task || nextGate();
  $('taskCard').classList.toggle('active', !!task);
  if (!shown) { $('taskName').textContent = 'All tasks done'; $('taskTimer').textContent = '–'; $('taskTodo').textContent = ''; $('doneBtn').hidden = true; $('confirmBox').hidden = true; }
  else if (task) {
    if (shownTask !== task) { shownTask = task; const tf = task.wp != null ? targetAtLL(P.wps[task.wp].ll) : null;
      const note = (TASK_NOTE[task.kind] || '') + (SAFE_KINDS.has(task.kind) ? (tf?.properties.radiation_shelter === true ? ' · radiation-protected' : ' · NO radiation protection') : '');
      $('taskName').innerHTML = `${task.name}${note ? `<small>${note}</small>` : ''}`; $('taskTodo').textContent = task.items.join(' · '); showConfirm(false); }
    const over = task.minutes && task.elapsed > task.minutes;
    $('taskTimer').textContent = task.minutes ? `${task.elapsed.toFixed(0)} / ${task.minutes} min${over ? ' · overtime' : ''}` : `${task.elapsed.toFixed(0)} min`;
    $('taskTimer').classList.toggle('over', !!over);
  } else {
    if (shownTask !== 'preview:' + P.tasks.indexOf(shown)) {
      shownTask = 'preview:' + P.tasks.indexOf(shown);
      $('taskName').innerHTML = `On arrival: ${shown.name}<small>${shown.minutes ? `~${shown.minutes} min · ` : ''}the walk stops there until the task is confirmed complete</small>`;
      $('taskTodo').textContent = ''; $('doneBtn').hidden = true; $('confirmBox').hidden = true;
    }
    $('taskTimer').textContent = `in ${(shown.at - d).toFixed(0)} m`; $('taskTimer').classList.remove('over');
  }

  // Environment (env.json, MCD model) at the current local solar time
  if (env) {
    const sc = scenarioFor(eff), e = envAt(env, lmstAt(startHour, evaMin), sc);
    $('envCard').hidden = false; $('envTime').textContent = `${ltst(e.hour)} LMST${P.sunset ? ` · sunset ${P.sunset}` : ''}`;
    $('envT').textContent = `${(e.temp_K - 273.15).toFixed(0)} °C`; $('envW').textContent = `${e.wind_ms.toFixed(1)} m/s`;
    $('envTau').textContent = e.tau.toFixed(2); $('envTau').className = e.tau > 1 ? 't-warn' : '';
    $('envNote').textContent = `${sc} scenario · ${e.pressure_Pa.toFixed(0)} Pa · Mars Climate Database model, not observations`;
  }

  // Status row
  $('met').textContent = hm(evaMin);
  $('o2Lasts').textContent = hm(o2LeftMin / eff.o2_x);
  const cs = comms(pos);
  // alert once when the link is lost; re-arm only after a full link ('ok'), so the coverage edge doesn't repeat it
  const simLos = spentNow.time_min < losUntil;
  if (cs === 'ok') losArmed = true;
  if (cs === 'bad' && (losArmed || (simLos && !simFired))) { losArmed = false; if (simLos) simFired = true; lowAlert('los', 'No line of sight to the habitat. Move back toward the last point with link.'); }
  $('comms').textContent = cs ? { ok: '● Link', warn: '◐ Weak', bad: '○ No LOS' }[cs] : '–';
  $('comms').className = cs ? 't-' + cs : '';
  $('commsSub').textContent = cs ? { ok: 'line of sight OK', warn: 'leaving coverage', bad: 'no line of sight' }[cs] : 'no viewshed';

  $('o2Txt').textContent = `${o2Left.toFixed(1)} %`;
  $('o2Bar').style.width = o2Left + '%'; $('o2Res').style.left = RESERVE + '%';
  $('o2Bar').style.background = { ok: '#6fcf97', warn: '#f2c94c', bad: '#ff4d4d' }[state];
  $('ret').className = 'chip ' + { ok: 'ok', warn: 'warn', bad: 'bad' }[state];
  $('ret').textContent = `${{ ok: 'GO', warn: 'CAUTION', bad: 'RETURN' }[state]} · margin ${Number.isFinite(margin) ? (margin >= 0 ? '+' : '') + margin.toFixed(0) : '–'} min · home needs ${Number.isFinite(homeMin) ? homeMin.toFixed(0) : '∞'} min${cth == null ? ' (straight-line estimate)' : ''} · ${RESERVE} % reserve kept`;
  $('doseTxt').textContent = `${dose.toFixed(4)} mSv`;
  $('doseBar').style.width = (doseTotal ? dose / doseTotal * 100 : 0) + '%';
  $('doseNote').innerHTML = `<span class="${eff.dose_x > 1 ? 't-bad' : ''}">${(GCR * eff.dose_x).toFixed(3)} mSv/h${eff.dose_x > 1 ? ` · ×${eff.dose_x}` : ''}</span> · bar = share of the planned dose`;
  $('scrub').value = Math.round(d); $('scrub').style.setProperty('--p', (tot ? d / tot * 100 : 0) + '%');
  $('scrubTxt').textContent = `${d.toFixed(0)} / ${tot.toFixed(0)} m`;
  spentNow = { o2_min: o2UsedMin, dose_mSv: dose, time_min: evaMin };
  // bus contract: {lon, lat, o2_used_min, t_min} + extras the console shows
  send('position', { lon: pos[0], lat: pos[1], o2_used_min: o2UsedMin, t_min: evaMin, d, o2_left: o2Left, can_return: canReturn,
    margin_min: Number.isFinite(margin) ? margin : null, ingress_min: ingress ? Math.max(0, (ingress.minutes || 0) - (ingress.elapsed || 0)) : 0, comms: cs, off_route_m: offR,
    task: task ? task.name : null, task_elapsed: task ? task.elapsed : null, task_min: task ? task.minutes : null, spent: spentNow });
}

function loop(t) {
  if (!playing || !P) return;
  const dtMin = Math.min(0.25, (t - last) / 1000) * SIM / 60; last = t;
  if (drift.m !== drift.target) { const step = dtMin * SPEED * 60; drift.m += Math.sign(drift.target - drift.m) * Math.min(step, Math.abs(drift.target - drift.m)); }
  const task = activeTask();
  if (task) {                                       // standing still doing the task: time, O2 and dose keep running
    task.elapsed += dtMin; P.extra.time_min += dtMin; P.extra.o2_min += dtMin * taskRate(task.kind) * eff.o2_x; P.extra.dose_mSv += GCR * dtMin / 60 * eff.dose_x;
    if (DEMO && task.elapsed >= (task.kind === 'hold' ? Math.max(task.minutes, DEMO_HOLD_MIN) : task.minutes)) { render(); completeTask(task.name); return; }   // completeTask re-arms the loop
  } else {
    const gate = nextGate(), lim = gate ? gate.at : total();
    let i = 0; while (i < P.cumD.length - 2 && P.cumD[i + 1] <= d) i++;
    const dt = P.cumT[i + 1] - P.cumT[i], v = dt > 0 ? (P.cumD[i + 1] - P.cumD[i]) / dt : SPEED * 60;   // m per planned minute (Tobler on slopes)
    d = Math.min(lim, d + dtMin * v);
  }
  render();
  if (d >= total() && !nextGate()) { playing = false; $('playBtn').textContent = walkLabel(); return; }
  requestAnimationFrame(loop);
}
$('speedBtn').onclick = () => { SIM = SPEEDS[(SPEEDS.indexOf(SIM) + 1) % SPEEDS.length]; $('speedBtn').textContent = `×${SIM}`; if (!playing) $('playBtn').textContent = walkLabel(); };
function resetWalk() {
  d = 0; shownWp = null; shownTask = null;
  P.extra = { o2_min: 0, dose_mSv: 0, time_min: 0 };
  P.tasks.forEach(t => { t.done = false; t.elapsed = 0; }); showConfirm(false);
}
// Why a plan is NO-GO, from the planner stats (daylight, O₂ return, walkback, battery)
function noGoText(st) {
  const why = st.o2_return_ok === false ? 'not enough O₂ to get back' : st.walkback_ok === false ? 'too far to walk back'
    : st.battery_used_pct > 100 ? 'the suit battery runs out' : `back at ${st.end_lmst_hhmm}, after sunset ${st.sunset_lmst_hhmm}${st.daylight_margin_min != null ? ` (${st.daylight_margin_min} min daylight margin)` : ''}`;
  return `NO-GO: ${why}. The console flags this plan as NO-GO: stay in the habitat.`;
}
$('playBtn').onclick = () => {
  if (!P) return;
  if (!playing && P.stats0?.go === 'NO-GO' && !P.replanned) setBanner('high', `HIGH · ${noGoText(P.stats0)}`);   // manual walk still allowed, but warned every time
  if (d >= total() && !nextGate()) resetWalk();
  playing = !playing; $('playBtn').textContent = playing ? '⏸ Pause' : walkLabel();
  if (playing) { last = performance.now(); requestAnimationFrame(loop); }
};
$('scrub').addEventListener('input', e => {        // drag forward or back, but never past an unfinished task
  if (!P) return; const gate = nextGate();
  d = Math.min(+e.target.value, gate ? gate.at : total()); e.target.value = Math.round(d); shownWp = null; render();
});
function setFollow(v) { follow = v; const b = $('followBtn'); b.classList.toggle('on', v); b.textContent = `◉ Follow astronaut: ${v ? 'ON' : 'OFF'}`; if (v && P) { const ll = astro.getLatLng(); map.panTo(ll); } }
$('followBtn').onclick = () => setFollow(!follow);
map.on('dragstart', () => { if (follow) setFollow(false); });   // dragging the map by hand releases the camera
$('resetBtn').onclick = () => { if (!P) return; playing = false; resetWalk(); $('playBtn').textContent = walkLabel(); render(); };

// ---------- Messages from the console ----------
onMessage(m => {
  if (m.type === 'plan') setPlan(m.payload);
  if (m.type === 'alert') {                         // {alert, destination, destination_kind}; the replanned route follows as a 'plan'
    if (reportTimer) { clearTimeout(reportTimer); reportTimer = null; $('reportStatus').textContent = `Habitat answered → ${m.payload.destination || 'new route'}.`; }
    const a = m.payload.alert || m.payload, e = a.effect || {};
    showAlarm(m.payload);
    setBanner('high', `HIGH · ${a.name || ALERT_NAMES[a.type] || a.type}: → ${m.payload.destination || (a.action === 'return' ? 'habitat' : 'safe place')} · O₂ ×${e.o2_x ?? 1} · dose ×${e.dose_x ?? 1}`);
  }
  if (m.type === 'sim') simulate(m.payload.kind);
  if (m.type === 'task_done_cmd') completeTask(m.payload.name);   // habitat confirmed it from the console   // demo only: console simulates a low-priority event
});
try { const saved = localStorage.getItem('marswalk:plan'); if (saved) setPlan(JSON.parse(saved)); } catch {}
