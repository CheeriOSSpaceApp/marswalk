#!/usr/bin/env python3
"""
Pruebas geométricas controladas del viewshed (Bloque 3, Marco).
Ejecutar desde la raíz del repo:   python pipeline/tests/test_viewshed.py
(También funciona con pytest.) Escribe pipeline/out/viewshed_tests.json con los resultados reales.
"""
import json
import math
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from process_viewshed import (R_MARS_M, lonlat_to_cell, viewshed_border_rays,  # noqa: E402
                              viewshed_r3)

CELL = 3.0
RESULTS = {}


def brute_force(z, r0, c0, dx, dy, ha, ht, curvature=True, step=0.05):
    """Referencia independiente y lenta: muestreo denso (cada 0.05 celda) con interpolación
    bilineal a lo largo de cada línea. No comparte código con R3."""
    H, W = z.shape
    zo = z[r0, c0] + ha
    ck = 1 / (2 * R_MARS_M) if curvature else 0.0
    out = np.zeros((H, W), np.uint8)
    for r in range(H):
        for c in range(W):
            dr, dc = r - r0, c - c0
            n = max(abs(dr), abs(dc))
            if n <= 1:
                out[r, c] = 1
                continue
            L = math.hypot(dr * dy, dc * dx)
            gt = (z[r, c] + ht - ck * L * L - zo) / L
            ok = True
            ns = int(n / step)
            for i in range(1, ns):
                t = i / ns
                # solo cruces "intermedios": se excluye la última media celda (la propia celda objetivo)
                if t * n > n - 0.5 or t * n < 0.5:
                    continue
                rp, cp = r0 + t * dr, c0 + t * dc
                rl, cl = min(int(math.floor(rp)), H - 2), min(int(math.floor(cp)), W - 2)
                wr, wc = rp - rl, cp - cl
                zi = (z[rl, cl] * (1 - wr) * (1 - wc) + z[rl + 1, cl] * wr * (1 - wc)
                      + z[rl, cl + 1] * (1 - wr) * wc + z[rl + 1, cl + 1] * wr * wc)
                d = t * L
                if (zi - ck * d * d - zo) / d >= gt:
                    ok = False
                    break
            out[r, c] = ok
    return out


def record(name, passed, **info):
    RESULTS[name] = {"passed": bool(passed), **info}
    print(f"[{'OK ' if passed else 'FALLA'}] {name}: {info}")
    return passed


def test_1_flat():
    z = np.zeros((101, 101), np.float32)
    for curv in (False, True):
        v, _ = viewshed_r3(z, 50, 50, CELL, CELL, 5.0, 0.0, curvature=curv)
        record(f"1_plano_curvatura_{curv}", v.all(), visible_pct=100 * v.mean())
    assert v.all()


def test_2_isolated_bump():
    """Montículo de 20 m a 30 celdas al este: debe ocultar una 'sombra' detrás (al este) y
    nada delante ni en otras direcciones."""
    z = np.zeros((101, 101), np.float32)
    z[48:53, 80:83] = 20.0
    v, _ = viewshed_r3(z, 50, 50, CELL, CELL, 2.0, 0.0, curvature=False)
    behind = v[50, 84:].mean()            # detrás del montículo en la misma fila
    front = v[50, 52:79].mean()           # entre la antena y el montículo
    west = v[:, :45].mean()               # lado opuesto
    top = v[48:53, 80:83].mean()          # el propio montículo es visible
    ok = behind == 0 and front == 1 and west == 1 and top > 0
    record("2_monticulo_aislado", ok, detras=behind, delante=front, oeste=west, cima_visible=top,
           celdas_ocultas=int((v == 0).sum()))
    assert ok


def test_3_obstacle_between():
    """Muro de 10 m entre la antena (fila 50, col 10) y un punto objetivo (fila 50, col 90).
    Geometría: antena a 2 m; muro en col 50 (120 m); objetivo a 240 m.
    Gradiente del muro (10-2)/120 > gradiente del objetivo (0-2)/240 -> objetivo NO visible.
    Con un objetivo elevado 30 m: (30-2)/240 = 0.1167 > 8/120 = 0.0667 -> visible."""
    z = np.zeros((101, 101), np.float32)
    z[:, 50] = 10.0
    v, _ = viewshed_r3(z, 50, 10, CELL, CELL, 2.0, 0.0, curvature=False)
    z2 = z.copy(); z2[50, 90] = 30.0
    v2, _ = viewshed_r3(z2, 50, 10, CELL, CELL, 2.0, 0.0, curvature=False)
    ok = v[50, 90] == 0 and v[50, 30] == 1 and v2[50, 90] == 1
    record("3_obstaculo_intermedio", ok, objetivo_detras_del_muro=int(v[50, 90]),
           punto_antes_del_muro=int(v[50, 30]), objetivo_elevado_30m=int(v2[50, 90]))
    assert ok


def test_4_higher_antenna():
    rng = np.random.default_rng(42)
    z = rng.normal(0, 1, (121, 121)).cumsum(0).cumsum(1).astype(np.float32) * 0.05
    pct, prev, mono = [], None, True
    for ha in (0.5, 2.0, 5.0, 10.0, 30.0):
        v, _ = viewshed_r3(z, 60, 60, CELL, CELL, ha, 0.0)
        if prev is not None and (prev & ~v.astype(bool)).any():
            mono = False                       # una antena más alta nunca debe "perder" celdas
        prev = v.astype(bool)
        pct.append(round(100 * v.mean(), 2))
    ok = mono and all(a <= b for a, b in zip(pct, pct[1:])) and pct[-1] > pct[0]
    record("4_antena_mas_alta", ok, alturas_m=[0.5, 2, 5, 10, 30], visible_pct=pct, monotono_por_celda=mono)
    assert ok


