# Manual visual test (5–10 min) — anyone on the team

## Start
```powershell
cd marswalk\web
npx vite
```
Open **http://localhost:5173/planner-test.html?site=jezero** (real Mars) and, in another tab, `?site=mock` (synthetic).
Keep DevTools open (F12 → Console): any red error = bug, report it.

## Checklist (expected result → if not, it's a bug)
| # | Do | Expected |
|---|---|---|
| 1 | Load the page | Gray shaded terrain; red = forbidden, yellow = caution; white labels on targets; text `site: jezero, 1000×1000, cell 3 m` |
| 2 | Click 2 points on gray terrain | Cyan route in < 1 s that never crosses red; stats panel with `safe: true` |
| 3 | Click start on a red zone edge | Route still appears (snapped to nearest walkable cell). Deep inside a big red zone → `point_in_forbidden_zone` |
| 4 | Click a point inside a closed red ring (island) | `unreachable` (correct: no way in) |
| 5 | **EVA** button (jezero) | Habitat → 10 depot tubes → Wildcat Ridge → habitat: ~1430 m, ~190 min (task 165), O₂ ~45 %, `safe: true` |
| 6 | Tick **Suit failure**, press EVA again | Same route, O₂ ×1.5 (~68 %) |
| 7 | Tick **Dust**, plan between 2 points crossing yellow areas | Route changes: avoids steep/rough terrain |
| 8 | After an EVA, press **SPE → shelter** | Orange route from YOU to the habitat (jezero: Hawksbill isn't a radiation shelter), old route dashed, `round_trip_ms` < 1000 |
| 9 | Press **dust → return**, then **suit → return** (without replanning) | `state` shows both alerts stacked (o2_x 1.65, visibility 0.3) |
| 10 | Tick **No-return ring**, move the O₂ slider down | Dark area grows from the edges inward; at ~30 min only the area near the habitat stays lit |
| 11 | Repeat 2, 5, 8 with `?site=mock` | Works the same on the fake terrain (SPE goes to "Shelter A (mock)") |

## Red flags
Route through red · `NaN`/`null` in stats (except `turnaround_point`) · > 1 s · route not starting at YOU after an alert · console errors.

## Automated (before every push)
```powershell
node test/planner.test.mjs        # 35 PASS
node test/hand_check.mjs          # stats vs hand calculation
node test/validate_data.mjs jezero
node test/jezero_eva.mjs          # real EVA-1 numbers
```

## Full demo (when console + tablet are pushed)
Two windows side by side: `/console.html` and `/tablet.html`. Plan in the console → the tablet shows the route without reloading →
▶ walk → inject SPE in the console → tablet route changes by itself + banner, < 1 s. Repeat 3 times without errors before recording.
