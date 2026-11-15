import L from 'leaflet';
import { createSiteMap } from './common.js';
import { buildLayers } from './layers.js';
import { createPlanner } from './plannerClient.js';   // Eric's real planner (A* in a Web Worker), docs/INTEGRATION.md
import { routeModel } from './route.js';
import { createRing } from './ring.js';
import { send, onMessage } from './bus.js';
import { helmetIcon } from './geo.js';
import { loadEnv, envAt, scenarioFor, ltst, fmtEnv, lmstAt } from './env.js';
import { loadPresets, removePreset, onPresetsChange, presetSummary } from './presets.js';

const { map, site, name, bounds, basemap } = await createSiteMap();
const env = await loadEnv(site);
const habitat = site.meta.habitat;
const $ = id => document.getElementById(id);

// ---------- Layers panel ----------
const ring = createRing(map, bounds, site.meta), ringLayer = ring.layer;     // real no-return zone (costToHome)
const layerList = [{ id: 'basemap', label: 'Mars Trek basemap', layer: basemap, on: false }, { id: 'ring', label: 'No-return zone (dark red)', layer: ringLayer, on: true }, ...buildLayers(site, name, bounds, (ll, n, ph, k) => addStop(ll, n, ph, k))];
layerList.forEach((e, i) => {
  if (e.id !== 'ring') e.layer.setZIndex?.(i);
  if (e.on) e.layer.addTo(map);
  const row = document.createElement('div'); row.className = 'layer';
  row.innerHTML = `<label><input type="checkbox" ${e.on ? 'checked' : ''}> ${e.label}</label>` +
                  (e.opacity ? `<input type="range" min="0" max="1" step="0.05" value="${e.layer.options.opacity}">` : '');
  if (e.legend) {
    const lg = document.createElement('div'); lg.className = 'legend';
    lg.innerHTML = e.legend.map(l => `<div class="lg"><i style="background:${l.color}"></i><b>${l.name}</b><span>${l.meaning}</span></div>`).join('');
    row.insertBefore(lg, row.querySelector('input[type=range]'));
  }
  const rg = row.querySelector('input[type=range]');
  if (rg) rg.style.setProperty('--p', (e.layer.options.opacity * 100) + '%');
  row.querySelector('input[type=checkbox]').onchange = ev => ev.target.checked ? e.layer.addTo(map) : map.removeLayer(e.layer);
  rg?.addEventListener('input', ev => { e.layer.setOpacity(+ev.target.value); ev.target.style.setProperty('--p', ev.target.value * 100 + '%'); });
  $('layers').appendChild(row);
});
L.circleMarker([habitat[1], habitat[0]], { radius: 8, color: '#000', weight: 2, fillColor: '#fff', fillOpacity: 1, bubblingMouseEvents: false })
  .bindTooltip('Habitat (start & end)').addTo(map);

