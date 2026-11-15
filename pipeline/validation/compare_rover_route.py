#!/usr/bin/env python3
"""Bloque 4 / Prueba 2 (Marco): ruta del planner de Martian Map vs. segmento real de Perseverance.

Waypoints = posiciones REALES de fin de manejo del rover (último vértice del LineString del sol
indicado en rover_traverse.geojson). El segmento del rover es la concatenación exacta de los sols
intermedios: no hay proyección ni vértices inventados y los extremos coinciden por construcción.

La ruta del planner NO se genera aquí: se lee de la salida de plan() de Eric (GeoJSON LineString),
producida con run_planner.mjs entre los mismos waypoints. Este script no sustituye al planner.

Métricas espaciales (métrica local en metros, ver grid_utils):
  - pct_rover_within_20m = longitud del rover a <= 20 m de la ruta del planner / longitud del rover
  - pct_route_within_20m = inversa
  Se densifica cada polilínea a 0.5 m y cada muestra pesa la longitud que representa (no se cuentan
  vértices). Distancia punto-polilínea exacta (shapely).

Costo (mismo modelo para las dos geometrías):
  - cellCost de cost.js ejecutado tal cual en Node (eval_cost.mjs), minutos de O2 por metro.
  - Regla del planner (Plan de ejecución): grid 8-conectado, costo de mover = promedio del costo de
    las dos celdas × distancia (cell_m o √2·cell_m). Ambas geometrías se convierten a cadenas de
    celdas 8-conectadas y se les aplica esa misma suma  -> cost_grid  (verificación: reproduce el
    costo interno del planner).
  - MÉTRICA PRINCIPAL: integral continua Σ cellCost(celda) × metros recorridos en la celda -> cost_line.
    Se prefiere porque la cadena 8-conectada alarga una línea oblicua (efecto escalera) y eso penaliza
    más al rover, cuya geometría no sigue el grid. Para la ruta del planner ambas coinciden.
  - Si una celda tiene costo Infinity, el costo de esa geometría es Infinity y la razón se reporta
    como NO COMPARABLE (nunca se sustituye por 0).
"""
import argparse, json, math, os, subprocess, sys, tempfile

import numpy as np
from shapely.geometry import LineString, Point

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from grid_utils import Grid, load_traverse, cells_with_length, densify_xy  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))


def rover_segment(parts, grid, from_sol_end, to_sol_end):
    sols = [p["props"].get("sol") for p in parts]
    i0, i1 = sols.index(from_sol_end), sols.index(to_sol_end)
    if i1 <= i0:
        raise SystemExit("to_sol_end debe ser posterior a from_sol_end")
    seg = parts[i0 + 1: i1 + 1]
    xs, ys = [], []
    for k, p in enumerate(seg):
        x, y = grid.to_xy(p["coords"][:, 0], p["coords"][:, 1])
        if xs:
            gap = math.hypot(x[0] - xs[-1], y[0] - ys[-1])
            if gap > 1.0:
                raise SystemExit(f"El segmento cruza una discontinuidad de {gap:.1f} m (sol {p['props'].get('sol')}): elegir otro")
            x, y = x[1:], y[1:]
        xs.extend(x); ys.extend(y)
    start = parts[i0]["coords"][-1][:2]; end = parts[i1]["coords"][-1][:2]
    return np.array(xs), np.array(ys), start, end, [p["props"].get("sol") for p in seg]


def within_pct(ax, ay, bline, thr, step=0.5):
    """% de la LONGITUD de A a <= thr m de la polilínea B (ponderado por longitud)."""
    px, py = densify_xy(ax, ay, step)
    d = np.array([bline.distance(Point(x, y)) for x, y in zip(px, py)])
    seg = np.hypot(np.diff(px), np.diff(py))
    dm = 0.5 * (d[:-1] + d[1:])            # distancia en el punto medio de cada sub-tramo (aprox. trapecio)
    inside = np.where((d[:-1] <= thr) & (d[1:] <= thr), seg,
                      np.where((d[:-1] > thr) & (d[1:] > thr), 0.0,
                               seg * np.clip(np.abs(thr - np.minimum(d[:-1], d[1:])) /
                                             np.maximum(np.abs(d[1:] - d[:-1]), 1e-12), 0, 1)))
    w = seg
    return {"pct": float(inside.sum() / seg.sum() * 100), "length_m": float(seg.sum()),
            "mean_m": float(np.average(dm, weights=w)), "median_m": float(np.median(d)),
            "p90_m": float(np.percentile(d, 90)), "max_m": float(d.max())}


def to_8chain(x, y, grid):
    """Cadena de celdas 8-conectada que sigue la polilínea (supercobertura, quitando las celdas de
    esquina cuando el paso diagonal es posible)."""
    px, py = densify_xy(x, y, 0.05)
    r, c = grid.xy_to_rc(px, py)
    chain = [(int(r[0]), int(c[0]))]
    for rr, cc in zip(r[1:], c[1:]):
        if (rr, cc) != chain[-1]:
            chain.append((int(rr), int(cc)))
    out = [chain[0]]
    i = 1
    while i < len(chain):
        a = out[-1]
        if i + 1 < len(chain):
            b = chain[i + 1]
            if abs(b[0] - a[0]) == 1 and abs(b[1] - a[1]) == 1:  # esquina: saltarla
                out.append(b); i += 2; continue
        out.append(chain[i]); i += 1
    for a, b in zip(out[:-1], out[1:]):
        assert max(abs(a[0] - b[0]), abs(a[1] - b[1])) == 1, (a, b)
    return out


