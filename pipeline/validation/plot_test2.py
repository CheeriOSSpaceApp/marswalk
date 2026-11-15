#!/usr/bin/env python3
"""Gráfica 2 (Prueba 2): mapa del segmento real del rover y la ruta calculada, con el corredor de 20 m.
Lee los resultados de compare_rover_route.py; no recalcula métricas."""
import argparse, json, os, sys
import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.colors import ListedColormap, LightSource
from matplotlib.lines import Line2D
from matplotlib.patches import Patch
from shapely.geometry import LineString
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from grid_utils import Grid

ROVER, PLAN, INK, MUTED = "#eb6834", "#2a78d6", "#1f1f1e", "#6b6a64"
ap = argparse.ArgumentParser(); ap.add_argument("--data"); ap.add_argument("--out")
ap.add_argument("--seg", nargs=2, type=int, action="append"); ap.add_argument("--label", default="Ruta Martian Map")
a = ap.parse_args()
g = Grid(os.path.join(a.data, "meta.json"))
elev = g.load(os.path.join(a.data, "elevation.f32"), "<f4"); hz = g.load(os.path.join(a.data, "hazard.u8"), np.uint8)
hs = LightSource(azdeg=315, altdeg=35).hillshade(elev, vert_exag=2, dx=g.dx, dy=g.dy)
tg = json.load(open(os.path.join(a.data, "targets.geojson")))["features"]
ex = json.load(open(os.path.join(a.out, "test2_extras.json")))

