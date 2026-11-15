#!/usr/bin/env python3
"""Bloque 4 / Prueba 1 (Marco): pendiente y hazard del recorrido real de Perseverance vs. todo el AOI.

Uso (desde la raíz del repo):
  python pipeline/validate_traverse_distribution.py --data web/public/data/jezero --out docs/validation

Representación del recorrido: CELDAS ÚNICAS atravesadas (supercobertura exacta: se calcula cada cruce
del segmento con los bordes de celda, así no se omite ninguna celda intermedia ni se cuenta dos veces
una celda por tener varios vértices). Como sensibilidad se reporta también la versión ponderada por
longitud recorrida dentro de cada celda.

Modelo nulo (para no depender de p-valores inflados por autocorrelación espacial): se desplaza y
rota rígidamente la geometría completa del recorrido a posiciones aleatorias dentro del AOI y se
recalculan las mismas métricas. Semilla fija → reproducible.
"""
import argparse
import json
import math
import os
import sys

import numpy as np
from scipy import stats

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from grid_utils import Grid, load_traverse, cells_with_length  # noqa: E402

HZ_NAMES = {0: "Libre (0)", 1: "Precaución (1)", 2: "Prohibido (2)"}


def describe(v):
    v = np.asarray(v, float)
    return {"n": int(v.size), "mean": float(v.mean()), "median": float(np.median(v)),
            "std": float(v.std(ddof=1)), "min": float(v.min()), "max": float(v.max()),
            "p25": float(np.percentile(v, 25)), "p75": float(np.percentile(v, 75)),
            "p90": float(np.percentile(v, 90)), "p95": float(np.percentile(v, 95)),
            "pct_ge10": float((v >= 10).mean() * 100), "pct_ge15": float((v >= 15).mean() * 100)}


