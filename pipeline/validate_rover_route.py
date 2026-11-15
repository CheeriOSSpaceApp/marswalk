#!/usr/bin/env python3
"""Compare MarsWalk's EVA route with the real Perseverance traverse.

The report measures slope and hazard distributions in the whole AOI versus a
20 m corridor around the rover traverse, then reports what fraction of the
MarsWalk route is within 20 m of the rover between the selected waypoints.

Usage from the repository root:
  python pipeline/validate_rover_route.py
  python pipeline/validate_rover_route.py --route pipeline/out/jezero_eva_route.geojson
"""
import argparse
import json
import math
from pathlib import Path

import numpy as np

R_MARS_M = 3_396_190.0
DEG = math.pi / 180.0


def distance_m(a, b, lat0):
    dx = (b[0] - a[0]) * DEG * R_MARS_M * math.cos(lat0 * DEG)
    dy = (b[1] - a[1]) * DEG * R_MARS_M
    return math.hypot(dx, dy)


def point_segment_distance_m(p, a, b, lat0):
    scale_x = DEG * R_MARS_M * math.cos(lat0 * DEG)
    scale_y = DEG * R_MARS_M
    px, py = p[0] * scale_x, p[1] * scale_y
    ax, ay = a[0] * scale_x, a[1] * scale_y
    bx, by = b[0] * scale_x, b[1] * scale_y
    vx, vy = bx - ax, by - ay
    denom = vx * vx + vy * vy
    t = 0.0 if denom == 0 else max(0.0, min(1.0, ((px - ax) * vx + (py - ay) * vy) / denom))
    return math.hypot(px - (ax + t * vx), py - (ay + t * vy))


def nearest_distance_m(point, lines, lat0):
    return min(point_segment_distance_m(point, a, b, lat0)
               for line in lines for a, b in zip(line, line[1:]))


def histogram(values):
    values = np.asarray(values)
    n = len(values)
    return {
        "0-5_deg": round(100 * np.mean(values < 5), 1),
        "5-10_deg": round(100 * np.mean((values >= 5) & (values < 10)), 1),
        "10-15_deg": round(100 * np.mean((values >= 10) & (values < 15)), 1),
        "15+_deg": round(100 * np.mean(values >= 15), 1),
        "samples": int(n),
    }


def hazard_histogram(values):
    values = np.asarray(values)
    return {f"hazard_{i}": round(100 * np.mean(values == i), 1) for i in (0, 1, 2)} | {
        "samples": int(len(values))
    }


def load_lines(path):
    data = json.loads(path.read_text())
    return [f["geometry"]["coordinates"] for f in data["features"]
            if f.get("geometry", {}).get("type") == "LineString"]


def raster_cells_near_lines(lines, meta, radius_m):
    width, height = meta["width"], meta["height"]
    lon_min, lat_min, lon_max, lat_max = meta["bbox"]
    lat0 = (lat_min + lat_max) / 2
    cell_x = (lon_max - lon_min) * DEG * R_MARS_M * math.cos(lat0 * DEG) / width
    cell_y = (lat_max - lat_min) * DEG * R_MARS_M / height
    cells = set()
    for line in lines:
        for lon, lat, *_ in line:
            col = int((lon - lon_min) / (lon_max - lon_min) * width)
            row = int((lat_max - lat) / (lat_max - lat_min) * height)
            radius_x = math.ceil(radius_m / cell_x)
            radius_y = math.ceil(radius_m / cell_y)
            for dr in range(-radius_y, radius_y + 1):
                for dc in range(-radius_x, radius_x + 1):
                    r, c = row + dr, col + dc
                    if 0 <= r < height and 0 <= c < width:
                        cells.add(r * width + c)
    return np.fromiter(cells, dtype=np.int64)


