#!/usr/bin/env python3
"""
process_rover_traverse.py — Martian Map / MarsWalk, Marco, Block 2.

Turns NASA/JPL's real Perseverance traverse (MMGIS layer M20_traverse.json)
into web/public/data/jezero/rover_traverse.geojson, clipped to Gabriel's AOI (meta.json bbox).

Source: https://mars.nasa.gov/mmgis-maps/M20/Layers/json/M20_traverse.json
        (layer of NASA's "Where is Perseverance?" map; this copy is named
        "M20_Traverse_Path_tosol2022").

What the source file actually is (inspected, not assumed):
  * GeoJSON FeatureCollection, 1 Feature per drive sol, geometry LineString [lon, lat, z].
  * properties: sol, fromRMC, toRMC (Rover Motion Counter "site_drive"), length (m),
    SCLK_START, SCLK_END (spacecraft clock, s).
  * The "crs" member says CRS84 (Earth WGS84). That is a GDAL/GeoJSON export label,
    NOT the real frame: the values are Mars planetocentric, longitude 0-360 E, latitude +N
    (first vertex = Octavia E. Butler landing site, 77.4509 E 18.4446 N), z = metres
    (relative to the MOLA geoid; landing site -2569.9 m). We never attach an EPSG code.

Steps (in order):
  1 load source (read-only)       2 inspect structure / integrity
  3 order drives (sol, SCLK)      4 load and check AOI (meta.json bbox)
  5 check coordinate compatibility (same frame, 0-360 E, [lon,lat])
  6 clip each drive to the AOI geometrically (Liang-Barsky per segment, z interpolated),
    cross-checked against shapely.intersection()
  7 validate the result          8 export rover_traverse.geojson
  9 write report (JSON + MD)     10 control figure (PNG)

Inputs used: ONLY the source traverse and meta.json (AOI + habitat).

Contract handling: CONTRACTS.md says "LineString of real traverse clipped to AOI".
The real drive data inside the AOI is NOT one connected line (navigation re-localizations
leave ~8 m jumps). We do NOT join pieces. Output = FeatureCollection whose every
feature geometry is a LineString (one per drive sol, original properties preserved).
The script reports the connected pieces so the team can approve this layout.

Usage (from repo root):
  python pipeline/process_rover_traverse.py
  python pipeline/process_rover_traverse.py --src pipeline/raw/M20_traverse.json \
      --meta web/public/data/jezero/meta.json --out web/public/data/jezero/rover_traverse.geojson \
      --gap-m 1.0 --force
"""
import argparse
import hashlib
import json
import math
import sys
from pathlib import Path

R_MARS_M = 3_396_190.0          # CONTRACTS.md: radius 3,396.19 km
DEG = math.pi / 180.0


# ----------------------------------------------------------------------------- geometry helpers
def seg_len_m(a, b):
    """Local equirectangular distance in metres between [lon,lat,...] a and b (Mars sphere).
    Exact enough for segments of a few metres to tens of metres."""
    lat0 = (a[1] + b[1]) * 0.5 * DEG
    dx = (b[0] - a[0]) * DEG * R_MARS_M * math.cos(lat0)
    dy = (b[1] - a[1]) * DEG * R_MARS_M
    return math.hypot(dx, dy)


def line_len_m(coords):
    return sum(seg_len_m(a, b) for a, b in zip(coords, coords[1:]))


def inside(p, bb, eps=0.0):
    return bb[0] - eps <= p[0] <= bb[2] + eps and bb[1] - eps <= p[1] <= bb[3] + eps


def clip_segment(p, q, bb):
    """Liang-Barsky clip of segment p->q (lon,lat,z) against bbox [lonMin,latMin,lonMax,latMax].
    Returns (p', q') or None. Intersection points get z linearly interpolated.
    The AOI edges are lines of constant lon / lat on the project's equirectangular grid,
    so clipping in degrees is exactly the AOI definition (no projection needed)."""
    t0, t1 = 0.0, 1.0
    dx, dy = q[0] - p[0], q[1] - p[1]
    for pk, qk in ((-dx, p[0] - bb[0]), (dx, bb[2] - p[0]), (-dy, p[1] - bb[1]), (dy, bb[3] - p[1])):
        if pk == 0:
            if qk < 0:
                return None
            continue
        t = qk / pk
        if pk < 0:
            t0 = max(t0, t)
        else:
            t1 = min(t1, t)
        if t0 > t1:
            return None

    def lerp(t):
        return [p[i] + t * (q[i] - p[i]) for i in range(len(p))]

    return (p if t0 == 0.0 else lerp(t0)), (q if t1 == 1.0 else lerp(t1))