// ---------- EVA start time (LMST) — any hour; each option says if the current route works at that hour ----------
for (let h = 0; h < 24; h += 0.5) { const o = document.createElement('option'); o.value = h; o.textContent = ltst(h); if (h === 9) o.selected = true; $('startHour').appendChild(o); }
const startHour = () => +$('startHour').value;
const pv = x => (x && typeof x === 'object' && 'value' in x) ? x.value : x;
const SUNRISE = pv(site.params?.sunrise_lmst) ?? 6, SUNSET = pv(site.params?.sunset_lmst) ?? 18, NIGHT_BUF = pv(site.params?.night_buffer_min) ?? 30;
const MARS_H = 88775.244 / 24 / 60;                       // Earth min per Mars hour (same as planner daylightCheck)
// Same rule as Eric's daylightCheck + the planner's O2 / walkback / battery verdict (which doesn't depend on the hour)
function verdictAt(h, st) {
  if (!st.o2_return_ok || !st.walkback_ok || st.battery_used_pct > 100) return { go: 'NO-GO', why: !st.o2_return_ok ? 'not enough O₂ to get back (any hour)' : !st.walkback_ok ? 'too far to walk back (any hour)' : 'suit battery runs out (any hour)' };
  if (h < SUNRISE) return { go: 'NO-GO', why: `leaves before sunrise (${ltst(SUNRISE)})` };
  const end = h + st.duration_min / MARS_H, margin = (SUNSET - end) * MARS_H;
  if (margin < 0) return { go: 'NO-GO', why: `back at ${ltst(end)}, after sunset (${ltst(SUNSET)})`, end };
  if (margin < NIGHT_BUF) return { go: 'CAUTION', why: `back at ${ltst(end)}, only ${Math.round(margin)} min before sunset`, end };
  return { go: 'GO', why: `back at ${ltst(end)}, ${Math.round(margin)} min before sunset`, end };
}
let baseStats = null;                                     // stats of the last fresh plan (not replans)
const SYM = { GO: '✓', CAUTION: '!', 'NO-GO': '✗' };
function annotateHours() {
  for (const o of $('startHour').options) {
    const h = +o.value;
    if (!baseStats) { o.textContent = ltst(h); continue; }
    const v = verdictAt(h, baseStats); o.textContent = `${ltst(h)}   ${SYM[v.go]} ${v.go}`;
  }
  const v = baseStats && verdictAt(startHour(), baseStats), el = $('hourVerdict');
  el.hidden = !v; if (v) { el.className = 'verdict go-' + v.go; el.innerHTML = `<b>${SYM[v.go]} ${v.go}</b> ${v.why}`; }
}
$('startHour').onchange = () => { annotateHours(); if (stops.length && baseStats) planRoute(); };

// ---------- Stops ----------
// task = true  -> "task to do": the walk stops there and the tablet shows a checklist (custom points: TASK_DEFAULT min)
// task = false -> pass-through waypoint (a target marked false is visited without doing its task)
// task = null  -> planner decides (targets get their params.task_min, custom points 0)
const TASK_DEFAULT = 15;                   // min for a custom task stop (team estimate, editable per stop)
const stops = [];                          // {ll:[lon,lat], name, photo_id, kind, task, task_min}
const stopGroup = L.layerGroup().addTo(map);
let taskN = 0;
function addStop(ll, label, photo_id = null, kind = null, task = null) {
  stops.push({ ll, name: label || (task ? `Field task ${++taskN}` : 'Custom point'), photo_id, kind, task, task_min: TASK_DEFAULT });
  renderStops();
}
const isTask = s => s.task ?? (!!s.kind && s.kind !== 'habitat');           // targets are tasks unless toggled off
function toggleTask(i) {
  const s = stops[i]; s.task = !isTask(s);
  if (s.task && s.name.startsWith('Custom point')) s.name = `Field task ${++taskN}`;
  else if (!s.task && !s.kind && s.name.startsWith('Field task')) s.name = 'Custom point';
  renderStops();
}
function renderStops() {
  stopGroup.clearLayers(); $('stops').innerHTML = '';
  stops.forEach((s, i) => {
    const t = isTask(s);
    const mk = L.marker([s.ll[1], s.ll[0]], { icon: L.divIcon({ className: 'stop' + (t ? ' task' : ''), html: t ? `⚑${i + 1}` : String(i + 1), iconSize: [t ? 30 : 22, 22] }), bubblingMouseEvents: false })
      .bindTooltip(t ? 'Task to do · double-click to make it a waypoint' : 'Waypoint · double-click to make it a task').addTo(stopGroup);
    mk.on('dblclick', ev => { L.DomEvent.stop(ev); toggleTask(i); });
    const li = document.createElement('li'); li.className = t ? 'task' : '';
    li.title = 'Double-click to toggle task / waypoint';
    li.innerHTML = `<span>${i + 1}. ${t ? '<b class="tbadge">⚑ TASK</b> ' : ''}${s.name}</span>` +
      (t && !s.kind ? `<input type="number" min="1" max="240" value="${s.task_min}" title="Task minutes"><small>min</small>` : '') +
      `<button title="Remove">×</button>`;
    li.ondblclick = ev => { if (ev.target.tagName !== 'INPUT' && ev.target.tagName !== 'BUTTON') toggleTask(i); };
    li.querySelector('input')?.addEventListener('change', ev => { s.task_min = Math.max(1, +ev.target.value || TASK_DEFAULT); });
    li.querySelector('button').onclick = () => { stops.splice(i, 1); renderStops(); };
    $('stops').appendChild(li);
  });
  $('stopsEmpty').style.display = stops.length ? 'none' : 'block';
}
// single click = waypoint, double click = task stop (wait a moment so a double click doesn't also add a waypoint)
map.doubleClickZoom.disable();
let clickTimer = null;
map.on('click', e => { clearTimeout(clickTimer); clickTimer = setTimeout(() => addStop([e.latlng.lng, e.latlng.lat]), 260); });
map.on('dblclick', e => { clearTimeout(clickTimer); addStop([e.latlng.lng, e.latlng.lat], null, null, null, true); });
renderStops();

