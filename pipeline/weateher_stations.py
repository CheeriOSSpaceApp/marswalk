"""Propone WS-1, WS-2 y WS-3 con filtros de terreno y ranking VIKOR.

Guardar junto a calcstations.py en pipeline/ y ejecutar:
    .venv/bin/python pipeline/weather_stations.py

Primera ejecución: selecciona en el mapa el centro del cráter, su borde NORTE y
una zona abierta de referencia al noreste. Las tres selecciones se guardan para
repetir el cálculo. --select permite elegirlas de nuevo.

También admite --center FILA COLUMNA --rim FILA COLUMNA --reference FILA COLUMNA.
Los umbrales de instalación, las zonas circulares y los pesos son decisiones
configurables del equipo; las propuestas requieren revisión visual y del planner.
"""

import argparse
import csv
import math
import sys
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
from scipy import ndimage

from calcstations import cell_to_coordinates, coordinates_to_cell, cost_to_safety, load_cost_grid, read_json, validate_meta, walking_distances, write_json

ROOT = Path(__file__).resolve().parents[1]
SOURCE = "pipeline/weather_stations.py VIKOR terrain-screened proposal"
ROLES = {
    "WS-1": {"name": "Reference Station", "purpose": "Baseline wind, temperature, pressure and dust", "role": "reference"},
    "WS-2": {"name": "Crater Floor", "purpose": "Compare crater-floor temperature and possible local wind circulation", "role": "crater_floor"},
    "WS-3": {"name": "Crater Rim", "purpose": "Compare higher-terrain wind exposure with the crater floor", "role": "crater_rim"},
}


def load_layer(path, shape, dtype):
    expected = math.prod(shape) * np.dtype(dtype).itemsize
    if Path(path).stat().st_size != expected:
        raise ValueError(f"Tamaño incorrecto: {path}; se esperaban {expected} bytes.")
    return np.fromfile(path, dtype=dtype).reshape(shape)


def normalize_loss(values, direction):
    low, high = float(values.min()), float(values.max())
    if high == low:
        return values * 0.0
    if direction == "cost":
        return (values - low) / (high - low)
    if direction == "benefit":
        return (high - values) / (high - low)
    raise ValueError(f"Dirección de criterio desconocida: {direction}.")


def vikor(table, directions, weights=None, v=0.5):
    if table.empty or not 0 <= v <= 1:
        raise ValueError("VIKOR necesita candidatas y 0 <= v <= 1.")
    result = table.copy().reset_index(drop=True)
    criteria = result[list(directions)].astype(float)
    if not np.isfinite(criteria.to_numpy()).all():
        raise ValueError("VIKOR recibió criterios con NaN o Infinity.")
    weights = {name: 1.0 for name in directions} if weights is None else weights
    if set(weights) != set(directions):
        raise ValueError(f"Los pesos deben incluir exactamente estos criterios: {list(directions)}.")
    weight = pd.Series(weights, dtype=float).reindex(list(directions))
    if not np.isfinite(weight.to_numpy()).all() or (weight < 0).any() or weight.sum() <= 0:
        raise ValueError("Los pesos deben ser finitos, no negativos y sumar más de cero.")
    weight = weight / weight.sum()
    loss = pd.DataFrame(index=result.index)
    for name, direction in directions.items():
        loss[name] = normalize_loss(criteria[name], direction)
    weighted = loss.mul(weight, axis="columns")
    result["Si"] = weighted.sum(axis=1)
    result["Ri"] = weighted.max(axis=1)
    s_term = normalize_loss(result["Si"], "cost")
    r_term = normalize_loss(result["Ri"], "cost")
    result["Qi"] = v * s_term + (1 - v) * r_term
    tie_columns = [name for name in ("walking_distance_m", "row", "column") if name in result.columns]
    result = result.sort_values(["Qi", "Si", "Ri", *tie_columns], kind="stable").reset_index(drop=True)
    count = len(result)
    dq = 1.0 / (count - 1) if count > 1 else 0.0
    advantage = count == 1 or float(result.loc[1, "Qi"] - result.loc[0, "Qi"]) >= dq
    stability = bool(np.isclose(result.loc[0, "Si"], result["Si"].min(), rtol=0, atol=1e-12) or np.isclose(result.loc[0, "Ri"], result["Ri"].min(), rtol=0, atol=1e-12))
    if advantage and stability:
        compromise = result.index == 0
    elif advantage:
        compromise = result.index < 2
    else:
        compromise = result["Qi"] - result.loc[0, "Qi"] < dq
    result["compromise"] = compromise
    details = {"v": float(v), "weights": weight.to_dict(), "directions": directions, "acceptable_advantage": bool(advantage), "acceptable_stability": stability, "DQ": dq, "compromise_candidates": int(result["compromise"].sum())}
    return result, details


