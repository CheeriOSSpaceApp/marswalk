# MarsWalk Presentation Guide

## What MarsWalk is

MarsWalk is an EVA traverse planner for astronauts working near the Three Forks
sample depot area of Jezero Crater. It answers a practical question:

> Given terrain, suit limits, science targets, and changing hazards, what is
> the safest route an astronaut can take right now?

The project has two synchronized screens:

- **Habitat console:** plans an EVA, shows terrain and targets, injects alerts,
  and replans when conditions change.
- **Field tablet:** shows the astronaut's current route, progress, remaining
  safety margin, and alert instructions.

The project is designed around the idea of a global costmap and global planner,
similar to the planning pattern used by ROS Nav2, but adapted to the constraints
of a human Mars EVA.

## Why this matters

An astronaut cannot choose a route based only on distance. A route may be
shorter but require more oxygen, cross steep terrain, lose communication with
the habitat, or leave too little time and oxygen for the return.

MarsWalk combines these factors:

- terrain slope and roughness;
- forbidden and caution zones;
- walking speed and metabolic cost;
- oxygen consumption;
- radiation exposure;
- walkback distance and reserve oxygen;
- habitat visibility and communications;
- live alerts such as solar particle events, dust, and suit failure;
- science value of the remaining stops.

The result is a route that is explainable: the application can show not only
where the astronaut should walk, but also why the route is safe or unsafe.

## The user story for the demo

The demo follows one EVA:

1. The crew starts at the habitat.
2. The console displays the Jezero terrain and science targets.
3. The planner builds a route through depot and science stops and back to the
   habitat.
4. The tablet receives the plan and simulates the astronaut walking it.
5. The console injects an alert while the EVA is in progress.
6. The planner selects the appropriate response:
   - a solar particle event sends the crew to a radiation shelter when one is
     available, otherwise to the habitat;
   - dust reduces visibility and makes steep or rough terrain less desirable;
   - suit failure increases oxygen consumption;
   - a return alert sends the crew home or to the nearest safe fallback point
     when the habitat is no longer reachable within the safety limits.
7. The tablet receives the new route and displays the alert without reloading.

## What the presenters should show

### Recommended live sequence

Use the real Jezero site for the main presentation:

1. Open `console.html` with the Jezero site.
2. Point out the habitat, targets, hillshade, caution areas, and forbidden
   areas.
3. Run the EVA plan.
4. Explain the statistics:
   - distance;
   - total time;
   - task time;
   - oxygen used and remaining margin;
   - radiation dose;
   - walkback limit;
   - safe/unsafe result.
5. Open the tablet beside the console and start the walk simulation.
6. Inject an alert from the console.
7. Show the tablet's alert banner and changed route.
8. Explain that both screens stay synchronized through a browser
   `BroadcastChannel`, not by refreshing the page.

### Jezero sanity-check numbers

The expected EVA-1 result on the current Jezero data is approximately:

- **1,430 m** total walking distance;
- **190 min** total mission time;
- **165 min** working/task time;
- **45%** oxygen used;
- **191.5 min** oxygen margin;
- **601 m** maximum walkback distance;
- **0.075 mSv** radiation dose;
- **safe: true**.

These are validation values, not promises that every future data or parameter
change will produce exactly the same result.

For the rover-validation evidence and the presentation graphic, see
[docs/ROVER_VALIDATION.md](ROVER_VALIDATION.md).

### If the live demo fails

Use the mock site or the prepared screenshots/video capture. The mock site
uses the same data contract and planner behavior, but synthetic terrain. It is
appropriate for demonstrating the software flow, not for claiming scientific
terrain fidelity.

## How the code works

### 1. Data contract and loading

The files under `web/public/data/` follow the rules in
[CONTRACTS.md](../CONTRACTS.md):

- `common/` contains shared mission configuration such as suit limits,
  parameters, and alert effects;
- `mock/` contains synthetic terrain for repeatable testing;
- `jezero/` contains the real Jezero terrain and science data;
- raster files use a 1000 x 1000 grid with 3 m cells;
- row 0 is north, column 0 is west, and the flat index is
  `row * width + column`.

[`web/src/data.js`](../web/src/data.js) is the single loader. The rest of the
application receives one site object containing metadata, typed terrain layers,
targets, suit configuration, model parameters, and alerts.

### 2. Physical cost model

[`web/src/cost.js`](../web/src/cost.js) converts terrain and astronaut
parameters into a physical oxygen cost:

