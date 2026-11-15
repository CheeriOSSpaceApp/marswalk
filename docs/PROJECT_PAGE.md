# Project page draft (Space Apps submission) — copy field by field

Every number below was measured in the repo (`node test/jezero_eva.mjs`, `docs/validation/`). Check before pasting;
one person edits the project page at a time and presses **Save Progress** often.

## Project Name
MarsWalk: an oxygen-aware EVA traverse planner for Jezero Crater

## High-Level Summary
MarsWalk plans walking EVAs for the first astronauts on Mars using real NASA terrain of Jezero Crater, with **oxygen as
the cost** and one hard rule checked at every step: *can the crew still get home?* A habitat console plans the route
(A* on a 1000 × 1000 grid built from a HiRISE DTM, metabolic cost from NASA spacesuit studies, radiation from MSL/RAD,
daylight from the Mars Climate Database) and a field tablet guides the astronaut. When something goes wrong (solar
particle event, dust storm, suit failure, oxygen leak, a new obstacle, a task that runs long, sunset) MarsWalk re-plans
from the astronaut's position in milliseconds and shows why it chose the new destination. Its routes match where
Perseverance's drivers actually drove.

## Detailed Description
**What it does.** For EVA-1 (habitat → 10 sample tubes of the Three Forks depot → Wildcat Ridge → habitat) MarsWalk
returns a 1432 m, 190 min route that uses 42 % of the suit's oxygen, keeps a 192 min margin above an 18 % reserve, stays
within NASA's 1770 m walkback limit and 100 % in line of sight of the habitat antenna, and is GO from a 09:00 LMST start
(NO-GO if started at 15:00: back after the 17:37 sunset).

**How it works.**
- *Cost map:* HiRISE DTM → slope, detrended roughness, hazard; each 3 m cell costs "O₂-minutes per metre" from the
  Pandolf load-carriage equation scaled to Mars gravity, with the suit mass and 1200 BTU/h design rate of NASA
  ICES-2026-127. Airlock, refill and sheltering time burn O₂ at the resting rate (600 BTU/h, NASA suited-rest data).
- *Planner:* optimal A* (admissible octile heuristic) between stops, plus a Dijkstra "cost-to-safety" field from the
  habitat and O₂ caches, so the point-of-no-return check is O(1) anywhere on the map. A live **safe zone** shows where the
  astronaut can still go from where they stand with the oxygen they have left.
- *Safety rules at every step:* O₂ return with reserve, walkback distance, suit battery, daylight.
- *Re-planning:* each alert has its own rule (SPE → nearest radiation shelter; dust → nearest safe point; suit failure →
  habitat; O₂ leak → home, or via the O₂ cache that makes it survivable). Replans take 11–65 ms; every option the
  planner considered is listed with why it was or wasn't chosen.
- *Infrastructure:* O₂ caches placed with greedy k-center on the same oxygen costs; weather stations ranked with VIKOR.
- *Interface:* habitat console + astronaut tablet (Leaflet, Web Worker, BroadcastChannel); POV photo from Perseverance
  at each waypoint; mission report export.

**Validation.** Given the start and end of a real Perseverance drive (sols 538→543), 99.7 % of the rover's path lies
within 20 m of MarsWalk's route (median 5 m). The cells the rover crossed are 93 % "free" and 0.6 % "forbidden" on our
hazard map, against 83 % and 7.3 % for the whole map. A hand calculation reproduces 12/12 planner statistics; 87 unit
tests and browser end-to-end tests run on every change.

**Why it matters.** The first human EVAs on Mars will be planned around oxygen, radiation and the walk home. MarsWalk
turns NASA data into a decision-support tool that computes, justifies and re-plans a route, not only a map with layers.
The same engine works for any site with a DTM (a synthetic test site ships with it), for the Moon and for Earth analogs.

**Tools.** JavaScript (Vite, Leaflet, Web Workers), Python (NumPy, SciPy, scikit-image, Matplotlib), GitHub Pages.

## NASA Data
| Data | Link | How we use it |
|---|---|---|
| Mars 2020 TRN HiRISE DTM of Jezero (1 m, USGS Astrogeology) | https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/mars2020_trn/HiRISE/ | Elevation → slope, roughness, hazard, hillshade: the cost map |
| Perseverance traverse (NASA/JPL MMGIS) | https://mars.nasa.gov/mmgis-maps/M20/Layers/json/M20_traverse.json | Validation of the planner against real drives; map layer |
| Perseverance waypoints (NASA/JPL MMGIS) | https://mars.nasa.gov/mmgis-maps/M20/Layers/json/M20_waypoints.json | Area of interest and photo locations |
| Perseverance raw images (Navcam, Mastcam-Z) | https://mars.nasa.gov/mars2020/multimedia/raw-images/ | POV photo of each waypoint on the tablet |
| Mars Trek WMTS basemap (Viking MDIM 2.1) | https://trek.nasa.gov/ | Optional basemap |
| NASA spacesuit studies: ICES-2026-127, ICES-2026-158, NTRS 20130011117, 20160013674, 20170009505 | https://ntrs.nasa.gov/ | Walking speed, suit and load mass, metabolic rates, O₂ capacity, battery, walkback limit |
| MSL/RAD surface radiation (Hassler et al. 2014) | doi:10.1126/science.1244797 | GCR dose rate |
| NASA-STD-3001 Vol. 1 and Human Integration Design Handbook | https://www.nasa.gov/ | SPE dose limit; resting O₂ cross-check |
| Space Exploration Vehicle fact sheet (FS-2011-08-045-JSC) | https://www.nasa.gov/ | Pressurized rover as radiation shelter (mission assumption) |

## Space Agency Partner Data
- Mars Climate Database v6.2 (LMD, with ESA and CNES): https://www-mars.lmd.jussieu.fr/mcd_python/ — sunrise/sunset
  at the habitat (Ls 270), hourly temperature, pressure, wind and dust optical depth.

## References
See the README *References* section (papers for Pandolf, Tobler, Soule & Goldman, RAD, VIKOR, AEMU PLSS, …) and
`CONTRACTS.md`. Open-source code: Leaflet (BSD-2), Vite (MIT), NumPy, SciPy, scikit-image, Matplotlib (BSD).
No copyrighted music or images. [Add the video's music source here if any.]

## Use of AI
We used AI assistants (Claude, ChatGPT, GitHub Copilot) to speed up coding, debugging, documentation and research of
sources; every use is logged with time, person and purpose in `AI_USAGE.md`. The concept, the safety rules, the model
choices and every number on this page were decided and checked by the team (unit tests, hand calculation, rover
validation). No AI-generated images are used; all Mars imagery is NASA data.

## Images to upload (≤ 10 MB each)
`docs/img/safe_zone_jezero.png` (safe zone shrinking), `docs/validation/validation_test2_route_map.png` (planner vs
rover), a screenshot of the console during the O₂-leak scenario, `pipeline/validation/stations_before_after.png`.
