# MarsWalk planner — technical README

**Owner:** Eric (tech lead) · **Code:** `web/src/planner.js`, `heap.js`, `planner.worker.js`, `plannerClient.js`, `report.js`
**Tests:** `web/test/` (60 automated checks + hand calculation + browser end-to-end)

MarsWalk plans walking EVAs (extravehicular activities) for astronauts at Jezero Crater. Starting from the habitat, it finds the
route that costs the **least oxygen**, visiting the targets (sample-depot tubes, science outcrops) and coming back. It checks
the safety rules at **every point** of the route, and **re-plans in milliseconds** when something changes: a solar particle
event, a dust storm, a suit failure, an obstacle the astronaut reports, a task that takes longer than planned, or the Sun
going down.

The design follows the robotics pattern of a **global costmap + global planner** (as in ROS 2 Nav2), adapted from a rover
to a human in a spacesuit. The cost is oxygen instead of distance, and "can I still get home?" is a hard constraint.

---

## 1. Architecture

```
NASA data (HiRISE DTM, Perseverance traverse, MCD)            pipeline/ (Python)
        │  elevation, slope, roughness, hazard, viewshed  (1000 × 1000 cells, 3 m)
        ▼
 cost model  cellCost(i) → O₂-minutes per metre       web/src/cost.js   (Pandolf + Tobler, Ana)
        │  evaluated ONCE per terrain → base O₂ grid (1 M cells)
        ▼
 apply state  alerts (O₂ ×, visibility), obstacles, comms, caution zones     ← cheap pass, per state
        │  two grids:  o2[i]  = physical oxygen      cost[i] = routing preference
        ▼
 search  A* (route)  ·  Dijkstra from the habitat (cost-to-home field, distance-to-home field)
        ▼
 rules   O₂ return rule · walkback 1770 m · battery · daylight   →  stats, turnaround point, safe / GO
        ▼
 Web Worker  ──postMessage RPC──►  plannerClient.js  ──►  console.html (habitat)  ⇄ BroadcastChannel ⇄  tablet.html (field)
```

Everything runs **in the browser**: no server, and no Earth link (4–22 min one-way light time), which matches how a habitat
would have to run it.

---

## 2. Cost model: two grids on purpose

`cellCost(i)` (Ana, `cost.js`) returns **O₂-equivalent minutes per metre** to walk through cell *i*:

- Metabolic power **M** from the **Pandolf** load-carriage equation, with body mass W = 82 kg, load L = 126.7 kg (suit and
  tools), grade from slope, and a terrain factor η from roughness. The gravity-dependent terms are scaled by g_Mars/g_Earth = 0.38.
- Speed **V** from **Tobler's** hiking function, capped at 2.2 mph (0.98 m/s, NASA ICES-2026-127).
- `cellCost = M / (V · 60 · P_nom)`, with **P_nom = 351.7 W (1200 BTU/h)**. So 1 O₂-minute = 1 minute of suit oxygen
  at the design metabolic rate.

The planner multiplies by distance: `edge(a→b) = ½(c_a + c_b) · d`, with d = 3 m straight or 3√2 m diagonal.

**Physical vs. routing cost.** We keep two grids:

| grid | contains | used for |
|---|---|---|
| `o2[i]` | Ana's physiology × alert O₂ factor (suit failure ×1.5) | stats, cost-to-home, the O₂ rule |
| `cost[i]` | `o2[i]` × risk preferences: no comms (+20 %), caution zones (+50 %), dust visibility, "caution" obstacles | **only** which path A* prefers |

If the risk penalties were mixed into the oxygen grid, the reported O₂ use would include "oxygen" that nobody breathes.
With two grids, the route avoids risk and the numbers stay physical.

Blocked cells (slope > 15°, hazard = forbidden, blocked obstacles, no data) are `Infinity` in both grids. The suit's
`max_slope_deg` is enforced inside the planner too, as defense in depth.

---

## 3. Search

### A\* (route between consecutive stops)
- **8-connected grid**, no corner cutting (no squeezing diagonally between two blocked cells).
- **Heuristic:** octile distance × the cheapest routing cost per metre in the grid. It never overestimates the true cost
  (it is **admissible**), so A\* returns the **optimal** route. A test checks that A\* and Dijkstra give the same cost on
  real data (102.965 vs 102.965 O₂-min).
- **Open list:** a binary min-heap on typed arrays, with *lazy deletion*: a better path just pushes the cell again, and
  stale copies are skipped when popped. Push and pop are O(log n), against O(n) for a sorted array.