fig, axs = plt.subplots(1, len(a.seg), figsize=(7.2 * len(a.seg), 8.6))
axs = np.atleast_1d(axs)
titles = {0: "A. Segmento principal: depot → frente del delta", 1: "B. Segmento de control: llanura"}
for k, (ax, (s0, s1)) in enumerate(zip(axs, a.seg)):
    tag = f"{s0}_{s1}"
    r = json.load(open(os.path.join(a.out, f"test2_results_{tag}.json")))
    gj = json.load(open(os.path.join(a.out, f"test2_geometries_{tag}.geojson")))["features"]
    rv = np.array(gj[0]["geometry"]["coordinates"]); pl = np.array(gj[1]["geometry"]["coordinates"])
    rx, ry = g.to_xy(rv[:, 0], rv[:, 1]); px, py = g.to_xy(pl[:, 0], pl[:, 1])
    xs = np.r_[rx, px]; ys = np.r_[ry, py]; pad = 60
    x0, x1, y0, y1 = xs.min() - pad, xs.max() + pad, ys.min() - pad, ys.max() + pad
    side = max(x1 - x0, y1 - y0); cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    x0, x1, y0, y1 = cx - side / 2, cx + side / 2, cy - side / 2, cy + side / 2
    ext = (0, g.W * g.dx, g.H * g.dy, 0)
    ax.imshow(hs, cmap="gray", extent=ext, vmin=0, vmax=1, interpolation="bilinear")
    ov = np.ma.masked_where(hz == 0, hz)
    ax.imshow(ov, cmap=ListedColormap(["#eda100", "#d7263d"]), vmin=1, vmax=2, alpha=0.38, extent=ext, interpolation="nearest")
    buf = LineString(np.c_[px, py]).buffer(r["threshold_m"])
    bx, by = buf.exterior.xy
    ax.fill(bx, by, color=PLAN, alpha=0.16, lw=0)
    ax.plot(bx, by, color=PLAN, lw=0.6, alpha=0.6)
    ax.plot(px, py, color=PLAN, lw=2.4, solid_capstyle="round")
    ax.plot(rx, ry, color="white", lw=4.2); ax.plot(rx, ry, color=ROVER, lw=2.4, solid_capstyle="round")
    ax.scatter([rx[0]], [ry[0]], s=90, c="white", edgecolors=INK, lw=1.6, zorder=5)
    ax.scatter([rx[-1]], [ry[-1]], s=110, marker="s", c=INK, edgecolors="white", lw=1.2, zorder=5)
    ax.annotate(f"Inicio\n(fin sol {s0})", (rx[0], ry[0]), xytext=(-62, 4), textcoords="offset points", fontsize=8.5, color=INK,
                bbox=dict(fc="white", ec="none", alpha=.8, pad=1.5))
    ax.annotate(f"Destino\n(fin sol {s1})", (rx[-1], ry[-1]), xytext=(8, 6), textcoords="offset points", fontsize=8.5, color=INK,
                bbox=dict(fc="white", ec="none", alpha=.8, pad=1.5))
    for f in tg:
        tx, ty = g.to_xy(*f["geometry"]["coordinates"])
        if x0 < tx < x1 and y0 < ty < y1 and (f["properties"]["kind"] != "depot" or f["properties"]["id"].endswith("dz13")):
            nm = {"depot": "Depot (DZ)", "science": "Wildcat Ridge", "shelter": "Punto seguro", "habitat": "Hábitat"}[f["properties"]["kind"]]
            ax.scatter([tx], [ty], marker="^", s=55, c="white", edgecolors=INK, lw=1, zorder=4)
            ax.annotate(nm, (tx, ty), xytext=(6, -12), textcoords="offset points", fontsize=8, color=MUTED, style="italic")
    # escala
    sb = 100 if side > 300 else 50
    bx0, by0 = x0 + side * 0.05, y1 - side * 0.05
    ax.plot([bx0, bx0 + sb], [by0, by0], color=INK, lw=3); ax.text(bx0 + sb / 2, by0 - side * 0.015, f"{sb} m", ha="center", fontsize=8.5, color=INK)
    ax.set_xlim(x0, x1); ax.set_ylim(y1, y0); ax.set_xticks([]); ax.set_yticks([])
    c = r["cost"]; e = ex[tag]
    txt = (f"Longitud a ≤20 m de la otra: rover {r['rover_vs_planner']['pct']:.1f} % · ruta {r['planner_vs_rover']['pct']:.1f} %\n"
           f"Longitud: rover {r['length_m']['rover']:.0f} m · ruta {r['length_m']['planner']:.0f} m\n"
           f"Costo (min O₂ eq.): rover {c['rover']['cost_line_min']:.1f} · ruta {c['planner']['cost_line_min']:.1f} → razón ruta/rover {r['cost_ratio']['value']:.2f}")
    ax.set_xlabel(txt, loc="left", fontsize=9.5, color=INK, linespacing=1.35, labelpad=8)
    ax.set_title(titles.get(k, tag), loc="left", fontsize=11, color=INK)
handles = [Line2D([], [], color=ROVER, lw=2.4, label="Recorrido real de Perseverance"),
           Line2D([], [], color=PLAN, lw=2.4, label=a.label),
           Patch(color=PLAN, alpha=.2, label="Corredor de 20 m alrededor de la ruta"),
           Patch(color="#eda100", alpha=.45, label="Hazard: precaución"), Patch(color="#d7263d", alpha=.45, label="Hazard: prohibido")]
fig.legend(handles=handles, loc="upper left", ncol=5, frameon=False, fontsize=9, bbox_to_anchor=(0.005, 0.955))
fig.suptitle("Prueba 2 — Ruta calculada vs. recorrido real entre dos posiciones reales del rover", x=0.01, ha="left",
             fontsize=13, weight="bold", color=INK)
fig.text(0.01, 0.008, "Fuente: recorrido M20 (NASA/JPL MMGIS); DTM, hazard y cost.js de Martian Map (grid 3 m). Fondo: sombreado de elevation.f32. "
         "Costo = cellCost × metros recorridos (mismo modelo para ambas). Norte arriba.", fontsize=7.8, color=MUTED)
fig.subplots_adjust(left=0.01, right=0.99, top=0.86, bottom=0.13, wspace=0.04)
fig.savefig(os.path.join(a.out, "validation_test2_route_map.png"), dpi=170)
print("ok")
