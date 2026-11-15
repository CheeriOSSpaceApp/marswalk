#!/usr/bin/env python3
"""Métricas explicativas de la Prueba 2 (no cambian los resultados principales):
 - corredor de casi-óptimos: % de la longitud del rover que pasa por celdas cuyo mejor camino
   inicio->celda->fin cuesta <= k × óptimo (k = 1.05, 1.10, 1.25, 1.50), con el mismo grafo del contrato.
 - pendiente, hazard y costo por metro a lo largo de cada geometría.
 - sensibilidad del umbral de proximidad (10, 20, 30, 50 m).
Uso: python test2_extras.py --data DIR --cost-grid F --out DIR --seg 433 455 [--seg 538 543]"""
import argparse, json, os, sys
import numpy as np
from scipy.sparse.csgraph import dijkstra
from shapely.geometry import LineString
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from grid_utils import Grid, load_traverse, cells_with_length
from reference_route import build_graph
from compare_rover_route import rover_segment, within_pct

ap = argparse.ArgumentParser(); ap.add_argument("--data"); ap.add_argument("--cost-grid"); ap.add_argument("--out")
ap.add_argument("--seg", nargs=2, type=int, action="append"); a = ap.parse_args()
g = Grid(os.path.join(a.data, "meta.json")); _, parts = load_traverse(os.path.join(a.data, "rover_traverse.geojson"))
cost = np.fromfile(a.cost_grid, "<f4").astype(np.float64).reshape(g.H, g.W)
slope = g.load(os.path.join(a.data, "slope.f32"), "<f4"); hz = g.load(os.path.join(a.data, "hazard.u8"), np.uint8)
rough = g.load(os.path.join(a.data, "roughness.f32"), "<f4")
G = build_graph(cost, g.meta["cell_m"]); out = {}
for s0, s1 in a.seg:
    tag = f"{s0}_{s1}"
    res = json.load(open(os.path.join(a.out, f"test2_results_{tag}.json")))
    route = json.load(open(os.path.join(a.out, f"ref_route_{tag}.json")))
    rx, ry, st, en, _ = rover_segment(parts, g, s0, s1)
    (r0, c0), (r1, c1) = route["stats"]["start_cell"], route["stats"]["goal_cell"]
    D = dijkstra(G, indices=[r0 * g.W + c0, r1 * g.W + c1])
    thru = (D[0] + D[1]).reshape(g.H, g.W); opt = D[0][r1 * g.W + c1]
    rcl = cells_with_length(rx, ry, g); keys = np.array(list(rcl)); L = np.array([rcl[tuple(k)] for k in keys])
    ratio = thru[keys[:, 0], keys[:, 1]] / opt
    corr = {f"k{k}": float(L[ratio <= k].sum() / L.sum() * 100) for k in (1.05, 1.10, 1.25, 1.50)}
    pcells = np.array(route["cells"])
    px, py = g.rc_to_xy(pcells[:, 0], pcells[:, 1]); pl = LineString(np.c_[px, py]); rl = LineString(np.c_[rx, ry])
    def prof(keys, w):
        s = slope[keys[:, 0], keys[:, 1]]; h = hz[keys[:, 0], keys[:, 1]]; c = cost[keys[:, 0], keys[:, 1]]
        return {"slope_mean_lenw": float(np.average(s, weights=w)), "slope_max": float(s.max()),
                "pct_len_slope_ge10": float(w[s >= 10].sum() / w.sum() * 100),
                "pct_len_caution": float(w[h == 1].sum() / w.sum() * 100),
                "rough_mean_lenw": float(np.average(rough[keys[:, 0], keys[:, 1]], weights=w)),
                "cost_per_m_mean": float(np.average(c, weights=w))}
    pcl = cells_with_length(px, py, g); pk = np.array(list(pcl)); pw = np.array([pcl[tuple(k)] for k in pk])
    out[tag] = {"optimal_cost_min": float(opt), "rover_len_in_near_optimal_corridor_pct": corr,
                "profile": {"rover": prof(keys, L), "planner": prof(pk, pw)},
                "threshold_sensitivity_pct_rover_within": {str(t): within_pct(rx, ry, pl, t)["pct"] for t in (10, 20, 30, 50)},
                "threshold_sensitivity_pct_planner_within": {str(t): within_pct(px, py, rl, t)["pct"] for t in (10, 20, 30, 50)}}
    np.save(os.path.join(a.out, f"thru_ratio_{tag}.npy"), (thru / opt).astype(np.float32))
json.dump(out, open(os.path.join(a.out, "test2_extras.json"), "w"), indent=2)
print(json.dumps(out, indent=1))