def test_5_curvature_horizon():
    """Esfera lisa (DEM = 0): con antena h_a y objetivo h_t el horizonte teórico es
    sqrt(2 R h_a) + sqrt(2 R h_t). Con h_a = 0.2 m, h_t = 0: 1165.7 m."""
    n = 901
    z = np.zeros((n, n), np.float32)
    ha = 0.2
    v, _ = viewshed_r3(z, n // 2, n // 2, CELL, CELL, ha, 0.0, curvature=True)
    rr, cc = np.mgrid[0:n, 0:n]
    d = np.hypot(rr - n // 2, cc - n // 2) * CELL
    horizon = math.sqrt(2 * R_MARS_M * ha)
    inside = v[d < horizon - 2 * CELL].mean()
    outside = v[d > horizon + 2 * CELL].mean()
    far_vis = d[v == 1].max()
    ok = inside == 1 and outside == 0
    record("5_horizonte_curvatura", ok, horizonte_teorico_m=round(horizon, 1),
           max_distancia_visible_m=round(float(far_vis), 1), dentro=inside, fuera=outside)
    assert ok


def test_6_vs_brute_force():
    rng = np.random.default_rng(7)
    z = rng.normal(0, 1, (61, 61)).cumsum(0).cumsum(1).astype(np.float64) * 0.08
    z += 6 * np.exp(-(((np.mgrid[0:61, 0:61][0] - 20) ** 2 + (np.mgrid[0:61, 0:61][1] - 40) ** 2) / 20))
    v, _ = viewshed_r3(z, 33, 27, CELL, CELL, 3.0, 1.5)
    b = brute_force(z, 33, 27, CELL, CELL, 3.0, 1.5)
    agree = float((v == b).mean())
    ok = agree >= 0.98
    record("6_vs_fuerza_bruta", ok, concordancia_pct=round(100 * agree, 2), r3_visible_pct=round(100 * v.mean(), 2),
           fuerza_bruta_visible_pct=round(100 * b.mean(), 2), celdas_distintas=int((v != b).sum()))
    assert ok


def test_7_orientation():
    """Cresta de 50 m al NORTE (filas pequeñas) en un grid con bbox: debe ocultar solo celdas
    del norte. Y lonlat_to_cell: esquina NO -> (0,0); esquina SE -> (H-1, W-1)."""
    meta = {"bbox": [77.0, 18.0, 77.1, 18.1], "width": 100, "height": 100}
    r_nw, c_nw, _, _ = lonlat_to_cell(77.0000001, 18.0999999, meta)
    r_se, c_se, _, _ = lonlat_to_cell(77.0999999, 18.0000001, meta)
    z = np.zeros((100, 100), np.float32); z[20, :] = 50.0
    v, _ = viewshed_r3(z, 60, 50, CELL, CELL, 2.0, 0.0, curvature=False)
    ok = (r_nw, c_nw) == (0, 0) and (r_se, c_se) == (99, 99) and v[:15].mean() < 0.2 and v[25:].all()
    record("7_orientacion", ok, esquina_NO=(r_nw, c_nw), esquina_SE=(r_se, c_se),
           visible_norte_detras_cresta_pct=round(100 * v[:15].mean(), 1), visible_sur_pct=100 * v[25:].mean())
    assert ok


def test_8_border_rays_coverage():
    """Documenta el problema del método literal del plan (rayos al borde, 1 muestra por paso):
    cobertura y concordancia con R3 sobre un terreno aleatorio."""
    rng = np.random.default_rng(3)
    z = rng.normal(0, 1, (201, 201)).cumsum(0).cumsum(1).astype(np.float64) * 0.05
    v, _ = viewshed_r3(z, 90, 120, CELL, CELL, 5.0, 1.5)
    vb, hit = viewshed_border_rays(z, 90, 120, CELL, CELL, 5.0, 1.5)
    unvisited = int((~hit).sum())
    agree = float((vb[hit] == v[hit]).mean())
    record("8_metodo_rayos_del_plan", True, celdas_no_visitadas=unvisited,
           concordancia_en_visitadas_pct=round(100 * agree, 2),
           nota="informativa: R3 se usa para la salida oficial")


if __name__ == "__main__":
    tests = [test_1_flat, test_2_isolated_bump, test_3_obstacle_between, test_4_higher_antenna,
             test_5_curvature_horizon, test_6_vs_brute_force, test_7_orientation, test_8_border_rays_coverage]
    failed = []
    for t in tests:
        try:
            t()
        except AssertionError:
            failed.append(t.__name__)
    out = Path("pipeline/out"); out.mkdir(parents=True, exist_ok=True)
    (out / "viewshed_tests.json").write_text(json.dumps(RESULTS, indent=2, ensure_ascii=False, default=float))
    print(f"\n{len(tests) - len(failed)}/{len(tests)} pruebas pasaron. Fallidas: {failed or 'ninguna'}")
    sys.exit(1 if failed else 0)