def context_figure(z, reachable, habitat):
    fig, ax = plt.subplots(figsize=(10, 9))
    image = ax.imshow(z, cmap="terrain", origin="upper", interpolation="nearest")
    if reachable.any() and not reachable.all():
        ax.contour(reachable.astype(np.uint8), levels=[0.5], colors=["magenta"], linewidths=0.4)
    ax.scatter(habitat[1], habitat[0], color="cyan", marker="*", edgecolors="black", s=150, label="Hábitat")
    fig.colorbar(image, ax=ax, label="Elevación (m)")
    ax.set_xlabel("Columna del grid")
    ax.set_ylabel("Fila del grid")
    ax.legend(loc="upper right")
    return fig, ax


def pick_regions(z, reachable, habitat):
    backends = ["MacOSX", "TkAgg", "QtAgg"] if sys.platform == "darwin" else ["TkAgg", "QtAgg"]
    for backend in backends:
        try:
            plt.switch_backend(backend)
            break
        except (ImportError, RuntimeError):
            continue
    else:
        raise RuntimeError("No hay backend gráfico interactivo. Usa --center FILA COLUMNA --rim FILA COLUMNA --reference FILA COLUMNA mirando weather_station_context.png.")
    fig, ax = context_figure(z, reachable, habitat)
    ax.set_title("3 clics: 1) centro del cráter  2) borde NORTE  3) referencia abierta al NE")
    plt.show(block=False)
    points = plt.ginput(3, timeout=-1, show_clicks=True)
    plt.close(fig)
    plt.switch_backend("Agg")
    if len(points) != 3:
        raise ValueError("La selección necesita tres puntos; vuelve a ejecutar con --select.")
    points = [[float(y), float(x)] for x, y in points]
    return {"center": points[0], "rim": points[1], "reference": points[2]}


def geometry_masks(selection, meta, z, reference_search):
    shape = z.shape
    center, rim, reference = [np.asarray(selection[name], dtype=float) for name in ("center", "rim", "reference")]
    for point in (center, rim, reference):
        if point.shape != (2,) or not np.isfinite(point).all() or not (0 <= point[0] < shape[0] and 0 <= point[1] < shape[1]):
            raise ValueError("Los puntos seleccionados deben estar dentro del grid, en orden FILA COLUMNA.")
    cell_m = float(meta["cell_m"])
    radius = float(np.linalg.norm(rim - center) * cell_m)
    if radius < 3 * cell_m or rim[0] >= center[0]:
        raise ValueError("Selecciona el centro y un punto del borde NORTE de un cráter de al menos tres celdas de radio.")
    if np.linalg.norm(reference - center) * cell_m <= 1.25 * radius:
        raise ValueError("El punto de referencia debe quedar fuera del cráter; elige terreno abierto al noreste.")
    rows, cols = np.indices(shape)
    dr, dc = rows - center[0], cols - center[1]
    radial = np.hypot(dr, dc) * cell_m
    to_reference = np.hypot(rows - reference[0], cols - reference[1]) * cell_m
    to_rim = np.hypot(rows - rim[0], cols - rim[1]) * cell_m
    floor = radial <= 0.45 * radius
    rim_zone = (radial >= 0.85 * radius) & (radial <= 1.20 * radius) & (dr < 0) & (np.abs(dc) <= -dr)
    finite = np.isfinite(z)
    if not (floor & finite).any() or not (rim_zone & finite).any():
        raise ValueError("No hay elevación válida para comprobar el fondo y borde seleccionados.")
    floor_median = float(np.median(z[floor & finite]))
    rim_median = float(np.median(z[rim_zone & finite]))
    if rim_median <= floor_median:
        raise ValueError("La elevación no confirma una depresión: revisa centro y borde del cráter con --select.")
    midpoint = (floor_median + rim_median) / 2
    floor = floor & (z <= midpoint)
    rim_zone = rim_zone & (z >= midpoint)
    reference_zone = (radial >= 1.25 * radius) & (to_reference <= reference_search)
    masks = {"WS-1": reference_zone, "WS-2": floor, "WS-3": rim_zone}
    distances = {"WS-1": to_reference, "WS-2": radial, "WS-3": to_rim}
    evidence = {"radius_m": radius, "floor_median_m": floor_median, "north_rim_median_m": rim_median, "zones": "floor <=0.45R; north rim 0.85R..1.20R; reference >=1.25R near selected point"}
    return masks, distances, evidence


