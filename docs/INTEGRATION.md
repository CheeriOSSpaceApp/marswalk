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
EVA-1 (habitat → 10 depot tubes → Wildcat Ridge → habitat): 1430 m, 190 min (165 working), O₂ 45.1 %,
margin 191.5 min, max walkback 601 m, dose 0.075 mSv, safe. Replan: 11–63 ms. SPE → habitat (Hawksbill isn't a radiation shelter).