def clip_line(coords, bb):
    """Clip a polyline to the bbox. Returns a list of pieces (each a list of vertices).
    Original vertices inside the AOI are kept byte-for-byte; only boundary crossings are new."""
    pieces, cur = [], []
    for p, q in zip(coords, coords[1:]):
        c = clip_segment(p, q, bb)
        if c is None:
            if cur:
                pieces.append(cur)
                cur = []
            continue
        a, b = c
        if not cur:
            cur = [a]
        elif cur[-1][:2] != a[:2]:          # re-entry after leaving the box
            pieces.append(cur)
            cur = [a]
        cur.append(b)
        if b is not q:                       # segment left the box at b
            pieces.append(cur)
            cur = []
    if cur:
        pieces.append(cur)
    return [pc for pc in pieces if len(pc) >= 2]


# ----------------------------------------------------------------------------- steps
def load_source(path):
    if not path.exists():
        sys.exit(f"ERROR: source traverse not found: {path}")
    raw = path.read_bytes()
    data = json.loads(raw)
    return data, hashlib.sha256(raw).hexdigest()


def inspect_source(data):
    """Structural + integrity inspection. Returns a dict for the report; aborts on fatal problems."""
    if data.get("type") != "FeatureCollection" or "features" not in data:
        sys.exit("ERROR: source is not a GeoJSON FeatureCollection; adapt the reader to the real structure.")
    feats = data["features"]
    rep = {"top_level_keys": list(data.keys()), "name": data.get("name"),
           "declared_crs": (data.get("crs") or {}).get("properties", {}).get("name"),
           "n_features": len(feats)}
    gtypes, keys, bad, dims = {}, set(), [], set()
    n_vert, n_dup = 0, 0
    lons, lats, zs = [], [], []
    for i, f in enumerate(feats):
        g = f.get("geometry") or {}
        gtypes[g.get("type")] = gtypes.get(g.get("type"), 0) + 1
        keys.update((f.get("properties") or {}).keys())
        cs = g.get("coordinates") or []
        n_vert += len(cs)
        for c in cs:
            dims.add(len(c))
            if len(c) < 2 or any(v is None or not isinstance(v, (int, float)) or not math.isfinite(v) for v in c):
                bad.append(i)
                break
            lons.append(c[0]); lats.append(c[1])
            if len(c) > 2:
                zs.append(c[2])
        n_dup += sum(1 for a, b in zip(cs, cs[1:]) if a == b)
    rep.update(geometry_types=gtypes, property_keys=sorted(keys), coord_dims=sorted(dims),
               n_vertices=n_vert, n_consecutive_duplicate_vertices=n_dup,
               n_features_with_invalid_coords=len(bad),
               lon_range=[min(lons), max(lons)], lat_range=[min(lats), max(lats)],
               z_range=[min(zs), max(zs)] if zs else None)
    if bad:
        sys.exit(f"ERROR: features with invalid coordinates: {bad[:10]}")
    if set(gtypes) != {"LineString"}:
        sys.exit(f"ERROR: unexpected geometry types {gtypes}")
    # Coordinate-frame sanity: Jezero is ~77.4 E, ~18.4 N. If values look like [lat, lon]
    # or -180..180 longitudes, stop: we never silently swap axes.
    if not (0 <= rep["lon_range"][0] and rep["lon_range"][1] <= 360):
        sys.exit("ERROR: longitudes outside 0-360 E; normalise explicitly before running.")
    if not (70 < rep["lon_range"][0] < 85 and 15 < rep["lat_range"][0] < 22):
        sys.exit("ERROR: coordinates are not at Jezero ([lon,lat] order?). Check the source.")
    return rep


