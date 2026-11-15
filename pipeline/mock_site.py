"""
mock_site.py — Generate a synthetic Mars site that follows CONTRACTS.md exactly.

Why: nobody waits for real Jezero data. Frontend (Santiago) and cost model (Ana)
build against web/public/data/mock/. At 20:30 we swap mock/ -> jezero/.

Run:  python pipeline/mock_site.py            (from repo root; keeps suit/params/alerts)
      python pipeline/mock_site.py --force    (regenerate EVERYTHING, overwrites teammates' files)
Out:  web/public/data/mock/*

Conventions (from CONTRACTS.md):
- Grid 1000x1000, cell_m = 3  (~3 x 3 km)
- Row 0 = north, col 0 = west. Index i = row * width + col
- Binaries little-endian (.f32 = Float32, .u8 = Uint8)
- Coords: Mars 2000 planetocentric, lon 0-360 E, lat north positive
"""
import json
import os
import sys

import numpy as np
from PIL import Image
from scipy import ndimage

RNG = np.random.default_rng(42)  # fixed seed -> everyone gets the same mock
W = H = 1000
CELL_M = 3.0
OUT = os.path.join(os.path.dirname(__file__), "..", "web", "public", "data", "mock")

# Bbox roughly over Jezero so coordinates "look" real (not the real AOI!)
LAT_C, LON_C = 18.45, 77.45
M_PER_DEG_LAT = 59270.0                       # 1 deg lat on Mars ~ 59.27 km
M_PER_DEG_LON = M_PER_DEG_LAT * np.cos(np.radians(LAT_C))
HALF_LAT = (H * CELL_M / 2) / M_PER_DEG_LAT
HALF_LON = (W * CELL_M / 2) / M_PER_DEG_LON
BBOX = [LON_C - HALF_LON, LAT_C - HALF_LAT, LON_C + HALF_LON, LAT_C + HALF_LAT]

# Provisional thresholds (Ana replaces these in params.json)
SLOPE_CAUTION, SLOPE_FORBIDDEN = 15.0, 25.0   # degrees
ROUGH_CAUTION, ROUGH_FORBIDDEN = 0.25, 0.6    # meters (local std dev)


def cell_to_lonlat(row, col):
    lon = BBOX[0] + (col + 0.5) / W * (BBOX[2] - BBOX[0])
    lat = BBOX[3] - (row + 0.5) / H * (BBOX[3] - BBOX[1])
    return [round(lon, 6), round(lat, 6)]


def make_elevation():
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    z = np.full((H, W), -2500.0, dtype=np.float32)  # Jezero floor ~ -2.5 km

    # 4 gaussian hills: (row, col, height_m, sigma_cells)
    for r, c, h, s in [(250, 300, 120, 90), (700, 750, 90, 70),
                       (300, 800, 70, 60), (780, 420, 80, 110)]:
        z += h * np.exp(-((yy - r) ** 2 + (xx - c) ** 2) / (2 * s ** 2))

    # Gentle regional tilt (like a delta front sloping down)
    z += 0.02 * xx * CELL_M * 0.3

    # One crater: bowl + raised rim
    cr, cc, R = 520, 520, 60
    d = np.sqrt((yy - cr) ** 2 + (xx - cc) ** 2)
    z += np.where(d < R, -25 * (1 - (d / R) ** 2), 0)
    z += 8 * np.exp(-((d - R) ** 2) / (2 * 6 ** 2))

    # Smooth noise (meter-scale undulations)
    z += ndimage.gaussian_filter(RNG.normal(0, 1, (H, W)), 8) * 25

    # Random rocks: small sharp bumps -> high roughness
    rocks = np.zeros((H, W), dtype=np.float32)
    idx = RNG.integers(0, H * W, 2500)
    rocks.flat[idx] = RNG.uniform(0.5, 2.5, idx.size)  # ~4000 rocks
    z += ndimage.gaussian_filter(rocks, 0.8) * 6
    return z.astype(np.float32)


def slope_deg(z):
    dzdy, dzdx = np.gradient(z, CELL_M)
    return np.degrees(np.arctan(np.hypot(dzdx, dzdy))).astype(np.float32)


def roughness(z, k=5):
    # local std dev in k x k: sqrt(E[z^2] - E[z]^2)
    z64 = z.astype(np.float64)
    m = ndimage.uniform_filter(z64, k)
    m2 = ndimage.uniform_filter(z64 ** 2, k)
    return np.sqrt(np.maximum(m2 - m ** 2, 0)).astype(np.float32)


