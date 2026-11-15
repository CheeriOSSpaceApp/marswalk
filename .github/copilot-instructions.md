# MarsWalk project guidelines

## Build and test

The web app is a Vite project. Run web commands from `web\`:

```powershell
npm install
npm run build
npx vite
```

There is no configured lint script. The focused validation commands are:

```powershell
node test/planner.test.mjs [mock|jezero]
node test/validate_data.mjs [mock|jezero]
node test/hand_check.mjs
node test/jezero_eva.mjs
node test/report.test.mjs
```

Run one test file directly when narrowing a failure, for example
`node test/planner.test.mjs mock`. The browser demo test is
`node test/e2e_demo.mjs`; it requires Playwright/Chromium and a running Vite
server. See [docs/MANUAL_TEST.md](../docs/MANUAL_TEST.md) for the manual
console/tablet smoke test.

The data pipeline is run from the repository root:

```powershell
pip install numpy scipy pillow
python pipeline/mock_site.py
python pipeline/export_jezero.py
```

`mock_site.py` regenerates synthetic data; do not use it to replace real
Jezero data.

## Architecture

- `pipeline\` converts NASA-derived inputs into the data files consumed by the
  app. `web\public\data\common\` contains shared mission configuration;
  `web\public\data\mock\` and `web\public\data\jezero\` contain site-specific
  terrain and targets.
- `web\src\data.js` is the single loader for site data and maps the shared
  contract into typed raster layers. Grid and file-format rules are defined in
  [CONTRACTS.md](../CONTRACTS.md).
- `web\src\planner.js` is pure, DOM-free planning logic. It builds a cached
  physical O2 cost grid, applies alert/obstacle/routing state, runs
  8-connected A* for each leg, and calculates route safety and mission
  statistics. `planner.worker.js` keeps that work off the UI thread;
  `plannerClient.js` is the Promise-based browser API.
- `console.html` owns planning, alerts, replanning, and mission state.
  `tablet.html` renders the current plan and simulates progress. They
  synchronize through `BroadcastChannel('marswalk')` in `web\src\bus.js`;
  follow the message and payload shapes in
  [docs/INTEGRATION.md](../docs/INTEGRATION.md).
- Planner tests exercise pure modules in Node. `test\jezero_eva.mjs` and the
  hand-check/report tests validate domain behavior and derived statistics;
  `test\validate_data.mjs` checks data against the contracts.

## Repository conventions

- Read [CONTRACTS.md](../CONTRACTS.md) before changing a data format or
  planner/browser API. Announce contract changes in `#general` and update the
  contract document in the same change.
- Preserve the Mars grid conventions: 1000x1000 at 3 m per cell, row 0 is
  north, column 0 is west, flat index is `row * width + col`, and raw binary
  rasters are little-endian. Coordinates are Mars 2000 planetocentric,
  longitude 0–360 degrees east.
- `cellCost` is physical O2-minutes per meter and must not depend on alert
  state. Apply visibility, caution, obstacle, and other routing modifiers
  separately so reported O2 usage remains physical. Slope limits are enforced
  in the planner as well as represented in the hazard data.
- Keep the distinction between `mock` and `jezero`: mock terrain is synthetic
  test data, while real terrain and science data belong in `jezero`.
- Alert state is cumulative: retain and pass the returned `state` through
  replans. Use `destination_kind` for behavior (`habitat` or `shelter`) and
  `destination` only for display.
- Keep UI code out of pure planner modules. Add browser wiring through the
  worker client and bus contracts rather than importing planner internals into
  the pages.
- Respect the ownership boundaries documented in [CLAUDE.md](../CLAUDE.md);
  coordinate before rewriting another contributor’s area. Keep changes small
  and run the relevant Node checks before integration.
- Record every meaningful AI-assisted change in [AI_USAGE.md](../AI_USAGE.md).