- **Memory:** `Float64Array` g-scores, `Int32Array` parent pointers and `Uint8Array` closed flags, about 13 MB for 1 M cells.
  No objects in the hot loop.

Worst case O(N log N) with N = 10⁶ cells. In practice A\* expands a small corridor around the route.

### Dijkstra from the habitat (return fields)
One Dijkstra from the habitat over the whole grid gives, for every cell:
- `costToHome[i]`: the cheapest O₂ to walk back from *i*. Edge costs are symmetric (½(c_a + c_b)·d), so cost(i→home) = cost(home→i).
- `distToHome[i]`: walking metres back (the same search on a unit-cost grid).

After that, "can I still get home from here?" is an **O(1) lookup** anywhere. That is what draws the tablet's **no-return
ring** live.

### Why re-planning is cheap
- The physiology grid (1 M `cellCost` calls, the expensive part) is computed **once per terrain**.
- An alert only multiplies it. A uniform factor k scales every path by k, so **costToHome × k is exact** (a test checks it
  against a full recomputation: max relative error 2.4·10⁻⁶).
- Obstacles change *which* cells are walkable, so for those states the two Dijkstras are re-run (~150 ms each).
- Results are cached per terrain (WeakMap) and per state.

A full re-plan therefore needs no incremental algorithm such as D\* Lite. That would be the upgrade for maps much larger
than 3 × 3 km.

---

## 4. Safety rules (checked at every point of the route)

| rule | definition | source |
|---|---|---|
| **O₂ return** | at every point *k*: O₂ used up to *k* (walk + tasks) + `costToHome[k]` ≤ usable O₂. The first point where it fails becomes `turnaround_point`. | team rule (Eric + Marco) |
| **Usable O₂** | 8 h × 60 × (1 − **18 %** reserve) = **393.6 O₂-min** | 8 h: ICES-2026-158; reserve: team decision (below) |
| **Walkback** | walking distance home ≤ **1770 m** everywhere (30 min at 2.2 mph) | NASA ICES-2026-127 |
| **Battery** | EVA hours ≤ 1155 Wh / 120 W = 9.6 h (suit electronics, not metabolism) | NASA GRC PLSS target |
| **Daylight** | home ≥ 30 min before sunset, and no departure before sunrise → GO / CAUTION / NO-GO | team rule; sunrise/sunset from MCD |

**Why an 18 % reserve.** It is 86.4 min of oxygen. The design worst case is a 30-min walkback at 1700 BTU/h with a suit
failure (×1.5), which costs 63.75 O₂-min. A 15 % reserve (72 min) left only 8 min of slack and did not cover a
95th-percentile crewmember. 18 % leaves +36 % and covers them, and it costs EVA-1 nothing: the margin is still 177 min.

**Task time** counts in O₂ and in the return rule, which is checked *after* the work at a stop (you must be able to get home
once the job is done). Task durations come from Ana's `params.task_min` (Apollo-based):
- habitat egress / ingress: 15 min each
- depot setup: 10 min (once) + 8 min per tube
- science stop: 45 min

**Airlock time** costs O₂ and time but **no radiation dose** (shielded; our assumption).

**Dose:** GCR 0.0279 mSv/h (MSL/RAD, Hassler et al. 2014) × time exposed × alert multiplier, via Ana's `radiation.js`.

---

## 5. Re-planning

| trigger | what the planner does | API |
|---|---|---|
| **SPE** (solar particle event) | go to the **fastest radiation-safe place**: the habitat, or a shelter flagged `radiation_shelter: true`. Dose ×50 is applied. | `replan` |
| **Dust storm** | visibility 0.3: steep or rough ground gets a higher routing cost; return to the habitat. **If O₂ or daylight don't allow it**, go to the fastest safe point that can be reached without touching the reserve. | `replan` |
| **Suit failure** | O₂ ×1.5 on every cell; return to the habitat | `replan` |
| **Obstacle reported** (astronaut, rover, drone or console) | circle of radius *r*: blocked = impassable, caution = ×3 routing cost; recompute return fields and route | `state.obstacles` + `adapt` |
| **Task overtime / "can I still do the rest?"** | re-plan current position → remaining stops → home; if unsafe, **drop stops with the lowest science value first** (ties: keep the larger margin) until safe → `continue` / `skip` / `return` | `adapt` |

Alerts stack: their multipliers combine, and the returned `state` is sent back on the next call.