def order_and_check_drives(feats, gap_m):
    """Order by (sol, SCLK_START); report RMC/geometry continuity between consecutive drives
    and duplicate drives (same fromRMC->toRMC). Nothing is deleted here."""
    order = sorted(range(len(feats)), key=lambda i: (feats[i]["properties"]["sol"],
                                                    feats[i]["properties"]["SCLK_START"]))
    is_file_order = order == list(range(len(feats)))
    breaks, dups = [], []
    for a, b in zip(order, order[1:]):
        pa, pb = feats[a]["properties"], feats[b]["properties"]
        ga, gb = feats[a]["geometry"]["coordinates"], feats[b]["geometry"]["coordinates"]
        jump = seg_len_m(ga[-1], gb[0])
        if (pa["fromRMC"], pa["toRMC"]) == (pb["fromRMC"], pb["toRMC"]):
            dups.append({"sol_a": pa["sol"], "sol_b": pb["sol"], "rmc": f'{pa["fromRMC"]}->{pa["toRMC"]}'})
        if jump > gap_m or pa["toRMC"] != pb["fromRMC"]:
            breaks.append({"after_sol": pa["sol"], "before_sol": pb["sol"], "jump_m": round(jump, 2),
                           "toRMC": pa["toRMC"], "next_fromRMC": pb["fromRMC"]})
    return order, is_file_order, breaks, dups


def load_aoi(meta_path):
    if not meta_path.exists():
        sys.exit(f"ERROR: AOI (meta.json) not found: {meta_path}. Ask Gabriel; do not invent a bbox.")
    meta = json.loads(meta_path.read_text())
    bb = meta.get("bbox")
    if not (isinstance(bb, list) and len(bb) == 4 and all(isinstance(v, (int, float)) for v in bb)):
        sys.exit("ERROR: meta.bbox must be [lonMin, latMin, lonMax, latMax]")
    if not (bb[0] < bb[2] and bb[1] < bb[3] and 0 <= bb[0] and bb[2] <= 360 and -90 <= bb[1] and bb[3] <= 90):
        sys.exit(f"ERROR: incoherent bbox {bb}")
    latc = (bb[1] + bb[3]) / 2
    w_m = (bb[2] - bb[0]) * DEG * R_MARS_M * math.cos(latc * DEG)
    h_m = (bb[3] - bb[1]) * DEG * R_MARS_M
    info = {"site": meta.get("site"), "bbox": bb, "width_m": round(w_m, 1), "height_m": round(h_m, 1),
            "grid": [meta.get("width"), meta.get("height")], "cell_m": meta.get("cell_m"),
            "grid_extent_m": [meta.get("width", 0) * meta.get("cell_m", 0)] * 2,
            "habitat": meta.get("habitat")}
    if meta.get("site") != "jezero":
        print(f"WARNING: meta.site = {meta.get('site')!r} (expected 'jezero')")
    hab = meta.get("habitat")
    if hab and not inside(hab, bb):
        sys.exit("ERROR: meta.habitat is outside meta.bbox")
    return meta, info


def build_output(feats, order, bb, exclude_sols, src_name, sha, aoi_info):
    out_feats, log = [], []
    for i in order:
        f = feats[i]
        p = dict(f["properties"])
        cs = f["geometry"]["coordinates"]
        pieces = clip_line(cs, bb)
        if not pieces:
            continue
        if p["sol"] in exclude_sols:
            log.append({"sol": p["sol"], "action": "excluded", "reason": exclude_sols[p["sol"]]})
            continue
        if line_len_m(cs) == 0.0:
            # length 0 in the source too: RMC site increment with no motion -> a degenerate
            # (invalid) LineString. Position is kept in the report, not as geometry.
            log.append({"sol": p["sol"], "action": "excluded",
                        "reason": f"longitud 0 (source length={p['length']}): cambio de site "
                                  f"{p['fromRMC']}->{p['toRMC']} sin movimiento",
                        "position": cs[0]})
            continue
        fully_inside = all(inside(c, bb) for c in cs)
        for k, pc in enumerate(pieces):
            props = dict(p)                         # original NASA fields, untouched
            props["clipped"] = not fully_inside     # True -> this drive crosses the AOI edge
            if len(pieces) > 1:
                props["part"] = k
            props["clipped_length_m"] = round(line_len_m(pc), 2)
            out_feats.append({"type": "Feature", "properties": props,
                              "geometry": {"type": "LineString", "coordinates": pc}})
    fc = {
        "type": "FeatureCollection",
        "name": "rover_traverse_jezero",
        "crs_note": "Mars 2000 planetocéntrico, lon 0-360 E, lat +N, orden [lon, lat, z]; "
                    "z = metros (geoide MOLA, valor de la fuente). No es EPSG/WGS84 aunque la fuente diga CRS84.",
        "source": {"rover": "Perseverance", "mission": "Mars 2020 (M20)", "provider": "NASA/JPL MMGIS",
                   "url": "https://mars.nasa.gov/mmgis-maps/M20/Layers/json/M20_traverse.json",
                   "url_status": "origen esperado (capa MMGIS de NASA/JPL); el archivo no trae URL: confirmar de dónde se descargó",
                   "file": src_name, "source_layer_name": None, "sha256": sha},
        "processing": "1 Feature por sol de manejo (LineString). Recorte geométrico al bbox de meta.json "
                      "(Liang-Barsky en lon/lat, z interpolada solo en los cruces del borde). Vértices interiores "
                      "sin modificar. Sin suavizado, sin puntos inventados, sin unir discontinuidades.",
        "aoi_bbox": bb,
        "features": out_feats,
    }
    return fc, log