def hazard(slope, rough):
    hz = np.zeros(slope.shape, dtype=np.uint8)
    hz[(slope > SLOPE_CAUTION) | (rough > ROUGH_CAUTION)] = 1
    hz[(slope > SLOPE_FORBIDDEN) | (rough > ROUGH_FORBIDDEN)] = 2
    return hz


def viewshed(z, hr, hc, mast_m=10.0):
    """Ray-cast LOS from habitat antenna to every border cell (mock of Marco's)."""
    vis = np.zeros(z.shape, dtype=np.uint8)
    z0 = z[hr, hc] + mast_m
    border = ([(0, c) for c in range(W)] + [(H - 1, c) for c in range(W)] +
              [(r, 0) for r in range(H)] + [(r, W - 1) for r in range(H)])
    for br, bc in border:
        n = int(max(abs(br - hr), abs(bc - hc))) + 1
        rr = np.linspace(hr, br, n).round().astype(int)
        cc = np.linspace(hc, bc, n).round().astype(int)
        dist = np.hypot(rr - hr, cc - hc) * CELL_M
        dist[0] = 1e-6
        ang = (z[rr, cc] - z0) / dist           # tan(elevation angle)
        prev_max = np.maximum.accumulate(np.concatenate([[-np.inf], ang[:-1]]))
        vis[rr[ang >= prev_max], cc[ang >= prev_max]] = 1
    vis[hr, hc] = 1
    return vis


def hillshade(z, az=315, alt=45):
    dzdy, dzdx = np.gradient(z, CELL_M)
    slope = np.arctan(np.hypot(dzdx, dzdy))
    aspect = np.arctan2(-dzdx, dzdy)
    az, alt = np.radians(az), np.radians(alt)
    hs = np.sin(alt) * np.cos(slope) + np.cos(alt) * np.sin(slope) * np.cos(az - aspect)
    return (np.clip(hs, 0, 1) * 255).astype(np.uint8)


def write_bin(name, arr, dtype):
    arr.astype(np.dtype(dtype).newbyteorder("<")).tofile(os.path.join(OUT, name))


# Files that teammates own and edit by hand inside mock/. NEVER overwrite them unless --force.
#   suit.json -> Marco, params.json -> Ana, alerts.json -> Marco + Ana
OWNED = {"suit.json": "Marco", "params.json": "Ana", "alerts.json": "Marco + Ana"}
FORCE = "--force" in sys.argv


COMMON = os.path.join(os.path.dirname(__file__), "..", "web", "public", "data", "common")


def write_json(name, obj):
    # suit/params/alerts are mission config shared by all sites -> data/common/
    path = os.path.join(COMMON if name in OWNED else OUT, name)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if name in OWNED and os.path.exists(path) and not FORCE:
        print(f"  skip {name} (owned by {OWNED[name]}; use --force to overwrite)")
        return
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, indent=2, ensure_ascii=False)


