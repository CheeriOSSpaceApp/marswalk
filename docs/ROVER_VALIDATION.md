# Rover and target validation

## Reproduce the analysis

From the repository root:

```powershell
cd web
node test/export_eva_route.mjs
cd ..
python pipeline/validate_rover_route.py
```

The commands create:

- `pipeline/out/jezero_eva_route.geojson` — the current MarsWalk EVA route
  from the habitat through the depot to Wildcat Ridge;
- `pipeline/out/rover_route_validation.json` — machine-readable metrics;
- `pipeline/out/rover_route_validation.png` — a compact slope/hazard graphic
  for the presentation.

The comparison uses the habitat and Wildcat Ridge as the two waypoints. The
route is compared with the clipped Perseverance traverse from
`web/public/data/jezero/rover_traverse.geojson`.

## Current Jezero result

| Metric | Result |
|---|---:|
| MarsWalk route vertices checked | 247 |
| Route vertices within 20 m of rover traverse | **50.6%** |
| Median MarsWalk-to-rover distance | **19.8 m** |
| Maximum sampled distance | 89.7 m |
| Rover corridor width | ±20 m |

The 20 m number is a comparison threshold, not a claim that the astronaut
should follow the rover's exact path. The rover and astronaut have different
vehicle/body dimensions, objectives, and safety constraints.

## Terrain distribution comparison

The validation compares the whole 1000 x 1000 AOI with all cells within 20 m
of a rover-traverse line.

| Slope range | Whole AOI | Rover ±20 m |
|---|---:|---:|
| 0–5° | 57.8% | 67.3% |
| 5–10° | 26.2% | 24.1% |
| 10–15° | 8.7% | 6.9% |
| 15°+ | 7.3% | 1.7% |

| Hazard class | Whole AOI | Rover ±20 m |
|---|---:|---:|
| Free | 82.7% | 91.2% |
| Caution | 10.0% | 7.1% |
| Forbidden | 7.3% | 1.7% |

This is the simple judge-facing message: the real rover traverse is
concentrated in gentler, safer terrain than the AOI as a whole, and MarsWalk's
route can be compared against that operational reference without pretending
the two missions have identical routes.

## Target and photo review

Every current Jezero target has a valid `photo_id` pointing to an entry in
`web/public/data/jezero/photos.json`:

- habitat → `ph-hab-01`;
- depot zones 13, 16, 17, 18, 19, 20, 21, 22, 25, and 26 → nearby rover
  context images;
- Wildcat Ridge → `ph-wr-01`;
- Hawksbill operational point → `ph-sh-01`.

The values in `targets.geojson` are intentionally operational priorities:

- habitat and shelter: **1** because they are logistics/safety points;
- depot tubes: **5** because recovering the cache is the primary EVA science
  objective;
- Wildcat Ridge: **4** because it provides valuable geological context but was
  already sampled by Perseverance.

When an EVA becomes unsafe, `adapt()` drops the lowest `science_value` stop
first. These values therefore describe mission priority, not the intrinsic
scientific quality of a rock.

## Alert source review

`web/public/data/common/alerts.json` now includes a `source` field for every
alert. The effects remain planning assumptions, while the source text makes
that distinction visible:

- SPE is identified as a NASA-relevant operational radiation hazard;
- dust multipliers are explicitly marked as MarsWalk assumptions to be
  calibrated against environment data;
- suit-failure oxygen scaling is explicitly marked as a contingency
  assumption.

The data validator checks that each alert has a source/assumption note and that
each target has an integer `science_value` from 1 to 5.
