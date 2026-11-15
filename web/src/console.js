import L from 'leaflet';
import { createSiteMap } from './common.js';
import { buildLayers } from './layers.js';
import { createPlanner } from './plannerClient.js';   // Eric's real planner (A* in a Web Worker), docs/INTEGRATION.md
import { routeModel } from './route.js';
import { createRing } from './ring.js';
import { send, onMessage } from './bus.js';
import { helmetIcon } from './geo.js';

const { map, site, name, bounds, basemap } = await createSiteMap();
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

// ---------- Stops ----------
const stops = [];                          // {ll:[lon,lat], name}
const stopGroup = L.layerGroup().addTo(map);
function addStop(ll, label, photo_id = null, kind = null) { stops.push({ ll, name: label || 'Custom point', photo_id, kind }); renderStops(); }
function renderStops() {
  stopGroup.clearLayers(); $('stops').innerHTML = '';
  stops.forEach((s, i) => {
    L.marker([s.ll[1], s.ll[0]], { icon: L.divIcon({ className: 'stop', html: String(i + 1), iconSize: [22, 22] }), bubblingMouseEvents: false }).addTo(stopGroup);
    const li = document.createElement('li');
    li.innerHTML = `<span>${i + 1}. ${s.name}</span><button title="Remove">×</button>`;
    li.querySelector('button').onclick = () => { stops.splice(i, 1); renderStops(); };
    $('stops').appendChild(li);
  });
  $('stopsEmpty').style.display = stops.length ? 'none' : 'block';
}
map.on('click', e => addStop([e.latlng.lng, e.latlng.lat]));
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

function drawRoute(res, title = null) {
  const m = routeModel(res, site);
  if (routeGroup) map.removeLayer(routeGroup);
  selected = null; routeGroup = L.featureGroup().addTo(map);
  segs = [];
  groupSegments(m.c, m.pieces, SEG_M).forEach(s => {
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
const showError = r => { $('status').textContent = 'Planner: ' + (ERRORS[r.error] || r.error); };
const planner = createPlanner();
$('planBtn').disabled = true; $('status').textContent = 'Loading planner…';
const plannerReady = planner.init(name).then(() => { $('planBtn').disabled = false; $('status').textContent = ''; })
  .catch(e => { $('status').textContent = 'Planner failed to load: ' + e.message; throw e; });

let alertState = {};                 // alerts stack: keep what replan() returns
let lastPosition = null;             // from the tablet: {lon, lat, o2_used_min, ...}
let ingressMin = 0;                  // pending habitat ingress of the current plan (O2-min reserved for it)
async function refreshRing() {       // costToHome depends on the alert state -> fetch once per state
  await plannerReady;
  ring.setData(await planner.costToHome({ state: alertState }));
  updateRing(true);
}
function updateRing(force = false) {
  if (!ring.ready) return;
  const used = lastPosition?.o2_used_min ?? 0;
  ring.update(ring.usable - used - ingressMin * (alertState.o2_x ?? 1), force);
}
refreshRing();

function publish(res, waypoints, extra = {}) {
  const payload = { plan: res, stops: waypoints.map(w => w.ll), waypoints, ...extra };
  send('plan', payload);
  try { localStorage.setItem('marswalk:plan', JSON.stringify(payload)); } catch {}
}

$('planBtn').onclick = async () => {
  if (!stops.length) { $('status').textContent = 'Add at least one stop (click the map or a target).'; return; }
  $('status').textContent = 'Planning…';
  await plannerReady;
  const res = await planner.plan({ start: habitat, stops: stops.map(s => s.ll), goal: habitat });
  if (res.error) return showError(res);
  $('status').textContent = '';
  if (Object.keys(alertState).length) { alertState = {}; refreshRing(); }   // a fresh plan starts with no alerts
  const m = drawRoute(res);
  ingressMin = m.legTask[m.legTask.length - 1] || 0; updateRing(true);
  publish(res, [...stops.map(s => ({ name: s.name, ll: s.ll, photo_id: s.photo_id, kind: s.kind })), { name: 'Habitat', ll: habitat, kind: 'habitat' }]);
};
$('clearBtn').onclick = () => { stops.length = 0; renderStops(); if (routeGroup) map.removeLayer(routeGroup); routeGroup = null;
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
    (p.task ? row('Task', p.task) : '');
});

// ---------- Alerts (docs/INTEGRATION.md §4): console owns replanning, tablet only renders ----------
const alertBox = $('alerts');
(site.alerts || []).forEach(a => {
  const b = document.createElement('button');
  b.textContent = `${a.type} → ${a.action}`;
  b.title = `O₂ ×${a.effect?.o2_x ?? 1} · dose ×${a.effect?.dose_x ?? 1} · visibility ${a.effect?.visibility ?? 1}`;
  b.onclick = async () => {
    if (!routeGroup) { $('status').textContent = 'Plan a route first, then inject an alert.'; return; }
    $('status').textContent = 'Replanning…';
    const current = lastPosition ? [lastPosition.lon, lastPosition.lat] : habitat;     // where the astronaut is right now
    const r = await planner.replan({ current, alert: a, state: alertState, o2_used_min: lastPosition?.o2_used_min ?? 0 });
    if (r.error) return showError(r);
    $('status').textContent = '';
    alertState = r.state;
    const { destination, destination_kind, destination_id } = r.replan;
    const m = drawRoute(r, `Alert ${a.type}: replanned from the astronaut's position → ${destination} (${r.replan.total_ms} ms). Stats cover the new leg only.`);
    ingressMin = destination_kind === 'habitat' ? (m.legTask[m.legTask.length - 1] || 0) : 0;
    refreshRing();
    const dest = (site.targets?.features || []).find(f => f.properties.id === destination_id);
    send('alert', { alert: a, destination, destination_kind });
    publish(r, [{ name: destination, ll: r.path.geometry.coordinates.at(-1), kind: destination_kind, photo_id: dest?.properties.photo_id ?? null }],
      { replan: true, state: r.state });
  };
  alertBox.appendChild(b);
});
