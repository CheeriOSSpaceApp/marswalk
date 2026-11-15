#!/usr/bin/env python3
"""Ruta de REFERENCIA (no es el planner de Eric): camino de costo mínimo exacto bajo la regla del
contrato del planner (Plan de ejecución):
  grid 8-conectado; costo de mover a->b = 0.5·(cellCost[a] + cellCost[b]) × (cell_m o √2·cell_m);
  celdas con cellCost = Infinity no se pueden pisar.
cellCost viene de cost_grid.f32, generado ejecutando cost.js real (cost_grid.mjs).
Dijkstra (scipy.sparse.csgraph) devuelve el óptimo exacto: un A* con heurística admisible sobre el mismo
grafo debe dar el MISMO costo (la geometría puede variar solo en empates). Sirve para verificar el
planner de Eric y para tener la Prueba 2 reproducible si el planner no corre fuera del navegador.
Uso: python reference_route.py --data DIR --cost-grid cost_grid.f32 --start LON LAT --goal LON LAT --out route.json
"""
import argparse, json, math, os, sys
import numpy as np
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import dijkstra

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from grid_utils import Grid  # noqa: E402


def build_graph(cost, cell_m):
    H, W = cost.shape
    idx = np.arange(H * W).reshape(H, W)
    fin = np.isfinite(cost)
    rows, cols, ws = [], [], []
    for dr, dc in ((0, 1), (1, 0), (1, 1), (1, -1)):
        r0, r1 = max(0, -dr), H - max(0, dr)
        c0, c1 = max(0, -dc), W - max(0, dc)
        a = idx[r0:r1, c0:c1]; b = idx[r0 + dr:r1 + dr, c0 + dc:c1 + dc]
        ca = cost[r0:r1, c0:c1]; cb = cost[r0 + dr:r1 + dr, c0 + dc:c1 + dc]
        ok = fin[r0:r1, c0:c1] & fin[r0 + dr:r1 + dr, c0 + dc:c1 + dc]
        d = cell_m * (math.sqrt(2) if dr and dc else 1.0)
        w = 0.5 * (ca + cb) * d
        for s, t in ((a, b), (b, a)):
            rows.append(s[ok]); cols.append(t[ok]); ws.append(w[ok])
    return coo_matrix((np.concatenate(ws).astype(np.float64), (np.concatenate(rows), np.concatenate(cols))),
                      shape=(H * W, H * W)).tocsr()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True); ap.add_argument("--cost-grid", required=True)
    ap.add_argument("--start", nargs=2, type=float, required=True); ap.add_argument("--goal", nargs=2, type=float, required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    g = Grid(os.path.join(a.data, "meta.json"))
    cost = np.fromfile(a.cost_grid, "<f4").astype(np.float64).reshape(g.H, g.W)
    slope = g.load(os.path.join(a.data, "slope.f32"), "<f4")
    hazard = g.load(os.path.join(a.data, "hazard.u8"), np.uint8)
    vs = g.load(os.path.join(a.data, "viewshed.u8"), np.uint8)
    rc = [tuple(int(v) for v in g.xy_to_rc(*g.to_xy(*p))) for p in (a.start, a.goal)]
    for (r, c), n in zip(rc, ("start", "goal")):
        if not np.isfinite(cost[r, c]):
            raise SystemExit(f"{n} cae en una celda prohibida ({r},{c})")
    G = build_graph(cost, g.meta["cell_m"])
    s, t = rc[0][0] * g.W + rc[0][1], rc[1][0] * g.W + rc[1][1]
    dist, pred = dijkstra(G, indices=s, return_predecessors=True)
    if not np.isfinite(dist[t]):
        raise SystemExit("sin camino")
    path = [t]
    while path[-1] != s:
        path.append(pred[path[-1]])
    path = path[::-1]
    rr, cc = np.array(path) // g.W, np.array(path) % g.W
    x, y = g.rc_to_xy(rr, cc); lon, lat = g.to_lonlat(x, y)
    steps = np.hypot(np.diff(x), np.diff(y))
    res = {"engine": "REFERENCIA Dijkstra (contrato del planner); NO es planner.js de Eric",
           "path": {"type": "LineString", "coordinates": [[float(o), float(l)] for o, l in zip(lon, lat)]},
           "cells": [[int(r), int(c)] for r, c in zip(rr, cc)],
           "stats": {"cost_min_O2_nominal": float(dist[t]), "distance_m": float(steps.sum()),
                     "max_slope_deg": float(slope[rr, cc].max()), "caution_cells": int((hazard[rr, cc] == 1).sum()),
                     "comms_pct": float(vs[rr, cc].mean() * 100), "n_cells": len(path),
                     "start_cell": rc[0], "goal_cell": rc[1]}}
    json.dump(res, open(a.out, "w"))
    print(json.dumps(res["stats"]))


if __name__ == "__main__":
    main()