// ---------- Route drawing ----------
const SEG_M = 250;                         // group planner vertices into ~250 m segments for display
let routeGroup = null, selected = null;
const COLORS = ['#e2603a', '#f29b6c'], DONE = '#56ccf2';
let segs = [];                              // {line, base, s} for every drawn segment

function groupSegments(coords, segs, maxLen) {
  const out = []; let cur = null;
  segs.forEach((g, i) => {
    if (!cur) cur = { pts: [coords[i]], distance_m: 0, time_min: 0, o2_min: 0, dose_mSv: 0, slope_deg: 0, commsN: 0, n: 0 };
    cur.pts.push(coords[i + 1]); cur.n++;
    cur.distance_m += g.distance_m; cur.time_min += g.time_min; cur.o2_min += g.o2_min; cur.dose_mSv += g.dose_mSv;
    cur.slope_deg = Math.max(cur.slope_deg, g.slope_deg ?? 0); cur.commsN += g.comms ?? 1;
    if (cur.distance_m >= maxLen) { out.push(cur); cur = null; }
  });
  if (cur) out.push(cur);
  let cum = 0; out.forEach((s, i) => { cum += s.distance_m; s.index = i + 1; s.cum = cum; s.comms = s.commsN / s.n * 100; });
  return out;
}
const row = (k, v) => `<div class="stat"><span>${k}</span><b>${v}</b></div>`;

function showSegment(s) {
  $('seg').innerHTML = row('Segment', s.index) + row('Length', s.distance_m.toFixed(0) + ' m') + row('Time', s.time_min.toFixed(1) + ' min') +
    row('O₂ used', s.o2_min.toFixed(1) + ' min') + row('Radiation dose', s.dose_mSv.toFixed(4) + ' mSv') +
    row('Max slope', s.slope_deg.toFixed(1) + '°') + row('Comms', s.comms.toFixed(0) + '%') +
    row('From start', (s.cum / 1000).toFixed(2) + ' km');
}

