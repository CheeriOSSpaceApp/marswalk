"""Selecciona cachés de O2 con greedy k-center y exporta GeoJSON, CSV y PNG.

Uso principal desde la raíz del repo:
    .venv/bin/python pipeline/calcstations.py --validate

Lee pipeline/validation/cost_grid.f32, exportado con el cost.js real.
Usa ocho vecinos y distancias de celda de meta.json.
El costo acumulado está en minutos equivalentes al consumo nominal de O2.

Variante SEV, como propuesta separada: --eva-targets <geojson_de_targets_del_EVA>
Esta variante requiere targets seleccionados explícitamente, pone radiation_shelter
en true y guarda stations_sev.geojson en la carpeta de informes para coordinarlo
con Marco antes de incorporarlo a la entrada activa del planner.
"""

import argparse
import csv
import json
import subprocess
from pathlib import Path

import matplotlib
import numpy as np
from skimage.graph import MCP_Geometric

matplotlib.use("Agg")

import matplotlib.pyplot as plt
from matplotlib.colors import LinearSegmentedColormap, Normalize

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SITE = ROOT / "web/public/data/jezero"
DEFAULT_REPORTS = ROOT / "pipeline/validation"
SOURCE = "pipeline/calcstations.py greedy k-center"


def read_json(path):
    with Path(path).open("r", encoding="utf-8") as handle:
        return json.load(handle)


def write_json(path, document):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    with temporary.open("w", encoding="utf-8") as handle:
        json.dump(document, handle, indent=2, ensure_ascii=False, allow_nan=False)
    temporary.replace(path)


def validate_meta(meta):
    height, width = meta["height"], meta["width"]
    if not isinstance(height, int) or not isinstance(width, int) or height <= 0 or width <= 0:
        raise ValueError("height y width deben ser enteros positivos.")
    cell_m = float(meta["cell_m"])
    if not np.isfinite(cell_m) or cell_m <= 0:
        raise ValueError("cell_m debe ser positivo y finito.")
    bounds = np.asarray(meta["bbox"], dtype=float)
    if bounds.shape != (4,) or not np.isfinite(bounds).all() or bounds[0] >= bounds[2] or bounds[1] >= bounds[3]:
        raise ValueError("bbox no es válido.")


def coordinates_to_cell(lon, lat, meta):
    lon_min, lat_min, lon_max, lat_max = meta["bbox"]
    if not np.isfinite([lon, lat]).all() or not (lon_min <= lon <= lon_max and lat_min <= lat <= lat_max):
        raise ValueError(f"Coordenadas fuera del bbox: {lon}, {lat}.")
    col = min(int((lon - lon_min) / (lon_max - lon_min) * meta["width"]), meta["width"] - 1)
    row = min(int((lat_max - lat) / (lat_max - lat_min) * meta["height"]), meta["height"] - 1)
    return row, col


def cell_to_coordinates(cell, meta):
    row, col = cell
    if not (0 <= row < meta["height"] and 0 <= col < meta["width"]):
        raise ValueError(f"Celda fuera del grid: {cell}.")
    lon_min, lat_min, lon_max, lat_max = meta["bbox"]
    lon = lon_min + (col + 0.5) * (lon_max - lon_min) / meta["width"]
    lat = lat_max - (row + 0.5) * (lat_max - lat_min) / meta["height"]
    return [float(lon), float(lat)]


def load_cost_grid(path, meta):
    expected_bytes = meta["height"] * meta["width"] * 4
    if Path(path).stat().st_size != expected_bytes:
        raise ValueError(f"El grid debe contener exactamente {expected_bytes} bytes Float32 LE.")
    costs = np.fromfile(path, dtype="<f4").reshape(meta["height"], meta["width"])
    if np.isnan(costs).any() or (costs < 0).any():
        raise ValueError("El grid contiene NaN o costos negativos; se permiten costos no negativos y +Infinity.")
    return costs


