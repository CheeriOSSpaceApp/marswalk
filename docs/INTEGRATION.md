# Frontend ↔ planner integration (Santiago + Eric)

Working reference implementation: `web/planner-test.html` (plans, injects alerts, draws the no-return ring).
Everything below is copy-paste ready. Run from `web/`: `npx vite` → http://localhost:5173/console.html

## 1. Files go in the repo, not only on your laptop
`web/console.html`, `web/tablet.html`, `web/src/bus.js` (+ any `web/src/*.js`, `web/src/*.css`).
If it's not pushed, nobody can integrate or test it. Small pushes, often.

## 2. Load data (never hardcode paths)
```js
import { loadSite, lonLatToCell } from './src/data.js';
const SITE = new URLSearchParams(location.search).get('site') || 'jezero';   // ?site=mock for tests
const site = await loadSite(SITE);            // {meta, layers, targets, suit, params, alerts}
const [lonMin, latMin, lonMax, latMax] = site.meta.bbox;
const bounds = [[latMin, lonMin], [latMax, lonMax]];                         // Leaflet wants [lat, lon]
L.imageOverlay(`/data/${SITE}/hillshade.png`, bounds).addTo(map);
L.geoJSON(site.targets).addTo(map);                                          // popups: feature.properties.name / notes
fetch(`/data/${SITE}/rover_traverse.geojson`).then(r => r.json()).then(g => L.geoJSON(g, { style: { color: '#ff0', weight: 2 } }).addTo(map));
```
Data folders: `data/<site>/` (terrain, targets, photos, traverse) and `data/common/` (suit, params, alerts). `loadSite` handles both.

## 3. Planner (console)
```js
import { createPlanner } from './src/plannerClient.js';
const planner = createPlanner();
await planner.init(SITE);
const habitat = site.meta.habitat;                                   // [lon, lat]
const res = await planner.plan({ start: habitat, stops: [[lon, lat], ...], goal: habitat });
if (res.error) showError(res.error);   // 'point_outside_map' | 'point_in_forbidden_zone' | 'unreachable'
else {
  L.geoJSON(res.path).addTo(map);
  // res.stats: distance_m, duration_min, walk_min, task_min, o2_used_pct, o2_used_min, dose_mSv,
  //            o2_return_ok, o2_margin_min, walkback_ok, walkback_max_m, battery_used_pct, comms_pct, safe
  // res.turnaround_point: [lon,lat] or null (draw a red X if not null)
  // res.segments[i].stats: same per leg (task_min = work at the end of that leg)
  bus.post('plan', { plan: res, stops });
}
```

## 4. Alerts (console → planner → tablet)
The console owns replanning; the tablet only renders.
```js
let alertState = {};                 // alerts stack: keep what replan returns
let lastPosition = null;             // from the tablet: {lon, lat, o2_used_min}
async function injectAlert(alert) {  // alert = one item of site.alerts
  const r = await planner.replan({ current: [lastPosition.lon, lastPosition.lat], alert,
                                   state: alertState, o2_used_min: lastPosition.o2_used_min });
  if (r.error) return showError(r.error);
  alertState = r.state;
  bus.post('alert', { alert, destination: r.replan.destination, destination_kind: r.replan.destination_kind });
  bus.post('plan', { plan: r, replan: true });
}
```
Use `r.replan.destination_kind` ('habitat' | 'shelter') for logic, `destination` (name) only for display.

## 5. Bus (bus.js, contract)
`BroadcastChannel('marswalk')`, messages `{type, payload}`:
| type | from → to | payload |
|---|---|---|
| `plan` | console → tablet | `{plan: <plan() or replan() result>, stops?, replan?: true}` |
| `alert` | console → tablet | `{alert, destination, destination_kind}` → banner |
| `position` | tablet → console | `{lon, lat, o2_used_min, t_min}` (simulated walk ▶) |