function weatherRows(res) {                   // env.json (MCD model) at the start and at the end of the EVA
  if (!env) return '';
  const sc = scenarioFor(alertState), t0 = lmstAt(startHour(), res.replan ? lastPosition?.t_min : 0);
  const a = envAt(env, t0, sc), b = envAt(env, lmstAt(t0, res.stats.duration_min), sc);
  return row(`Weather ${ltst(t0)} (${sc})`, `<small>${fmtEnv(a)}</small>`) + row(`Weather ${ltst(b.hour)} (end)`, `<small>${fmtEnv(b)}</small>`) +
    '<div class="est">Weather: Mars Climate Database model (not observations), env.json</div>';
}
function goBadge(res) {                       // one verdict for the mission: O2 / walkback / battery + daylight
  const st = res.stats;
  if (res.replan) return st.go ? `<div class="go go-${st.go}">${st.go}<small>home ${st.end_lmst_hhmm} LMST · sunset ${st.sunset_lmst_hhmm}</small></div>` : '';
  const v = verdictAt(startHour(), st);
  return `<div class="go go-${v.go}">${v.go}<small>start ${ltst(startHour())} LMST · ${v.why}</small></div>`;
}
function drawRoute(res, title = null) {
  const m = routeModel(res, site);
  if (routeGroup) map.removeLayer(routeGroup);
  selected = null; routeGroup = L.featureGroup().addTo(map);
  segs = [];
  const segLen = Math.max(15, Math.min(SEG_M, m.total / 6));       // short routes (replans) still get ~6 segments
  groupSegments(m.c, m.pieces, segLen).forEach(s => {
    const base = { color: COLORS[s.index % 2], weight: 5, opacity: 0.95 };
    const line = L.polyline(s.pts.map(p => [p[1], p[0]]), { ...base, bubblingMouseEvents: false }).addTo(routeGroup);
    line.bindTooltip('Segment ' + s.index, { sticky: true });
    const g = { line, base, s, done: false }; segs.push(g);
    line.on('click', () => {
      if (selected) selected.line.setStyle(selected.g.done ? { color: DONE, weight: 5 } : selected.base);
      selected = { line, base, g }; line.setStyle({ color: '#fff', weight: 8 }); showSegment(s);
    });
  });
  if (res.turnaround_point) {                       // first point where the O2 rule fails: turn back here
    const [lon, lat] = res.turnaround_point;
    L.marker([lat, lon], { icon: L.divIcon({ className: 'turnX', html: '✕<span>TURN BACK</span>', iconSize: [24, 24] }), interactive: false }).addTo(routeGroup);
  }
  if (routeGroup.getLayers().length) map.fitBounds(routeGroup.getBounds(), { padding: [40, 40], maxZoom: 16 }); // tiny routes: don't zoom into a blur
  const st = res.stats, ok = v => v ? '✓' : '✗';
  $('stats').innerHTML = (title ? `<div class="est">${title}</div>` : '') +
    goBadge(res) +
    row('Safe', st.safe ? '✓ yes' : '✗ NO') +
    row('Distance', (st.distance_m / 1000).toFixed(2) + ' km') +
    row('Duration', `${st.duration_min} min <small>(${st.walk_min} walk + ${st.task_min} work)</small>`) +
    row('O₂ used', `${st.o2_used_pct.toFixed(1)} % · ${st.o2_used_min.toFixed(0)} min`) +
    row('O₂ margin (return)', `${ok(st.o2_return_ok)} ${st.o2_margin_min >= 0 ? '+' : ''}${st.o2_margin_min} min`) +
    row('Walkback (max)', `${ok(st.walkback_ok)} ${st.walkback_max_m} m`) +
    row('Dose', st.dose_mSv.toFixed(3) + ' mSv') +
    row('Max slope', st.max_slope_deg.toFixed(1) + '°') +
    row('Battery', st.battery_used_pct + ' %') +
    row('Comms', site.layers.viewshed ? st.comms_pct + ' %' : '<small>no viewshed data</small>') +
    weatherRows(res) +
    (res.timing_ms ? `<div class="est">A* planner · ${res.timing_ms.cost_grid + res.timing_ms.astar} ms</div>` : '');
  $('seg').innerHTML = '<div class="empty">Click a route segment on the map.</div>';
  return m;
}
// ---------- Planner (Eric) ----------
const ERRORS = {
  point_outside_map: 'A stop is outside the map.',
  point_in_forbidden_zone: 'A stop is in a forbidden zone (slope or rocks) with no walkable cell nearby.',
  unreachable: 'No walkable route between two stops (blocked by forbidden terrain).',
  no_safe_destination: 'No safe destination reachable for this alert.',
};
function setStatus(kind, text, id = 'status') { const el = $(id); el.className = kind ? 'st-' + kind : ''; el.textContent = text; }
const showError = (r, id = 'status') => setStatus('warn', 'Planner: ' + (ERRORS[r.error] || r.error), id);
const planner = createPlanner();
$('planBtn').disabled = true; $('status').textContent = 'Loading planner…';
const plannerReady = planner.init(name).then(() => { $('planBtn').disabled = false; $('status').textContent = ''; })
  .catch(e => { $('status').textContent = 'Planner failed to load: ' + e.message; throw e; });

