import L from 'leaflet';
import { createSiteMap } from './common.js';
import { onMessage, send } from './bus.js';
import { lonLatToCell } from './data.js';
import { dist, helmetIcon } from './geo.js';
import { createPlanner } from './plannerClient.js';   // only for costToHome (no-return zone), docs/INTEGRATION.md §6
import { routeModel } from './route.js';
import { createRing } from './ring.js';

const { map, site, name, bounds } = await createSiteMap();
const { meta, suit, params } = site;
const $ = id => document.getElementById(id);
const val = x => (x && typeof x === 'object' && 'value' in x) ? x.value : x;    // accepts 8 or {value:8, source:…}
const WALKBACK = val(suit.walkback_m) ?? Infinity;       // suit.json limit: farthest allowed distance from the habitat
const O2_MIN = (val(suit.o2_hours) ?? 8) * 60, RESERVE = val(suit.reserve_pct) ?? 20, SPEED = val(params.V_cap) ?? val(params.base_speed_ms) ?? 1;
const USABLE = O2_MIN * (1 - RESERVE / 100);              // same as planner usableO2min()
const GCR = val(params.gcr_mSv_per_h) ?? 0.028;          // mSv/h on the surface
const MARGIN_WARN = 30;                                   // min of O2 margin below which the state is CAUTION (Ana's threshold)
const SPEEDS = [60, 300, 600];
let SIM = 60;
const walkLabel = () => `▶ Walk (×${SIM})`;
const R = 3396190, rad = x => x * Math.PI / 180, deg = x => x * 180 / Math.PI;
const photos = site.url('photos.json') ? await fetch(site.url('photos.json')).then(r => r.ok ? r.json() : []).catch(() => []) : [];

// ---------- Tasks (Ana's HUD) ----------
// Task minutes come from the planner (params.task_min via taskMinutesAt); here only the checklists.
const CHECK = {
  egress:  ['Suit leak check', 'Depressurize airlock', 'Comms check with habitat'],
  depot:   ['Locate the tube', 'In-situ photo', 'Inspect the seal', 'Collect and label'],
  science: ['Stratigraphy photo with scale', 'Photo of abrasion patch', 'Photo of drill holes', 'Field notes'],
  shelter: ['Reach muster point', 'Report position to habitat'],
  hold:    ['Reach the safe point', 'Report position to habitat', 'Hold until the alert clears'],
  habitat: ['Enter airlock', 'Repressurize', 'Stow samples'],
};
const TASK_NOTE = { shelter: 'Muster point · NO radiation protection', hold: 'Alert: wait here, coordinate with habitat' };

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
// ---------- Alarm popup ----------
const ALERT_NAMES = { SPE: 'Solar particle event', dust: 'Dust storm', suit: 'Suit failure' };
function beep() {                                   // three short beeps; browsers may block sound until the page has been clicked
  try {
    const ac = new (window.AudioContext || window.webkitAudioContext)(); if (ac.state === 'suspended') ac.resume();
    [0, 0.35, 0.7].forEach(t => { const o = ac.createOscillator(), g = ac.createGain(); o.type = 'square'; o.frequency.value = 880;
      g.gain.setValueAtTime(0.15, ac.currentTime + t); g.gain.setValueAtTime(0, ac.currentTime + t + 0.2);
      o.connect(g); g.connect(ac.destination); o.start(ac.currentTime + t); o.stop(ac.currentTime + t + 0.25); });
  } catch {}
}
function showAlarm(msg) {                         // msg = {alert, destination, destination_kind} (bus contract)
  const a = msg.alert || msg, e = a.effect || {};
  const where = msg.destination ? `Go to ${msg.destination_kind === 'habitat' ? 'the habitat' : msg.destination} now.` : a.action === 'shelter' ? 'Go to the shelter now.' : 'Return to the habitat now.';
  $('alarmTitle').textContent = `ALERT · ${ALERT_NAMES[a.type] || a.type}`;
  $('alarmBody').textContent = `${where}  O₂ use ×${e.o2_x ?? 1} · dose ×${e.dose_x ?? 1}` +
    (e.visibility != null && e.visibility < 1 ? ` · visibility ${Math.round(e.visibility * 100)} %` : '');
  $('alarm').hidden = false; beep();
}
$('alarmOk').onclick = () => { $('alarm').hidden = true; };

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
  tasks.forEach(t => { t.items = CHECK[t.kind]; t.checked = t.items.map(() => false); t.elapsed = 0; t.done = false; });
  return tasks;
}