def hz_props(h, w=None):
    h = np.asarray(h); w = np.ones(h.size) if w is None else np.asarray(w, float)
    tot = w.sum()
    return {int(k): {"count": int((h == k).sum()), "pct": float(w[h == k].sum() / tot * 100)} for k in (0, 1, 2)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--n-null", type=int, default=1000)
    ap.add_argument("--seed", type=int, default=20261115)
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    P = lambda f: os.path.join(a.data, f)

    grid = Grid(P("meta.json"))
    slope = grid.load(P("slope.f32"), "<f4")
    hazard = grid.load(P("hazard.u8"), np.uint8)
    rep = {"inspection": {}, "test1": {}}

    # ---------- Inspección ----------
    ins = rep["inspection"]
    ins["grid"] = {"width": grid.W, "height": grid.H, "dx_m": grid.dx, "dy_m": grid.dy,
                   "bbox": [grid.lon0, grid.lat0, grid.lon1, grid.lat1]}
    ins["slope"] = {"nan": int(np.isnan(slope).sum()), "inf": int(np.isinf(slope).sum()),
                    "min": float(np.nanmin(slope)), "max": float(np.nanmax(slope))}
    ins["hazard_values"] = {int(k): int(n) for k, n in zip(*np.unique(hazard, return_counts=True))}
    # coherencia hazard vs umbrales de pendiente de params.json
    prm = json.load(open(P("params.json")))
    sf, sc = prm["slope_forbidden_deg"], prm["slope_caution_deg"]
    ins["hazard_vs_slope"] = {
        "slope_ge_forbidden_and_hazard_lt2": int(((slope >= sf) & (hazard < 2)).sum()),
        "slope_ge_caution_and_hazard0": int(((slope >= sc) & (hazard == 0)).sum()),
        "hazard2_with_slope_lt_forbidden (rugosidad)": int(((hazard == 2) & (slope < sf)).sum()),
        "hazard1_with_slope_lt_caution (rugosidad)": int(((hazard == 1) & (slope < sc)).sum())}

    gj, parts = load_traverse(P("rover_traverse.geojson"))
    allc = np.vstack([p["coords"] for p in parts])
    inside = ((allc[:, 0] >= grid.lon0) & (allc[:, 0] <= grid.lon1) &
              (allc[:, 1] >= grid.lat0) & (allc[:, 1] <= grid.lat1))
    xy = [grid.to_xy(p["coords"][:, 0], p["coords"][:, 1]) for p in parts]
    seglen = [float(np.hypot(np.diff(x), np.diff(y)).sum()) for x, y in xy]
    gaps = []
    for i in range(len(parts) - 1):
        (x0, y0), (x1, y1) = xy[i], xy[i + 1]
        d = math.hypot(x1[0] - x0[-1], y1[0] - y0[-1])
        if d > 1.0:
            gaps.append({"after_sol": parts[i]["props"].get("sol"), "before_sol": parts[i+1]["props"].get("sol"), "gap_m": round(d, 2)})
    ins["traverse"] = {"features": len(parts), "vertices": int(len(allc)),
                       "vertices_outside_bbox": int((~inside).sum()), "length_m": round(sum(seglen), 2),
                       "sols": [parts[0]["props"].get("sol"), parts[-1]["props"].get("sol")],
                       "discontinuities_gt_1m": gaps, "pieces": len(gaps) + 1,
                       "nan": int(np.isnan(allc[:, :2]).sum())}
    if (~inside).sum() > 0:
        raise SystemExit("El recorrido tiene vértices fuera del AOI: revisar recorte")

    # ---------- Celdas atravesadas ----------
    cell_len = {}
    cell_sols = {}
    for p, (x, y) in zip(parts, xy):
        for k, L in cells_with_length(x, y, grid).items():
            cell_len[k] = cell_len.get(k, 0.0) + L
            cell_sols.setdefault(k, set()).add(p["props"].get("sol"))
    keys = np.array(list(cell_len.keys()))
    rr, cc = keys[:, 0], keys[:, 1]
    lens = np.array([cell_len[tuple(k)] for k in keys])
    s_tr = slope[rr, cc]; h_tr = hazard[rr, cc]
    valid = np.isfinite(s_tr)
    t1 = rep["test1"]
    t1["method"] = "celdas únicas atravesadas (supercobertura exacta); sensibilidad: ponderado por longitud"
    t1["n_cells_traverse"] = int(valid.sum())
    t1["length_covered_m"] = float(lens.sum())
    s_aoi = slope[np.isfinite(slope)]
    t1["slope"] = {"traverse": describe(s_tr[valid]), "aoi": describe(s_aoi)}
    # ponderado por longitud
    w = lens[valid]
    order = np.argsort(s_tr[valid]); cw = np.cumsum(w[order]) / w.sum()
    t1["slope"]["traverse_length_weighted"] = {
        "mean": float(np.average(s_tr[valid], weights=w)),
        "median": float(s_tr[valid][order][np.searchsorted(cw, 0.5)])}
    t1["hazard"] = {"traverse": hz_props(h_tr[valid]), "aoi": hz_props(hazard.ravel()),
                    "traverse_length_weighted": hz_props(h_tr[valid], w)}

    # pruebas descriptivas (n inflado por autocorrelación -> informativas)
    mw = stats.mannwhitneyu(s_tr[valid], s_aoi, alternative="less")
    obs = np.array([[(h_tr == k).sum() for k in (0, 1, 2)]])
    exp_p = np.array([(hazard == k).mean() for k in (0, 1, 2)])
    chi = stats.chisquare(obs[0], exp_p * obs.sum())
    # Cliff's delta (tamaño de efecto) con una muestra del AOI
    rng = np.random.default_rng(a.seed)
    samp = rng.choice(s_aoi, 200_000, replace=False)
    u = stats.mannwhitneyu(s_tr[valid], samp).statistic
    cliffs = 2 * u / (valid.sum() * samp.size) - 1
    t1["tests"] = {"mann_whitney_less_p": float(mw.pvalue), "chi2_hazard": float(chi.statistic),
                   "chi2_p": float(chi.pvalue), "cliffs_delta": float(cliffs),
                   "note": "Celdas vecinas no son independientes: los p-valores sobrestiman la significancia. Usar el modelo nulo."}

    # celdas prohibidas en el recorrido
    fb = [(int(r), int(c)) for r, c, h in zip(rr, cc, h_tr) if h == 2]
    t1["forbidden_cells"] = [{"row": r, "col": c, "slope_deg": round(float(slope[r, c]), 2),
                              "cause": "pendiente>=15" if slope[r, c] >= sf else "rugosidad (pendiente<15)",
                              "length_m": round(cell_len[(r, c)], 2), "sols": sorted(cell_sols[(r, c)])} for r, c in fb]

    # ---------- Modelo nulo: recorrido desplazado/rotado ----------
    X = np.concatenate([x for x, _ in xy]); Y = np.concatenate([y for _, y in xy])
    cx, cy = X.mean(), Y.mean()
    Wm, Hm = grid.W * grid.dx, grid.H * grid.dy
    null = []
    tries = 0
    while len(null) < a.n_null and tries < a.n_null * 200:
        tries += 1
        th = rng.uniform(0, 2 * np.pi); ct, st = math.cos(th), math.sin(th)
        tx, ty = rng.uniform(0, Wm), rng.uniform(0, Hm)
        ok = True; cl = {}
        new = []
        for x, y in xy:
            nx = ct * (x - cx) - st * (y - cy) + tx; ny = st * (x - cx) + ct * (y - cy) + ty
            if nx.min() < 0 or ny.min() < 0 or nx.max() >= Wm or ny.max() >= Hm:
                ok = False; break
            new.append((nx, ny))
        if not ok:
            continue
        for nx, ny in new:
            for k, L in cells_with_length(nx, ny, grid).items():
                cl[k] = 1
        kk = np.array(list(cl.keys()))
        sv = slope[kk[:, 0], kk[:, 1]]; hv = hazard[kk[:, 0], kk[:, 1]]
        null.append((sv.mean(), np.median(sv), (hv == 0).mean() * 100, (hv == 2).mean() * 100))
    null = np.array(null)
    o = (t1["slope"]["traverse"]["mean"], t1["slope"]["traverse"]["median"],
         t1["hazard"]["traverse"][0]["pct"], t1["hazard"]["traverse"][2]["pct"])
    t1["null_model"] = {
        "n": int(len(null)), "attempts": tries,
        "mean_slope": {"null_mean": float(null[:, 0].mean()), "null_p2_5": float(np.percentile(null[:, 0], 2.5)),
                       "null_p97_5": float(np.percentile(null[:, 0], 97.5)), "frac_null_le_obs": float((null[:, 0] <= o[0]).mean())},
        "median_slope": {"null_mean": float(null[:, 1].mean()), "frac_null_le_obs": float((null[:, 1] <= o[1]).mean())},
        "pct_free": {"null_mean": float(null[:, 2].mean()), "null_p2_5": float(np.percentile(null[:, 2], 2.5)),
                     "null_p97_5": float(np.percentile(null[:, 2], 97.5)), "frac_null_ge_obs": float((null[:, 2] >= o[2]).mean())},
        "pct_forbidden": {"null_mean": float(null[:, 3].mean()), "frac_null_le_obs": float((null[:, 3] <= o[3]).mean())}}
    np.save(os.path.join(a.out, "test1_null.npy"), null)

    json.dump(rep, open(os.path.join(a.out, "test1_results.json"), "w"), indent=2, ensure_ascii=False)
    np.save(os.path.join(a.out, "test1_traverse_slopes.npy"), s_tr[valid])
    print(json.dumps(rep, indent=1, ensure_ascii=False)[:6000])


if __name__ == "__main__":
    main()
