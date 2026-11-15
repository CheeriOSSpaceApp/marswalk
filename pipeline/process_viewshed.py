#!/usr/bin/env python3
"""
process_viewshed.py — Martian Map / MarsWalk, Marco, Bloque 3.

Calcula la LÍNEA DE VISTA GEOMÉTRICA (viewshed) entre la antena del hábitat y cada
celda del AOI de Jezero, y la exporta como web/public/data/jezero/viewshed.u8
(Uint8 raw, height x width, fila 0 = norte, columna 0 = oeste; 1 = visible, 0 = no).

IMPORTANTE: es visibilidad geométrica sobre el DEM. NO es un modelo de radio
(no hay potencia, frecuencia, ganancia, difracción, multitrayecto ni zona de Fresnel).
Un 1 significa "no hay terreno entre la antena y el traje", no "conexión garantizada".

Entradas (solo lectura): meta.json, elevation.f32 (Float32 little-endian, metros).
Salidas: viewshed.u8 + pipeline/out/viewshed_report.json + figuras PNG.

Método (ver VIEWSHED_REPORT.md):
  * Algoritmo principal "R3" (Franklin & Ray 1994): para CADA celda objetivo se recorre
    la línea antena->celda y se evalúa el terreno en cada cruce con las líneas de
    centros de fila/columna, interpolando linealmente entre las dos celdas vecinas.
    La celda es visible si su gradiente (dz/d) es estrictamente mayor que el máximo
    gradiente de todos los cruces intermedios. Es exacto respecto al DEM interpolado,
    no deja huecos y no depende de qué rayo "pase" por la celda.
  * Método del plan ("rayos hacia el borde", tipo R2) implementado también, solo como
    verificación cruzada: se reporta su cobertura y su concordancia con R3.
  * Curvatura marciana: z_efectiva = z - d^2 / (2 R) (R = 3,396.19 km, CONTRACTS.md).
    Sin refracción (atmósfera muy tenue; el término se deja como parámetro = 0).

Uso (desde la raíz del repo):
  python pipeline/process_viewshed.py
  python pipeline/process_viewshed.py --antenna-height-m 10 --target-height-m 1.5 --force

Dependencias: numpy (cálculo), matplotlib (solo figuras). Nada más.
"""
import argparse
import json
import math
import sys
import time
from pathlib import Path

import numpy as np

R_MARS_M = 3_396_190.0            # CONTRACTS.md (mismo valor que el bloque 2)
DEG = math.pi / 180.0

# ----------------------------------------------------------------------------- parámetros
# SUPUESTOS DEL EQUIPO (no son datos de NASA). Se pueden cambiar por línea de comandos.
ANTENNA_HEIGHT_M = 5.0     # altura del mástil de la antena del hábitat sobre el terreno
TARGET_HEIGHT_M = 1.5      # altura de la radio del traje (PLSS, a la altura de los hombros)
REFRACTION_K = 0.0         # coeficiente de refracción (0 = sin refracción)


# ----------------------------------------------------------------------------- lectura / validación
def load_meta(path):
    if not path.exists():
        sys.exit(f"ERROR: no existe {path}. Pedirlo a Gabriel; no se inventa un AOI.")
    try:
        meta = json.loads(path.read_text())
    except json.JSONDecodeError as ex:
        sys.exit(f"ERROR: {path} no es JSON válido: {ex}")
    for k in ("bbox", "width", "height", "cell_m", "habitat"):
        if k not in meta:
            sys.exit(f"ERROR: meta.json no tiene '{k}'")
    bb = meta["bbox"]
    if not (len(bb) == 4 and bb[0] < bb[2] and bb[1] < bb[3] and 0 <= bb[0] and bb[2] <= 360):
        sys.exit(f"ERROR: bbox incoherente {bb} (esperado [lonMin, latMin, lonMax, latMax], lon 0-360 E)")
    if not (isinstance(meta["width"], int) and isinstance(meta["height"], int)
            and meta["width"] > 1 and meta["height"] > 1):
        sys.exit("ERROR: width/height deben ser enteros > 1")
    return meta