let alertState = {};                 // alerts stack: keep what replan() returns
let baseState = {};                  // starting conditions set from the test bench (suit failure / dust)
let baseUsed = 0;                    // O2-min already used at EVA start (test bench: tank not full)
let lastPosition = null;             // from the tablet: {lon, lat, o2_used_min, ...}
let ingressMin = 0;                  // pending habitat ingress of the current plan (O2-min reserved for it)
async function refreshRing() {       // costToHome depends on the alert state -> fetch once per state
  await plannerReady;
  ring.setData(await planner.costToHome({ state: alertState }));
  updateRing(true);
}
function updateRing(force = false) {
  if (!ring.ready) return;
  const used = lastPosition?.o2_used_min ?? baseUsed;
  ring.update(ring.usable - used - ingressMin * (alertState.o2_x ?? 1), force);
}
refreshRing();

function publish(res, waypoints, extra = {}) {
  const payload = { plan: res, stops: waypoints.map(w => w.ll), waypoints, start_hour: startHour(), o2_start_used: baseUsed, base_state: baseState, ...extra };
  send('plan', payload);
  try { localStorage.setItem('marswalk:plan', JSON.stringify(payload)); } catch {}
}

async function planRoute() {
  if (!stops.length) { $('status').textContent = 'Add at least one stop (click the map or a target).'; return; }
  $('status').textContent = 'Planning…';
  await plannerReady;
  // req.task_min[k] overrides the planner's task time at stop k (null = planner default from targets / params)
  const task_min = [...stops.map(s => s.task === true ? (s.kind ? null : s.task_min) : s.task === false ? 0 : null), null];
  const res = await planner.plan({ start: habitat, stops: stops.map(s => s.ll), goal: habitat, task_min, start_lmst: startHour(), state: baseState, o2_used_min: baseUsed });
  if (res.error) return showError(res);
  $('status').textContent = '';
  if (JSON.stringify(alertState) !== JSON.stringify(baseState)) { alertState = { ...baseState }; refreshRing(); }   // a fresh plan starts with no alerts (only the bench conditions)
  baseStats = res.stats; annotateHours();
  const m = drawRoute(res);
  ingressMin = m.legTask[m.legTask.length - 1] || 0; updateRing(true);
  publish(res, [...stops.map(s => ({ name: s.name, ll: s.ll, photo_id: s.photo_id, kind: isTask(s) ? (s.kind || 'task') : null })), { name: 'Habitat', ll: habitat, kind: 'habitat' }]);
}
$('planBtn').onclick = planRoute;
$('clearBtn').onclick = () => { stops.length = 0; renderStops(); if (routeGroup) map.removeLayer(routeGroup); routeGroup = null; baseStats = null; annotateHours();
  $('stats').innerHTML = '<div class="empty">No route yet.</div>'; $('seg').innerHTML = '<div class="empty">Click a route segment on the map.</div>'; };

// ---------- Astronaut position coming from the tablet ----------
let astro = null;
const hm = min => `${Math.floor(min / 60)}:${String(Math.floor(min % 60)).padStart(2, '0')}`;
onMessage(msg => {
  if (msg.type !== 'position') return;
  const p = msg.payload, ll = [p.lat, p.lon];
  segs.forEach(g => {                         // segments already walked turn blue
    g.done = g.s.cum - g.s.distance_m / 2 <= p.d;
    if (selected?.line !== g.line) g.line.setStyle(g.done ? { color: DONE, weight: 5 } : g.base);
  });
  lastPosition = p;
  if (!astro) astro = L.marker(ll, { icon: helmetIcon(), zIndexOffset: 1000, interactive: false }).addTo(map);
  else astro.setLatLng(ll);
  if (p.ingress_min != null) ingressMin = p.ingress_min;
  updateRing();
  $('astro').innerHTML = row('O₂ used', `${p.o2_used_min.toFixed(0)} min` + (p.o2_left != null ? ` · ${p.o2_left.toFixed(1)} % left` : '')) +
    (p.margin_min != null ? row('Return margin', `${p.margin_min >= 0 ? '+' : ''}${p.margin_min.toFixed(0)} min`) : '') +
    row('Return', p.can_return ? '✓ OK' : '✗ NO RETURN') +
    (p.t_min != null ? row('EVA time', hm(p.t_min)) : '') +
    '';
  showTask(p);
});