def cost_to_safety(cost_grid, sources, cell_m):
    if not sources:
        raise ValueError("Se necesita al menos una fuente.")
    for source in sources:
        if not np.isfinite(cost_grid[source]):
            raise ValueError(f"Fuente en una celda bloqueada: {source}.")
    solver = MCP_Geometric(cost_grid, fully_connected=True, sampling=(cell_m, cell_m))
    field, _ = solver.find_costs(starts=sources)
    return field


def walking_distances(cost_grid, habitat, cell_m):
    walking_cost = np.where(np.isfinite(cost_grid), 1.0, np.inf)
    return cost_to_safety(walking_cost, [habitat], cell_m)


def load_eva_zone(path, meta, distance_m):
    document = read_json(path)
    if document.get("type") != "FeatureCollection":
        raise ValueError("Los targets del EVA deben ser un GeoJSON FeatureCollection.")
    zone = np.zeros(distance_m.shape, dtype=bool)
    for feature in document.get("features", []):
        properties = feature.get("properties") or {}
        if properties.get("kind") == "habitat":
            continue
        geometry = feature.get("geometry") or {}
        if geometry.get("type") != "Point":
            raise ValueError("Cada target del EVA debe ser un Point.")
        coordinates = geometry.get("coordinates", [])
        if len(coordinates) < 2:
            raise ValueError("Target del EVA sin longitud y latitud.")
        cell = coordinates_to_cell(float(coordinates[0]), float(coordinates[1]), meta)
        if not np.isfinite(distance_m[cell]):
            raise ValueError(f"Target del EVA inalcanzable desde el hábitat: {properties.get('id', cell)}.")
        zone[cell] = True
    if not zone.any():
        raise ValueError("No hay targets de EVA válidos en el archivo seleccionado.")
    return zone


def choose_station(cost_field, coverage_zone):
    if not coverage_zone.any():
        raise ValueError("La zona de cobertura está vacía.")
    candidates = np.where(coverage_zone, cost_field, -np.inf)
    row, col = np.unravel_index(np.argmax(candidates), cost_field.shape)
    return int(row), int(col)


def greedy_stations(cost_grid, coverage_zone, habitat, cell_m, max_stations=3, threshold=10.0):
    if not coverage_zone.any():
        raise ValueError("La zona de cobertura está vacía.")
    sources = [habitat]
    stations = []
    history = []
    field = cost_to_safety(cost_grid, sources, cell_m)
    before = field.copy()
    for k in range(max_stations + 1):
        if not np.isfinite(field[coverage_zone]).all():
            raise ValueError("Hay celdas de evaluación sin acceso a una fuente.")
        worst = float(field[coverage_zone].max())
        history.append({"k": k, "worst_o2_min": worst})
        if worst <= threshold or k == max_stations:
            break
        station = choose_station(field, coverage_zone)
        stations.append(station)
        sources.append(station)
        field = cost_to_safety(cost_grid, sources, cell_m)
    return stations, history, before, field


