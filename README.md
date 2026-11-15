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
- **Models (Ana).** Pandolf metabolic cost on Mars gravity, Tobler speed capped at 2.2 mph, GCR dose, task times. Every
  constant with its source: [Models](#models) below.
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
node test/planner.test.mjs          # 52 unit tests (optimality, safety rules, alerts, obstacles, adapt, day/night)
node test/hand_check.mjs            # planner vs. calculator, 12 values (docs/HAND_CHECK.md)
node test/report.test.mjs           # mission report
node test/validate_data.mjs jezero  # every data file against CONTRACTS.md
node test/jezero_eva.mjs            # EVA-1 and every alert on real terrain
```
Regenerate data: `python pipeline/export_jezero.py` (Jezero, needs internet) · `python pipeline/mock_site.py` (synthetic test site).

## Models
The models turn NASA-derived terrain layers into the numbers the crew sees: cost per meter for the route planner, O₂ use, radiation dose and alert effects. Every constant is listed with its source in Constants, anything we could not source is marked as an assumption.

### Walking speed
Speed on a slope of angle θ follows Tobler's hiking function, capped at the maximum nominal Apollo walking speed:

V = min( a · exp(−b · |tan θ + c|) / 3.6 , V_cap )   [m/s]

with a = 6 km/h, b = 3.5, c = 0.05 and V_cap = 0.98 m/s (2.2 mph, ICES-2026-127). Tobler's function was calibrated for unsuited hikers, we use it only to slow the astronaut down on steeper terrain.

### Metabolic cost (Pandolf)
Metabolic power on Mars, in watts, uses the Pandolf load-carriage equation:

M = g_r · [ 1.5·W + 2·(W + L)·(L/W)² + η·(W + L)·(1.5·V² + 0.35·V·G) ] (Pandolf et al. 1977, as presented in Kim et al. 2024.)

- W: body mass (kg). 
- L: suit plus tools and samples (kg).
- V: walking speed (m/s). 
- G: grade, G = 100 · tan θ (%).
- g_r = 0.38: Mars-to-Earth gravity ratio, applied to the whole expression (team assumption).
- η: terrain factor, interpolated from local roughness r between η_min = 1.1 (dirt road) and
  η_max = 2.1 (loose sand), Soule & Goldman 1972:
  η = η_min + (η_max − η_min) · min(r / r_ref, 1), with r_ref = 0.5 m (team assumption).

### From power to O₂ minutes per meter
Cost is expressed in "O₂ minutes": one O₂ minute is one minute of suit supply at the nominal metabolic rate P_nom = 351.7 W (1200 BTU/h, ICES-2026-127). The cost per meter of a cell is

c = M / (V · 60 · P_nom)   [O₂ min / m]

The planner multiplies c by the move length (cell size, or √2 times it on diagonals). Cells with hazard = 2, or with missing slope or roughness data, cost infinity.

### Radiation
The base galactic cosmic ray (GCR) rate is 0.0279 mSv/h, which is the 0.67 mSv/day average dose equivalent measured by MSL/RAD (Hassler et al. 2014) divided by 24 h. The dose of one route segment is

D_i = rate · (t_i / 60) · dose_x   [mSv]

where t_i is the segment duration in minutes and dose_x is the multiplier of the active alert (1 when there is none). The route dose is the sum over segments. For a few hours of EVA the GCR dose is small, the real radiation risk is a solar particle event (SPE), which is why an SPE alert sends the crew to the fastest radiation-safe place (the habitat, or a shelter flagged `radiation_shelter: true`).

### Task time
Time spent on tasks is added to the walking time, so it counts toward O₂ use and dose. Durations are team estimates informed by Apollo timelines:

| Task | Minutes |
|---|---|
| Depot setup | 10 |
| Depot, per tube | 8 |
| Science stop | 45 |
| Shelter check | 5 |
| Habitat egress / ingress | 15 each |
| Cache refill | 10 |

O₂ used during a task is its duration times a work metabolic factor of 1.0, i.e. nominal metabolic rate (conservative: Apollo geology stations ran at about 0.81 to 0.89 of it).

### Constants

| Constant | Value | Unit | Source | Assumption? |
|---|---|---|---|---|
| `V_cap` | 0.98 | m/s | ICES-2026-127, slide 9: 2.2 mph, maximum nominal Apollo walking speed | No |
| `tobler_a`, `tobler_b`, `tobler_offset` | 6, 3.5, 0.05 | km/h, n/a, n/a | Tobler 1993 hiking function; designed for unsuited hikers, here used only to slow down on steep slopes | Yes (applied to a suited Mars EVA) |
| `W` | 82 | kg | ICES-2026-127: average male crewmember, 180 lbm | No |
| `L` | 126.7 | kg | 104 kg suit (229 lbm max Mars suit) + 22.7 kg tools/samples (50 lbm), ICES-2026-127 | No |
| `gRatio` | 0.38 | n/a | Mars gravity = 3/8 g | Yes (scaling Pandolf power by 0.38) |
| `P_nom` | 351.7 | W | ICES-2026-127: 1200 BTU/hr x 0.29307 W per BTU/hr | No |
| `eta_min`, `eta_max` | 1.1, 2.1 | n/a | Soule & Goldman 1972: dirt road 1.1, loose sand 2.1 | Mapping from roughness is an assumption |
| `rough_ref` | 0.5 | m | Roughness at which eta reaches `eta_max` | Yes |
| `gcr_mSv_per_h` | 0.0279 | mSv/h | Hassler et al. 2014, Science 343: MSL/RAD average GCR dose equivalent, 0.67 +/- 0.12 mSv/day at Gale Crater, divided by 24 h | Earth-day (24 h) assumption; uncertainty applied as an approximation |
| `slope_forbidden_deg` | 15 | deg | Equal to `suit.json` `max_slope_deg` | Yes |
| `slope_caution_deg` | 10 | deg | Team proposal | Yes |
| `rough_caution_m`, `rough_forbidden_m` | 0.25, 0.6 | m | Team thresholds for the hazard layer | Yes |
| `task_min.depot_setup` | 10 | min | Team estimate (context photos and preparation) | Yes |
| `task_min.depot_per_tube` | 8 | min | Apollo 16: about 3 min per documented sample, plus seal check, packing and labeling (team estimate) | Yes |
| `task_min.science` | 45 | min | Apollo 15 station 2: about 51 min; no coring or drilling | Yes |
| `task_min.shelter` | 5 | min | Team estimate (terrain check) | Yes |
| `task_min.habitat_egress`, `habitat_ingress` | 15, 15 | min | EMU timeline (15 min each) | Yes |
| `work_metabolic_factor` | 1.0 | n/a | Design average (1200 BTU/h); Apollo geology-station rates were about 0.81-0.89 of it, but there is no Mars data, so the conservative value is used | Yes |
| `sunrise_lmst`, `sunset_lmst` | 6.84, 17.62 | h (LMST, decimal Martian hours) | MCD v6.2, Ls = 270°, habitat at 77.41°E 18.45°N: hourly solar-zenith crossing of 90°, linear interpolation, flat horizon, approximate LTST-to-LMST conversion | Yes |
| `night_buffer_min` | 30 | min | Team choice: margin to be back in the habitat before sunset | Yes |
| `w_caution` | 0.5 | n/a | Tunable weight (team default); adjusted with the rover validation | Yes |
| `w_obstacle_caution` | 2.0 | n/a | Tunable weight (team default); adjusted with the rover validation | Yes |
| `task_min.cache_refill` | 10 | min | Team estimate (placeholder): time to refill/restock at a cache during the EVA | Yes |

### Model limitations
- Slope is an unsigned magnitude, so descending costs the same as ascending. This is conservative; a signed-grade model (e.g. a Santee-type downhill correction) is future work.
- The gravity factor 0.38 scales the whole Pandolf expression, which is a team assumption.
- Tobler's function was calibrated for unsuited hikers; we use it only to slow down on steep slopes.
- Hazard thresholds, task durations, the roughness-to-η mapping and the alert multipliers are team assumptions (see `params.json` and `alerts.json`).
- The GCR rate was measured at Gale Crater and is applied at Jezero.
- Dust storms are modeled with a fixed visibility of 0.3 (`alerts.json`); low visibility only raises the routing cost of steep and rough cells, it does not change O₂ beyond the alert's `o2_x`.
- The hand check verifies that the planner computes its statistics correctly from these equations; it does not validate the model itself. That is done against the real rover traverse.
- The dependence of GCR dose on atmospheric pressure (Rafkin et al. 2014; Guo et al. 2017) is not modeled; a constant rate is used.

## References
- Ogilvie et al. (2026). ICES-2026-127, NASA JSC. https://ntrs.nasa.gov/citations/20260003038 (paper); https://ntrs.nasa.gov/citations/20260005410 (presentation). 
- Kim et al. (2024). Improving Metabolic Workload Estimation Accuracy for Planning and Analyzing Exploration Traverses. IEEE EMBC. NTRS 20240001423.
- Pandolf, K. B., Givoni, B., Goldman, R. F. (1977). *J. Appl. Physiol.* 43(4).
- Soule, R. G., Goldman, R. F. (1972). *J. Appl. Physiol.* 32(5). 
- Tobler, W. (1993). Three presentations on geographical analysis and modeling. NCGIA Technical Report 93-1. 
- Hassler, D. M. et al. (2014). *Science* 343(6169). doi:10.1126/science.1244797
- Zeitlin, C. et al. (2018). Analysis of the Radiation Hazard Observed by RAD on the Surface of Mars During the September 2017 Solar Particle Event. *Geophys. Res. Lett.*
- Hassler, D. M. et al. (2018). Space Weather on the Surface of Mars: Impact of the September 2017 Events. *Space Weather* 16(11).
- Rafkin, S. C. R. et al. (2014). *J. Geophys. Res. Planets* 119, 1345-1358. doi:10.1002/2013JE004525
- Guo, J. et al. (2017). *J. Geophys. Res. Planets* 122, 329-341. doi:10.1002/2016JE005206

### Planner limitations
Unsigned slope, 3 m cells, stop order given (not optimised), greedy re-planning, single astronaut: see
[docs/PLANNER.md §9](docs/PLANNER.md#9-limitations-and-future-work).
