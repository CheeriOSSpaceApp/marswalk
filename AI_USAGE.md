# AI Usage Log

Space Apps requires disclosing AI use. Each member logs every meaningful use here.
Format: `- [HH:MM] Name — Tool — What for — What we kept / changed`

- [17:05] Eric — Claude — Generated first draft of pipeline/mock_site.py (synthetic terrain) and web/src/data.js loader; reviewed and tuned thresholds/targets manually.
- [17:30] Eric — Claude — Planner v1: binary heap, A* (octile heuristic), Web Worker RPC, tests, test page. Reviewed design decisions; verified optimality vs Dijkstra in tests.
- [17:32] Dana — Claude — Researched and selected EVA-1 science targets (Three Forks depot, Wildcat Ridge, shelter) with NASA/JPL, PNAS and LPSC sources; team validated the choices and sources were checked by hand.
- [18:03] Dana — Claude — Extracted and verified target coordinates from published papers (LPSC 2023 PDF, Hogwallow Flats figure); built targets.geojson, Excel/CSV and the Bloque 1 summary doc. Pending items (tube-to-zone mapping, shelter DTM check) left marked, not invented.
- [18:41] Dana — Claude — POV photo search: script to match targets with rover stops in M20_waypoints.json, found and checked NASA raw images, built photos.json (contract kept). Dana tested the links by hand and dropped the 3 broken panoramas.
- [18:45] Eric — Claude — costToHome (Dijkstra from habitat), walkback check, no-return ring in test page; CONTRACTS.md cost-unit decision (agreed with Ana).
- [19:17] Dana — Claude — Documentation: photo/coverage PDF guide for Santiago, Excel table and Block 2 summary; reviewed manually. Captions based on metadata, visual check pending.
- [19:20] Eric — Claude — replan (alert → shelter/habitat, stacking state), snap-to-walkable, 20 tests, alert buttons in test page.
- [19:42] Dana — Claude — Researched NASA sources and drafted suit.json (6 params with source/assumption) + validation script; checked the 1200 BTU/h and 10 km references against sources, reviewed values manually.
- [19:57] Dana — Claude — Added habitat point (certified MSR landing site) and aligned walkback with Marco's suit.json; updated all deliverables.
- [20:01] Ana - Claude - Help with "pruebas.mjs" to test radiation.js
- [20:07] Dana — Claude — Updated photos.json, Excel and reports for the new habitat target (27 photos / 13 targets).
- [20:10] Eric — Claude — Fixed speedAt crash, enforced suit.json rules, data validator, e2e demo test, CLAUDE.md.
- [20:15] Dana — Claude — Re-validated suit.json against the new habitat point in targets.geojson (distances, walkback margin, reserve vs worst-case return); values unchanged, report updated with section 5.1.
- [20:20] Gabriel- ChatGPT- Create table using matplotlib in pyhton and saving changes in a .json file, checked by hand

- [20:40] Eric — Claude — Checked Marco's Jezero targets/photos (distances verified 283–548 m), moved them from mock/ to jezero/, added task time per target, radiation_shelter rule for SPE, out-of-map guard; 31 tests.
- [20:50] Dana — Claude — Processed M20_traverse.json and wrote process_rover_traverse.py → rover_traverse.geojson clipped to the AOI; reviewed QA report and figure.
- [20:52] Ana - Claude - Checked "radiation.js" to validate that it functions correctly.
- [22:36] Gabriel - ChatGPT - how to path within a repo to open files, in order to load de meta.json.
- [23:57] Dana — Claude — Task durations per target for Ana's params.json, based on Apollo data; flagged as assumptions for the team to validate.
- [00:12] Dana — Claude — Re-ran block 2 using only the team's files; kept per-sol LineStrings (pending Eric's approval), did not join gaps.
- [00:17] Dana — Claude — Checked rover traverse against suit.json limits and picked candidate segments for Sunday; checked by hand.
- [00:21] Ana - Claude - Help with creation of code for the HUD of the tablet based on design made by Ana.
- [00:35] Eric — Claude — Reorganized data folders (common/ + site), restored mock meta.json and moved Jezero meta to jezero/, integrated Ana's radiation.js, hand-check script + docs/HAND_CHECK.md (found and fixed 2 bugs: cache ignored terrain, double rounding).
- [00:50] Eric — Claude — Replan speed-up (base O2 cached per terrain, alert scaling proven exact by test), 32 unit tests + 14 browser tests passing.
- [01:05] Eric — Claude — Integration pass after everyone pushed: adapted planner to Ana's task_min structure (+ airlock no-dose assumption), ran Marco's traverse script, wrote pipeline/export_jezero.py on top of Gabriel's Elevation.py (detrended roughness, verified on synthetic planes), validator/CONTRACTS updates; 35 tests.
- [02:10] Santiago — Claude — Built web/console.html, tablet.html, src/bus.js + site.js, layers.js, console.js, tablet.js, style.css (Leaflet/Vite HUD: alert popup, compass, task checklists that gate the walk, no-return ring) and a provisional straight-line planner (src/planner.provisional.js) until plannerClient.js is wired; reviewed and adjusted the UI by hand, tested on mock and jezero.
- [02:45] Santiago — Claude — Wired console/tablet to Eric's planner per docs/INTEGRATION.md: plannerClient.js (A* worker) for plan/replan, alert state stacking, bus contract {plan, stops}/{alert, destination, destination_kind}/{lon, lat, o2_used_min, t_min}, real no-return zone from costToHome (src/ring.js), plan→per-vertex model (src/route.js), tablet task times from the planner; removed the provisional straight-line planner. Tested end-to-end on jezero and mock.
- [11:15] Eric — Claude — End-to-end browser test of Santiago's console/tablet with the real planner and Jezero data; fixed replan egress double-count (planner), negative ingress in tablet return estimate, over-zoom on tiny routes; 36 tests.
- [11:18] Ana - Claude - Help with the formatting of the models section in the README.md file. 
- [11:50] Eric — Claude — Tier 1 planner features: live obstacles in state (A), adapt() adaptive mission (B), day/night go/no-go + caution penalty (E), storm fallback to safe point (F), src/report.js mission report (C); 52 + 8 tests; docs/INTEGRATION.md §8.
- [11:34] Gabriel - ChatGPT- help calculate hours at specific latitude on mars
- [11:48] Marco — Copilot — Analyzed repository guidance and created `.github/copilot-instructions.md` for future sessions.
- [11:54] Marco — Copilot — Created presenter context and video presentation script in `docs/PRESENTATION.md`, grounded in the project architecture and validation docs.
- [12:04] Marco — Copilot — Implemented Jezero photo links, alert source notes, target validation, planner-route export, and rover comparison report/figure; reviewed generated metrics and tests.
- [12:00] Eric — Claude — Technical README of the planner (docs/PLANNER.md) and main README restructure; reserve decision 15 % → 18 % analysis (suit.json source updated). All numbers re-measured on the real grid.
- [12:15] Eric — Claude — Production deploy check (build served under /marswalk/): fixed worker data path bug that broke the planner on GitHub Pages, added index.html; three alert behaviours (shelter / safe_point / return) with replan.considered for the UI; verified NASA SEV fact sheet as a source for a radiation shelter; 56 tests.