let spentNow = { o2_min: 0, dose_mSv: 0, time_min: 0 };   // what the astronaut has used so far (carried into a replan)
function setPlan(payload) {
  if (!payload?.plan?.path) return;                       // old/unknown message
  const replanned = !!payload.replan, wasPlaying = playing;
  const m = routeModel(payload.plan, site);
  P = { ...m, base: replanned ? { ...spentNow } : { o2_min: 0, dose_mSv: 0, time_min: 0 }, extra: { o2_min: 0, dose_mSv: 0, time_min: 0 } };
  const wps = (payload.waypoints || []).slice(0, m.legEnd.length);
  while (wps.length < m.legEnd.length) wps.push({ name: 'Waypoint', ll: m.c[m.legEnd[wps.length]] });
  P.wps = wps.map((w, k) => ({ ...w, idx: m.legEnd[k] }));
  P.tasks = buildTasks(m, P.wps, replanned);
  eff = { o2_x: 1, dose_x: 1, visibility: 1, ...(replanned ? payload.state : {}) };
  refreshRing(replanned ? payload.state : {});
  routeLine.setLatLngs(m.c.map(p => [p[1], p[0]]));
  if (m.total > 1) map.fitBounds(routeLine.getBounds(), { padding: [40, 40] });
  d = 0; playing = !!(replanned && wasPlaying); shownWp = null; shownTask = null; $('playBtn').textContent = playing ? '⏸ Pause' : walkLabel();
  if (!replanned) $('banner').hidden = true;                 // a fresh plan clears the alert banner
  $('scrub').max = Math.round(m.total); $('scrub').value = 0;
  $('empty').hidden = true; $('hud').hidden = false; render();
  if (playing) { last = performance.now(); requestAnimationFrame(loop); }
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
  const vs = site.layers.viewshed; if (!vs) return null;
  const { row, col } = lonLatToCell(meta, pos[0], pos[1]);
  const inside = (r, c) => r >= 0 && c >= 0 && r < meta.height && c < meta.width;
  if (!inside(row, col) || !vs[row * meta.width + col]) return 'bad';
  const k = Math.max(1, Math.round(20 / (meta.cell_m || 3)));
  for (const [dr, dc] of [[-k, 0], [k, 0], [0, -k], [0, k]]) if (inside(row + dr, col + dc) && !vs[(row + dr) * meta.width + col + dc]) return 'warn';
  return 'ok';
}

// ---------- Task card ----------
function drawChecklist(t) {
  $('checklist').innerHTML = t.items.map((it, i) => `<li><label><input type="checkbox" data-i="${i}"${t.checked[i] ? ' checked' : ''}><span>${it}</span></label></li>`).join('');
  $('checklist').querySelectorAll('input').forEach(inp => inp.onchange = () => { t.checked[+inp.dataset.i] = inp.checked; updateDoneBtn(t); });
  updateDoneBtn(t);
}
function updateDoneBtn(t) {
  const ready = !!t && t.checked.every(Boolean);
  $('doneBtn').disabled = !ready; $('doneBtn').classList.toggle('ready', ready);
  $('doneBtn').textContent = !t ? '✓ Task done' : ready ? '✓ Task done · continue' : `✓ Task done (${t.checked.filter(Boolean).length}/${t.items.length})`;
}
$('doneBtn').onclick = () => {
  const t = P && activeTask(); if (!t || !t.checked.every(Boolean)) return;
  t.done = true; shownTask = null; shownWp = null; render();
  if (playing) { last = performance.now(); requestAnimationFrame(loop); }
};