def load_elevation(path, width, height):
    if not path.exists():
        sys.exit(f"ERROR: no existe {path}. Pedirlo a Gabriel.")
    n_bytes = path.stat().st_size
    expected = width * height * 4
    if n_bytes != expected:
        sys.exit(f"ERROR: {path.name} tiene {n_bytes} bytes; se esperaban {expected} "
                 f"({width}x{height} Float32). No coincide con meta.json.")
    z = np.fromfile(path, dtype="<f4").reshape(height, width)   # fila 0 = norte
    return z


def grid_geometry(meta):
    """Tamaño real de celda en metros a partir del bbox (no se asume que sea cuadrada)."""
    bb, W, H = meta["bbox"], meta["width"], meta["height"]
    latc = 0.5 * (bb[1] + bb[3]) * DEG
    dx = (bb[2] - bb[0]) * DEG * R_MARS_M * math.cos(latc) / W   # m por columna (E-O)
    dy = (bb[3] - bb[1]) * DEG * R_MARS_M / H                    # m por fila (N-S)
    return dx, dy


def lonlat_to_cell(lon, lat, meta):
    """Convención: bbox = BORDES exteriores del raster; celda (r, c) cubre
    lon in [lonMin + c*dlon, lonMin + (c+1)*dlon), lat in (latMax - (r+1)*dlat, latMax - r*dlat].
    Fila 0 = norte (latMax), columna 0 = oeste (lonMin).
    Devuelve (fila, columna) enteras y la posición fraccional (en unidades de celda)."""
    bb, W, H = meta["bbox"], meta["width"], meta["height"]
    cf = (lon - bb[0]) / (bb[2] - bb[0]) * W
    rf = (bb[3] - lat) / (bb[3] - bb[1]) * H
    if not (0 <= cf < W and 0 <= rf < H):
        sys.exit(f"ERROR: el punto ({lon}, {lat}) cae fuera del grid (col {cf:.2f}, fila {rf:.2f}).")
    return int(math.floor(rf)), int(math.floor(cf)), rf, cf