def make_figure(report, out):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    labels = ["0–5°", "5–10°", "10–15°", "15°+"]
    keys = ["0-5_deg", "5-10_deg", "10-15_deg", "15+_deg"]
    area = [report["area"]["slope"][k] for k in keys]
    rover = [report["rover_20m_corridor"]["slope"][k] for k in keys]
    hazard_keys = ["hazard_0", "hazard_1", "hazard_2"]
    x = np.arange(len(labels))
    fig, axes = plt.subplots(1, 2, figsize=(10, 4.5))
    axes[0].bar(x - 0.2, area, 0.4, label="Whole AOI", color="#6b7280")
    axes[0].bar(x + 0.2, rover, 0.4, label="Rover ±20 m", color="#f59e0b")
    axes[0].set_title("Slope distribution")
    axes[0].set_ylabel("Cells (%)")
    axes[0].set_xticks(x, labels)
    axes[0].legend()
    axes[1].bar(["Free", "Caution", "Forbidden"],
                [report["area"]["hazard"][k] for k in hazard_keys],
                color=["#9ca3af", "#facc15", "#ef4444"], label="Whole AOI")
    axes[1].bar(np.arange(3) + 0.25,
                [report["rover_20m_corridor"]["hazard"][k] for k in hazard_keys],
                0.25, color=["#374151", "#ca8a04", "#b91c1c"], label="Rover ±20 m")
    axes[1].set_title("Hazard distribution")
    axes[1].set_ylabel("Cells (%)")
    axes[1].set_xticks(np.arange(3) + 0.125, ["Free", "Caution", "Forbidden"])
    axes[1].legend()
    fig.suptitle("MarsWalk validation against Perseverance traverse")
    fig.tight_layout()
    fig.savefig(out, dpi=160)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--site", type=Path, default=Path("web/public/data/jezero"))
    parser.add_argument("--route", type=Path, default=Path("pipeline/out/jezero_eva_route.geojson"))
    parser.add_argument("--rover", type=Path, default=None)
    parser.add_argument("--out", type=Path, default=Path("pipeline/out/rover_route_validation.json"))
    args = parser.parse_args()
    rover_path = args.rover or args.site / "rover_traverse.geojson"
    meta = json.loads((args.site / "meta.json").read_text())
    slope = np.fromfile(args.site / "slope.f32", "<f4")
    hazard = np.fromfile(args.site / "hazard.u8", "u1")
    expected = meta["width"] * meta["height"]
    if len(slope) != expected or len(hazard) != expected:
        raise SystemExit("Raster size does not match meta.json")
    rover_lines = load_lines(rover_path)
    route_lines = load_lines(args.route)
    if not rover_lines or not route_lines:
        raise SystemExit("Both rover and MarsWalk route GeoJSON files need LineStrings")
    rover_cells = raster_cells_near_lines(rover_lines, meta, 20.0)
    lat0 = sum(meta["bbox"][1::2]) / 2
    route = route_lines[0]
    route_distances = [nearest_distance_m(p, rover_lines, lat0) for p in route]
    report = {
        "site": meta["site"],
        "corridor_radius_m": 20,
        "waypoints": {
            "from": "habitat-threeforks-lz",
            "to": "sci-wildcat-ridge",
        },
        "area": {
            "slope": histogram(slope),
            "hazard": hazard_histogram(hazard),
        },
        "rover_20m_corridor": {
            "slope": histogram(slope[rover_cells]),
            "hazard": hazard_histogram(hazard[rover_cells]),
            "cells": int(len(rover_cells)),
        },
        "marswalk_route_vs_rover": {
            "route_vertices": len(route),
            "within_20m_pct": round(100 * np.mean(np.asarray(route_distances) <= 20), 1),
            "median_distance_m": round(float(np.median(route_distances)), 1),
            "max_distance_m": round(float(np.max(route_distances)), 1),
        },
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=2))
    figure = args.out.with_suffix(".png")
    make_figure(report, figure)
    print(json.dumps(report, indent=2))
    print(f"Figure: {figure}")


if __name__ == "__main__":
    main()
