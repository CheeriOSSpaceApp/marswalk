#!/usr/bin/env python3
"""Gráfica 1 (Prueba 1): pendiente y hazard, recorrido de Perseverance vs. todo el AOI.
Lee solo los resultados de validate_traverse_distribution.py (no recalcula nada)."""
import argparse, json, os
import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

ROVER, AOI = "#eb6834", "#2a78d6"   # paleta categórica validada (slots 2 y 1)
INK, MUTED, GRID = "#1f1f1e", "#6b6a64", "#e4e3dd"

ap = argparse.ArgumentParser()
ap.add_argument("--data", required=True); ap.add_argument("--out", required=True)
a = ap.parse_args()
r = json.load(open(os.path.join(a.out, "test1_results.json")))["test1"]
s_tr = np.load(os.path.join(a.out, "test1_traverse_slopes.npy"))
null = np.load(os.path.join(a.out, "test1_null.npy"))
s_aoi = np.fromfile(os.path.join(a.data, "slope.f32"), "<f4")

plt.rcParams.update({"font.size": 10, "axes.edgecolor": MUTED, "axes.labelcolor": INK,
                     "xtick.color": MUTED, "ytick.color": MUTED, "font.family": "DejaVu Sans"})
fig, ax = plt.subplots(1, 3, figsize=(15, 5.0), gridspec_kw={"width_ratios": [1.3, 1, 1.1]})

# A: distribución de pendiente
bins = np.arange(0, 30.5, 0.5)
for v, c, lab, n in ((s_aoi, AOI, "Todo el AOI", r["slope"]["aoi"]["n"]),
                     (s_tr, ROVER, "Celdas recorridas por Perseverance", r["slope"]["traverse"]["n"])):
    h, e = np.histogram(v, bins=bins); h = h / v.size * 100  # % del total (las celdas >30° quedan fuera del eje)
    ax[0].step(e[:-1], h, where="post", color=c, lw=2, label=f"{lab} (n = {n:,})")
    med = np.median(v)
    ax[0].axvline(med, color=c, lw=1.2, ls="--")
ax[0].axvspan(10, 15, color="#f3e3b0", alpha=.45, lw=0); ax[0].axvspan(15, 30, color="#f2c4bd", alpha=.45, lw=0)
ax[0].text(12.5, ax[0].get_ylim()[1]*0.93, "precaución\n10–15°", ha="center", va="top", fontsize=8.5, color=MUTED)
ax[0].text(22, ax[0].get_ylim()[1]*0.93, "prohibido ≥15°\n(límite del traje)", ha="center", va="top", fontsize=8.5, color=MUTED)
sm = r["slope"]
ax[0].text(0.98, 0.62, f"Mediana: rover {sm['traverse']['median']:.1f}° · AOI {sm['aoi']['median']:.1f}°\n"
           f"Media: rover {sm['traverse']['mean']:.1f}° · AOI {sm['aoi']['mean']:.1f}°\n"
           f"P90: rover {sm['traverse']['p90']:.1f}° · AOI {sm['aoi']['p90']:.1f}°",
           transform=ax[0].transAxes, ha="right", va="top", fontsize=8.5, color=INK)
ax[0].set_xlim(0, 30); ax[0].set_xlabel("Pendiente (grados, slope.f32)"); ax[0].set_ylabel("% de celdas")
ax[0].set_title("A. Distribución de pendiente (líneas punteadas = mediana)", loc="left", fontsize=10.5, color=INK)
ax[0].legend(frameon=False, fontsize=8.5, loc="upper right", bbox_to_anchor=(1, 0.80), borderaxespad=0)

# B: hazard
cats = ["Libre (0)", "Precaución (1)", "Prohibido (2)"]
pr = [r["hazard"]["traverse"][str(k)]["pct"] for k in range(3)]
pa = [r["hazard"]["aoi"][str(k)]["pct"] for k in range(3)]
x = np.arange(3); w = 0.36
b1 = ax[1].bar(x - w/2 - .01, pa, w, color=AOI, label="Todo el AOI")
b2 = ax[1].bar(x + w/2 + .01, pr, w, color=ROVER, label="Recorrido Perseverance")
for bars in (b1, b2):
    for b in bars:
        ax[1].text(b.get_x() + b.get_width()/2, b.get_height() + 1.2, f"{b.get_height():.1f}%", ha="center", fontsize=8.5, color=INK)
ax[1].set_xticks(x, cats); ax[1].set_ylim(0, 105); ax[1].set_ylabel("% de celdas")
ax[1].set_title("B. Clases de hazard.u8", loc="left", fontsize=10.5, color=INK)
ax[1].legend(frameon=False, fontsize=8.5)

# C: modelo nulo
nm = r["null_model"]
ax[2].hist(null[:, 0], bins=40, color="#b7d3f6", edgecolor="white", lw=.5, label=f"{nm['n']} recorridos simulados\n(misma forma, desplazada y rotada)")
ax[2].axvline(sm["traverse"]["mean"], color=ROVER, lw=2.2, label=f"Recorrido real: {sm['traverse']['mean']:.2f}°")
ax[2].axvline(sm["aoi"]["mean"], color=AOI, lw=1.4, ls="--", label=f"Media del AOI: {sm['aoi']['mean']:.2f}°")
ax[2].set_xlabel("Pendiente media de las celdas recorridas (°)"); ax[2].set_ylabel("Nº de simulaciones")
ax[2].set_title("C. ¿Es casualidad? Modelo nulo espacial", loc="left", fontsize=10.5, color=INK)
ax[2].text(0.98, 0.50, f"{nm['mean_slope']['frac_null_le_obs']*100:.0f}% de los simulados\ntienen pendiente media ≤ real\n"
           f"{nm['pct_forbidden']['frac_null_le_obs']*100:.1f}% tienen ≤ % prohibido real",
           transform=ax[2].transAxes, ha="right", fontsize=8.5, color=INK)
ax[2].legend(frameon=False, fontsize=8, loc="upper right")

for x_ in ax:
    x_.grid(axis="y", color=GRID, lw=.8); x_.set_axisbelow(True)
    for sp in ("top", "right"): x_.spines[sp].set_visible(False)
fig.suptitle("Prueba 1 — Perseverance cruzó terreno más suave que el promedio del AOI;\n"
             "la diferencia es moderada al compararla con recorridos de la misma forma colocados al azar", x=0.01, ha="left", fontsize=12.5, color=INK, weight="bold")
fig.text(0.01, 0.005, "Fuente: recorrido M20 (NASA/JPL MMGIS, sols 401–753, recortado al AOI de Jezero); slope.f32 y hazard.u8 de Martian Map "
         "(grid 1000×1000, 3 m). \nCeldas únicas atravesadas; eje A truncado en 30° (el AOI llega a 66°). Hazard usa umbrales para humano con traje, no para el rover.",
         fontsize=7.8, color=MUTED)
fig.tight_layout(rect=(0, 0.05, 1, 0.93))
fig.savefig(os.path.join(a.out, "validation_test1_slope_hazard.png"), dpi=170)
print("ok")
