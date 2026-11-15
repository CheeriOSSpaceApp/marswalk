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
