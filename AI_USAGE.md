# AI Usage Log

Space Apps requires disclosing AI use. Each member logs every meaningful use here.
Format: `- [HH:MM] Name — Tool — What for — What we kept / changed`

- [17:05] Eric — Claude — Generated first draft of pipeline/mock_site.py (synthetic terrain) and web/src/data.js loader; reviewed and tuned thresholds/targets manually.
- [17:30] Eric — Claude — Planner v1: binary heap, A* (octile heuristic), Web Worker RPC, tests, test page. Reviewed design decisions; verified optimality vs Dijkstra in tests.
- [18:45] Eric — Claude — costToHome (Dijkstra from habitat), walkback check, no-return ring in test page; CONTRACTS.md cost-unit decision (agreed with Ana).
- [19:20] Eric — Claude — replan (alert → shelter/habitat, stacking state), snap-to-walkable, 20 tests, alert buttons in test page.
- [20:01] Ana - Claude - Help with "pruebas.mjs" to test radiation.js
- [20:10] Eric — Claude — Fixed speedAt crash, enforced suit.json rules, data validator, e2e demo test, CLAUDE.md.
- [20:20] Gabriel- ChatGPT- Create table using matplotlib in pyhton and saving changes in a .json file, checked by hand

- [20:40] Eric — Claude — Checked Marco's Jezero targets/photos (distances verified 283–548 m), moved them from mock/ to jezero/, added task time per target, radiation_shelter rule for SPE, out-of-map guard; 31 tests.

- [20:52] Ana - Claude - Checked "radiation.js" to validate that it functions correctly.
- [22:36] Gabriel - ChatGPT - how to path within a repo to open files, in order to load de meta.json.
- [00:21] Ana - Claude - Help with creation of code for the HUD of the tablet based on design made by Ana.
- [00:35] Eric — Claude — Reorganized data folders (common/ + site), restored mock meta.json and moved Jezero meta to jezero/, integrated Ana's radiation.js, hand-check script + docs/HAND_CHECK.md (found and fixed 2 bugs: cache ignored terrain, double rounding).
- [00:50] Eric — Claude — Replan speed-up (base O2 cached per terrain, alert scaling proven exact by test), 32 unit tests + 14 browser tests passing.
- [01:05] Eric — Claude — Integration pass after everyone pushed: adapted planner to Ana's task_min structure (+ airlock no-dose assumption), ran Marco's traverse script, wrote pipeline/export_jezero.py on top of Gabriel's Elevation.py (detrended roughness, verified on synthetic planes), validator/CONTRACTS updates; 35 tests.
- [01:35] Eric — Claude — Jezero integration: validator snap-aware reachability (Wildcat Ridge at scarp base), EVA-1 run on real terrain (test/jezero_eva.mjs), consistent replan destination ids, docs/INTEGRATION.md for console/tablet wiring.
