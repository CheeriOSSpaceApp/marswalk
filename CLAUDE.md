# CLAUDE.md — context for any AI assistant working in this repo

**MarsWalk** — NASA Space Apps 2026, challenge "Interplanetary Survival Guide: Martian Map".
EVA traverse planner for astronauts on foot at Jezero Crater (Three Forks sample depot area).
Two screens: habitat **console** (plan, inject alerts) and field **tablet** (execute route), synced by BroadcastChannel.
Concept: global costmap + global planner (like ROS Nav2). Deadline: Sun Nov 15, 22:00 submit (America/Mexico_City).

## Team & ownership (don't rewrite someone else's file without telling them)
- **Eric** — tech lead, planner (`web/src/planner*.js`, `heap.js`, `data.js`, tests), merges to main
- **Santiago** — frontend: `console.html`, `tablet.html`, `bus.js` (Leaflet, Vite)
- **Gabriel** — data pipeline (`pipeline/`, `web/public/data/jezero/` rasters, meta.json). GitHub: Khronos00
- **Ana** — cost model `web/src/cost.js`, `web/src/radiation.js`, `params.json`, env.json, tablet HUD. GitHub: anakikilopez
- **Marco** — `suit.json`, `alerts.json`, viewshed, rover traverse, validation
- **Dana** — science targets, photos.json, video, project page

## Data folders (web/public/data/)
- `common/` suit.json (Marco), params.json (Ana), alerts.json (Marco+Ana) — shared by all sites
- `mock/` synthetic terrain for testing (Eric). NEVER put real data here.
- `jezero/` real site: meta.json (Gabriel), targets.geojson + photos.json + rover_traverse.geojson (Marco), rasters via pipeline/export_jezero.py (Gabriel's DTM read)
- Frontend wiring: docs/INTEGRATION.md. GitHub: Santiago = CajadeCarton, Dana = Danatotis

## Source of truth
`CONTRACTS.md` defines every file format and code API. Read it before changing anything.
Changing a contract = announce in #general first, then update CONTRACTS.md in the same PR.

## Key decisions (with reasons — judges will ask)
- Grid 1000×1000, 3 m cells, row 0 = north, little-endian raw binaries.
- `cellCost` = O₂-minutes **per meter**; 1 O₂-min = 1 min at 352 W (1200 BTU/h, ICES-2026-127).
- Cost grid precomputed once per (params, state) → A* only reads an array; replanning = rebuild grid + rerun (~0.3–0.5 s), no D* Lite needed.
- A* 8-connected, no corner cutting, octile heuristic × min cost/m (admissible → optimal; test checks A* == Dijkstra).
- Binary heap with typed arrays + lazy deletion.
- costToHome / distToHome = one Dijkstra from habitat (edge costs are symmetric). If cost becomes direction-dependent (uphill ≠ downhill), switch to reversed edges.
- Safety: O₂ rule (used + return ≤ 408 min usable) and walkback rule (≤ 1770 m walking, ICES-2026-127: 30 min at 2.2 mph). Slope > suit.max_slope_deg (15°) is impassable, enforced in the planner too.
- Replan: SPE → nearest shelter by walking TIME (dose ∝ exposure time), habitat counts as shelter; dust/suit → habitat. Alert effects stack multiplicatively via returned `state`.
- Planner runs in a Web Worker (UI never freezes).

## Commands (from `web/`)
```bash
node test/planner.test.mjs [mock|jezero]    # unit tests (must all PASS before any PR)
node test/validate_data.mjs [mock|jezero]   # checks a data folder against CONTRACTS.md
node test/hand_check.mjs                    # planner stats vs hand calculation (docs/HAND_CHECK.md)
node test/jezero_eva.mjs                    # EVA-1 + alerts + Tier 1 scenarios on the real Jezero terrain
node test/report.test.mjs                   # mission report from a synthetic log
python pipeline/export_jezero.py            # (repo root, needs internet) DTM -> jezero/ layers
npx vite                                    # dev server -> /planner-test.html
node test/e2e_demo.mjs                      # browser test of the demo (needs: npm i -D playwright && npx playwright install chromium)
python ../pipeline/mock_site.py             # regenerate synthetic site (from repo root: python pipeline/mock_site.py)
```

## Rules
- Log every meaningful AI use in `AI_USAGE.md` (required by Space Apps).
- No AI-generated images that look like real NASA photos.
- Small PRs; Eric merges. Run the tests first.