def spaced_candidates(ranking, number, separation_m, cell_m):
    chosen = []
    for index in range(len(ranking)):
        row = ranking.iloc[index]
        cell = (int(row["row"]), int(row["column"]))
        if all(math.hypot(cell[0] - other[0], cell[1] - other[1]) * cell_m >= separation_m for other in chosen):
            chosen.append(cell)
            if len(chosen) == number:
                break
    cells = set(chosen)
    selection = [(int(row), int(col)) in cells for row, col in zip(ranking["row"], ranking["column"])]
    return ranking.loc[selection].head(number).copy()


def propose_stations(meta, z, slope, roughness, distance_m, oxygen_min, allowed, clearance, masks, role_distances, weights, v, alternatives, separation):
    features = []
    records = []
    summaries = {}
    for station_id, role in ROLES.items():
        region = masks[station_id]
        reachable = region & np.isfinite(distance_m)
        candidates = region & allowed
        summary = {"region_cells": int(region.sum()), "reachable_cells": int(reachable.sum()), "candidate_cells": int(candidates.sum())}
        if not candidates.any():
            summary["status"] = "no_reachable_cells" if not reachable.any() else "no_candidate_meets_installation_and_operation_filters"
            summaries[station_id] = summary
            records.append({"station_id": station_id, "name": role["name"], "status": summary["status"]})
            print(f"{station_id}: {summary['status']}; no se inventa una ubicación fuera de su zona.")
            continue
        rows, cols = np.nonzero(candidates)
        data = {"row": rows, "column": cols, "elevation_m": z[candidates], "slope_deg": slope[candidates], "roughness_m": roughness[candidates], "walking_distance_m": distance_m[candidates], "oxygen_to_habitat_min": oxygen_min[candidates], "clearance_m": clearance[candidates], "role_distance_m": role_distances[station_id][candidates]}
        table = pd.DataFrame(data)
        directions = {"slope_deg": "cost", "roughness_m": "cost", "oxygen_to_habitat_min": "cost", "clearance_m": "benefit", "role_distance_m": "cost"}
        if station_id == "WS-2":
            directions["elevation_m"] = "cost"
        elif station_id == "WS-3":
            directions["elevation_m"] = "benefit"
        ranking, details = vikor(table, directions, weights.get(station_id), v)
        selected = spaced_candidates(ranking, alternatives, separation, float(meta["cell_m"]))
        for alternative_number, (_, candidate) in enumerate(selected.iterrows(), start=1):
            cell = (int(candidate["row"]), int(candidate["column"]))
            lon, lat = cell_to_coordinates(cell, meta)
            record = {"station_id": station_id, "name": role["name"], "status": "proposal", "alternative": alternative_number, "longitude": lon, "latitude": lat, "row": cell[0], "column": cell[1], "elevation_m": float(candidate["elevation_m"]), "slope_deg": float(candidate["slope_deg"]), "roughness_m": float(candidate["roughness_m"]), "walking_distance_m": float(candidate["walking_distance_m"]), "oxygen_to_habitat_min": float(candidate["oxygen_to_habitat_min"]), "clearance_m": float(candidate["clearance_m"]), "Si": float(candidate["Si"]), "Ri": float(candidate["Ri"]), "Qi": float(candidate["Qi"]), "compromise": bool(candidate["compromise"])}
            records.append(record)
            if alternative_number == 1:
                properties = {**record, "id": station_id, "kind": "weather_station", "station_type": role["role"], "purpose": role["purpose"], "source": SOURCE, "requires_visual_review": True, "requires_planner_validation": True, "notes": "VIKOR terrain-screened proposal. Open terrain and wind exposure require inspection; no measured weather prediction is inferred from the DEM."}
                feature = {"type": "Feature", "geometry": {"type": "Point", "coordinates": [lon, lat]}, "properties": properties}
                features.append(feature)
                print(f"{station_id}: lon={lon:.8f}, lat={lat:.8f}, slope={record['slope_deg']:.2f} deg, route={record['walking_distance_m']:.1f} m, Qi={record['Qi']:.4f}")
        summary.update({"status": "proposal", "vikor": details, "reported_alternatives": len(selected)})
        summaries[station_id] = summary
    return features, records, summaries


