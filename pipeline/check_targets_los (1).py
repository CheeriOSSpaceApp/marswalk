#!/usr/bin/env python3
"""Línea de vista (viewshed.u8) en cada target de targets.geojson y en los tramos rectos del circuito EVA-1.
Uso: python pipeline/check_targets_los.py   (desde la raíz del repo). Solo lee; no modifica datos."""
import json, math, sys
from pathlib import Path
import numpy as np
sys.path.insert(0, str(Path(__file__).resolve().parent))
from process_viewshed import lonlat_to_cell, grid_geometry, viewshed_r3
site = Path("web/public/data/jezero")
meta = json.loads((site / "meta.json").read_text()); W, H = meta["width"], meta["height"]
vis = np.fromfile(site / "viewshed.u8", np.uint8).reshape(H, W)
z = np.fromfile(site / "elevation.f32", "<f4").reshape(H, W)
dx, dy = grid_geometry(meta)
r0, c0, _, _ = lonlat_to_cell(*meta["habitat"], meta)
fc = json.loads((site / "targets.geojson").read_text())
rows = []
for f in fc["features"]:
    p = f["properties"]; lon, lat = f["geometry"]["coordinates"][:2]
    r, c, _, _ = lonlat_to_cell(lon, lat, meta)
    d = math.hypot((r - r0) * dy, (c - c0) * dx)
    nb = vis[max(r-3,0):r+4, max(c-3,0):c+4]          # vecindario 7x7 (~21 m)
    rows.append({"id": p["id"], "kind": p["kind"], "row": r, "col": c, "dist_m": round(d, 1),
                 "elev_dem_m": round(float(z[r, c]), 2), "los": int(vis[r, c]),
                 "los_7x7_pct": round(100 * float(nb.mean()), 1)})
    print(f'{p["id"]:24s} fila {r:4d} col {c:4d}  {d:6.1f} m  z {z[r,c]:9.2f}  LOS {vis[r,c]}  vecindario {100*nb.mean():5.1f}%')
# circuito EVA-1 en línea recta: hábitat -> centroide depot -> refugio -> Wildcat -> hábitat
pt = {f["properties"]["id"]: f["geometry"]["coordinates"][:2] for f in fc["features"]}
dep = np.mean([v for k, v in pt.items() if k.startswith("depot")], axis=0)
legs = [("habitat", meta["habitat"], "depot_centroid", dep), ("depot_centroid", dep, "shelter", pt["shelter-hawksbill-01"]),
        ("shelter", pt["shelter-hawksbill-01"], "wildcat", pt["sci-wildcat-ridge"]), ("wildcat", pt["sci-wildcat-ridge"], "habitat", meta["habitat"])]
legs_out = []
for a, pa, b, pb in legs:
    n = 400; t = np.linspace(0, 1, n)
    lon = pa[0] + t * (pb[0] - pa[0]); lat = pa[1] + t * (pb[1] - pa[1])
    cs = np.clip(((lon - meta["bbox"][0]) / (meta["bbox"][2] - meta["bbox"][0]) * W).astype(int), 0, W - 1)
    rs = np.clip(((meta["bbox"][3] - lat) / (meta["bbox"][3] - meta["bbox"][1]) * H).astype(int), 0, H - 1)
    v = vis[rs, cs]; L = math.hypot((rs[-1]-rs[0])*dy, (cs[-1]-cs[0])*dx)
    legs_out.append({"leg": f"{a}->{b}", "len_m": round(L, 1), "los_pct": round(100 * float(v.mean()), 1)})
    print(f"tramo {a}->{b}: {L:.0f} m, LOS {100*v.mean():.1f}%")
# sensibilidad del Wildcat a la altura del mástil / traje
wr, wc, _, _ = lonlat_to_cell(*pt["sci-wildcat-ridge"], meta)
sens = []
for ha in (2, 5, 10):
    for ht in (0.0, 1.5):
        v, g = viewshed_r3(z[min(r0,wr)-5:max(r0,wr)+6, min(c0,wc)-5:max(c0,wc)+6],
                           r0-(min(r0,wr)-5), c0-(min(c0,wc)-5), dx, dy, ha, ht)
        val = int(v[wr-(min(r0,wr)-5), wc-(min(c0,wc)-5)]); sens.append({"antenna_m": ha, "suit_m": ht, "wildcat_los": val})
print("Wildcat sensibilidad:", sens)
Path("pipeline/out/targets_los.json").write_text(json.dumps({"targets": rows, "eva1_legs_straight": legs_out, "wildcat_sensitivity": sens}, indent=2, ensure_ascii=False))