- slope affects walking speed;
- roughness affects terrain difficulty;
- the Pandolf model estimates metabolic power;
- metabolic power is converted to oxygen-equivalent minutes per meter.

`cellCost` represents physical oxygen consumption. It does **not** include
alert or visibility preferences. This separation is important: avoiding a
poor-visibility area may change the chosen route, but it must not make the
reported oxygen usage physically inaccurate.

### 3. Planning

[`web/src/planner.js`](../web/src/planner.js) first builds a cached base oxygen
grid. It then applies operational state, such as visibility, caution penalties,
and live obstacles, to create the routing grid.

For each route leg it:

1. converts geographic coordinates to grid cells;
2. snaps points to walkable cells when appropriate;
3. searches with 8-connected A*;
4. prevents diagonal corner cutting;
5. calculates distance, time, oxygen, dose, battery, communications, and
   safety statistics;
6. checks the return-to-habitat and walkback constraints.

The cost grid is cached because the terrain does not change between alerts.
This keeps replanning fast enough for an interactive EVA demo.

### 4. Worker boundary

Planning can evaluate up to one million raster cells, so the browser UI should
not perform it on the main thread. [`planner.worker.js`](../web/src/planner.worker.js)
runs the planner in a Web Worker, while
[`plannerClient.js`](../web/src/plannerClient.js) exposes a Promise-based API
for the pages.

The main operations are:

- `init(site)`;
- `plan(request)`;
- `replan(request)`;
- `adapt(request)`;
- `costToHome(request)`.

### 5. Console/tablet synchronization

[`web/src/bus.js`](../web/src/bus.js) uses
`BroadcastChannel('marswalk')`. The console owns planning and sends plan or
alert messages. The tablet renders the plan, simulates progress, and sends
position updates back to the console.

The integration payloads are documented in
[docs/INTEGRATION.md](INTEGRATION.md). Keep those payload shapes stable when
changing frontend behavior.

### 6. Replanning and adaptive missions

Alert effects are cumulative. The console must retain the `state` returned by
the planner and pass it into the next replan. Behavior uses
`destination_kind` (`habitat` or `shelter`); `destination` is only the display
name.

The adaptive planner can also drop lower-value science stops when the
remaining route is no longer safe. This lets the crew preserve the highest
priority science while returning within oxygen, time, daylight, and walkback
limits.

## Important terms for presenters

| Term | Plain-language explanation |
|---|---|
| Costmap | A grid where every cell has a movement cost or is marked impassable. |
| Cell cost | Physical oxygen cost per meter for terrain and walking conditions. |
| A* | The search algorithm that finds a low-cost route through the grid. |
| Replan | Build a new route from the astronaut's current position after a change. |
| No-return ring | The area from which the astronaut cannot safely reach home with the remaining oxygen. |
| Walkback | The maximum distance the crew can walk back under the suit safety rule. |
| SPE | Solar particle event; a radiation alert that requires shelter or return. |
| State | The cumulative alert and obstacle conditions used by the planner. |

## Questions presenters may receive

### Why not choose the shortest path?

Because distance is only one part of EVA risk. A slightly longer route can use
less oxygen, avoid a forbidden slope, preserve communications, or provide a
safer return.

### Is this a real NASA flight-planning system?

No. MarsWalk is a prototype and a decision-support demonstration. It uses
NASA-derived terrain and published context where available, while clearly
marking team assumptions in the configuration. It is not certified flight
software.

### Why are there two sites?

`jezero` is the real demonstration site. `mock` is deterministic synthetic
terrain for testing and development, so tests can run without depending on
large external data-generation steps.

### Why does the route change during the EVA?

The astronaut's position, remaining oxygen, visibility, alerts, and obstacles
can change. The planner starts from the current position and calculates a new
safe destination rather than continuing to follow an obsolete route.

### What is the most important design decision?

The separation between physical oxygen cost and routing preferences. Alert
effects can influence route selection, but the reported oxygen statistics
remain tied to the physical model.

## Before recording