def connected_pieces(fc, tol_m):
    """Group consecutive output features whose end/start touch (<= tol_m)."""
    groups = []
    for f in fc["features"]:
        cs = f["geometry"]["coordinates"]
        if groups and seg_len_m(groups[-1]["end"], cs[0]) <= tol_m:
            g = groups[-1]
            g["sols"].append(f["properties"]["sol"]); g["end"] = cs[-1]; g["length_m"] += line_len_m(cs)
        else:
            groups.append({"sols": [f["properties"]["sol"]], "start": cs[0], "end": cs[-1],
                           "length_m": line_len_m(cs)})
    for g in groups:
        g["length_m"] = round(g["length_m"], 1)
        g["sol_range"] = [g["sols"][0], g["sols"][-1]]
        g["n_drives"] = len(g["sols"])
        g["start"] = [round(v, 8) for v in g["start"][:2]]
        g["end"] = [round(v, 8) for v in g["end"][:2]]
    return groups


def validate(fc, bb, feats_in, src_len_in_m):
    """Every check here is actually executed; results go to the report."""
    from shapely.geometry import LineString, box, shape
    res = {}
    aoi = box(*bb)
    res["is_featurecollection"] = fc["type"] == "FeatureCollection" and len(fc["features"]) > 0
    res["all_linestring"] = all(f["geometry"]["type"] == "LineString" for f in fc["features"])
    allc = [c for f in fc["features"] for c in f["geometry"]["coordinates"]]
    res["n_vertices"] = len(allc)
    res["all_finite"] = all(math.isfinite(v) for c in allc for v in c)
    eps = 1e-9
    res["all_inside_aoi"] = all(inside(c, bb, eps) for c in allc)
    res["lon_0_360_lat_N"] = all(0 <= c[0] <= 360 and -90 <= c[1] <= 90 for c in allc)
    geoms = [shape(f["geometry"]) for f in fc["features"]]
    res["all_valid_nonempty"] = all(g.is_valid and not g.is_empty and len(g.coords) >= 2 for g in geoms)
    steps = [seg_len_m(a, b) for f in fc["features"] for a, b in zip(f["geometry"]["coordinates"],
                                                                  f["geometry"]["coordinates"][1:])]
    res["max_step_m"] = round(max(steps), 2)
    res["no_absurd_steps"] = res["max_step_m"] < 50       # rover drives in < ~25 m steps here
    # Cross-check our clip against shapely.intersection() on the same source drives (2D).
    hd = 0.0
    for f in feats_in:
        inter = LineString([c[:2] for c in f["geometry"]["coordinates"]]).intersection(aoi)
        mine = [o for o in fc["features"] if o["properties"]["sol"] == f["properties"]["sol"]]
        if inter.is_empty or not mine:
            continue
        from shapely.ops import unary_union
        u = unary_union([LineString([c[:2] for c in o["geometry"]["coordinates"]]) for o in mine])
        hd = max(hd, inter.hausdorff_distance(u))
    res["shapely_crosscheck_hausdorff_deg"] = hd
    res["shapely_crosscheck_ok"] = hd < 1e-9
    res["clipped_length_m"] = round(sum(line_len_m(f["geometry"]["coordinates"]) for f in fc["features"]), 1)
    res["source_length_of_drives_touching_aoi_m"] = round(src_len_in_m, 1)
    return res


