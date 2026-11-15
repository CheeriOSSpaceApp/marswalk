"""
export_jezero.py — Turn Gabriel's DTM read (Elevation.py) into the CONTRACTS.md layers for jezero/.

Reuses Gabriel's code as-is:  Elevation.map(meta) -> (elevation, dx_m, dy_m)   and   Elevation.elevcalc(...) -> slope
Adds only the export step: elevation.f32, slope.f32, roughness.f32, hazard.u8, hillshade.png, slope.png.
(ortho.png and viewshed.u8 are NOT produced here: ortho = Gabriel, viewshed = Marco.)

Run from repo root (needs internet; reads only the AOI window of the USGS Mars 2020 TRN HiRISE DTM):
    pip install rasterio pyproj numpy scipy pillow matplotlib pandas requests
    python pipeline/export_jezero.py
Self-test without internet (uses the mock elevation):
    python pipeline/export_jezero.py --selftest
"""
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "web" / "public" / "data"


def roughness(z, k=5, cell_m=3.0):
    """DETRENDED roughness: std dev of elevation AFTER removing the best-fit local plane in a k x k window (m).
    Plain std dev of z mixes slope into roughness: a perfectly smooth 8 deg plane already gives 0.6 m
    in a 15 m window. Here a smooth plane of any slope gives ~0. NaN-safe (no-data cells -> NaN).
    var_resid = var(z) - cov(z,x)^2/var(x) - cov(z,y)^2/var(y)   (x, y = offsets from window center)"""
    valid = np.isfinite(z)
    zf = np.where(valid, z, np.nanmean(z)).astype(np.float64)
    off = (np.arange(k) - k // 2) * cell_m
    X = np.tile(off, (k, 1)) / (k * k)          # kernel: mean of x*z
    Y = X.T.copy()
    mz = ndimage.uniform_filter(zf, k)
    mz2 = ndimage.uniform_filter(zf ** 2, k)
    czx = ndimage.correlate(zf, X)               # E[x z]  (E[x] = 0 in a centered window)
    czy = ndimage.correlate(zf, Y)
    varx = np.mean(np.tile(off, (k, 1)) ** 2)
    var_resid = (mz2 - mz ** 2) - czx ** 2 / varx - czy ** 2 / varx

    r = np.sqrt(np.maximum(var_resid, 0))

    bad = ndimage.maximum_filter(~valid, size=k, mode="reflect")
    r[bad] = np.nan

    return r


def hazard(slope, rough, p):
    """0 free, 1 caution, 2 forbidden. Thresholds from Ana's params.json. No data -> forbidden."""
    s_c, s_f = p["slope_caution_deg"], p["slope_forbidden_deg"]
    r_c, r_f = p["rough_caution_m"], p["rough_forbidden_m"]
    hz = np.zeros(slope.shape, np.uint8)
    hz[(slope > s_c) | (rough > r_c)] = 1
    hz[(slope > s_f) | (rough > r_f) | ~np.isfinite(slope) | ~np.isfinite(rough)] = 2
    return hz


def hillshade(z, dx, dy, az=315, alt=45):
    zf = np.where(np.isfinite(z), z, np.nanmean(z))
    gy, gx = np.gradient(zf, dy, dx)
    slope = np.arctan(np.hypot(gx, gy))
    aspect = np.arctan2(-gx, gy)
    az, alt = np.radians(az), np.radians(alt)
    hs = np.sin(alt) * np.cos(slope) + np.cos(alt) * np.sin(slope) * np.cos(az - aspect)
    out = (np.clip(hs, 0, 1) * 255).astype(np.uint8)
    out[~np.isfinite(z)] = 0
    return out


def slope_png(slope, vmax):
    sn = np.clip(np.nan_to_num(slope, nan=vmax) / vmax, 0, 1)
    rgb = np.stack([sn * 255, (1 - np.abs(sn - 0.5) * 2) * 200, (1 - sn) * 255], -1).astype(np.uint8)
    return rgb


def export(z, dx, dy, meta, params, out):
    from Elevation import elevcalc  # Gabriel's slope (np.gradient with real dx/dy)
    H, W = meta["height"], meta["width"]
    assert z.shape == (H, W), f"elevation shape {z.shape} != meta {(H, W)}"
    z = np.asarray(z, dtype=np.float64)
    slope = elevcalc(np.ma.masked_invalid(z), dx, dy)
    rough = roughness(z, 5, (dx + dy) / 2)
    hz = hazard(slope, rough, params)
    out.mkdir(parents=True, exist_ok=True)
    for name, arr, dt in [("elevation.f32", z, "<f4"), ("slope.f32", slope, "<f4"),
                          ("roughness.f32", rough, "<f4"), ("hazard.u8", hz, "u1")]:
        np.asarray(arr).astype(dt).tofile(out / name)
    Image.fromarray(hillshade(z, dx, dy)).save(out / "hillshade.png")
    Image.fromarray(slope_png(slope, max(params["slope_forbidden_deg"] * 2, 30))).save(out / "slope.png")
    nan = int(np.sum(~np.isfinite(z)))
    print(f"cell {dx:.2f} x {dy:.2f} m | elevation {np.nanmin(z):.1f}..{np.nanmax(z):.1f} m | NaN cells {nan}")
    print(f"slope max {np.nanmax(slope):.1f} deg | hazard free {np.mean(hz == 0):.1%} caution {np.mean(hz == 1):.1%} forbidden {np.mean(hz == 2):.1%}")
    print(f"wrote {out}")


def main():
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    params = json.loads((DATA / "common" / "params.json").read_text(encoding="utf-8"))
    if "--selftest" in sys.argv:
        meta = json.loads((DATA / "mock" / "meta.json").read_text(encoding="utf-8"))
        z = np.fromfile(DATA / "mock" / "elevation.f32", "<f4").reshape(meta["height"], meta["width"])
        z[:5, :5] = np.nan  # simulate DTM holes
        export(z, meta["cell_m"], meta["cell_m"], meta, params, ROOT / "pipeline" / "_selftest_out")
        return
    meta = json.loads((DATA / "jezero" / "meta.json").read_text(encoding="utf-8"))
    from Elevation import map as read_dtm  # Gabriel's windowed DTM read (needs internet)
    elevation, dx, dy = read_dtm(meta)
    export(np.ma.filled(elevation.astype(np.float64), np.nan), dx, dy, meta, params, DATA / "jezero")


if __name__ == "__main__":
    main()