def main():
    os.makedirs(OUT, exist_ok=True)
    habitat_rc = (850, 150)   # flat-ish SW corner
    depot_rc = (200, 600)
    z = make_elevation()
    s = slope_deg(z)
    ro = roughness(z)
    hz = hazard(s, ro)
    # make sure habitat & depot are walkable
    for r, c in (habitat_rc, depot_rc, (350, 450), (440, 520), (600, 350)):
        hz[r - 3:r + 4, c - 3:c + 4] = 0
    vs = viewshed(z, *habitat_rc)

    write_bin("elevation.f32", z, "f4")
    write_bin("slope.f32", s, "f4")
    write_bin("roughness.f32", ro, "f4")
    write_bin("hazard.u8", hz, "u1")
    write_bin("viewshed.u8", vs, "u1")

    hs = hillshade(z)
    Image.fromarray(hs).save(os.path.join(OUT, "hillshade.png"))
    tint = np.stack([hs * 0.85 + 30, hs * 0.55 + 20, hs * 0.35 + 10], -1)  # Mars-ish
    Image.fromarray(np.clip(tint, 0, 255).astype(np.uint8)).save(os.path.join(OUT, "ortho.png"))
    sn = np.clip(s / 30.0, 0, 1)
    slope_rgb = np.stack([sn * 255, (1 - abs(sn - 0.5) * 2) * 200, (1 - sn) * 255], -1)
    Image.fromarray(slope_rgb.astype(np.uint8)).save(os.path.join(OUT, "slope.png"))

    write_json("meta.json", {
        "site": "mock", "bbox": [round(v, 6) for v in BBOX],
        "width": W, "height": H, "cell_m": CELL_M,
        "habitat": cell_to_lonlat(*habitat_rc),
    })

    targets = [
        ("habitat", "Habitat", "habitat", 1, habitat_rc),
        ("depot", "Sample Depot (mock)", "depot", 5, depot_rc),
        ("sci1", "Delta outcrop (mock)", "science", 4, (350, 450)),
        ("sci2", "Crater rim (mock)", "science", 3, (440, 520)),
        ("shelter1", "Shelter A (mock)", "shelter", 1, (600, 350)),
    ]
    write_json("targets.geojson", {"type": "FeatureCollection", "features": [
        {"type": "Feature",
         "geometry": {"type": "Point", "coordinates": cell_to_lonlat(r, c)},
         "properties": {"id": i, "name": n, "kind": k, "science_value": v,
                        "notes": "mock", "photo_id": None,
                        **({"radiation_shelter": True} if k == "shelter" else {})}}
        for i, n, k, v, (r, c) in targets]})

    write_json("photos.json", [])
    write_json("rover_traverse.geojson", {"type": "FeatureCollection", "features": [
        {"type": "Feature", "properties": {"mock": True}, "geometry": {
            "type": "LineString",
            "coordinates": [cell_to_lonlat(r, c) for r, c in
                            [(900, 100), (750, 250), (600, 420), (400, 520), (200, 600)]]}}]})

    write_json("env.json", {"mock": True, "scenarios": {
        sc: [{"hour": h, "temp_K": round(210 + 40 * np.sin((h - 8) / 24 * 2 * np.pi), 1),
              "pressure_Pa": p, "wind_ms": wv, "tau": t} for h in range(24)]
        for sc, p, wv, t in [("clear", 700, 5, 0.5), ("dusty", 705, 12, 1.5),
                             ("storm", 710, 25, 4.0)]}})

    # suit.json = Marco's values (keep identical to his file; he owns it)
    ices = "NASA ICES-2026-127 (Ogilvie et al., Mars Spacesuit Mass Requirements)"
    write_json("suit.json", {
        "o2_hours": {"value": 8, "assumption": True,
                     "source": "8 h EVA design duration (VERIFY source); sized at 1200 BTU/h = 352 W average metabolic rate from " + ices},
        "reserve_pct": {"value": 15, "assumption": True, "source": "prototype decision: 72 of 480 O2-min never planned"},
        "battery_Wh": {"value": 1155, "assumption": True, "source": "prototype decision"},
        "base_power_W": {"value": 120, "assumption": True, "source": "prototype decision: suit electronics, NOT metabolism"},
        "walkback_m": {"value": 1770, "assumption": True,
                       "source": ices + ": 30-min walkback at 2.2 mph"},
        "max_slope_deg": {"value": 15, "assumption": True, "source": "prototype decision"},
    })

    write_json("alerts.json", [
        {"id": "spe1", "type": "SPE", "effect": {"dose_x": 50, "o2_x": 1.0, "visibility": 1.0},
         "action": "shelter"},
        {"id": "dust1", "type": "dust", "effect": {"dose_x": 1.0, "o2_x": 1.1, "visibility": 0.3},
         "action": "return"},
        {"id": "suit1", "type": "suit", "effect": {"dose_x": 1.0, "o2_x": 1.5, "visibility": 1.0},
         "action": "return"},
    ])

    write_json("params.json", {
        "mock": True,
        "slope_caution_deg": SLOPE_CAUTION, "slope_forbidden_deg": SLOPE_FORBIDDEN,
        "rough_caution_m": ROUGH_CAUTION, "rough_forbidden_m": ROUGH_FORBIDDEN,
        "w_slope": 1.0, "w_rough": 1.0, "w_nocomms": 0.2,
        "base_speed_ms": 1.0, "gcr_mSv_per_h": 0.028,
    })

    print(f"OK -> {os.path.abspath(OUT)}")
    print(f"hazard: free {np.mean(hz==0):.1%}, caution {np.mean(hz==1):.1%}, "
          f"forbidden {np.mean(hz==2):.1%} | viewshed {np.mean(vs):.1%} | "
          f"slope max {s.max():.1f} deg")


if __name__ == "__main__":
    main()
