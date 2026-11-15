# CONTRACTS.md

Everything lives in `web/public/data/<site>/` where `<site>` is `mock` or `jezero`.
If you need to change a format: announce in #general FIRST, then update this file.

## Global conventions
- Mars 2000 planetocentric coords, longitude 0–360°E, latitude north positive
- Grid is equirectangular over the AOI; **row 0 = north, col 0 = west**
- Flat index: `i = row * width + col`
- Binaries are **little-endian**, raw (no header): `.f32` = Float32, `.u8` = Uint8, size = width × height
- 1° latitude on Mars ≈ 59.27 km (radius 3,396.19 km)

## Data files
| File | Format | Owner | Used by | Due |
|---|---|---|---|---|
| meta.json | `{site, bbox:[lonMin,latMin,lonMax,latMax], width, height, cell_m, habitat:[lon,lat]}` | Gabriel (mock: Eric) | All | 18:00 |
| elevation.f32 | Float32, meters | Gabriel | Eric, Marco | 20:30 |
| slope.f32 | Float32, degrees | Gabriel | Eric, Ana | 20:30 |
| roughness.f32 | Float32, meters (local std dev 5×5) | Gabriel | Eric, Ana | 20:30 |
| hazard.u8 | Uint8: 0 free, 1 caution, 2 forbidden | Gabriel + Ana (thresholds) | Eric | 20:30 |
| viewshed.u8 | Uint8: 1 = line of sight to habitat | Marco | Eric, Santiago | 23:00 |
| hillshade.png, ortho.png, slope.png | PNG, same bbox, display only | Gabriel | Santiago | 20:30 |
| targets.geojson | Points: id, name, kind (habitat\|depot\|science\|shelter), science_value 1–5, notes, photo_id | Dana + Gabriel | Eric, Santiago | 20:30 |
| photos.json | `[{id, lon, lat, sol, camera, url, caption}]` | Dana | Santiago | 23:00 |
| rover_traverse.geojson | LineString of real traverse clipped to AOI | Marco | Marco, Santiago | 20:30 |
| env.json | per local hour 0–23 and scenario (clear, dusty, storm): temp_K, pressure_Pa, wind_ms, tau | Gabriel + Ana | Ana, Santiago | 23:00 |
| suit.json | o2_hours, reserve_pct, battery_Wh, base_power_W, walkback_m, max_slope_deg — each `{value, source, assumption}`. Planner enforces: slope > max_slope_deg → impassable; O₂ rule with reserve; walkback distance; battery (base_power_W is suit electronics, NOT metabolism) | Marco | Ana, Eric | 19:00 |
| alerts.json | `[{id, type (SPE\|dust\|suit), effect:{dose_x, o2_x, visibility}, action (return\|shelter)}]` | Marco + Ana | Eric, Santiago | 23:00 |
| params.json | model weights & constants, with source | Ana | Eric | 19:00 |

## Code contracts (JavaScript, `web/src/`)

**Cost units (decided 18:45, Eric + Ana):** `cellCost` returns **O₂-equivalent minutes per meter**.
The planner computes the cost of moving between neighbor cells a→b as
`edge = 0.5 * (cellCost(a) + cellCost(b)) * distance_m`, where distance_m = `cell_m` (straight) or `√2 · cell_m` (diagonal).
So a route's total cost is in O₂-minutes and compares directly with `suit.o2_hours * 60`.
**Definition (Marco, 19:50):** 1 O₂-minute = 1 minute of suit O₂ at the design metabolic rate of 1200 BTU/h = **352 W**
(NASA ICES-2026-127). So `cellCost = (M_watts / 352) / (speed_m_s * 60)`: walking faster or uphill costs more than 1 O₂-min per minute.
`cost.js` should also export `speedAt(i, layers, params) -> m/s` (if it doesn't, the planner uses Tobler with Ana's `tobler_*` and `V_cap` params).
**Split of responsibilities (20:25):** `cellCost` = **physiology only** (Pandolf, terrain, gravity); it may ignore `state`.
The planner applies operational modifiers itself: alert `o2_x` multiplies physical O₂; no-comms (`w_nocomms`) and dust (`visibility`) only raise the
**routing** cost (which path A* prefers), never the O₂ numbers. Stats, costToHome and the O₂ rule always use physical O₂.
Do NOT return per-cell cost (time to cross the cell × M): it would be off by a factor of `cell_m`.

| Module | Signature | Owner | Used by |
|---|---|---|---|
| data.js | `loadSite(site) -> {meta, layers:{elevation, slope, roughness, hazard, viewshed}, targets, suit, params, alerts}` | Eric | All |
| cost.js | `cellCost(i, layers, params, state) -> O2-equivalent MINUTES PER METER walked through cell i, or Infinity (impassable)`. Also exports `speedAt(i, layers) -> m/s` | Ana | Eric |
| planner.worker.js | `plan({start, stops[], goal, params, state}) -> {path: GeoJSON LineString, stats, segments[]}` | Eric | Santiago |
| stats | `{distance_m, duration_min, o2_used_pct, dose_mSv, max_slope_deg, comms_pct, o2_return_ok, o2_margin_min, walkback_ok, walkback_max_m, battery_used_pct, safe}` + top-level `turnaround_point` ([lon,lat] or null), `o2_worst_point` | Eric + Ana | Santiago |
| safety rules | **O₂ rule:** at every point, O₂ used so far + cheapest return (costToHome) ≤ usable O₂ (`o2_hours·60·(1−reserve)`, 408 min) → `o2_return_ok`; first failing point → `turnaround_point`. **Walkback rule (ICES-2026-127):** at every point, walking distance home ≤ `walkback_m` (1770 m) → `walkback_ok`. `safe` = both + battery ≤ 100% | Eric + Marco | Santiago, Dana |
| plannerClient.js | `createPlanner()` -> `{init(site), plan(req), costToHome(req), terminate()}` (all Promises) | Eric | Santiago |
| costToHome | `planner.costToHome({state}) -> {costToHome: Float32Array (O2-min home), distToHome: Float32Array (meters home), usable_o2_min, walkback_m}` (Infinity = unreachable). Tablet: cell i is beyond no-return if `costToHome[i] > O2 remaining` | Eric | Santiago |
| replan | `planner.replan({current:[lon,lat], alert, state?, o2_used_min?}) -> plan + {state, replan:{alert, action, destination, total_ms}}`. SPE/`shelter` → nearest shelter **by walking time** (habitat counts); dust/suit/`return` → habitat. Keep returned `state` and send it on the next call (alerts stack multiplicatively). Position is lon/lat (same as the `position` bus message), not a cell index. | Eric | Santiago |
| bus.js | `BroadcastChannel('marswalk')`: `{type: 'plan'\|'alert'\|'position', payload}` | Santiago | All |