def save_csv(path, records):
    columns = ["station_id", "name", "status", "alternative", "longitude", "latitude", "row", "column", "elevation_m", "slope_deg", "roughness_m", "walking_distance_m", "oxygen_to_habitat_min", "clearance_m", "Si", "Ri", "Qi", "compromise"]
    temporary = path.with_name(path.name + ".tmp")
    with temporary.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=columns)
        writer.writeheader()
        writer.writerows(records)
    temporary.replace(path)


def save_map(path, z, reachable, habitat, selection, evidence, features):
    fig, ax = context_figure(z, reachable, habitat)
    center = selection["center"]
    cell_m = evidence["cell_m"]
    circle = plt.Circle((center[1], center[0]), evidence["radius_m"] / cell_m, fill=False, color="white", linewidth=1.3, linestyle="--")
    ax.add_patch(circle)
    colors = {"WS-1": "#00BFC4", "WS-2": "#E69F00", "WS-3": "#A463F2"}
    for feature in features:
        properties = feature["properties"]
        station_id = properties["id"]
        ax.scatter(properties["column"], properties["row"], color=colors[station_id], edgecolors="black", marker="D", s=90, label=f"{station_id}: {properties['name']}")
        ax.annotate(station_id, xy=(properties["column"], properties["row"]), xytext=(6, 7), textcoords="offset points", color="white", bbox={"facecolor": "black", "alpha": 0.7, "pad": 1})
    ax.set_title(f"Estaciones meteorológicas propuestas: {len(features)}/3; VIKOR por función")
    ax.legend(loc="upper right")
    fig.tight_layout()
    fig.savefig(path, dpi=160)
    plt.close(fig)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--site-dir", type=Path, default=ROOT / "web/public/data/jezero")
    parser.add_argument("--params", type=Path, default=ROOT / "web/public/data/common/params.json")
    parser.add_argument("--cost-grid", type=Path, default=ROOT / "pipeline/validation/cost_grid.f32")
    parser.add_argument("--output-dir", type=Path, default=ROOT / "pipeline/validation")
    parser.add_argument("--center", nargs=2, type=float, metavar=("ROW", "COLUMN"))
    parser.add_argument("--rim", nargs=2, type=float, metavar=("ROW", "COLUMN"))
    parser.add_argument("--reference", nargs=2, type=float, metavar=("ROW", "COLUMN"))
    parser.add_argument("--select", action="store_true")
    parser.add_argument("--max-distance", type=float, default=800.0)
    parser.add_argument("--site-slope", type=float, default=5.0)
    parser.add_argument("--site-roughness", type=float, default=None)
    parser.add_argument("--setback", type=float, default=15.0)
    parser.add_argument("--reference-search", type=float, default=200.0)
    parser.add_argument("--alternatives", type=int, default=3)
    parser.add_argument("--separation", type=float, default=30.0)
    parser.add_argument("--v", type=float, default=0.5)
    parser.add_argument("--weights", type=Path, help="JSON: cada WS tiene un diccionario de pesos para sus criterios.")
    args = parser.parse_args()
    numeric = [args.max_distance, args.site_slope, args.setback, args.reference_search, args.separation, args.v]
    if not np.isfinite(numeric).all() or min(numeric[:-1]) < 0 or args.reference_search <= 0 or args.alternatives < 1 or not 0 <= args.v <= 1:
        parser.error("Revisa distancias, pendiente, número de alternativas y v.")
    meta = read_json(args.site_dir / "meta.json")
    validate_meta(meta)
    params = read_json(args.params)
    shape = (meta["height"], meta["width"])
    z = load_layer(args.site_dir / "elevation.f32", shape, "<f4")
    slope = load_layer(args.site_dir / "slope.f32", shape, "<f4")
    roughness = load_layer(args.site_dir / "roughness.f32", shape, "<f4")
    hazard = load_layer(args.site_dir / "hazard.u8", shape, "u1")
    cost_grid = load_cost_grid(args.cost_grid, meta)
    valid = np.isfinite(z) & np.isfinite(slope) & np.isfinite(roughness)
    travel_allowed = valid & np.isfinite(cost_grid) & (hazard < 2) & (slope <= params["slope_forbidden_deg"]) & (roughness <= params["rough_forbidden_m"])
    travel_cost = np.where(travel_allowed, cost_grid, np.inf)
    habitat = coordinates_to_cell(*meta["habitat"], meta)
    cell_m = float(meta["cell_m"])
    distance_m = walking_distances(travel_cost, habitat, cell_m)
    reachable = np.isfinite(distance_m)
    oxygen_min = cost_to_safety(travel_cost, [habitat], cell_m)
    site_slope = min(args.site_slope, params["slope_forbidden_deg"])
    site_roughness = params["rough_caution_m"] if args.site_roughness is None else args.site_roughness
    if not np.isfinite(site_roughness) or site_roughness < 0:
        parser.error("site-roughness debe ser no negativa y finita.")
    flat = travel_allowed & (hazard == 0) & (slope <= site_slope) & (roughness <= site_roughness)
    padded = np.pad(flat, 1, mode="constant", constant_values=False)
    clearance = ndimage.distance_transform_edt(padded, sampling=(cell_m, cell_m))[1:-1, 1:-1]
    allowed = flat & reachable & (distance_m <= args.max_distance) & (clearance >= args.setback)
    args.output_dir.mkdir(parents=True, exist_ok=True)
    context_path = args.output_dir / "weather_station_context.png"
    fig, ax = context_figure(z, reachable, habitat)
    ax.set_title("Contexto: elevación; magenta delimita conectividad con el hábitat")
    fig.savefig(context_path, dpi=130)
    plt.close(fig)
    selection_path = args.output_dir / "weather_station_regions.json"
    supplied = [args.center is not None, args.rim is not None, args.reference is not None]
    signature = {name: meta[name] for name in ("bbox", "width", "height", "cell_m")}
    if any(supplied) and not all(supplied):
        parser.error("Indica center, rim y reference juntos, siempre como FILA COLUMNA.")
    if all(supplied):
        selection = {"center": args.center, "rim": args.rim, "reference": args.reference}
    elif selection_path.is_file() and not args.select:
        saved = read_json(selection_path)
        if saved.get("grid") != signature:
            raise ValueError("Cambió la metadata del mapa; vuelve a seleccionar el cráter con --select.")
        selection = saved["selection"]
    else:
        print("Selecciona tres puntos: centro del cráter, borde norte y terreno abierto al noreste para WS-1.")
        print(f"Si no abre una ventana, usa --center --rim --reference mirando {context_path}.")
        selection = pick_regions(z, reachable, habitat)
    masks, role_distances, evidence = geometry_masks(selection, meta, z, args.reference_search)
    write_json(selection_path, {"grid": signature, "coordinate_frame": "row,column pixel-center coordinates", "selection": selection})
    weights = read_json(args.weights) if args.weights else {}
    features, records, summaries = propose_stations(meta, z, slope, roughness, distance_m, oxygen_min, allowed, clearance, masks, role_distances, weights, args.v, args.alternatives, args.separation)
    assumptions = {"team_configurable": True, "site_slope_deg": site_slope, "site_roughness_m": site_roughness, "flat_terrain_setback_m": args.setback, "max_shortest_walking_distance_m": args.max_distance, "reference_search_radius_m": args.reference_search, "default_weights": "equal normalized weights per role", "v": args.v, "geographic_grid": "north-up equirectangular bbox, matching the current terrain exporter", "review": "DEM/roughness screen only; inspect rocks, structures, sensor exposure, full EVA route and planner walkback."}
    metadata = {"source": SOURCE, "complete": len(features) == 3, "selection": selection, "crater": evidence, "assumptions": assumptions, "roles": summaries, "vikor_score_scope": "Qi is normalized independently within each role; compare alternatives of the same role only.", "vikor_reference": "Opricovic & Tzeng (2004), DOI:10.1016/S0377-2217(03)00020-1"}
    output = {"type": "FeatureCollection", "metadata": metadata, "features": features}
    geojson_path = args.output_dir / "weather_stations.geojson"
    csv_path = args.output_dir / "weather_station_candidates.csv"
    map_path = args.output_dir / "weather_stations.png"
    write_json(geojson_path, output)
    save_csv(csv_path, records)
    evidence["cell_m"] = cell_m
    save_map(map_path, z, reachable, habitat, selection, evidence, features)
    print(f"Propuestas: {len(features)}/3; radio operativo máximo {args.max_distance:g} m; umbrales y pesos son supuestos configurables del equipo.")
    print(f"GeoJSON: {geojson_path.resolve()}")
    print(f"Alternativas CSV: {csv_path.resolve()}")
    print(f"Mapa: {map_path.resolve()}")
    print("Estos puntos son estaciones meteorológicas propuestas; requieren revisión visual y validación de ruta en el planner.")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, RuntimeError) as error:
        raise SystemExit(f"ERROR: {error}") from error