// ---------- Alerts (docs/INTEGRATION.md §4): console owns replanning, tablet only renders ----------
const alertBox = $('alerts');
const ALERT_NAMES = { SPE: 'Solar particle event', dust: 'Dust storm', suit: 'Suit failure', los: 'Loss of line of sight', deviation: 'Route deviation' };
const ACTION_LABEL = { shelter: 'radiation shelter', safe_point: 'nearest safe point', return: 'habitat', resupply: 'resupply O₂' };
const aname = a => a.name || ALERT_NAMES[a.type] || a.type;          // alerts.json may give its own name (e.g. 'O2 leak')
// INTEGRATION §8.7: every replan says which places it considered, how many walking minutes each, and why
function consideredHtml(list = []) {
  if (!list.length) return '';
  return '<div class="opts"><div class="opts-h">Options considered (walking time):</div>' + list.map(c =>
    `<div class="opt ${c.chosen ? 'chosen' : c.eligible ? 'ok' : 'no'}"><b>${c.chosen ? '➜' : c.eligible ? '✓' : '✗'}</b>` +
    `<span>${c.name}</span><em>${c.minutes != null ? c.minutes + ' min' : '–'}</em>` +
    `<small>${c.chosen ? 'chosen: fastest eligible' : c.why === 'candidate' ? 'eligible, slower' : c.why}</small></div>`).join('') + '</div>';
}
const shortConsidered = (list = []) => list.slice(0, 4).map(c => `${c.name.split(' - ')[0]} ${c.minutes ?? '–'} min ${c.chosen ? '✓' : c.eligible ? '' : '✗'}`.trim()).join(' · ');
const head = (cls, html) => { const h = document.createElement('div'); h.className = 'prio ' + cls; h.innerHTML = html; alertBox.appendChild(h); };
function logAlert(priority, text) {
  const log = $('alertLog'), li = document.createElement('div'); li.className = 'ev ' + priority;
  li.innerHTML = `<b>${priority === 'high' ? 'HIGH' : priority === 'low' ? 'LOW' : '✓'}</b> ${lastPosition?.t_min != null ? hm(lastPosition.t_min) + ' · ' : ''}${text}`;
  log.prepend(li); while (log.children.length > 5) log.lastChild.remove();
}
head('high', '<b>■ High priority</b> · replans the route');
(site.alerts || []).forEach(a => {
  const b = document.createElement('button'); b.className = 'high';
  b.textContent = `${aname(a)} → ${ACTION_LABEL[a.action] || a.action}`;
  b.title = `O₂ ×${a.effect?.o2_x ?? 1} · dose ×${a.effect?.dose_x ?? 1} · visibility ${a.effect?.visibility ?? 1}`;
  b.onclick = async () => {
    if (!routeGroup) { setStatus('warn', 'Plan a route first (Route → Plan), then inject an alert.', 'alertStatus'); return; }
    setStatus('', 'Replanning…', 'alertStatus');
    const current = lastPosition ? [lastPosition.lon, lastPosition.lat] : habitat;     // where the astronaut is right now
    const r = await planner.replan({ current, alert: a, state: alertState, o2_used_min: lastPosition?.o2_used_min ?? 0, now_lmst: lmstAt(startHour(), lastPosition?.t_min) });
    if (r.error) return showError(r, 'alertStatus');
    alertState = r.state;
    const { destination, destination_kind, destination_id } = r.replan;
    const fallback = !!r.replan.fallback_to_safe_point;      // §8.4: habitat doesn't fit (O₂ / daylight) -> nearest safe point
    const considered = r.replan.considered || [];
    send('alert', { alert: a, destination, destination_kind, fallback, considered: shortConsidered(considered) });
    logAlert('high', `${aname(a)} → ${destination}`);
    if (r.stats.distance_m < 5) {               // the astronaut is already there (e.g. still in the habitat): keep the route, just alert
      setStatus('high', `${aname(a)}: the astronaut is already at ${destination}. Stay there (EVA on hold). Alert sent to the tablet.`, 'alertStatus');
      $('alertStatus').insertAdjacentHTML('beforeend', consideredHtml(considered));
      return;
    }
    const m = drawRoute(r, `Alert ${a.type}: replanned from the astronaut's position → ${destination} (${r.replan.total_ms} ms). Stats cover the new leg only.`);
    ingressMin = destination_kind === 'habitat' ? (m.legTask[m.legTask.length - 1] || 0) : 0;
    refreshRing();
    const dest = (site.targets?.features || []).find(f => f.properties.id === destination_id);
    publish(r, [{ name: destination, ll: r.path.geometry.coordinates.at(-1), kind: destination_kind, photo_id: dest?.properties.photo_id ?? null }],
      { replan: true, state: r.state });
    setStatus('high', `${fallback ? `Can't make it home: go to ${destination}. ` : ''}${aname(a)} sent → new route to ${destination} (${(r.stats.distance_m / 1000).toFixed(2)} km, ${r.replan.total_ms} ms) is on the tablet.${r.replan.via_cache ? ` Refill at ${r.replan.via_cache.name || r.replan.via_cache}.` : ''}`, 'alertStatus');
    $('alertStatus').insertAdjacentHTML('beforeend', consideredHtml(considered));
  };
  alertBox.appendChild(b);
});

// LOW priority: the tablet detects them (viewshed / distance to the route) and reports them as 'warning'.
// In the simulation the astronaut walks exactly on the route, so these buttons simulate the event for the demo.
head('low', '<b>■ Low priority</b> · detected by the tablet, no replan <small>(buttons simulate it)</small>');
[['los', 'Loss of line of sight'], ['deviation', 'Route deviation']].forEach(([kind, label]) => {
  const b = document.createElement('button'); b.className = 'low'; b.textContent = label;
  b.onclick = () => { if (!routeGroup) { setStatus('warn', 'Plan a route first (Route → Plan).', 'alertStatus'); return; } send('sim', { kind }); setStatus('low', `${label} simulated on the tablet (press Walk there to see it move).`, 'alertStatus'); };
  alertBox.appendChild(b);
});
onMessage(msg => { if (msg.type === 'warning') logAlert('low', `${ALERT_NAMES[msg.payload.type] || msg.payload.type}: ${msg.payload.message}`); });

// ---------- Task in progress: one button + confirmation (habitat can close the task too) ----------
let tcTask = null;
function showTask(p) {
  const has = !!p.task; $('taskCtl').hidden = !has;
  if (!has) { tcTask = null; return; }
  if (p.task !== tcTask) { tcTask = p.task; $('tcName').textContent = p.task; $('tcConfirm').hidden = true; $('tcBtn').hidden = false; }
  $('tcTime').textContent = p.task_min ? `${(p.task_elapsed ?? 0).toFixed(0)} / ${p.task_min} min` : '';
}
$('tcBtn').onclick = () => { $('tcBtn').hidden = true; $('tcConfirm').hidden = false; };
$('tcNo').onclick = () => { $('tcConfirm').hidden = true; $('tcBtn').hidden = false; };
$('tcYes').onclick = () => { if (tcTask) send('task_done_cmd', { name: tcTask }); $('tcConfirm').hidden = true; $('tcBtn').hidden = false; };
onMessage(msg => { if (msg.type === 'task_done') logAlert('done', `Task complete: ${msg.payload.name}`); });

// ---------- Configuration from the planner test bench (planner-test.html → "Send to console") ----------
// {site, stops:[[lon,lat]], start_hour, o2_start_min, state:{o2_x?, visibility?}, route_label}
const O2_TOTAL = (pv(site.suit?.o2_hours) ?? 8) * 60;
function targetNear(ll) {
  let best = null, bd = 20;                // within 20 m of a target -> use its name / kind / photo
  for (const f of site.targets?.features || []) { const c = f.geometry.coordinates;
    const d = Math.hypot((c[0] - ll[0]) * Math.cos(c[1] * Math.PI / 180), c[1] - ll[1]) * Math.PI / 180 * 3396190;
    if (d < bd) { bd = d; best = f; } }
  return best;
}
async function applyConfig(cfg, fromLive = false) {
  if (!cfg) return;
  if (cfg.site && cfg.site !== name) { setStatus('warn', `The test bench sent a ${cfg.site} configuration; this console shows ${name}. Open console.html?site=${cfg.site}.`); return; }
  stops.length = 0;
  for (const ll of cfg.stops || []) {
    const f = targetNear(ll);
    if (f?.properties.kind === 'habitat') continue;         // the console adds the habitat at both ends
    if (f) addStop(f.geometry.coordinates, f.properties.name, f.properties.photo_id, f.properties.kind); else addStop(ll);
  }
  if (cfg.start_hour != null) $('startHour').value = String(Math.round(cfg.start_hour * 2) / 2);
  baseUsed = cfg.o2_start_min != null ? Math.max(0, O2_TOTAL - cfg.o2_start_min) : 0;
  baseState = cfg.state || {};
  const conds = [baseState.o2_x > 1 && 'suit failure (O₂ ×' + baseState.o2_x + ')', baseState.visibility < 1 && 'dust (visibility ' + baseState.visibility + ')'].filter(Boolean);
  $('cfgNote').hidden = false;
  $('cfgNote').innerHTML = `<b>Configured from the test bench</b> · ${cfg.route_label || stops.length + ' stops'} · O₂ at start ${Math.round(O2_TOTAL - baseUsed)} min (${Math.round((O2_TOTAL - baseUsed) / O2_TOTAL * 100)} %)` +
    `${conds.length ? ' · ' + conds.join(', ') : ''} · start ${ltst(startHour())} <button id="cfgReset">Reset</button>`;
  $('cfgReset').onclick = () => { baseUsed = 0; baseState = {}; $('cfgNote').hidden = true; try { localStorage.removeItem('marswalk:config'); } catch {} if (stops.length) planRoute(); };
  await plannerReady;
  if (stops.length) await planRoute();
  if (fromLive) send('config_ack', { stops: stops.length, ok: !!routeGroup });
}
onMessage(msg => { if (msg.type === 'config') applyConfig(msg.payload, true); });

// ---------- Saved presets (created in the test bench with "Save preset") ----------
let activePreset = null;
function renderPresets() {
  const list = loadPresets(name), box = $('presets'); box.innerHTML = '';
  if (!list.length) { box.innerHTML = '<div class="empty">None yet. Create them in the planner test bench (Console setup → Save preset).</div>'; return; }
  for (const p of list) {
    const row = document.createElement('div'); row.className = 'preset' + (p.id === activePreset ? ' active' : '');
    row.innerHTML = '<div class="pn"><b></b><small></small></div><button class="ld">Load</button><button class="rm" title="Delete">×</button>';
    row.querySelector('b').textContent = p.name; row.querySelector('small').textContent = presetSummary(p.cfg, O2_TOTAL);
    row.querySelector('.ld').onclick = async () => { activePreset = p.id; renderPresets(); await applyConfig({ ...p.cfg, route_label: p.name }); };
    row.querySelector('.rm').onclick = () => { if (activePreset === p.id) activePreset = null; removePreset(p.id); };
    box.appendChild(row);
  }
}
onPresetsChange(renderPresets); renderPresets();
try { const c = JSON.parse(localStorage.getItem('marswalk:config') || 'null'); if (c && Date.now() - (c.t || 0) < 12 * 3600e3) applyConfig(c); } catch {}