def save_stations(path, stations, history, meta, threshold, radiation_shelter=False):
    document = {"type": "FeatureCollection", "features": []}
    if Path(path).is_file():
        document = read_json(path)
        if document.get("type") != "FeatureCollection" or not isinstance(document.get("features"), list):
            raise ValueError("El stations.geojson existente no es un FeatureCollection válido.")
    kept = []
    for feature in document["features"]:
        properties = feature.get("properties") or {}
        generated_here = properties.get("source") == SOURCE and bool(properties.get("radiation_shelter", False)) == radiation_shelter
        if not generated_here:
            kept.append(feature)
    used_ids = {str((feature.get("properties") or {}).get("id", "")) for feature in kept}
    generated = []
    prefix = "sev-cache" if radiation_shelter else "cache"
    number = 1
    final_worst = history[-1]["worst_o2_min"]
    met = final_worst <= threshold
    for step, cell in enumerate(stations, start=1):
        while f"{prefix}-{number}" in used_ids:
            number += 1
        station_id = f"{prefix}-{number}"
        station_name = f"Refugio SEV {number}" if radiation_shelter else f"Cache {number}"
        previous = history[step - 1]["worst_o2_min"]
        current = history[step]["worst_o2_min"]
        notes = f"Greedy k-center, k={step}; worst case before/after: {previous:.2f}/{current:.2f} nominal O2 min. Final worst case: {final_worst:.2f}; threshold: {threshold:.2f}; threshold_met: {str(met).lower()}."
        if radiation_shelter:
            notes += " Variante SEV: propuesta para coordinar con Marco."
        feature = {
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": cell_to_coordinates(cell, meta)},
            "properties": {
                "id": station_id,
                "name": station_name,
                "kind": "shelter",
                "station_type": "cache",
                "radiation_shelter": bool(radiation_shelter),
                "supplies": {"o2_min": {"value": 120, "source": "Marco"}},
                "source": SOURCE,
                "notes": notes,
            },
        }
        generated.append(feature)
        used_ids.add(station_id)
        number += 1
    document["features"] = kept + generated
    write_json(path, document)
    return generated


def save_summary(path, history, stations, features, threshold):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    columns = ["k", "worst_o2_min", "threshold_o2_min", "threshold_met", "station_id", "row", "column"]
    with temporary.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=columns)
        writer.writeheader()
        for entry in history:
            k = entry["k"]
            row, col = stations[k - 1] if k else ("", "")
            station_id = features[k - 1]["properties"]["id"] if k else ""
            record = {"k": k, "worst_o2_min": entry["worst_o2_min"], "threshold_o2_min": threshold, "threshold_met": entry["worst_o2_min"] <= threshold, "station_id": station_id, "row": row, "column": col}
            writer.writerow(record)
    temporary.replace(path)