## 6. Tablet: progress + no-return ring
- Walk simulation: step along `plan.path.geometry.coordinates`; O₂ used so far ≈ `plan.stats.o2_used_min × (step / n)` (good enough for the demo); post `position` every step.
- Ring: `const { costToHome, usable_o2_min } = await planner.costToHome({ state: alertState })` once per state.
  Cell `i` is beyond no-return if `costToHome[i] > usable_o2_min − o2_used_min`. Draw like `drawRing()` in planner-test.html.
- HUD priority (Ana): O₂ remaining vs cost to get home (top), next waypoint (distance, bearing, ETA), dose, alert banner.

## 7. Real numbers to sanity-check the UI (Jezero, `node test/jezero_eva.mjs`)
EVA-1 (habitat → 10 depot tubes → Wildcat Ridge → habitat): 1432 m, 190 min (165 working), O₂ 42.0 %,
margin 192 min (reserve 18 %), max walkback 601 m, dose 0.075 mSv, safe. Replan: 11–63 ms. SPE → habitat (Hawksbill isn't a radiation shelter).

---
# 8. Tier 1 features (11:30) — planner side DONE, UI to wire

All planner pieces are tested (`node test/planner.test.mjs` → 52 PASS, `node test/report.test.mjs`, `node test/jezero_eva.mjs`).
Same worker, same `plannerClient` — nothing existing breaks.

## 8.1 Mission clock (Mars time) — everyone uses the same one
- Console: input **"EVA start (LMST)"**, default `09:00` → `startLmst = 9.0` (hours, decimal).
- Tablet keeps `t_min` (minutes since EVA start, simulated). `nowLmst = startLmst + t_min / 61.649` (1 Mars hour = 61.649 Earth min; sol = 24 h 39 min).
- Pass it to the planner: `plan({..., start_lmst: startLmst})`, `replan({..., now_lmst})`, `adapt({..., now_lmst})`.
- New stats when you pass it: `start_lmst_hhmm, end_lmst_hhmm, sunset_lmst_hhmm, daylight_margin_min, go: 'GO'|'CAUTION'|'NO-GO'`.
  `NO-GO` ⇒ `safe: false`. Show a big GO / CAUTION / NO-GO badge in the console stats and on the tablet.

## 8.2 Live map updates (A, ideas #1 + #13)
Obstacles live in the planner **state**, next to the alert multipliers:
```js
let alertState = {};   // already exists; obstacles go inside it
// tablet: long-press / "Report obstacle" button on the map
const ob = { id: crypto.randomUUID(), lon, lat, radius_m: 20, kind: 'blocked' /* or 'caution' */, source: 'astronaut', note: 'boulder field' };
send('obstacle', ob);                                   // tablet -> console (console can also create them: source 'console' | 'rover' | 'drone')
// console:
onMessage(async (m) => { if (m.type !== 'obstacle') return;
  alertState = { ...alertState, obstacles: [...(alertState.obstacles || []), m.payload] };
  const r = await planner.adapt({ current: [lastPosition.lon, lastPosition.lat], stops: remainingStops,
                                  state: alertState, o2_used_min: lastPosition.o2_used_min, now_lmst: nowLmst() });
  drawObstacle(m.payload); refreshRing();               // ring changes too (costToHome recomputed with the obstacle)
  publish(r, waypointsFrom(r), { adapt: r.adapt, state: alertState });
});
```
- Draw obstacles as red (blocked) / yellow (caution) circles on BOTH screens.
- Same message for "a rover/drone photo shows X": just `source: 'rover' | 'drone'`. That's idea #13 without image processing.
- `remainingStops` = stops not yet reached, in order (console knows them from `position.d` vs. the leg ends, or the tablet sends `next_stop_index` in `position`).

## 8.3 Adaptive mission (B, idea #12)
```js
const r = await planner.adapt({ current, stops: remainingStops, state: alertState, o2_used_min, now_lmst });
// r.adapt = { decision: 'continue'|'skip'|'return', dropped: [{id, name, science_value, reason}], kept: [...], safe }
```
Call it: (1) after every `obstacle`, (2) when the tablet reports `task_done` with `actual_min > planned_min`, (3) from a console button **"Re-check remaining plan"**.
Tablet: if `decision !== 'continue'` show a banner: *"Skip Crater rim (not enough O₂) — new plan sent"* / *"Return to habitat"*.
Drops the lowest `science_value` first, so targets need meaningful values (Marco/Dana).

## 8.4 Storm → nearest safe point (F, idea #15)
Nothing to wire: `replan` for a `return` alert now checks if the habitat still fits (O₂ / daylight); if not it goes to the
fastest safe point. Show `r.replan.fallback_to_safe_point === true` as *"Can't make it home: go to <destination>"*.

## 8.5 Messages, checklist, notes, phases (D + C, ideas #6, #9, #11) — new bus types
| type | from → to | payload |
|---|---|---|
| `msg` | both | `{from: 'console'\|'tablet', text, t_min}` → chat panel on both screens |
| `checklist` | tablet → console | `{task_id, item, done, t_min}` → console shows live ✓ per task |
| `note` | tablet → console | `{template, text, t_min, lon, lat}` templates: `geology`, `sample`, `hazard`, `suit`, `free` |
| `phase` | tablet → console | `{phase, t_min}` — phases: `prep` (egress) · `outbound` · `working` · `transit` · `returning` · `ingress` · `done` |
| `obstacle` | both | see 8.2 |
| `map_correction` | tablet → console | `{lon, lat, was: 'free'\|'caution', now: 'blocked'\|'caution'\|'free', note}` → also creates an obstacle if `now !== 'free'` |
| `report` | tablet → console | the object from `buildReport()` at the end |

## 8.6 Mission report (C, ideas #2 + #9 + #11 + #12)
The tablet records a log while the EVA runs and builds the report at the end:
```js
import { buildReport, reportToMarkdown } from './report.js';
const log = { mission_id: 'EVA-1', site: name, crew: ['…'], start_lmst: startLmst, planned: firstPlan, events: [] };
const ev = (type, payload) => log.events.push({ t_min, type, ...payload });
// call ev(...) for: phase, position (every ~30 s mission time), arrive, task_done {name, planned_min, actual_min},
//                   alert, adapt, obstacle, map_correction, note, msg, checklist
// at 'done':
const report = buildReport(log, site);            // site = what loadSite() returned
send('report', report);
download('mission-report.md', reportToMarkdown(report));   // + render `report` as a page/modal
```
The report includes: planned vs actual (distance, time, O₂), battery Wh, dose, minutes per phase, % of the walk on caution
terrain, max slope, overtime per task, alerts, re-planning decisions, map updates, map corrections and field notes.
See the sample output: `node test/report.test.mjs`.

## 8.7 Show WHY the destination was chosen (12:10)
Every `replan` result has `r.replan.considered`: `[{name, kind, minutes, eligible, why, chosen}]`, sorted by minutes. Show it in the
alert card on the console (and short on the tablet), e.g.
`Hawksbill Gap 4 min ✓ · Habitat 11 min` (dust) or `Hawksbill Gap 4 min ✗ not radiation-protected · Habitat 11 min ✓` (SPE).
That's how a judge SEES that the system looks for the nearest refuge and why it sometimes doesn't take it.
Alert actions: `shelter` (SPE, radiation-safe only) · `safe_point` (dust, nearest of habitat or any safe point) · `return` (suit, habitat only).

## 8.8 Emergency caches / stations (Tier 2, 13:00) — planner DONE
**Develop the UI now with `?site=mock`:** `data/mock/stations.geojson` has 2 mock caches (120 and 60 O₂-min).
In the browser: `suit → resupply` (O₂ leak) goes via "O2 Cache 1", dust may pick a cache as safe point. Gabriel's real file will be `data/jezero/stations.geojson` (same format).
- Stations come from `data/<site>/stations.geojson` (Gabriel). `loadSite` merges them into `site.targets` (`properties.station: true`).
  **Your `site.js` loads targets separately: also fetch `stations.geojson` (optional) and draw them** — icon by `station_type` (cache / relay / shelter).
- **Inventory panel (console):** one row per cache: name, `supplies.o2_min` − used = left. Keep `cacheUsed = {}`; after every plan/replan/adapt
  result, add `r.refills[] → cacheUsed[id] += o2_min`, and pass `state: { ...alertState, cache_used: cacheUsed }` in every call.
  That's idea #15's "NASA knows how much is left to restock".
- **New alert button** comes automatically from `alerts.json`: `O2 leak → resupply`. Show `r.replan.via_cache` ("refill at Hawksbill cache, then home").
- `adapt` can now return `decision: 'refill'` + `adapt.via_cache` → tablet banner: *"Detour to <cache> to refill O₂ — science kept"*.
- Stats: `o2_refilled_min`; the plan's `refills: [{id, name, o2_min}]`. Tablet: when the astronaut reaches a cache stop, add a checklist
  "Connect O₂ line · Refill · Disconnect" and subtract the refill from O₂ used.
- Optional: `planner.costToHome()` now also returns `costToSafety` (null if no caches). Using it for the ring shows the bigger safe zone.

## 9. O₂ at rest + live safe zone (13:50) — planner DONE, UI to wire

### 9.1 O₂ at rest (affects tablet + console numbers)
`params.json` has a new `rest_metabolic_factor` = **0.5** (600 BTU/h; sources in the param). Airlock egress/ingress, cache refill,
shelter time and `hold` (waiting after a replan) now burn **0.5 O₂-min per minute**; science and depot work still burn 1.0.
Every result now carries what you need, so the UI never hard-codes a rate:
- `plan.tasks[]` = `{index, key, activity: 'rest'|'work', minutes, o2_per_min, o2_min}` (index 0 = start/egress, k = stop k / goal)
- `segments[k].stats.task_o2_min`, `.task_activity`, `.task_o2_per_min` (task at the END of leg k)
- `stats.o2_per_min = {rest, work}` (already × the alert's `o2_x`) · `stats.task_o2_min`
- `costToHome()` result: `o2_per_min = {rest, work}`

**Santiago — tablet.js line ~348** (it burns 1 O₂-min/min for every task today):
`P.extra.o2_min += dtMin * eff.o2_x` → `P.extra.o2_min += dtMin * (task.o2_per_min ?? 1) * eff.o2_x` where `task.o2_per_min` is the
**base** rate (`plan.tasks[k].o2_per_min / state.o2_x`, or simply 0.5 for egress/ingress/shelter/hold/cache and 1 for depot/science,
read from `plan.stats.o2_per_min` divided by `o2_x`). In `buildTasks` copy it from `m.tasks` (console must forward `res.tasks` in `publish`).
Same for the ingress estimate in the return math (`ingressO2` ≈ 15 × 0.5 = 7.5, not 15).

### 9.2 Live safe zone (the "breathing" zone for the video)
```js
const z = await planner.safeZone({ current: [lon, lat], o2_used_min, state: alertState, tight_min: 30 });
// z.zone: Uint8Array W×H — 0 = no-return (can't go there and still reach safety), 1 = tight (< 30 min margin), 2 = safe
// z.slack: Float32Array — O₂-min of margin per cell (−Infinity = unreachable)
// z.wait_max_min: how long the crew can stand still HERE before leaving for safety (null at the habitat)
// z.safe_km2, z.tight_km2, z.budget_min, z.here_margin_min, z.timing_ms (200–600 ms on Jezero)
```
Paint it like `ring.js` (one canvas pixel per cell): zone 0 dark red (as now), 1 amber, 2 transparent. Call it
**when the astronaut moved ≥ ~20 m or O₂ used changed ≥ 2 min**, and always after an alert/refill (do not call every frame).
Use it for the ring in the tablet and the console instead of `costToHome ≤ left`. It already includes caches (Tier 2) and the
1770 m walkback. **Demo tip:** on Jezero the walkback limit dominates until ~250 O₂-min used; the zone collapses visibly between
250 and 380 → start the demo preset with `o2_start_min` ≈ 250 used, or trigger the O₂ leak.

`replan.wait_max_min` (shelter / safe-point replans): "you can sit out the storm here for X min". Show it on the destination card.