`adapt` is **greedy**. The exact problem (choose the subset of stops that maximises science value within an oxygen and
time budget) is the *orienteering problem*, which is NP-hard. Greedy by science value is explainable to a crew and runs in
milliseconds for ~10 stops.

**Mars time:** the planner works in Earth minutes and converts to Local Mean Solar Time with
1 Mars hour = 88 775.244 s / 24 = 61.649 min (one sol = 24 h 39 min).

---

## 6. Performance (measured, Node / Chromium, real Jezero grid 1000 × 1000)

| operation | time |
|---|---|
| first plan (physiology grid + 2 full-grid Dijkstras + A\*) | ~460 ms |
| full EVA-1 plan afterwards (12 legs, grid cached) | ~35 ms |
| replan after an alert | 11–65 ms |
| `adapt` after an obstacle (recomputes return fields) | ~370 ms |
| `adapt` after overtime | ~10 ms |
| browser click → route drawn (console, worker round trip) | 150–600 ms |

All of it runs in a **Web Worker**, so the map never freezes.

---

## 7. Verification

| what | how | result |
|---|---|---|
| optimality | A\* cost == Dijkstra cost | equal |
| safety logic | 52 unit tests: no forbidden cell on any route, slope ≤ 15°, O₂ rule and turnaround, walkback, task time, airlock dose, alert stacking, scaling exactness, obstacles, adapt, day/night, storm fallback | 52/52 |
| **hand calculation** | 2 synthetic routes computed with a calculator (`docs/HAND_CHECK.md`) against the planner | 12/12 values match; **found and fixed 2 real bugs** (a cache that ignored the terrain; double rounding of O₂ %) |
| real terrain | EVA-1 and each alert on Jezero (`test/jezero_eva.mjs`) | safe, numbers below |
| full stack | headless Chromium: console plans → tablet receives → walk → position back → SPE → tablet alarm | pass |
| data | `test/validate_data.mjs` checks every file against `CONTRACTS.md` (units, ranges, NaN, bbox, reachability) | 0 errors |
| mission report | `test/report.test.mjs` with a synthetic log | 8/8 |

## 8. Results — EVA-1 on real Jezero terrain

Habitat (certified MSR landing site at Three Forks) → 10 depot tubes → Wildcat Ridge (delta-front mudstone) → habitat:

| | |
|---|---|
| distance | **1432 m** |
| duration | **190 min** (25 walking, 165 working) |
| O₂ used | **45.1 %** (216.6 O₂-min) |
| O₂ margin on the return rule | **177 min** |
| max walkback | 601 m (limit 1770) |
| dose | 0.075 mSv |
| line of sight to the habitat | 100 % |
| start 09:00 LMST | back 12:04 → **GO** (sunset 18:00) |
| same EVA starting 15:30 | back 18:34 → **NO-GO** |

**Finding:** on EVA-1 the active limit is **work time, not walking**: 165 of 190 minutes are spent at the targets. The
planner's adaptive mode therefore matters most for overtime at the depot.

Wildcat Ridge sits on the 16° delta-front scarp. The planner stops the astronaut 3 m away, on 14.3° ground at its base,
which is where an outcrop would be observed.

---

## 9. Limitations and future work

- **Slope is unsigned:** downhill costs the same as uphill (conservative). A signed-grade model (Santee correction) needs
  per-move elevation and reversed edges for the return field.
- **3 m cells** smooth out rocks smaller than ~3 m. Roughness (detrended standard deviation in 5 × 5) partly compensates.
- **Stop order is given, not optimised** (a TSP). With ~10 depot tubes within 30 m of each other this barely matters on EVA-1.
- `adapt` is greedy (see §5), not an optimal orienteering solution.
- **Single astronaut.** Crew pairs (both suits must satisfy the rules, buddy line of sight) and rover-assisted EVAs need
  their own models. This is future work, not a parameter tweak.
- Obstacles are circles; photo-based terrain updates use the same mechanism, with the geometry coming from the image.
- BroadcastChannel links windows in one browser. A real habitat would use its local network (WebSocket), with no
  dependence on Earth.

## 10. Robotics mapping (for reviewers with a ROS background)

| MarsWalk | ROS 2 Nav2 |
|---|---|
| terrain layers + cost model → base O₂ grid | static layer of the global costmap |
| alerts, comms, caution penalties, obstacles | additional costmap layers / inflation |
| A\* with octile heuristic | `NavfnPlanner` / `SmacPlanner2D` |
| costToHome field | a navigation function to a fixed goal (a "return-to-home" field) |
| replan on events | behavior tree re-planning on new costmap updates |