def eval_cells(cells, args):
    with tempfile.TemporaryDirectory() as td:
        ci, co = os.path.join(td, "c.json"), os.path.join(td, "o.json")
        json.dump([list(c) for c in cells], open(ci, "w"))
        subprocess.run(["node", os.path.join(HERE, "eval_cost.mjs"), args.cost_js, args.data, ci, co], check=True)
        v = json.load(open(co))
    return {c: (math.inf if x is None else x) for c, x in zip(cells, v)}


def grid_cost(chain, cc, cell_m):
    tot = 0.0
    for a, b in zip(chain[:-1], chain[1:]):
        d = cell_m * (math.sqrt(2) if a[0] != b[0] and a[1] != b[1] else 1.0)
        tot += 0.5 * (cc[a] + cc[b]) * d
    return tot


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True)
    ap.add_argument("--cost-js", required=True)
    ap.add_argument("--planner-route", required=True, help="GeoJSON de plan() de Eric (path LineString)")
    ap.add_argument("--from-sol-end", type=int, required=True)
    ap.add_argument("--to-sol-end", type=int, required=True)
    ap.add_argument("--threshold-m", type=float, default=20.0)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    grid = Grid(os.path.join(a.data, "meta.json"))
    _, parts = load_traverse(os.path.join(a.data, "rover_traverse.geojson"))
    rx, ry, start, end, sols = rover_segment(parts, grid, a.from_sol_end, a.to_sol_end)

    g = json.load(open(a.planner_route))
    geom = g["path"] if "path" in g else (g["features"][0]["geometry"] if "features" in g else g.get("geometry", g))
    if geom.get("type") == "Feature":  # plan() de Eric devuelve path = Feature
        geom = geom["geometry"]
    pc = np.asarray(geom["coordinates"], float)
    px, py = grid.to_xy(pc[:, 0], pc[:, 1])
    sx, sy = grid.to_xy(*start[:2]); ex, ey = grid.to_xy(*end[:2])
    endpoint_err = {"start_m": float(math.hypot(px[0] - sx, py[0] - sy)), "end_m": float(math.hypot(px[-1] - ex, py[-1] - ey))}

    rline, pline = LineString(np.c_[rx, ry]), LineString(np.c_[px, py])
    res = {"waypoints": {"start": {"lon": start[0], "lat": start[1], "source": f"fin del manejo del sol {a.from_sol_end}"},
                         "end": {"lon": end[0], "lat": end[1], "source": f"fin del manejo del sol {a.to_sol_end}"}},
           "rover_sols": sols, "planner_endpoint_offset_m": endpoint_err,
           "length_m": {"rover": rline.length, "planner": pline.length, "straight": math.hypot(ex - sx, ey - sy)},
           "rover_vs_planner": within_pct(rx, ry, pline, a.threshold_m),
           "planner_vs_rover": within_pct(px, py, rline, a.threshold_m),
           "hausdorff_m": rline.hausdorff_distance(pline), "threshold_m": a.threshold_m}

    rchain, pchain = to_8chain(rx, ry, grid), to_8chain(px, py, grid)
    rcl, pcl = cells_with_length(rx, ry, grid), cells_with_length(px, py, grid)
    allc = sorted(set(rchain) | set(pchain) | set(rcl) | set(pcl))
    cc = eval_cells(allc, a)
    cell_m = grid.meta["cell_m"]
    out = {}
    for name, chain, cl in (("planner", pchain, pcl), ("rover", rchain, rcl)):
        inf = [c for c in chain if math.isinf(cc[c])]
        out[name] = {"cost_grid_min": grid_cost(chain, cc, cell_m), "cost_line_min": sum(cc[k] * L for k, L in cl.items()),
                     "chain_cells": len(chain), "chain_length_m": sum(cell_m * (math.sqrt(2) if a_[0] != b[0] and a_[1] != b[1] else 1)
                                                                       for a_, b in zip(chain[:-1], chain[1:])),
                     "infinite_cells": inf}
    res["cost"] = out
    cr, cp = out["rover"]["cost_grid_min"], out["planner"]["cost_grid_min"]
    ok = math.isfinite(cr) and math.isfinite(cp) and cr > 0 and cp > 0
    res["cost_ratio"] = {"definition": "cost_planner / cost_rover; numerador = ruta calculada, denominador = rover",
                         "value": (out["planner"]["cost_line_min"] / out["rover"]["cost_line_min"]) if ok else None,
                         "value_grid_rule": cp / cr if ok else None, "comparable": ok}
    tag = f"{a.from_sol_end}_{a.to_sol_end}"
    res["planner_engine"] = g.get("engine", "planner.js (Eric)")
    res["planner_stats"] = g.get("stats")
    json.dump(res, open(os.path.join(a.out, f"test2_results_{tag}.json"), "w"), indent=2, default=float)
    json.dump({"type": "FeatureCollection", "features": [
        {"type": "Feature", "properties": {"name": "rover_segment", "sols": sols},
         "geometry": {"type": "LineString", "coordinates": [[float(u), float(v)] for u, v in zip(*grid.to_lonlat(rx, ry))]}},
        {"type": "Feature", "properties": {"name": "planner_route"},
         "geometry": {"type": "LineString", "coordinates": pc[:, :2].tolist()}}]},
        open(os.path.join(a.out, f"test2_geometries_{tag}.geojson"), "w"))
    print(json.dumps({k: v for k, v in res.items() if k not in ("planner_stats",)}, indent=1, default=float))


if __name__ == "__main__":
    main()
