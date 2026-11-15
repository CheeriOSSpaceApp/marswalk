# Hand check of the planner stats (Ana + Eric)

Goal (plan, Ana 20:30–23:00): *"Revisa que stats de Eric coincidan con un cálculo a mano en 2 rutas de prueba."*
Automated version: `cd web && node test/hand_check.mjs` (planner vs. the same formulas, written independently).

Terrain is synthetic so it can be done with a calculator: every cell has the same slope and roughness,
route goes straight east from the habitat, **333 cells × 3 m = 999 m**, so the return trip costs the same as the outbound.
Constants from `data/common/params.json` and `suit.json`: W = 82 kg, L = 126.7 kg, g_ratio = 0.38, P_nom = 351.7 W,
V_cap = 0.98 m/s, Tobler a=6, b=3.5, offset=0.05, η = 1.1 → 2.1 (rough_ref 0.5 m), GCR = 0.0279 mSv/h,
O₂ = 8 h = 480 min, reserve 15 % → 408 usable.

## Formulas (one line each)
1. Speed: `V = min( a·e^(−b·|tanθ + 0.05|) / 3.6 , V_cap )` (m/s)
2. Grade: `G = 100·tanθ` (%)
3. Terrain factor: `η = 1.1 + 1.0 · min(rough / 0.5, 1)`
4. Pandolf on Mars: `M = 0.38 · [1.5W + 2(W+L)(L/W)² + η(W+L)(1.5V² + 0.35·V·G)]` (W)
5. Cost per meter: `c = M / (V · 60 · P_nom)` (O₂-min per meter)
6. O₂ of the walk: `c · 999`. Task: 1 O₂-min per minute (at P_nom).
7. `o2_used_pct = 100 · (walk + task) / 480`
8. `o2_margin_min = 408 − (walk + task + walk_back)` (worst point = goal, after the task)
9. `duration = 999 / V / 60 + task`;  `dose = 0.0279 · duration / 60`

Shared pieces: `1.5W = 123`, `L/W = 1.54512`, `(L/W)² = 2.38740`, `2(W+L)(L/W)² = 417.4 · 2.38740 = 996.50`, `W+L = 208.7`,
`V·60·P_nom = 0.98 · 60 · 351.7 = 20 679.96`.

## R1 — flat (θ = 0°), smooth (rough = 0), 999 m, no task
| step | value |
|---|---|
| Tobler: 6·e^(−3.5·0.05) = 6·0.83946 = 5.0368 km/h = 1.399 m/s → **capped V = 0.98** | |
| G = 0, η = 1.1 | |
| third term: 1.1 · 208.7 · (1.5 · 0.9604) = 229.57 · 1.4406 = 330.72 | |
| M = 0.38 · (123 + 996.50 + 330.72) = 0.38 · 1450.22 | **551.1 W** |
| c = 551.08 / 20 679.96 | **0.026648 O₂-min/m** |
| walk O₂ = 0.026648 · 999 | 26.62 min |
| o2_used_pct = 100 · 26.62 / 480 | **5.5 %** |
| o2_margin = 408 − 2 · 26.62 | **354.8 min** |
| duration = 999 / 0.98 / 60 | **17.0 min** |
| dose = 0.0279 · 16.99 / 60 | **0.0079 mSv** |

## R2 — 5° slope, rough 0.25 m, 999 m, + 30 min task at the goal
| step | value |
|---|---|
| tan 5° = 0.087489; Tobler: 6·e^(−3.5·0.137489) = 6·0.61803 = 3.708 km/h = 1.030 m/s → **V = 0.98** | |
| G = 8.749 %, η = 1.1 + 0.5 = 1.6 | |
| third term: 1.6 · 208.7 · (1.4406 + 0.35·0.98·8.749) = 333.92 · 4.4415 = 1483.1 | |
| M = 0.38 · (123 + 996.50 + 1483.1) = 0.38 · 2602.6 | **989.0 W** |
| c = 989.0 / 20 679.96 | **0.047824 O₂-min/m** |
| walk O₂ = 0.047824 · 999 | 47.78 min |
| o2_used_pct = 100 · (47.78 + 30) / 480 | **16.2 %** |
| o2_margin = 408 − (47.78 + 30 + 47.78) | **282.4 min** |
| duration = 16.99 + 30 | **47.0 min** |
| dose = 0.0279 · 46.99 / 60 | **0.0219 mSv** |

## Result (00:35)
All 12 values match. The hand check found **2 real bugs**, both fixed:
1. The cost-grid cache ignored the terrain → after switching site the planner reused the old grid (R2 reported R1's O₂).
2. O₂ % was rounded twice (walk, then walk + task) → 16.3 % instead of 16.2 %.

## Known limitation to discuss (Ana)
`slope.f32` stores the slope *magnitude*, so `cellCost` treats every slope as uphill (`G = max(0, 100·tanθ)`):
downhill costs the same as uphill. That's conservative (over-estimates O₂), fine for v1. Say so in the README.
A direction-aware version needs elevation per move, and then costToHome must use reversed edges.
