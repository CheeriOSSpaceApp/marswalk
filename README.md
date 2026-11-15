# MarsWalk — EVA traverse planner for Jezero Crater (NASA Space Apps 2026)

**Challenge:** Interplanetary Survival Guide: Martian Map · **Team:** CheeriOS

MarsWalk plans walking EVAs (extravehicular activities) on real Mars terrain, with **oxygen as the cost** and **"can I still
get home?" as a hard rule at every step**. The **habitat console** plans the route; the **field tablet** guides the
astronaut. When something changes (solar particle event, dust storm, suit failure, an obstacle the astronaut reports, a task
that runs long, the Sun going down), the route is **re-planned in milliseconds** and pushed to the tablet.

Built on real NASA data: HiRISE DTM of Jezero (1 m → 3 m grid), Perseverance's traverse and Three Forks sample depot,
NASA spacesuit studies (ICES-2026-127 / -158), MSL/RAD radiation, Mars Climate Database.

## Run it
```bash
cd web
npm install
npm run dev
```
- Habitat console: http://localhost:5173/console.html
- Field tablet: http://localhost:5173/tablet.html (open both side by side)
- Planner test bench: http://localhost:5173/planner-test.html?site=jezero

Add `?site=mock` to any page for the synthetic test terrain.

## Results — EVA-1 on real Jezero terrain
Habitat → 10 sample-depot tubes → Wildcat Ridge → habitat: **1432 m, 190 min (165 of them working), 45 % of O₂,
177 min of O₂ margin, 0.075 mSv. Safe, GO from a 09:00 LMST start.**
Re-plan after an alert: 11–65 ms. Full numbers and method: [docs/PLANNER.md](docs/PLANNER.md).

## How it works (one paragraph per piece)
- **Planner (Eric).** Global costmap + global planner, as in ROS 2 Nav2. Optimal A\* on a 1000 × 1000 oxygen-cost grid; a
  Dijkstra "cost-to-home" field gives an O(1) point-of-no-return check anywhere; safety rules: O₂ return with an 18 % reserve,
  1770 m walkback, battery, daylight. Details, complexity and verification: [docs/PLANNER.md](docs/PLANNER.md).
- **Models (Ana).** Pandolf metabolic cost on Mars gravity, Tobler speed capped at 2.2 mph, GCR dose, task times.
  *Section in progress: Ana.*
- **Data pipeline (Gabriel).** HiRISE DTM → elevation, slope, detrended roughness, hazard, hillshade, ortho; climate from
  the MCD. `pipeline/export_jezero.py`. *Section in progress: Gabriel.*
- **Life support, comms and validation (Marco).** Suit limits with NASA sources (`web/public/data/common/suit.json`);
  line-of-sight viewshed from the habitat antenna; the rover traverse as validation. *Validation results in progress: Marco.*
- **Interface (Santiago).** Leaflet console + tablet, synced live over BroadcastChannel; no-return ring, HUD, checklists, alerts.
- **Science and story (Dana).** EVA-1 science objectives (Three Forks depot, Wildcat Ridge), POV photos, video, project page.

## Repository
- `pipeline/` — Python: NASA data → contract layers (`export_jezero.py`, `process_rover_traverse.py`, `process_viewshed.py`, `mock_site.py`)
- `web/src/` — planner (`planner.js`, `heap.js`, worker, client), cost model (`cost.js`, `radiation.js`), UI (`console.js`, `tablet.js`, …), `report.js`
- `web/public/data/jezero/` real site · `common/` suit, model params, alerts · `mock/` synthetic test terrain
- `docs/` — [PLANNER](docs/PLANNER.md) · [INTEGRATION](docs/INTEGRATION.md) (frontend ↔ planner) · [HAND_CHECK](docs/HAND_CHECK.md) · [MANUAL_TEST](docs/MANUAL_TEST.md)
- `CONTRACTS.md` — every file format, API and team decision (with time). `AI_USAGE.md` — AI use log (Space Apps rule).

## Tests
```bash
cd web
node test/planner.test.mjs        # 52 unit tests
node test/hand_check.mjs          # planner vs. calculator, 12 values
node test/report.test.mjs         # mission report
node test/validate_data.mjs jezero
node test/jezero_eva.mjs          # EVA-1 and every alert on real terrain
```

## Model limitations
- Slope is used as an unsigned magnitude, so descending costs the same as
  ascending. This is conservative; a signed-grade model (e.g. a Santee-type
  downhill correction) is future work.
- Pandolf power is scaled by 0.38 for Martian gravity (team assumption).
- Tobler's hiking function was calibrated for unsuited hikers; we use it only
  to slow down on steep slopes.
- Hazard thresholds, task durations and alert multipliers are team assumptions
  (see `params.json` and `alerts.json`).