# ----------------------------------------------------------------------------- algoritmo R3
def viewshed_r3(z, r0, c0, dx, dy, antenna_h, target_h, radius_m=R_MARS_M, refraction_k=0.0,
                curvature=True):
    """Viewshed exacto tipo R3, vectorizado con NumPy.

    z          : DEM (H, W) float, metros. NaN = NoData.
    (r0, c0)   : celda de la antena (centro de celda).
    dx, dy     : metros por columna / por fila.
    Devuelve (vis uint8 (H, W), gmax float32 (H, W)) donde gmax es el máximo gradiente de
    horizonte visto antes de cada celda (útil para depurar).

    Para cada celda objetivo (r, c), con dr = r - r0, dc = c - c0:
      cruces de columna k = 1..|dc|-1 : t = k/|dc| -> fila fraccional r0 + t*dr (interp. vertical)
      cruces de fila    k = 1..|dr|-1 : t = k/|dr| -> col. fraccional c0 + t*dc (interp. horizontal)
    En cada cruce: d = t * L, g = (z(cruce) - curv(d) - Zo) / d.
    Visible  <=>  (z_obj + target_h - curv(L) - Zo) / L  >  max(g)   (estricto).
    """
    H, W = z.shape
    zf = z.astype(np.float64)
    nodata = ~np.isfinite(zf)
    if nodata[r0, c0]:
        raise ValueError("La celda de la antena es NoData")
    zo = zf[r0, c0] + antenna_h
    # NoData en celdas intermedias: se reemplaza por el mínimo del DEM (no bloquea).
    # Las celdas NoData como OBJETIVO se marcan 0 (sin dato = sin LOS garantizada).
    zfill = np.where(nodata, np.nanmin(zf), zf)
    curv_k = (1.0 - refraction_k) / (2.0 * radius_m) if curvature else 0.0

    rr, cc = np.mgrid[0:H, 0:W]
    dr_all = (rr - r0).ravel()
    dc_all = (cc - c0).ravel()
    M_all = np.maximum(np.abs(dr_all), np.abs(dc_all))       # anillo de Chebyshev
    order = np.argsort(M_all, kind="stable")
    M_sorted = M_all[order]
    bounds = np.searchsorted(M_sorted, np.arange(M_sorted.max() + 2))

    vis = np.zeros(H * W, dtype=np.uint8)
    gmax_out = np.full(H * W, -np.inf, dtype=np.float32)
    BATCH = 4000

    for M in range(0, M_sorted.max() + 1):
        idx_all = order[bounds[M]:bounds[M + 1]]
        if idx_all.size == 0:
            continue
        if M <= 1:                       # la propia celda y sus 8 vecinas: sin cruces intermedios
            vis[idx_all] = 1
            continue
        k = np.arange(1, M, dtype=np.float64)[None, :]      # (1, M-1)
        for s in range(0, idx_all.size, BATCH):
            idx = idx_all[s:s + BATCH]
            dr = dr_all[idx].astype(np.float64)[:, None]
            dc = dc_all[idx].astype(np.float64)[:, None]
            adr, adc = np.abs(dr), np.abs(dc)
            L = np.hypot(dr * dy, dc * dx)                    # (n,1) metros
            g = np.full((idx.size, 1), -np.inf)

            # --- cruces con columnas (solo si |dc| >= 2)
            with np.errstate(divide="ignore", invalid="ignore"):
                t = k / adc
            valid = (k < adc)
            if valid.any():
                t = np.where(valid, t, 0.0)
                cpos = c0 + np.rint(t * dc).astype(np.int64)  # exactamente entera en el cruce
                rpos = r0 + t * dr
                r_lo = np.clip(np.floor(rpos).astype(np.int64), 0, H - 1)
                r_hi = np.clip(r_lo + 1, 0, H - 1)
                w = rpos - r_lo
                cpos = np.clip(cpos, 0, W - 1)
                zi = zfill[r_lo, cpos] * (1 - w) + zfill[r_hi, cpos] * w
                d = t * L
                with np.errstate(divide="ignore", invalid="ignore"):
                    gi = (zi - curv_k * d * d - zo) / d
                gi = np.where(valid, gi, -np.inf)
                g = np.maximum(g, gi.max(axis=1, keepdims=True))

            # --- cruces con filas (solo si |dr| >= 2)
            with np.errstate(divide="ignore", invalid="ignore"):
                t = k / adr
            valid = (k < adr)
            if valid.any():
                t = np.where(valid, t, 0.0)
                rpos = r0 + np.rint(t * dr).astype(np.int64)
                cposf = c0 + t * dc
                c_lo = np.clip(np.floor(cposf).astype(np.int64), 0, W - 1)
                c_hi = np.clip(c_lo + 1, 0, W - 1)
                w = cposf - c_lo
                rpos = np.clip(rpos, 0, H - 1)
                zi = zfill[rpos, c_lo] * (1 - w) + zfill[rpos, c_hi] * w
                d = t * L
                with np.errstate(divide="ignore", invalid="ignore"):
                    gi = (zi - curv_k * d * d - zo) / d
                gi = np.where(valid, gi, -np.inf)
                g = np.maximum(g, gi.max(axis=1, keepdims=True))

            ri, ci = r0 + dr_all[idx], c0 + dc_all[idx]
            zt = zfill[ri, ci] + target_h - curv_k * L[:, 0] ** 2
            gt = (zt - zo) / L[:, 0]
            vis[idx] = (gt > g[:, 0]).astype(np.uint8)
            gmax_out[idx] = g[:, 0]

    vis = vis.reshape(H, W)
    vis[nodata] = 0
    vis[r0, c0] = 1
    return vis, gmax_out.reshape(H, W)


