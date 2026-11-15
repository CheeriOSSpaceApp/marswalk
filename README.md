# MarsWalk — EVA traverse planner for Jezero Crater (NASA Space Apps 2026)

Global costmap + global planner (same idea as ROS Nav2) for astronauts on foot:
habitat console plans the route, field tablet executes it, and alerts (SPE, dust, suit failure) trigger live replanning.

## Layout
- `pipeline/` — Python: raw NASA data -> contract layers (`mock_site.py` makes a synthetic site)
- `web/` — Vite + JS: `console.html`, `tablet.html`, planner Web Worker
- `web/public/data/<site>/` — data contract files (`mock` or `jezero`)
- `docs/` — notes, figures
- `CONTRACTS.md` — file & code formats. **Change it only after announcing in #general.**

## Quick start
```bash
pip install numpy scipy pillow
python pipeline/mock_site.py      # -> web/public/data/mock/
```
## Models
The models turn NASA-derived terrain layers into the numbers the crew sees: cost per meter for the route planner, O₂ use, radiation dose and alert effects. Every constant is listed with its source in Constants, anything we could not source is marked as an assumption.

### Walking speed
Speed on a slope of angle θ follows Tobler's hiking function, capped at the maximum nominal Apollo walking speed:

V = min( a · exp(−b · |tan θ + c|) / 3.6 , V_cap )   [m/s]

with a = 6 km/h, b = 3.5, c = 0.05 and V_cap = 0.98 m/s (2.2 mph, ICES-2026-127). Tobler's function was calibrated for unsuited hikers, we use it only to slow the astronaut down on steeper terrain.

### Metabolic cost (Pandolf)
Metabolic power on Mars, in watts, uses the Pandolf load-carriage equation:

M = g_r · [ 1.5·W + 2·(W + L)·(L/W)² + η·(W + L)·(1.5·V² + 0.35·V·G) ]

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

where t_i is the segment duration in minutes and dose_x is the multiplier of the active alert (1 when there is none). The route dose is the sum over segments. For a few hours of EVA the GCR dose is small, the real radiation risk is a solar particle event (SPE), which is why an SPE alert sends the crew to the nearest shelter.

### Task time
Time spent on tasks is added to the walking time, so it counts toward O₂ use and dose. Durations are team estimates informed by Apollo timelines:

| Task | Minutes |
|---|---|
| Depot setup | 10 |
| Depot, per tube | 8 |
| Science stop | 45 |
| Shelter check | 5 |
| Habitat egress / ingress | 15 each |

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

### Model Limitations
- Slope is an unsigned magnitude, so descending costs the same as ascending. This is conservative; a signed-grade model (e.g. a Santee-type downhill correction) is future work.
- The gravity factor 0.38 scales the whole Pandolf expression, which is a team assumption.
- Tobler's function was calibrated for unsuited hikers;  we use it only
  to slow down on steep slopes.
- Hazard thresholds, task durations, the roughness-to-η mapping and the alert multipliers are team assumptions (see `params.json` and `alerts.json`).
- The GCR rate was measured at Gale Crater and is applied at Jezero.
- Dust visibility uses a simple exponential with a floor of 0.2.
- The hand check verifies that the planner computes its statistics correctly from these equations; it does not validate the model itself. That is done against the real rover traverse.

## References
- Ogilvie et al. (2026). ICES-2026-127, NASA JSC. https://ntrs.nasa.gov/citations/20260003038 (paper); https://ntrs.nasa.gov/citations/20260005410 (presentation). 
- Kim et al. (2024). Improving Metabolic Workload Estimation Accuracy for Planning and Analyzing Exploration Traverses. IEEE EMBC. NTRS 20240001423.
- Pandolf, Kim. B., Givoni, B., Goldman, R. F. (1977). *J. Appl. Physiol.* 43(4).
- Soule, R. G., Goldman, R. F. (1972). *J. Appl. Physiol.* 32(5). 
- Tobler, W. (1993). Three presentations on geographical analysis and modeling. NCGIA Technical Report 93-1. 
- Hassler, D. M. et al. (2014). *Science* 343(6169). doi:10.1126/science.1244797
- Zeitlin, C. et al. (2018). Analysis of the Radiation Hazard Observed by RAD on the Surface of Mars During the September 2017 Solar Particle Event. *Geophys. Res. Lett.*
- Hassler, D. M. et al. (2018). Space Weather on the Surface of Mars: Impact of the September 2017 Events. *Space Weather* 16(11).
- Rafkin, S. C. R. et al. (2014). *J. Geophys. Res. Planets* 119, 1345-1358. doi:10.1002/2013JE004525
- Guo, J. et al. (2017). *J. Geophys. Res. Planets* 122, 329-341. doi:10.1002/2016JE005206