function render() {
  if (!P) return;
  const pos = position(), tot = total(), task = activeTask();
  astro.setLatLng([pos[1], pos[0]]);
  if (follow) map.panTo([pos[1], pos[0]], { animate: true, duration: 0.25 });
  let k = 0; while (k < P.cumD.length - 2 && P.cumD[k + 1] <= d) k++;               // segment the astronaut is on
  if (dist(P.c[k], P.c[k + 1]) > 0.01) { const h = bearing(P.c[k], P.c[k + 1]); $('hdgTxt').textContent = h; $('needle').style.transform = `rotate(${parseFloat(h)}deg)`; }   // direction of travel
  const ll = p => [p[1], p[0]];
  doneLine.setLatLngs([...P.c.slice(0, k + 1).map(ll), ll(pos)]);
  routeLine.setLatLngs([ll(pos), ...P.c.slice(k + 1).map(ll)]);

  // O2, dose, time = plan up to here + carried-over base + time spent on tasks
  const o2UsedMin = P.base.o2_min + at(P.cumO2) + P.extra.o2_min;
  const o2Left = Math.max(0, 100 - o2UsedMin / O2_MIN * 100), o2LeftMin = o2Left / 100 * O2_MIN;
  const dose = P.base.dose_mSv + at(P.cumDose) + P.extra.dose_mSv, doseTotal = P.base.dose_mSv + P.cumDose[P.cumDose.length - 1] + P.extra.dose_mSv;
  const evaMin = P.base.time_min + at(P.cumT) + P.extra.time_min;
  // Ingress = the LAST habitat task of the route (the first one is the egress). Never negative (overtime).
  const habTasks = P.tasks.filter(t => t.kind === 'habitat'), lastHab = habTasks.length > 1 || (habTasks.length === 1 && P.tasks.indexOf(habTasks[0]) > 0) ? habTasks.at(-1) : null;
  const distHome = dist(pos, meta.habitat), ingress = lastHab && !lastHab.done ? lastHab : null;
  const ingressO2 = (ingress ? Math.max(0, (ingress.minutes || 0) - (ingress.elapsed || 0)) : 0) * eff.o2_x;
  const cth = ring.costAt(pos[0], pos[1]);                                            // planner costToHome (O2-min, real terrain)
  const walkHome = cth ?? distHome / SPEED / 60 * eff.o2_x;                           // fallback: straight line at V_cap
  const homeMin = walkHome + ingressO2;
  const margin = USABLE - o2UsedMin - homeMin;                                        // planner rule: used + return <= usable
  const state = !(margin >= 0) || distHome > WALKBACK ? 'bad' : margin < MARGIN_WARN ? 'warn' : 'ok';
  const canReturn = state !== 'bad';
  ring.update(USABLE - o2UsedMin - ingressO2);

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
  if (!shown) { $('taskName').textContent = 'All tasks done'; $('taskTimer').textContent = '–'; $('checklist').innerHTML = ''; updateDoneBtn(null); $('doneBtn').hidden = true; }
  else if (task) {
    $('doneBtn').hidden = false;
    if (shownTask !== task) { shownTask = task; $('taskName').innerHTML = `${task.name}${TASK_NOTE[task.kind] ? `<small>${TASK_NOTE[task.kind]}</small>` : ''}`; drawChecklist(task); }
    const over = task.minutes && task.elapsed > task.minutes;
    $('taskTimer').textContent = task.minutes ? `${task.elapsed.toFixed(0)} / ${task.minutes} min${over ? ' · overtime' : ''}` : `${task.elapsed.toFixed(0)} min`;
    $('taskTimer').classList.toggle('over', !!over);
  } else {
    if (shownTask !== 'preview:' + P.tasks.indexOf(shown)) {
      shownTask = 'preview:' + P.tasks.indexOf(shown);
      $('taskName').innerHTML = `On arrival: ${shown.name}<small>${shown.items.length} checks${shown.minutes ? ` · ~${shown.minutes} min` : ''} · the walk stops there until every check is done</small>`;
      $('checklist').innerHTML = ''; $('doneBtn').hidden = true;
    }
    $('taskTimer').textContent = `in ${(shown.at - d).toFixed(0)} m`; $('taskTimer').classList.remove('over');
  }

  // Status row
  $('met').textContent = hm(evaMin);
  $('o2Lasts').textContent = hm(o2LeftMin / eff.o2_x);
  const cs = comms(pos);
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
    margin_min: Number.isFinite(margin) ? margin : null, ingress_min: ingressO2 / eff.o2_x,
    task: task ? `${task.name} · ${task.checked.filter(Boolean).length}/${task.items.length} checks` : null, spent: spentNow });
}

function loop(t) {
  if (!playing || !P) return;
  const dtMin = Math.min(0.25, (t - last) / 1000) * SIM / 60; last = t;
  const task = activeTask();
  if (task) {                                       // standing still doing the task: time, O2 and dose keep running
    task.elapsed += dtMin; P.extra.time_min += dtMin; P.extra.o2_min += dtMin * eff.o2_x; P.extra.dose_mSv += GCR * dtMin / 60 * eff.dose_x;
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
  P.tasks.forEach(t => { t.done = false; t.elapsed = 0; t.checked = t.items.map(() => false); });
}
$('playBtn').onclick = () => {
  if (!P) return;
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
    const a = m.payload.alert || m.payload, e = a.effect || {};
    showAlarm(m.payload); const b = $('banner'); b.hidden = false;
    b.textContent = `ALERT ${a.type}: → ${m.payload.destination || (a.action === 'shelter' ? 'shelter' : 'habitat')} · O₂ ×${e.o2_x ?? 1} · dose ×${e.dose_x ?? 1}`;
  }
});
try { const saved = localStorage.getItem('marswalk:plan'); if (saved) setPlan(JSON.parse(saved)); } catch {}