def near3x3(H, W, r0, c0):
    m = np.zeros((H, W), bool)
    m[max(r0 - 1, 0):r0 + 2, max(c0 - 1, 0):c0 + 2] = True
    return m


# ----------------------------------------------------------------------------- método del plan (verificación)
def viewshed_border_rays(z, r0, c0, dx, dy, antenna_h, target_h, radius_m=R_MARS_M, curvature=True):
    """Método literal del Plan de ejecución: un rayo desde la antena hacia cada celda del
    borde; se recorre el rayo paso a paso (1 paso por fila/columna del eje mayor), se
    interpola el terreno y se marca visible la celda más cercana si su gradiente supera el
    máximo visto antes en ESE rayo. Devuelve (vis, visitado). Solo se usa para comparar."""
    H, W = z.shape
    zf = z.astype(np.float64)
    zo = zf[r0, c0] + antenna_h
    ck = 1.0 / (2.0 * radius_m) if curvature else 0.0
    vis = np.zeros((H, W), np.uint8)
    hit = np.zeros((H, W), bool)
    border = ([(0, c) for c in range(W)] + [(H - 1, c) for c in range(W)]
              + [(r, 0) for r in range(1, H - 1)] + [(r, W - 1) for r in range(1, H - 1)])
    for (rb, cb) in border:
        dr, dc = rb - r0, cb - c0
        n = max(abs(dr), abs(dc))
        if n == 0:
            continue
        s = np.arange(1, n + 1) / n
        rp, cp = r0 + s * dr, c0 + s * dc
        # bilineal
        r_lo = np.clip(np.floor(rp).astype(int), 0, H - 2); c_lo = np.clip(np.floor(cp).astype(int), 0, W - 2)
        wr, wc = rp - r_lo, cp - c_lo
        zi = (zf[r_lo, c_lo] * (1 - wr) * (1 - wc) + zf[r_lo + 1, c_lo] * wr * (1 - wc)
              + zf[r_lo, c_lo + 1] * (1 - wr) * wc + zf[r_lo + 1, c_lo + 1] * wr * wc)
        d = s * math.hypot(dr * dy, dc * dx)
        g_ground = (zi - ck * d * d - zo) / d
        g_target = (zi + target_h - ck * d * d - zo) / d
        prev_max = np.concatenate([[-np.inf], np.maximum.accumulate(g_ground)[:-1]])
        ri, ci = np.rint(rp).astype(int), np.rint(cp).astype(int)
        v = (g_target > prev_max).astype(np.uint8)
        # una celda tocada por varios rayos: visible si CUALQUIER rayo la ve (criterio común R2)
        np.maximum.at(vis, (ri, ci), v)
        hit[ri, ci] = True
    vis[r0, c0] = 1; hit[r0, c0] = True
    return vis, hit


# ----------------------------------------------------------------------------- figuras
def hillshade(z, dx, dy, az_deg=315.0, alt_deg=45.0):
    gy, gx = np.gradient(z.astype(np.float64), dy, dx)     # gy: hacia el sur (fila +)
    slope = np.arctan(np.hypot(gx, gy))
    aspect = np.arctan2(-gx, gy)                            # convención de norte arriba
    az, alt = az_deg * DEG, alt_deg * DEG
    hs = np.sin(alt) * np.cos(slope) + np.cos(alt) * np.sin(slope) * np.cos(az - aspect)
    return np.clip(hs, 0, 1)