def save_comparison(path, before, after, coverage_zone, habitat, stations, features, threshold):
    cmap = LinearSegmentedColormap.from_list("access_purple", ["#F1E6FF", "#BA80E6", "#692399"]).with_extremes(bad="black")
    norm = Normalize(vmin=0, vmax=max(float(before[coverage_zone].max()), 1e-9))
    fig, axes = plt.subplots(1, 2, figsize=(15, 7), constrained_layout=True)
    fields = [before, after]
    titles = ["Antes: solo hábitat", f"Después: hábitat + {len(stations)} estaciones nuevas"]
    for ax, field, title in zip(axes, fields, titles):
        display = np.ma.masked_where(~coverage_zone, field)
        image = ax.imshow(display, cmap=cmap, norm=norm, origin="upper", interpolation="nearest")
        ax.scatter(habitat[1], habitat[0], color="cyan", marker="*", edgecolors="black", s=150, label="Hábitat")
        worst = float(field[coverage_zone].max())
        ax.set_title(f"{title}; peor caso {worst:.2f} min O2 nominales")
        ax.set_xlabel("Columna del grid")
        ax.set_ylabel("Fila del grid")
    if stations:
        rows, cols = zip(*stations)
        axes[1].scatter(cols, rows, color="#FFD166", marker="^", edgecolors="black", s=85, label="Estación nueva")
        for cell, feature in zip(stations, features):
            axes[1].annotate(feature["properties"]["id"], xy=(cell[1], cell[0]), xytext=(6, 6), textcoords="offset points", color="white", fontsize=8, bbox={"facecolor": "black", "alpha": 0.7, "edgecolor": "none", "pad": 1})
    for ax in axes:
        ax.legend(loc="upper right")
    fig.colorbar(image, ax=axes.tolist(), label="Minutos equivalentes de O2 al lugar seguro más cercano")
    result = "CUMPLIDO" if float(after[coverage_zone].max()) <= threshold else "NO CUMPLIDO"
    fig.suptitle(f"Cobertura greedy k-center; umbral {threshold:g} min: {result}")
    fig.supxlabel("Negro: fuera de la zona evaluada o no transitable. Ambos paneles comparten la misma escala.")
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    fig.savefig(temporary, format="png", dpi=160)
    plt.close(fig)
    temporary.replace(path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--site-dir", type=Path, default=DEFAULT_SITE)
    parser.add_argument("--cost-grid", type=Path, default=DEFAULT_REPORTS / "cost_grid.f32")
    parser.add_argument("--report-dir", type=Path, default=DEFAULT_REPORTS)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--max-stations", type=int, default=None)
    parser.add_argument("--threshold", type=float, default=10.0)
    parser.add_argument("--walkback", type=float, default=1770.0)
    parser.add_argument("--eva-targets", type=Path, help="GeoJSON que contiene solamente los targets seleccionados del EVA; activa la propuesta SEV.")
    parser.add_argument("--validate", action="store_true", help="Ejecuta node test/validate_data.mjs jezero desde web.")
    args = parser.parse_args()
    is_sev = args.eva_targets is not None
    max_stations = args.max_stations if args.max_stations is not None else (1 if is_sev else 3)
    if max_stations < 0 or not np.isfinite([args.threshold, args.walkback]).all() or args.threshold < 0 or args.walkback < 0:
        parser.error("max-stations, threshold y walkback deben ser no negativos y finitos.")
    stem = "stations_sev" if is_sev else "stations"
    default_output = args.report_dir / "stations_sev.geojson" if is_sev else args.site_dir / "stations.geojson"
    output = args.output if args.output is not None else default_output
    active_output = DEFAULT_SITE / "stations.geojson"
    if args.validate and (args.site_dir.resolve() != DEFAULT_SITE.resolve() or output.resolve() != active_output.resolve()):
        parser.error("--validate comprueba la entrada activa web/public/data/jezero/stations.geojson; las propuestas separadas se guardan sin esta opción.")
    meta = read_json(args.site_dir / "meta.json")
    validate_meta(meta)
    cost_grid = load_cost_grid(args.cost_grid, meta)
    habitat = coordinates_to_cell(*meta["habitat"], meta)
    cell_m = float(meta["cell_m"])
    distance_m = walking_distances(cost_grid, habitat, cell_m)
    reachable = np.isfinite(distance_m)
    coverage_zone = load_eva_zone(args.eva_targets, meta, distance_m) if is_sev else (reachable & (distance_m <= args.walkback))
    print(f"Habitat cell (row, column): {habitat}")
    print(f"Walkable cells: {np.count_nonzero(np.isfinite(cost_grid))}")
    print(f"Reachable cells: {np.count_nonzero(reachable)}")
    print(f"Cells in evaluation zone: {np.count_nonzero(coverage_zone)}")
    stations, history, before, after = greedy_stations(cost_grid, coverage_zone, habitat, cell_m, max_stations, args.threshold)
    features = save_stations(output, stations, history, meta, args.threshold, radiation_shelter=is_sev)
    summary_path = args.report_dir / f"{stem}_summary.csv"
    figure_path = args.report_dir / f"{stem}_before_after.png"
    save_summary(summary_path, history, stations, features, args.threshold)
    save_comparison(figure_path, before, after, coverage_zone, habitat, stations, features, args.threshold)
    for entry in history:
        print(f"k={entry['k']}: {entry['worst_o2_min']:.2f} nominal O2 min")
    for cell, feature in zip(stations, features):
        print(f"{feature['properties']['id']}: cell={cell}, coordinates={feature['geometry']['coordinates']}")
    met = history[-1]["worst_o2_min"] <= args.threshold
    print(f"Threshold met: {met}; threshold={args.threshold:g} nominal O2 min; caches added={len(stations)}")
    print(f"GeoJSON: {output.resolve()}")
    print(f"Table: {summary_path.resolve()}")
    print(f"Figure: {figure_path.resolve()}")
    if args.validate:
        subprocess.run(["node", "test/validate_data.mjs", "jezero"], cwd=ROOT / "web", check=True)
        print("Planner data validation passed.")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        raise SystemExit(f"ERROR: {error}") from error