def make_figure(src_feats, fc, bb, meta, png, pieces=()):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    latc = (bb[1] + bb[3]) / 2
    k = math.cos(latc * DEG)                    # equal-metre aspect for lon/lat plot
    fig, axes = plt.subplots(1, 2, figsize=(15, 7.5))
    for ax, zoom in zip(axes, (False, True)):
        for f in src_feats:
            cs = f["geometry"]["coordinates"]
            ax.plot([c[0] for c in cs], [c[1] for c in cs], color="#9aa0a6", lw=0.8, zorder=1)
        for f in fc["features"]:
            cs = f["geometry"]["coordinates"]
            ax.plot([c[0] for c in cs], [c[1] for c in cs], color="#d93025", lw=1.8, zorder=3)
        ax.plot([bb[0], bb[2], bb[2], bb[0], bb[0]], [bb[1], bb[1], bb[3], bb[3], bb[1]],
                color="#1a73e8", lw=1.5, ls="--", zorder=2, label="AOI (meta.json bbox)")
        first = fc["features"][0]["geometry"]["coordinates"][0]
        last = fc["features"][-1]["geometry"]["coordinates"][-1]
        ax.scatter(*first[:2], s=70, c="#188038", marker="o", zorder=5,
                   label=f'inicio recortado (sol {fc["features"][0]["properties"]["sol"]})')
        ax.scatter(*last[:2], s=80, c="#000000", marker="s", zorder=5,
                   label=f'fin recortado (sol {fc["features"][-1]["properties"]["sol"]})')
        if meta.get("habitat"):
            ax.scatter(*meta["habitat"], s=120, marker="*", c="#f9ab00", edgecolor="k", zorder=6, label="hábitat")
        if zoom:
            for n, pc in enumerate(pieces[1:]):        # start of each new piece = data discontinuity
                ax.scatter(*pc["start"], s=90, facecolor="none", edgecolor="#e8710a", lw=2, zorder=7,
                           label="discontinuidad (re-localización ~8 m)" if n == 0 else None)
        ax.set_aspect(1 / k)
        ax.set_xlabel("Longitud (°E, planetocéntrica)")
        ax.set_ylabel("Latitud (°N)")
        if zoom:
            pad = 0.002
            ax.set_xlim(bb[0] - pad, bb[2] + pad); ax.set_ylim(bb[1] - pad, bb[3] + pad)
            ax.set_title("Zoom al AOI 3×3 km: recorrido recortado")
            ax.legend(loc="lower left", fontsize=8)
        else:
            ax.set_title("Recorrido completo M20 (gris) y AOI")
        ax.grid(alpha=0.3)
    fig.suptitle("Perseverance — M20_traverse.json recortado al AOI de Jezero (control de calidad)")
    fig.tight_layout(rect=[0, 0.02, 1, 0.94])
    fig.savefig(png, dpi=150)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--src", default="pipeline/raw/M20_traverse.json")
    ap.add_argument("--meta", default="web/public/data/jezero/meta.json")
    ap.add_argument("--out", default="web/public/data/jezero/rover_traverse.geojson")
    ap.add_argument("--report-dir", default="pipeline/out")
    ap.add_argument("--gap-m", type=float, default=1.0,
                    help="jump between consecutive drives (m) above which they are a separate piece")
    ap.add_argument("--keep-duplicates", action="store_true",
                    help="keep duplicate drives (same fromRMC->toRMC) instead of excluding them")
    ap.add_argument("--force", action="store_true", help="overwrite an existing output file")
    a = ap.parse_args()

    src, meta_p, out = Path(a.src), Path(a.meta), Path(a.out)
    rdir = Path(a.report_dir); rdir.mkdir(parents=True, exist_ok=True)
    if out.exists() and not a.force:
        sys.exit(f"ERROR: {out} exists. Re-run with --force to overwrite (source data is never modified).")

    # 1-2 load + inspect
    data, sha = load_source(src)
    insp = inspect_source(data)
    feats = data["features"]
    print(f"[1-2] {src.name}: {insp['n_features']} drives, {insp['n_vertices']} vertices, "
          f"sols {feats[0]['properties']['sol']}-{feats[-1]['properties']['sol']}, declared CRS {insp['declared_crs']}")

    # 3 order
    order, file_order_ok, breaks, dups = order_and_check_drives(feats, a.gap_m)
    print(f"[3] order by (sol, SCLK_START) == file order: {file_order_ok}; "
          f"{len(breaks)} discontinuities, {len(dups)} duplicate drives in the whole file")

    # 4 AOI
    meta, aoi = load_aoi(meta_p)
    bb = aoi["bbox"]
    print(f"[4] AOI {bb} ~ {aoi['width_m']} x {aoi['height_m']} m (grid {aoi['grid_extent_m']} m)")

    # 5 compatibility: both are Mars planetocentric lon 0-360E / lat N, [lon,lat] order.
    lon_ok = 0 <= bb[0] <= 360 and insp["lon_range"][0] >= 0
    print(f"[5] frames compatible (0-360E, [lon,lat]): {lon_ok}; no transformation applied")

    # 6 clip
    from shapely.geometry import LineString, box
    aoi_poly = box(*bb)
    touching = [feats[i] for i in order
                if LineString([c[:2] for c in feats[i]["geometry"]["coordinates"]]).intersects(aoi_poly)]
    touching_sols = {f["properties"]["sol"] for f in touching}
    exclude = {}
    if not a.keep_duplicates:
        for d in dups:
            if d["sol_a"] in touching_sols and d["sol_b"] in touching_sols:
                # keep the first; exclude the second unless its z is not plausible -> report both
                fb = next(f for f in touching if f["properties"]["sol"] == d["sol_b"])
                zb = [c[2] for c in fb["geometry"]["coordinates"] if len(c) > 2]
                note = (f"duplicado de sol {d['sol_a']} (mismo RMC {d['rmc']})"
                        + ("; z no plausible (~0 m, el terreno está a ~-2545 m)" if zb and max(abs(z) for z in zb) < 1 else ""))
                exclude[d["sol_b"]] = note
    fc, excl_log = build_output(feats, order, bb, exclude, src.name, sha, aoi)
    fc["source"]["source_layer_name"] = data.get("name")
    if not fc["features"]:
        sys.exit("ERROR: no part of the traverse intersects the AOI. Check bbox and coordinate order. Nothing exported.")
    pieces = connected_pieces(fc, a.gap_m)
    print(f"[6] {len(touching)} drives touch the AOI -> {len(fc['features'])} LineString features, "
          f"{len(pieces)} connected pieces; excluded: {excl_log}")

    # 7 validate
    src_len = sum(line_len_m(f["geometry"]["coordinates"]) for f in touching)
    val = validate(fc, bb, touching, src_len)
    print(f"[7] validation: {json.dumps(val)}")
    hard = ["is_featurecollection", "all_linestring", "all_finite", "all_inside_aoi",
            "lon_0_360_lat_N", "all_valid_nonempty", "no_absurd_steps", "shapely_crosscheck_ok"]
    failed = [h for h in hard if not val[h]]
    if failed:
        sys.exit(f"ERROR: validation failed {failed}; nothing exported.")

    # 8 export (json module: exact coordinates, keeps z and order, no terrestrial CRS stamped)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(fc, ensure_ascii=False, separators=(",", ":")))
    import geopandas as gpd                                # re-read check, like the frontend would
    g = gpd.read_file(out)
    print(f"[8] wrote {out} ({out.stat().st_size/1024:.1f} KB); geopandas re-read: {len(g)} rows, "
          f"types {sorted(set(g.geom_type))}")

    # 9 report
    all_len = sum(line_len_m(f["geometry"]["coordinates"]) for f in feats)
    breaks_in = [b for b in breaks if b["after_sol"] in touching_sols or b["before_sol"] in touching_sols]
    report = {"source": {"file": str(src), "sha256": sha, **insp,
                         "ordered_by": "(sol, SCLK_START)", "file_order_is_chronological": file_order_ok,
                         "sum_length_property_km": round(sum(f["properties"]["length"] for f in feats) / 1000, 3),
                         "computed_length_km": round(all_len / 1000, 3),
                         "discontinuities_whole_file": breaks, "duplicate_drives_whole_file": dups},
              "aoi": aoi,
              "clip": {"drives_touching_aoi": len(touching),
                       "sol_range": [min(touching_sols), max(touching_sols)],
                       "excluded": excl_log, "discontinuities_in_aoi": breaks_in,
                       "output_features": len(fc["features"]),
                       "output_vertices": val["n_vertices"],
                       "connected_pieces": pieces},
              "validation": val}
    (rdir / "rover_traverse_report.json").write_text(json.dumps(report, indent=2, ensure_ascii=False))
    print(f"[9] report -> {rdir/'rover_traverse_report.json'}")

    # 10 figure
    png = rdir / "rover_traverse_check.png"
    make_figure(feats, fc, bb, meta, png, pieces)
    print(f"[10] figure -> {png}")


if __name__ == "__main__":
    main()