def make_figures(z, vis, r0, c0, dx, dy, meta, params, stats, out_dir, rover_xy=None):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.colors import ListedColormap
    from matplotlib.patches import Patch
    H, W = z.shape
    ext = [0, W * dx, H * dy, 0]                     # metros desde la esquina NO; norte arriba
    hx, hy = (c0 + 0.5) * dx, (r0 + 0.5) * dy
    title_params = (f"antena {params['antenna_height_m']:g} m + traje {params['target_height_m']:g} m "
                    f"· curvatura {'sí' if params['curvature'] else 'no'}")

    def deco(ax):
        ax.scatter([hx], [hy], marker="*", s=260, c="#f9ab00", edgecolor="k", lw=1.2, zorder=6)
        ax.annotate("Hábitat / antena", (hx, hy), xytext=(12, 12), textcoords="offset points",
                    fontsize=9, color="k", bbox=dict(boxstyle="round,pad=0.2", fc="white", alpha=0.85))
        # barra de escala de 500 m
        x0, y0 = 120, H * dy - 150
        ax.plot([x0, x0 + 500], [y0, y0], color="k", lw=4, solid_capstyle="butt")
        ax.plot([x0, x0 + 500], [y0, y0], color="w", lw=2, solid_capstyle="butt")
        ax.text(x0 + 250, y0 - 50, "500 m", ha="center", fontsize=9,
                bbox=dict(boxstyle="round,pad=0.15", fc="white", alpha=0.8))
        ax.annotate("N", xy=(W * dx - 120, 140), xytext=(W * dx - 120, 380), ha="center",
                    arrowprops=dict(arrowstyle="-|>", lw=2, color="k"), fontsize=12, weight="bold")
        ax.set_xlabel("Este desde el borde oeste (m)")
        ax.set_ylabel("Sur desde el borde norte (m)")

    # 1) binario
    fig, ax = plt.subplots(figsize=(8.6, 8.2))
    cmap = ListedColormap(["#b3261e", "#1e8e3e"])
    ax.imshow(vis, cmap=cmap, vmin=0, vmax=1, extent=ext, interpolation="nearest")
    deco(ax)
    ax.legend(handles=[Patch(color="#1e8e3e", label=f"1 = línea de vista ({stats['visible_pct']:.1f} %)"),
                       Patch(color="#b3261e", label=f"0 = sin línea de vista ({stats['not_visible_pct']:.1f} %)")],
              loc="lower right", fontsize=9, framealpha=0.95)
    ax.set_title("viewshed.u8 — línea de vista geométrica hacia la antena del hábitat\n" + title_params,
                 fontsize=11)
    fig.text(0.5, 0.01, "Visibilidad geométrica sobre el DEM; no equivale a cobertura de radio garantizada.",
             ha="center", fontsize=8.5, style="italic")
    fig.tight_layout(rect=[0, 0.03, 1, 1])
    p1 = out_dir / "viewshed_binary.png"
    fig.savefig(p1, dpi=130); plt.close(fig)

    # 2) sobre el terreno
    hs = hillshade(z, dx, dy)
    fig, ax = plt.subplots(figsize=(9.6, 8.2))
    im = ax.imshow(z, cmap="gist_earth", extent=ext, interpolation="bilinear")
    ax.imshow(hs, cmap="gray", alpha=0.45, extent=ext, interpolation="bilinear")
    shade = np.ma.masked_where(vis == 1, vis)
    ax.imshow(shade, cmap=ListedColormap(["#000000"]), alpha=0.50, extent=ext, interpolation="nearest")
    # coordenadas explícitas de centros de celda (y crece hacia el sur, igual que imshow)
    ax.contour((np.arange(W) + 0.5) * dx, (np.arange(H) + 0.5) * dy, vis, levels=[0.5],
               colors="#ff3b30", linewidths=0.7)
    if rover_xy is not None:
        for xs, ys in rover_xy:
            ax.plot(xs, ys, color="#00e5ff", lw=1.0, alpha=0.9)
    deco(ax)
    cb = fig.colorbar(im, ax=ax, fraction=0.04, pad=0.02)
    cb.set_label("Elevación (m, referencia del DEM)")
    handles = [Patch(facecolor="none", edgecolor="#ff3b30", label="límite de línea de vista"),
               Patch(color="#3a3a3a", label="0 = sin línea de vista (sombreado)"),
               Patch(facecolor="none", edgecolor="none", label="1 = con línea de vista (sin sombra)")]
    if rover_xy is not None:
        handles.append(Patch(color="#00e5ff", label="recorrido real de Perseverance"))
    ax.legend(handles=handles, loc="lower right", fontsize=8.5, framealpha=0.95)
    ax.set_title("Viewshed sobre el terreno (elevación + hillshade)\n" + title_params, fontsize=11)
    fig.text(0.5, 0.01, "Visibilidad geométrica sobre el DEM; no equivale a cobertura de radio garantizada.",
             ha="center", fontsize=8.5, style="italic")
    fig.tight_layout(rect=[0, 0.03, 1, 1])
    p2 = out_dir / "viewshed_terrain.png"
    fig.savefig(p2, dpi=130); plt.close(fig)
    return p1, p2