From `web\`, verify the build and the core behavior:

```powershell
npm run build
node test/planner.test.mjs jezero
node test/hand_check.mjs
node test/jezero_eva.mjs
node test/report.test.mjs
```

For a manual browser check, follow
[docs/MANUAL_TEST.md](MANUAL_TEST.md). Keep the browser console visible while
testing; a red error should be treated as a failed demo.

---

# Video presentation script

## Suggested length

Approximately **3 to 4 minutes**, with the application visible for most of the
video. The wording can be shortened if the submission has a strict time limit.

## Scene 1 — The problem (0:00–0:25)

**Visual:** Mars terrain or the Jezero map. Show the habitat and several
targets.

**Narrator:**

> On Mars, planning a walk is not just finding the shortest line between two
> points. An astronaut must manage oxygen, difficult terrain, radiation,
> communications, science priorities, and the possibility that conditions will
> change during the EVA.
>
> MarsWalk is a decision-support tool that plans safer traverses for
> astronauts near the Three Forks sample depot area of Jezero Crater.

## Scene 2 — The product (0:25–0:55)

**Visual:** Show the console and tablet side by side.

**Narrator:**

> MarsWalk has two synchronized views. The habitat console creates the mission
> plan, displays the terrain and science targets, and handles alerts. The field
> tablet travels with the astronaut and shows the active route, progress, and
> safety information.
>
> Both screens share the same mission state in real time, so the field crew can
> receive a new route without refreshing the application.

## Scene 3 — Planning an EVA (0:55–1:35)

**Visual:** Click the EVA or plan control. Show the route and statistics panel.

**Narrator:**

> The planner starts with a 1000 by 1000 terrain grid. Each cell represents
> three meters. The data includes elevation, slope, roughness, hazards,
> visibility, targets, and suit limits.
>
> The route is not optimized for distance alone. The cost model estimates
> walking speed and metabolic oxygen use for each cell. The planner then uses
> an 8-connected A* search to find a route that avoids forbidden terrain and
> respects the astronaut's safety limits.
>
> For this Jezero EVA, the expected result is about 1.43 kilometers, 190
> minutes total, and 45 percent oxygen used. The application also reports
> radiation dose, walkback distance, return margin, and whether the mission is
> safe.

## Scene 4 — Tablet execution (1:35–2:00)

**Visual:** Start the tablet simulation. Show the marker moving along the route
and the HUD updating.

**Narrator:**

> The tablet receives the plan and simulates the astronaut progressing along
> the route. It sends position and oxygen updates back to the console.
>
> The tablet also shows the no-return ring: the region from which the
> astronaut cannot safely get back with the remaining oxygen. This turns an
> abstract safety calculation into information the crew can understand at a
> glance.

## Scene 5 — Live alert and replan (2:00–2:45)

**Visual:** Inject an SPE, dust, or suit-failure alert. Show the route changing
and the tablet banner appearing.

**Narrator:**

> Now we inject an alert during the EVA.
>
> A solar particle event changes the destination to a radiation shelter or the
> habitat. Dust reduces visibility and makes steep or rough terrain less
> desirable. A suit failure increases oxygen consumption.
>
> MarsWalk keeps the alert state cumulative, starts from the astronaut's
> current position, and computes a new route. The console owns the replan, and
> the tablet receives the new route and alert banner through a
> `BroadcastChannel`.
>
> The goal is not to pretend that the original plan is still valid. The goal
> is to give the crew a safe next action.

## Scene 6 — Adaptive mission (2:45–3:15)

**Visual:** Show an obstacle or an unsafe state, then show the remaining stops
and the adapted plan.

**Narrator:**

> If the remaining mission no longer fits inside the safety limits, MarsWalk
> can adapt the mission. It drops lower-value science stops first, preserves
> the highest-priority work, and replans the return.
>
> This is important because a real EVA is not a fixed sequence of waypoints.
> It is a changing decision process with a strict safety boundary.

## Scene 7 — Closing (3:15–3:40)

**Visual:** Return to the full console/tablet view and the final safe status.

**Narrator:**

> MarsWalk combines terrain data, human performance models, mission priorities,
> and live replanning in one explainable interface.
>
> It does not replace mission certification or astronaut judgment. It
> demonstrates how a Mars surface system can turn complex environmental data
> into a clear, actionable route.
>
> MarsWalk: plan the science, protect the crew, and always keep a way home.

## Optional short version

> MarsWalk is an EVA traverse planner for astronauts at Jezero Crater. It
> combines terrain slope, roughness, oxygen use, radiation, communications,
> walkback limits, and science priorities to calculate a safe route.
>
> The habitat console plans the mission, while the field tablet shows progress.
> If dust, a solar particle event, a suit failure, or a new obstacle appears,
> the console replans from the astronaut's current position and sends the new
> route to the tablet in real time.
>
> Behind the interface is a cached terrain costmap and an 8-connected A* global
> planner running in a Web Worker, so the browser remains responsive.
>
> MarsWalk is a prototype, but it demonstrates the key idea for human
> exploration: the best route is not always the shortest route. It is the route
> that gets the crew to the science target and preserves a safe way home.
