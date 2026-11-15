# MarsWalk — EVA traverse planner for Jezero Crater (NASA Space Apps 2026)

Global costmap + global planner (same idea as ROS Nav2) for astronauts on foot:
habitat console plans the route, field tablet executes it, and alerts (SPE, dust, suit failure) trigger live replanning.

## Layout
- `pipeline/` — Python: raw NASA data -> contract layers (`mock_site.py` makes a synthetic site)
- `web/` — Vite + JS: `console.html`, `tablet.html`, planner Web Worker
- `web/public/data/<site>/` — data contract files (`mock` or `jezero`)
- `docs/` — notes, figures
- `CONTRACTS.md` — file & code formats. **Change it only after announcing in #general.**

## Quick start
```bash
pip install numpy scipy pillow
python pipeline/mock_site.py      # -> web/public/data/mock/
```
## Model limitations
- Slope is used as an unsigned magnitude, so descending costs the same as
  ascending. This is conservative; a signed-grade model (e.g. a Santee-type
  downhill correction) is future work.
- Pandolf power is scaled by 0.38 for Martian gravity (team assumption).
- Tobler's hiking function was calibrated for unsuited hikers; we use it only
  to slow down on steep slopes.
- Hazard thresholds, task durations and alert multipliers are team assumptions
  (see `params.json` and `alerts.json`).