# ----------------------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--site-dir", default="web/public/data/jezero")
    ap.add_argument("--out", default=None, help="por defecto <site-dir>/viewshed.u8")
    ap.add_argument("--report-dir", default="pipeline/out")
    ap.add_argument("--antenna-height-m", type=float, default=ANTENNA_HEIGHT_M)
    ap.add_argument("--target-height-m", type=float, default=TARGET_HEIGHT_M)
    ap.add_argument("--refraction-k", type=float, default=REFRACTION_K)
    ap.add_argument("--no-curvature", action="store_true")
    ap.add_argument("--skip-crosscheck", action="store_true", help="no ejecutar el método de rayos del plan")
    ap.add_argument("--sensitivity", action="store_true", help="tabla de % visible para varias alturas")
    ap.add_argument("--force", action="store_true", help="sobrescribir viewshed.u8 si existe")
    a = ap.parse_args()

    site = Path(a.site_dir)
    out = Path(a.out) if a.out else site / "viewshed.u8"
    rdir = Path(a.report_dir); rdir.mkdir(parents=True, exist_ok=True)
    if out.exists() and not a.force:
        sys.exit(f"ERROR: {out} ya existe. Usa --force para sobrescribir.")
    if a.antenna_height_m < 0 or a.target_height_m < 0:
        sys.exit("ERROR: las alturas deben ser >= 0")

    # 1. inspección
    meta = load_meta(site / "meta.json")
    W, H = meta["width"], meta["height"]
    z = load_elevation(site / "elevation.f32", W, H)
    n_nan, n_inf = int(np.isnan(z).sum()), int(np.isinf(z).sum())
    finite = np.isfinite(z)
    suspicious = int((finite & ((z < -10000) | (z > 25000))).sum())   # fuera del rango físico de Marte
    dx, dy = grid_geometry(meta)
    print(f"[1] meta: {W}x{H}, bbox {meta['bbox']}, cell_m {meta['cell_m']}; "
          f"celda real {dx:.4f} m (E-O) x {dy:.4f} m (N-S)")
    print(f"    elevation.f32: min {np.nanmin(z):.3f}  max {np.nanmax(z):.3f}  media {np.nanmean(z):.3f} m; "
          f"NaN {n_nan}, Inf {n_inf}, fuera de rango {suspicious}")
    if abs(dx - meta["cell_m"]) > 0.05 * meta["cell_m"] or abs(dy - meta["cell_m"]) > 0.05 * meta["cell_m"]:
        print(f"    AVISO: el tamaño de celda derivado del bbox difiere >5 % de cell_m={meta['cell_m']}")

    # 2. antena
    lon, lat = meta["habitat"]
    r0, c0, rf, cf = lonlat_to_cell(lon, lat, meta)
    z0 = float(z[r0, c0])
    if not math.isfinite(z0):
        sys.exit("ERROR: la celda del hábitat no tiene elevación válida")
    print(f"[2] hábitat lon {lon} E, lat {lat} N -> fila {r0}, columna {c0} "
          f"(fraccional {rf:.3f}, {cf:.3f}); terreno {z0:.3f} m; antena a {z0 + a.antenna_height_m:.3f} m "
          f"(mástil {a.antenna_height_m:g} m, SUPUESTO)")

    # 3. cálculo
    curv = not a.no_curvature
    t0 = time.time()
    vis, gmax = viewshed_r3(z, r0, c0, dx, dy, a.antenna_height_m, a.target_height_m,
                            refraction_k=a.refraction_k, curvature=curv)
    t_r3 = time.time() - t0
    print(f"[3] R3 completado en {t_r3:.1f} s")

    # 4. verificación cruzada con el método del plan
    cross = None
    if not a.skip_crosscheck:
        t0 = time.time()
        vb, hit = viewshed_border_rays(z, r0, c0, dx, dy, a.antenna_height_m, a.target_height_m, curvature=curv)
        cross = {"seconds": round(time.time() - t0, 1),
                 "cells_never_visited_by_border_rays": int((~hit).sum()),
                 "agreement_on_visited_cells_pct": round(100 * float((vb[hit] == vis[hit]).mean()), 3),
                 "border_rays_visible_pct": round(100 * float(vb.mean()), 3)}
        print(f"[4] método de rayos del plan: {cross}")

    # 5. exportación
    vis = np.ascontiguousarray(vis, dtype=np.uint8)
    out.parent.mkdir(parents=True, exist_ok=True)
    vis.tofile(out)

    # 6. validación estructural (relectura del archivo, como lo haría el frontend)
    rb = np.fromfile(out, dtype=np.uint8)
    checks = {
        "file_exists": out.exists(),
        "size_bytes": out.stat().st_size,
        "size_ok": out.stat().st_size == W * H,
        "only_0_1": bool(np.isin(rb, [0, 1]).all()),
        "reread_equal": bool(rb.size == W * H and np.array_equal(rb.reshape(H, W), vis)),
        "habitat_visible": bool(rb.reshape(H, W)[r0, c0] == 1),
        "neighbors_3x3_visible": bool(rb.reshape(H, W)[max(r0 - 1, 0):r0 + 2, max(c0 - 1, 0):c0 + 2].all()),
        # toda celda fuera del 3x3 del hábitat debe tener un horizonte calculado (finito)
        "no_unevaluated_cells": bool((np.isfinite(gmax) | near3x3(H, W, r0, c0)).all()),
        "nodata_cells_marked_0": int(((~finite) & (vis == 1)).sum()) == 0,
    }
    n_vis = int(rb.sum()); n = W * H
    stats = {"total_cells": n, "visible": n_vis, "not_visible": n - n_vis,
             "visible_pct": round(100 * n_vis / n, 3), "not_visible_pct": round(100 * (n - n_vis) / n, 3)}
    print(f"[6] validación: {checks}")
    print(f"    estadísticas: {stats}")
    hard = ["file_exists", "size_ok", "only_0_1", "reread_equal", "habitat_visible", "nodata_cells_marked_0",
            "no_unevaluated_cells"]
    failed = [h for h in hard if not checks[h]]
    if failed:
        sys.exit(f"ERROR: validación fallida {failed}")

    # 7. sensibilidad (opcional)
    sens = None
    if a.sensitivity:
        sens = []
        for ha in (2.0, 3.0, 5.0, 10.0, 20.0):
            for ht in (0.0, a.target_height_m):
                v, _ = viewshed_r3(z, r0, c0, dx, dy, ha, ht, refraction_k=a.refraction_k, curvature=curv)
                sens.append({"antenna_height_m": ha, "target_height_m": ht, "visible_pct": round(100 * v.mean(), 2)})
                print(f"    sens antena {ha:5.1f} m, traje {ht:3.1f} m -> {100 * v.mean():6.2f} % visible")
        v, _ = viewshed_r3(z, r0, c0, dx, dy, a.antenna_height_m, a.target_height_m, curvature=False)
        sens.append({"antenna_height_m": a.antenna_height_m, "target_height_m": a.target_height_m,
                     "curvature": False, "visible_pct": round(100 * v.mean(), 2),
                     "cells_changed_vs_curvature": int((v != vis).sum())})
        print(f"    sin curvatura: {sens[-1]}")

    # 8. LOS a lo largo del recorrido real del rover (contexto para Eric)
    rover = None; rover_xy = None
    rt = site / "rover_traverse.geojson"
    if rt.exists():
        fc = json.loads(rt.read_text())
        bb = meta["bbox"]
        pts = np.array([c[:3] for f in fc["features"] for c in f["geometry"]["coordinates"]])
        cf_ = (pts[:, 0] - bb[0]) / (bb[2] - bb[0]) * W
        rf_ = (bb[3] - pts[:, 1]) / (bb[3] - bb[1]) * H
        ci = np.clip(np.floor(cf_).astype(int), 0, W - 1); ri = np.clip(np.floor(rf_).astype(int), 0, H - 1)
        dz = pts[:, 2] - z[ri, ci]
        rover = {"n_vertices": int(len(pts)), "vertices_with_los_pct": round(100 * float(vis[ri, ci].mean()), 2),
                 "rover_z_minus_dem_mean_m": round(float(dz.mean()), 3),
                 "rover_z_minus_dem_std_m": round(float(dz.std()), 3)}
        rover_xy = []
        for f in fc["features"]:
            cs = np.array(f["geometry"]["coordinates"])
            rover_xy.append(((cs[:, 0] - bb[0]) / (bb[2] - bb[0]) * W * dx,
                             (bb[3] - cs[:, 1]) / (bb[3] - bb[1]) * H * dy))
        print(f"[8] recorrido del rover: {rover}")

    params = {"antenna_height_m": a.antenna_height_m, "antenna_height_is_assumption": True,
              "target_height_m": a.target_height_m, "target_height_is_assumption": True,
              "curvature": curv, "mars_radius_m": R_MARS_M, "refraction_k": a.refraction_k,
              "algorithm": "R3 (Franklin & Ray 1994), cruces de filas/columnas con interpolación lineal",
              "visibility_rule": "visible si gradiente(objetivo) > max(gradiente de cruces intermedios), estricto"}
    p1, p2 = make_figures(z, vis, r0, c0, dx, dy, meta, params, stats, rdir, rover_xy)
    print(f"[9] figuras: {p1}, {p2}")

    report = {
        "inputs": {"meta": str(site / "meta.json"), "elevation": str(site / "elevation.f32"),
                   "width": W, "height": H, "bbox": meta["bbox"], "cell_m_meta": meta["cell_m"],
                   "cell_m_from_bbox": [round(dx, 4), round(dy, 4)],
                   "elev_min_m": round(float(np.nanmin(z)), 3), "elev_max_m": round(float(np.nanmax(z)), 3),
                   "elev_mean_m": round(float(np.nanmean(z)), 3), "nan": n_nan, "inf": n_inf,
                   "out_of_range": suspicious},
        "habitat": {"lon": lon, "lat": lat, "row": r0, "col": c0, "row_frac": round(rf, 3),
                    "col_frac": round(cf, 3), "terrain_m": round(z0, 3),
                    "antenna_abs_m": round(z0 + a.antenna_height_m, 3)},
        "params": params, "seconds_r3": round(t_r3, 1), "crosscheck_border_rays": cross,
        "output": {"path": str(out), "dtype": "uint8", "shape": [H, W], "order": "row-major, fila 0 = norte"},
        "checks": checks, "stats": stats, "sensitivity": sens, "rover_traverse": rover,
    }
    (rdir / "viewshed_report.json").write_text(json.dumps(report, indent=2, ensure_ascii=False))
    print(f"[10] reporte -> {rdir / 'viewshed_report.json'}")


if __name__ == "__main__":
    main()
