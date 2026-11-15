"""Zonas, candidatas VIKOR y selección de estaciones meteorológicas.

Guardar en pipeline/weateher_stations.py y ejecutar:
    .venv/bin/python pipeline/weateher_stations.py
Sin ventana: añadir --headless. Escoger alternativas: --choose WS-1=B WS-3=C.

Las tres funciones buscan en TODA el área alcanzable a 800 m del hábitat.
El color de la pestaña activa ocupa ese alcance completo; el relieve se usa
como preferencia VIKOR, sin cortar el área con el radio de un cráter.
El modo anterior se conserva con --zone-mode crater.
No pide clics sobre un mapa vacío: primero calcula y muestra las candidatas.
Requisitos: numpy scipy pandas matplotlib scikit-image.
VIKOR: Opricovic & Tzeng (2004), DOI:10.1016/S0377-2217(03)00020-1.
Los pesos por función, las zonas y los umbrales de instalación son supuestos del equipo.
"""

import argparse
import csv
import json
import math
import sys
from itertools import product
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
from matplotlib.colors import to_rgba
from matplotlib.lines import Line2D
from matplotlib.patches import Patch
from matplotlib.transforms import Bbox
from matplotlib.widgets import Button
from scipy import ndimage
from skimage.graph import MCP_Geometric

ROOT = Path(__file__).resolve().parents[1]
SOURCE = "pipeline/weateher_stations.py VIKOR terrain-screened proposal"
ROLES = {
    "WS-1": {"name": "Referencia exterior NE", "role": "reference", "color": "#008F9C", "purpose": "Baseline wind, temperature, pressure and dust"},
    "WS-2": {"name": "Fondo del cráter", "role": "crater_floor", "color": "#D97800", "purpose": "Compare crater-floor temperature and possible local circulation"},
    "WS-3": {"name": "Borde norte", "role": "crater_rim", "color": "#8D49CE", "purpose": "Compare wind exposure at higher and lower elevations"},
}
LABELS = {"slope_deg": "pendiente", "roughness_m": "rugosidad", "oxygen_to_habitat_min": "O2 de regreso", "clearance_m": "margen plano", "role_distance_m": "posición en zona", "elevation_m": "elevación"}
LABELS.update({"local_relief_m": "variación del entorno", "terrain_position_m": "altura local relativa"})
LABELS.update({"depth_below_context_m": "profundidad bajo el entorno", "height_above_context_m": "altura sobre el entorno"})
FULL_AREA_NAMES = {"WS-1": "Referencia abierta", "WS-2": "Terreno bajo / fondo candidato", "WS-3": "Terreno alto / borde candidato"}
FULL_AREA_TYPES = {"WS-1": "reference", "WS-2": "low_terrain_candidate", "WS-3": "high_terrain_candidate"}


def read_json(path):
    with Path(path).open("r", encoding="utf-8") as handle:
        return json.load(handle)


def write_json(path, document):
    temporary = path.with_name(path.name + ".tmp")
    with temporary.open("w", encoding="utf-8") as handle:
        json.dump(document, handle, indent=2, ensure_ascii=False, allow_nan=False)
    temporary.replace(path)


def load_layer(path, shape, dtype):
    expected = math.prod(shape) * np.dtype(dtype).itemsize
    if path.stat().st_size != expected:
        raise ValueError(f"Tamaño incorrecto: {path}; se esperaban {expected} bytes.")
    return np.fromfile(path, dtype=dtype).reshape(shape)


def validate_meta(meta):
    if any(not isinstance(meta[key], int) or meta[key] <= 0 for key in ("width", "height")):
        raise ValueError("width y height deben ser enteros positivos.")
    bounds = np.asarray(meta["bbox"], dtype=float)
    if bounds.shape != (4,) or not np.isfinite(bounds).all() or bounds[0] >= bounds[2] or bounds[1] >= bounds[3]:
        raise ValueError("bbox inválido.")
    if not np.isfinite(meta["cell_m"]) or meta["cell_m"] <= 0:
        raise ValueError("cell_m debe ser positivo y finito.")


def habitat_to_cell(meta):
    west, south, east, north = meta["bbox"]
    lon, lat = meta["habitat"]
    if not np.isfinite([lon, lat]).all() or not (west <= lon <= east and south <= lat <= north):
        raise ValueError("El hábitat está fuera del bbox.")
    row = min(int((north - lat) / (north - south) * meta["height"]), meta["height"] - 1)
    col = min(int((lon - west) / (east - west) * meta["width"]), meta["width"] - 1)
    return row, col


def cell_to_coordinates(cell, meta):
    row, col = cell
    west, south, east, north = meta["bbox"]
    lon = west + (col + 0.5) * (east - west) / meta["width"]
    lat = north - (row + 0.5) * (north - south) / meta["height"]
    return [float(lon), float(lat)]


def path_field(costs, habitat, cell_m):
    if not np.isfinite(costs[habitat]):
        raise ValueError("El hábitat está en una celda bloqueada.")
    solver = MCP_Geometric(costs, fully_connected=True, sampling=(cell_m, cell_m))
    field, _ = solver.find_costs(starts=[habitat])
    return field


def normalize_loss(values, direction):
    low, high = float(values.min()), float(values.max())
    if high - low <= max(1e-12, 1e-9 * max(abs(low), abs(high), 1.0)):
        return values * 0.0
    if direction == "cost":
        return (values - low) / (high - low)
    if direction == "benefit":
        return (high - values) / (high - low)
    raise ValueError(f"Dirección desconocida: {direction}.")


def vikor(table, directions, weights=None, v=0.5):
    """Ordena TODAS las celdas factibles de un rol; Qi menor es preferible."""
    if table.empty or not 0 <= v <= 1:
        raise ValueError("VIKOR necesita candidatas y 0 <= v <= 1.")
    result = table.copy().reset_index(drop=True)
    criteria = result[list(directions)].astype(float)
    if not np.isfinite(criteria.to_numpy()).all():
        raise ValueError("Hay criterios con NaN o Infinity.")
    active = {}
    for name in directions:
        low, high = float(criteria[name].min()), float(criteria[name].max())
        active[name] = high - low > max(1e-12, 1e-9 * max(abs(low), abs(high), 1.0))
    if weights is not None and set(weights) != set(directions):
        raise ValueError(f"Pesos: se necesitan exactamente estos criterios: {list(directions)}.")
    raw = pd.Series({name: 1.0 for name in directions} if weights is None else weights, dtype=float).reindex(list(directions))
    if not np.isfinite(raw.to_numpy()).all() or (raw < 0).any() or raw.sum() <= 0:
        raise ValueError("Los pesos deben ser finitos, no negativos y sumar más de cero.")
    effective = raw * pd.Series(active, dtype=float)
    if any(active.values()) and effective.sum() <= 0:
        raise ValueError("Los pesos manuales dan cero a todos los criterios que varían.")
    weight = effective / effective.sum() if effective.sum() else effective
    loss = pd.DataFrame({name: normalize_loss(criteria[name], direction) for name, direction in directions.items()})
    weighted = loss.mul(weight, axis="columns")
    result["Si"] = weighted.sum(axis=1)
    result["Ri"] = weighted.max(axis=1)
    result["Qi"] = v * normalize_loss(result["Si"], "cost") + (1 - v) * normalize_loss(result["Ri"], "cost")
    tie_columns = [name for name in ("walking_distance_m", "row", "column") if name in result.columns]
    result = result.sort_values(["Qi", "Si", "Ri", *tie_columns], kind="stable").reset_index(drop=True)
    count = len(result)
    dq = 1 / (count - 1) if count > 1 else 0.0
    advantage = count == 1 or float(result.loc[1, "Qi"] - result.loc[0, "Qi"]) >= dq - 1e-12
    stability = bool(np.isclose(result.loc[0, "Si"], result["Si"].min(), rtol=0, atol=1e-12) or np.isclose(result.loc[0, "Ri"], result["Ri"].min(), rtol=0, atol=1e-12))
    if advantage and stability:
        result["compromise"] = result.index == 0
    elif advantage:
        result["compromise"] = result.index < 2
    else:
        result["compromise"] = result["Qi"] - result.loc[0, "Qi"] < dq
    result["rank"] = np.arange(1, count + 1)
    audit = [{"criterion": name, "direction": directions[name], "minimum": float(criteria[name].min()), "maximum": float(criteria[name].max()), "active": active[name], "raw_weight": float(raw[name]), "weight": float(weight[name]), "method": "equal_active" if weights is None else "manual_active_normalized"} for name in directions]
    details = {"v": float(v), "weights": weight.to_dict(), "weight_audit": audit, "acceptable_advantage": bool(advantage), "acceptable_stability": stability, "DQ": dq, "compromise_candidates": int(result["compromise"].sum()), "uninformative": not any(active.values())}
    return result, details


def validate_point(point, shape):
    point = np.asarray(point, dtype=float)
    if point.shape != (2,) or not np.isfinite(point).all() or not (0 <= point[0] < shape[0] and 0 <= point[1] < shape[1]):
        raise ValueError("Centro, borde y referencia deben estar dentro del grid como FILA COLUMNA.")
    return point


def geometry_masks(selection, meta, z):
    """Partición explícita por posición y relieve; no adapta zonas para forzar 3 puntos."""
    cell_m = float(meta["cell_m"])
    center = validate_point(selection["center"], z.shape)
    rim = validate_point(selection["rim"], z.shape)
    radius = float(np.linalg.norm(rim - center) * cell_m)
    if radius < 3 * cell_m or rim[0] >= center[0]:
        raise ValueError("El borde debe estar al norte del centro; radio mínimo de tres celdas.")
    rows, cols = np.indices(z.shape)
    dr, dc = rows - center[0], cols - center[1]
    radial = np.hypot(dr, dc) * cell_m
    angle = np.abs(np.degrees(np.arctan2(dc, -dr)))
    core = (radial <= 0.35 * radius) & np.isfinite(z)
    north_band = (radial >= 0.85 * radius) & (radial <= 1.15 * radius) & (angle <= 60) & np.isfinite(z)
    if not core.any() or not north_band.any():
        raise ValueError("No hay suficientes elevaciones para comprobar fondo y borde norte.")
    floor_median, rim_median = float(np.median(z[core])), float(np.median(z[north_band]))
    if rim_median <= floor_median:
        raise ValueError("El relieve no confirma una depresión con ese centro y borde.")
    midpoint = (floor_median + rim_median) / 2
    rim_outer = radius + max(0.5 * radius, 60.0)
    reference_inner = max(1.3 * radius, radius + 30.0)
    floor = (radial <= 0.55 * radius) & (z <= midpoint)
    rim_position = (radial >= 0.85 * radius) & (radial <= rim_outer) & (angle <= 60)
    rim_zone = rim_position & (z >= midpoint)
    reference_zone = (dr < 0) & (dc > 0) & (radial >= reference_inner) & ~rim_position & np.isfinite(z)
    if "reference" in selection:
        reference = validate_point(selection["reference"], z.shape)
        if reference[0] >= center[0] or reference[1] <= center[1] or np.linalg.norm(reference - center) * cell_m <= radius:
            raise ValueError("La referencia preferida debe estar fuera del cráter, al noreste.")
    else:
        offset = 1.8 * radius / (math.sqrt(2) * cell_m)
        reference = np.clip(center + [-offset, offset], [0, 0], np.asarray(z.shape) - 1)
    selection["reference"] = reference.tolist()
    masks = {"WS-1": reference_zone, "WS-2": floor, "WS-3": rim_zone}
    distances = {"WS-1": np.hypot(rows - reference[0], cols - reference[1]) * cell_m, "WS-2": radial, "WS-3": np.hypot(rows - rim[0], cols - rim[1]) * cell_m}
    definitions = {"WS-1": f"Exterior NE; r ≥ {reference_inner:.0f} m; excluye el borde norte.", "WS-2": f"Centro: r ≤ {0.55 * radius:.0f} m; z ≤ {midpoint:.1f} m.", "WS-3": f"Norte ±60°; r {0.85 * radius:.0f}–{rim_outer:.0f} m; z ≥ {midpoint:.1f} m."}
    circle_inside = bool(center[0] - radius / cell_m >= -0.5 and center[0] + radius / cell_m <= z.shape[0] - 0.5 and center[1] - radius / cell_m >= -0.5 and center[1] + radius / cell_m <= z.shape[1] - 0.5)
    evidence = {"radius_m": radius, "floor_median_m": floor_median, "north_rim_median_m": rim_median, "midpoint_elevation_m": midpoint, "definitions": definitions, "reference_anchor_is_soft_preference": True, "cell_m": cell_m, "circle_fully_within_grid": circle_inside, "empty_geographic_zones": [station_id for station_id, region in masks.items() if not region.any()]}
    return masks, distances, evidence


def filter_counts(region, stages):
    remaining = region.copy()
    counts = {"zona": int(remaining.sum())}
    first_empty = "zona" if not remaining.any() else None
    for name, condition in stages.items():
        previous = int(remaining.sum())
        remaining &= condition
        counts[name] = int(remaining.sum())
        if previous and not remaining.any() and first_empty is None:
            first_empty = name
    return counts, first_empty


def full_area_search(z, operation, meta, args):
    """Un mismo dominio por función; la morfología es un criterio, no un recorte."""
    cell_m = float(meta["cell_m"])
    size = max(3, 2 * int(round(args.terrain_window / cell_m / 2)) + 1)
    valid = np.isfinite(z)
    baseline = float(np.median(z[valid]))
    centered = np.where(valid, z - baseline, 0).astype(np.float64)
    support = ndimage.uniform_filter(valid.astype(np.float64), size=size, mode="constant", cval=0)
    mean = ndimage.uniform_filter(centered, size=size, mode="constant", cval=0) / np.maximum(support, 1e-12)
    mean_square = ndimage.uniform_filter(centered ** 2, size=size, mode="constant", cval=0) / np.maximum(support, 1e-12)
    terrain_position = z.astype(np.float64) - baseline - mean
    local_relief = np.sqrt(np.maximum(mean_square - mean ** 2, 0))
    terrain_position[~valid] = np.nan
    local_relief[~valid] = np.nan
    masks = {station_id: operation.copy() for station_id in ROLES}
    definitions = {"WS-1": "Área completa; prefiere entorno uniforme.", "WS-2": "Área completa; prefiere terreno bajo local.", "WS-3": "Área completa; prefiere terreno alto local."}
    evidence = {"search_mode": "full-area", "selection_method": "full_walkable_area_with_role_preferences", "definitions": definitions, "operational_clipping_m": args.max_distance, "cell_m": cell_m, "local_window_cells": size, "local_window_m": float(size * cell_m), "terrain_position_definition": "elevation minus valid-data local mean", "local_relief_definition": "local elevation standard deviation at the context scale; distinct from roughness.f32", "zone_cells_inside_operation": {station_id: int(operation.sum()) for station_id in ROLES}, "same_complete_footprint_for_all_roles": True, "requires_terrain_role_visual_review": True}
    selection = {"mode": "full-area", "habitat_cell": list(habitat_to_cell(meta)), "max_walking_distance_m": args.max_distance}
    return selection, masks, evidence, terrain_position, local_relief


def automatic_choices(records):
    """Prefiere primeras posiciones sin colocar dos estaciones en la misma celda."""
    groups = {station_id: [record for record in records if record["station_id"] == station_id] for station_id in ROLES}
    present = [station_id for station_id in ROLES if groups[station_id]]
    if not present:
        return {}
    best, best_key = None, None
    for combination in product(*(groups[station_id] for station_id in present)):
        cells = {(record["row"], record["column"]) for record in combination}
        if len(cells) != len(combination):
            continue
        ranks = [record["rank"] for record in combination]
        key = (max(ranks), sum(ranks), tuple(ranks))
        if best_key is None or key < best_key:
            best, best_key = combination, key
    if best is None:
        choices, used = {}, set()
        for station_id in present:
            for record in groups[station_id]:
                cell = (record["row"], record["column"])
                if cell not in used:
                    choices[station_id] = record["candidate_id"]
                    used.add(cell)
                    break
        return choices
    return {record["station_id"]: record["candidate_id"] for record in best}


def depression_evidence(z, center, radius_m, cell_m, minimum_depth):
    """Contraste circular tras quitar el plano del anillo; evidencia topográfica."""
    radius_px = radius_m / cell_m
    row, col = center
    half = int(math.ceil(1.2 * radius_px))
    top, bottom = max(0, row - half), min(z.shape[0], row + half + 1)
    left, right = max(0, col - half), min(z.shape[1], col + half + 1)
    patch = z[top:bottom, left:right].astype(np.float64)
    yy, xx = np.indices(patch.shape)
    x, y = (xx + left - col) * cell_m, (yy + top - row) * cell_m
    radial = np.hypot(x, y)
    finite = np.isfinite(patch)
    core = (radial <= 0.35 * radius_m) & finite
    ring_position = (radial >= 0.85 * radius_m) & (radial <= 1.15 * radius_m)
    ring = ring_position & finite
    if core.sum() < 5 or ring.sum() < 12 or ring.sum() < 0.9 * ring_position.sum():
        return None
    design = np.column_stack([np.ones(int(ring.sum())), x[ring], y[ring]])
    plane, _, _, _ = np.linalg.lstsq(design, patch[ring], rcond=None)
    residual = patch - (plane[0] + plane[1] * x + plane[2] * y)
    floor = float(np.median(residual[core]))
    depth = float(np.median(residual[ring]) - floor)
    if depth < minimum_depth:
        return None
    sectors = np.floor((np.arctan2(y, x) + np.pi) / (2 * np.pi) * 8).astype(int) % 8
    raised = 0
    for number in range(8):
        cells = ring & (sectors == number)
        if cells.any() and np.median(residual[cells]) >= floor + 0.5 * depth:
            raised += 1
    if raised < 6:
        return None
    return {"detrended_depth_m": depth, "raised_ring_sectors": raised, "tested_ring_sectors": 8, "minimum_depth_m": minimum_depth}


def crater_counts(masks, allowed, oxygen):
    counts = {station_id: int((region & allowed).sum()) for station_id, region in masks.items()}
    least_costs = [float(np.min(oxygen[region & allowed])) for region in masks.values() if (region & allowed).any()]
    worst_best_o2 = max(least_costs) if least_costs else None
    return counts, worst_best_o2


def detect_craters(z, meta, allowed, oxygen, args):
    """Propone centros por contraste a varias escalas y comprueba el anillo."""
    cell_m = float(meta["cell_m"])
    finite = np.isfinite(z)
    valid = finite.astype(np.float64)
    base = float(np.median(z[finite]))
    centered = np.where(finite, z - base, 0).astype(np.float64)
    rows, cols = np.indices(z.shape)
    edge_m = np.minimum.reduce([rows + 0.5, z.shape[0] - 0.5 - rows, cols + 0.5, z.shape[1] - 0.5 - cols]) * cell_m
    proposals = []
    for radius in args.crater_radii:
        if radius < 3 * cell_m:
            continue
        inner_size = max(3, 2 * int(round(0.35 * radius / cell_m)) + 1)
        outer_size = max(inner_size + 2, 2 * int(round(1.25 * radius / cell_m)) + 1)
        inner_valid = ndimage.uniform_filter(valid, size=inner_size, mode="reflect")
        outer_valid = ndimage.uniform_filter(valid, size=outer_size, mode="reflect")
        inner = ndimage.uniform_filter(centered, size=inner_size, mode="reflect") / np.maximum(inner_valid, 1e-12)
        outer = ndimage.uniform_filter(centered, size=outer_size, mode="reflect") / np.maximum(outer_valid, 1e-12)
        contrast = outer - inner
        eligible = allowed & (edge_m >= 1.25 * radius) & (inner_valid >= 0.95) & (outer_valid >= 0.95) & (contrast >= 0.25 * args.crater_min_depth)
        score = np.where(eligible, contrast, -np.inf)
        peaks = eligible & (score == ndimage.maximum_filter(score, size=max(3, int(radius / cell_m)), mode="constant", cval=-np.inf))
        locations = np.flatnonzero(peaks)
        if not locations.size:
            continue
        locations = locations[np.argsort(-score.ravel()[locations], kind="stable")]
        peak_rows, peak_cols = np.unravel_index(locations, z.shape)
        available = np.ones(len(locations), dtype=bool)
        for _ in range(8):
            remaining = np.flatnonzero(available)
            if not remaining.size:
                break
            index = int(remaining[0])
            row, col = int(peak_rows[index]), int(peak_cols[index])
            available &= np.hypot(peak_rows - row, peak_cols - col) * cell_m >= 0.6 * radius
            available[index] = False
            test = depression_evidence(z, (row, col), radius, cell_m, args.crater_min_depth)
            if test is None:
                continue
            selection = {"center": [float(row), float(col)], "rim": [float(row - radius / cell_m), float(col)]}
            try:
                masks, _, _ = geometry_masks(selection, meta, z)
            except ValueError:
                continue
            counts, worst = crater_counts(masks, allowed, oxygen)
            roles = sum(value > 0 for value in counts.values())
            if not roles:
                continue
            proposal = {"center_row": row, "center_column": col, "radius_m": float(radius), **test, "relative_relief": test["detrended_depth_m"] / radius, "feasible_roles": roles, "WS-1_cells": counts["WS-1"], "WS-2_cells": counts["WS-2"], "WS-3_cells": counts["WS-3"], "worst_best_o2_min": worst, "contrast_m": float(contrast[row, col])}
            proposals.append(proposal)
        print(f"Búsqueda de depresiones: radio {radius:g} m; {len(proposals)} propuestas comprobadas hasta ahora.")
    proposals.sort(key=lambda item: (-item["feasible_roles"], -item["raised_ring_sectors"], -item["relative_relief"], item["worst_best_o2_min"], item["center_row"], item["center_column"]))
    return proposals


def resolve_crater(selection, z, meta, allowed, oxygen, args):
    initial = None
    if selection is not None:
        try:
            masks, distances, evidence = geometry_masks(selection, meta, z)
            counts, _ = crater_counts(masks, allowed, oxygen)
            initial = (selection, masks, distances, evidence)
            if args.keep_crater or (all(value > 0 for value in counts.values()) and not args.rescan_craters):
                evidence["selection_method"] = "provided_or_saved_crater"
                return initial, []
            print(f"El cráter guardado sólo permite {sum(value > 0 for value in counts.values())}/3 funciones dentro del alcance; buscando uno cercano que permita las tres.")
        except ValueError as error:
            if args.keep_crater:
                raise
            print(f"Se revisa la geometría guardada: {error}")
    elif args.keep_crater:
        raise ValueError("--keep-crater necesita un cráter guardado o --center y --rim.")
    proposals = detect_craters(z, meta, allowed, oxygen, args)
    proposal_columns = ["center_row", "center_column", "radius_m", "detrended_depth_m", "raised_ring_sectors", "tested_ring_sectors", "minimum_depth_m", "relative_relief", "feasible_roles", "WS-1_cells", "WS-2_cells", "WS-3_cells", "worst_best_o2_min", "contrast_m"]
    save_csv(args.output_dir / "weather_crater_candidates.csv", proposals, proposal_columns)
    if proposals:
        best = proposals[0]
        initial_roles = 0
        if initial is not None:
            initial_counts, _ = crater_counts(initial[1], allowed, oxygen)
            initial_roles = sum(value > 0 for value in initial_counts.values())
        if best["feasible_roles"] >= initial_roles:
            radius_px = best["radius_m"] / float(meta["cell_m"])
            selection = {"center": [float(best["center_row"]), float(best["center_column"])], "rim": [best["center_row"] - radius_px, float(best["center_column"])]}
            masks, distances, evidence = geometry_masks(selection, meta, z)
            evidence.update({"selection_method": "automatic_crater_like_depression", "detection": best, "requires_crater_visual_review": True})
            print(f"Depresión seleccionada automáticamente: centro={selection['center']}, radio={best['radius_m']:g} m, profundidad sin plano={best['detrended_depth_m']:.2f} m, funciones factibles={best['feasible_roles']}/3.")
            return (selection, masks, distances, evidence), proposals
    if initial is not None:
        initial[3]["selection_method"] = "saved_crater_no_complete_automatic_alternative"
        print("No se encontró una depresión que complete las tres funciones con los filtros actuales; se conserva la propuesta parcial, sin relajar los límites.")
        return initial, proposals
    raise ValueError("No se encontró una depresión con ubicaciones factibles. Revisa weather_crater_candidates.csv, los filtros o define el cráter con --center y --rim; no se generan tres puntos sin evidencia de terreno.")


def spaced_candidates(ranking, number, separation_m, cell_m):
    rows = ranking["row"].to_numpy()
    cols = ranking["column"].to_numpy()
    available = np.ones(len(ranking), dtype=bool)
    indices = []
    for _ in range(number):
        possible = np.flatnonzero(available)
        if not possible.size:
            break
        index = int(possible[0])
        indices.append(index)
        available &= np.hypot(rows - rows[index], cols - cols[index]) * cell_m >= separation_m
        available[index] = False
    return ranking.iloc[indices].copy()


def propose_stations(meta, layers, distance_m, oxygen, clearance, masks, role_distances, stages, weights, args):
    records, summaries = [], {}
    for station_id, role in ROLES.items():
        counts, first_empty = filter_counts(masks[station_id], stages)
        summary = {"filter_counts": counts, "first_empty_filter": first_empty, "candidate_cells": counts["margen"]}
        summaries[station_id] = summary
        if first_empty is not None:
            summary["status"] = "no_feasible_candidate"
            print(f"{station_id}: sin candidatas; primer filtro que deja cero: {first_empty}; filtros {counts}.")
            continue
        allowed = masks[station_id].copy()
        for condition in stages.values():
            allowed &= condition
        rows, cols = np.nonzero(allowed)
        data = {"row": rows, "column": cols, "elevation_m": layers["elevation"][allowed], "slope_deg": layers["slope"][allowed], "roughness_m": layers["roughness"][allowed], "walking_distance_m": distance_m[allowed], "oxygen_to_habitat_min": oxygen[allowed], "clearance_m": clearance[allowed]}
        directions = {"slope_deg": "cost", "roughness_m": "cost", "oxygen_to_habitat_min": "cost", "clearance_m": "benefit"}
        full_area = getattr(args, "zone_mode", "crater") == "full-area"
        if full_area:
            local_position = layers["terrain_position"][allowed]
            data.update({"local_relief_m": layers["local_relief"][allowed], "terrain_position_m": local_position, "depth_below_context_m": np.maximum(-local_position, 0), "height_above_context_m": np.maximum(local_position, 0)})
            role_criterion = {"WS-1": "local_relief_m", "WS-2": "depth_below_context_m", "WS-3": "height_above_context_m"}[station_id]
            directions[role_criterion] = "cost" if station_id == "WS-1" else "benefit"
        else:
            data["role_distance_m"] = role_distances[station_id][allowed]
            directions["role_distance_m"] = "cost"
            if station_id != "WS-1":
                directions["elevation_m"] = "cost" if station_id == "WS-2" else "benefit"
        role_weights = weights.get(station_id)
        default_role_policy = full_area and role_weights is None
        if default_role_policy:
            role_criterion = {"WS-1": "local_relief_m", "WS-2": "depth_below_context_m", "WS-3": "height_above_context_m"}[station_id]
            role_weights = {name: args.role_weight if name == role_criterion else (1 - args.role_weight) / 4 for name in directions}
        ranking, details = vikor(pd.DataFrame(data), directions, role_weights, args.v)
        if default_role_policy:
            details["weight_policy"] = "role_priority_active_normalized"
            details["requested_role_weight"] = args.role_weight
            for audit in details["weight_audit"]:
                audit["method"] = "role_priority_active_normalized"
        shortlist = ranking.head(args.alternatives).copy() if args.candidate_mode == "top" else spaced_candidates(ranking, args.alternatives, args.separation, float(meta["cell_m"]))
        for number, (_, row) in enumerate(shortlist.iterrows()):
            cell = (int(row["row"]), int(row["column"]))
            lon, lat = cell_to_coordinates(cell, meta)
            record = {"station_id": station_id, "candidate_id": f"{station_id}-{chr(65 + number)}", "label": f"{station_id[-1]}{chr(65 + number)}", "name": FULL_AREA_NAMES[station_id] if full_area else role["name"], "alternative": chr(65 + number), "rank": int(row["rank"]), "longitude": lon, "latitude": lat, "row": cell[0], "column": cell[1], "compromise": bool(row["compromise"])}
            record.update({key: float(row[key]) for key in (*directions, "walking_distance_m", "Si", "Ri", "Qi")})
            record["elevation_m"] = float(row["elevation_m"])
            if full_area:
                record.update({"local_relief_m": float(row["local_relief_m"]), "terrain_position_m": float(row["terrain_position_m"]), "depth_below_context_m": float(row["depth_below_context_m"]), "height_above_context_m": float(row["height_above_context_m"])})
            records.append(record)
        summary.update({"status": "proposal", "vikor": details, "reported_alternatives": len(shortlist)})
        weight_text = ", ".join(f"{LABELS[name]}={100 * weight:.1f}%" for name, weight in details["weights"].items())
        print(f"{station_id}: {len(ranking)} celdas factibles; {len(shortlist)} alternativas, modo={args.candidate_mode}; pesos {weight_text}.")
    return records, summaries


def choose_backend(headless):
    if headless:
        plt.switch_backend("Agg")
        return False
    backends = ["MacOSX", "TkAgg", "QtAgg"] if sys.platform == "darwin" else ["TkAgg", "QtAgg"]
    for backend in backends:
        try:
            plt.switch_backend(backend)
            probe = plt.figure()
            plt.close(probe)
            return True
        except (ImportError, RuntimeError):
            continue
    plt.switch_backend("Agg")
    print("Sin ventana interactiva: se guardan automáticamente las mejores; usa --choose WS-1=B para cambiar una alternativa del PNG.")
    return False


def fit_grid(ax, shape):
    """Un centro de píxel = un índice; los artistas no amplían el encuadre."""
    height, width = shape
    ax.set_xlim(-0.5, width - 0.5)
    ax.set_ylim(height - 0.5, -0.5)
    ax.set_aspect("equal", adjustable="box")
    ax.set_autoscale_on(False)


def spread_labels(ax, annotations, records, choices, fixed_labels):
    """Separa etiquetas en pantalla; nunca desplaza coordenadas del terreno."""
    ax.figure.canvas.draw()
    renderer = ax.figure.canvas.get_renderer()
    bounds = ax.get_window_extent(renderer).padded(-4)
    reserved = [label.get_bbox_patch().get_window_extent(renderer).padded(3) for label in fixed_labels if label is not None]
    for record in records:
        px, py = ax.transData.transform((record["column"], record["row"]))
        reserved.append(Bbox.from_bounds(px - 5, py - 5, 10, 10))
    selected = set(choices.values())
    order = sorted(annotations, key=lambda cid: (cid not in selected, cid))
    pixels_per_point = ax.figure.dpi / 72
    boxes = {}
    for cid in order:
        annotation = annotations[cid]
        width, height, descent = renderer.get_text_width_height_descent(annotation.get_text(), annotation.get_fontproperties(), ismath=False)
        width, height = width + 10, height + descent + 10
        anchor_x, anchor_y = ax.transData.transform(annotation.xy)
        best, best_box, best_overlap = (12, 12), None, np.inf
        for radius in (16, 28, 43, 60, 82, 110, 145, 190, 245, 310, 390):
            for angle in np.linspace(0, 2 * np.pi, 20, endpoint=False):
                dx, dy = radius * np.cos(angle), radius * np.sin(angle)
                px, py = anchor_x + dx * pixels_per_point, anchor_y + dy * pixels_per_point
                box = Bbox.from_bounds(px - width / 2, py - height / 2, width, height)
                if not bounds.contains(box.x0, box.y0) or not bounds.contains(box.x1, box.y1):
                    continue
                overlap = 0.0
                for other in reserved:
                    intersection = Bbox.intersection(box, other)
                    if intersection is not None:
                        overlap += intersection.width * intersection.height
                if overlap < best_overlap:
                    best, best_box, best_overlap = (float(dx), float(dy)), box, overlap
                if overlap == 0:
                    break
            if best_overlap == 0:
                break
        annotation.set_position(best)
        if best_box is not None:
            reserved.append(best_box)
            boxes[cid] = best_box
    return boxes


def atlas(z, walkable, operation, allowed, habitat, selection, masks, evidence, records, summaries, choices, args, interactive=False):
    full_area = evidence.get("search_mode") == "full-area"
    names = FULL_AREA_NAMES if full_area else {station_id: role["name"] for station_id, role in ROLES.items()}
    fig = plt.figure(figsize=(18, 11), facecolor="#F6F7F9")
    ax = fig.add_axes([0.045, 0.14, 0.57, 0.74])
    panel = fig.add_axes([0.65, 0.11, 0.335, 0.81])
    panel.set_axis_off()
    finite = z[np.isfinite(z)]
    vmin, vmax = float(np.min(finite)), float(np.max(finite))
    if vmax <= vmin:
        vmax = vmin + 1
    ax.imshow(z, cmap="gray", vmin=vmin, vmax=vmax, origin="upper", interpolation="nearest")
    fit_grid(ax, z.shape)
    blocked = np.zeros((*z.shape, 4), dtype=np.float32)
    blocked[~walkable] = [0, 0, 0, 0.65]
    ax.imshow(blocked, origin="upper", interpolation="nearest")
    zone_images, zone_contours = {}, {}
    for station_id, region in masks.items():
        region = region & operation
        rgba = np.zeros((*z.shape, 4), dtype=np.float32)
        rgba[region] = to_rgba(ROLES[station_id]["color"], 0.23)
        rgba[region & allowed] = to_rgba(ROLES[station_id]["color"], 0.67)
        zone_image = ax.imshow(rgba, origin="upper", interpolation="nearest")
        zone_image.set_visible(not full_area or station_id == "WS-1")
        zone_images[station_id] = zone_image
        if region.any() and not region.all():
            zone_contour = ax.contour(region.astype(np.uint8), levels=[0.5], colors=[ROLES[station_id]["color"]], linewidths=1.0)
            zone_contour.set_visible(not full_area or station_id == "WS-1")
            zone_contours[station_id] = zone_contour
    if operation.any() and not operation.all():
        ax.contour(operation.astype(np.uint8), levels=[0.5], colors=["white"], linewidths=2.5)
        ax.contour(operation.astype(np.uint8), levels=[0.5], colors=["#101820"], linewidths=1.1, linestyles="--")
    center_label = None
    if not full_area:
        center, rim = selection["center"], selection["rim"]
        circle = plt.Circle((center[1], center[0]), evidence["radius_m"] / evidence["cell_m"], fill=False, edgecolor="white", linestyle=":", linewidth=1.3)
        ax.add_patch(circle)
        ax.plot([center[1], rim[1]], [center[0], rim[0]], color="white", linestyle=":", linewidth=1.0)
        center_label = ax.annotate("Centro", (center[1], center[0]), xytext=(-8, 10), textcoords="offset points", fontsize=8, ha="right", color="white", bbox={"facecolor": "#20252D", "alpha": 0.75, "edgecolor": "none"})
    ax.scatter(habitat[1], habitat[0], c="#FFDF00", marker="*", s=230, edgecolors="black", linewidths=1.2, zorder=8)
    habitat_label = ax.annotate("Hábitat", (habitat[1], habitat[0]), xytext=(9, -14), textcoords="offset points", fontsize=9, bbox={"facecolor": "white", "alpha": 0.9, "edgecolor": "none", "pad": 2})
    ax.annotate("N", xy=(0.04, 0.95), xytext=(0.04, 0.85), xycoords="axes fraction", ha="center", fontsize=11, fontweight="bold", arrowprops={"arrowstyle": "-|>", "color": "black", "lw": 1.5})
    ax.set_xlabel(f"Columna del grid (0–{z.shape[1] - 1}) · este →")
    ax.set_ylabel(f"Fila del grid (0–{z.shape[0] - 1}) · sur →")
    title = f"Cada WS busca en TODO el alcance caminable de {args.max_distance:g} m" if full_area else f"Zonas dentro del alcance caminable de {args.max_distance:g} m"
    ax.set_title(title, loc="left", fontsize=12.5 if full_area else 14, fontweight="bold", pad=12)
    legend_names = {"WS-1": "Referencia", "WS-2": "Terreno bajo", "WS-3": "Terreno alto"} if full_area else names
    handles = [Patch(facecolor=role["color"], alpha=0.7, label=f"{station_id}: {legend_names[station_id]}") for station_id, role in ROLES.items()]
    handles.extend([Line2D([0], [0], color="#101820", linestyle="--", label=f"Ruta ≤ {args.max_distance:g} m"), Line2D([0], [0], marker="o", color="none", markeredgecolor="black", markerfacecolor="none", markersize=11, label="Anillo negro: elegida")])
    ax.legend(handles=handles, loc="upper center", bbox_to_anchor=(0.5, -0.08), ncol=2, fontsize=9, frameon=False)
    panel.text(0, 1.0, "ELIGE ENTRE CANDIDATAS", fontsize=15, fontweight="bold", va="top")
    panel.text(0, 0.961, "Cambia WS con las pestañas o teclas 1, 2, 3.\nA = menor Qi · Enter: guardar · R: restaurar", fontsize=10, va="top", color="#475467")
    artists, text_artists, rings, points, annotations = {}, {}, {}, {}, {}
    role_artists, tab_labels = {}, {}
    state = {"active_role": "WS-1", "warning": ""}
    by_id = {record["candidate_id"]: record for record in records}
    for record in records:
        station_id, cid = record["station_id"], record["candidate_id"]
        point = ax.scatter(record["column"], record["row"], c=ROLES[station_id]["color"], marker="o", s=38, edgecolors="white", linewidths=0.8, zorder=6, picker=5)
        artists[point] = cid
        points[cid] = point
        ring = ax.scatter(record["column"], record["row"], s=190, facecolors="none", edgecolors="black", linewidths=2.1, zorder=7)
        rings[cid] = ring
        annotation = ax.annotate(record["label"], (record["column"], record["row"]), xytext=(12, 12), textcoords="offset points", fontsize=8, fontweight="bold", ha="center", va="center", bbox={"facecolor": "white", "edgecolor": ROLES[station_id]["color"], "alpha": 0.98, "pad": 1.5}, arrowprops={"arrowstyle": "-", "color": ROLES[station_id]["color"], "linewidth": 0.7, "shrinkA": 2, "shrinkB": 2}, zorder=9, picker=True)
        artists[annotation] = cid
        annotations[cid] = annotation
    for index, station_id in enumerate(ROLES):
        tab = panel.text(0.04 + index * 0.33, 0.892, station_id, fontsize=12, fontweight="bold", va="top", picker=True, bbox={"facecolor": "white", "edgecolor": "#CAD3DE", "boxstyle": "round,pad=0.4"})
        role_artists[tab] = station_id
        tab_labels[station_id] = tab
    role_heading = panel.text(0, 0.82, "", fontsize=11, fontweight="bold", va="top")
    weight_heading = panel.text(0, 0.777, "", fontsize=8.7, color="#475467", va="top")
    panel.text(0.02, 0.733, "ID  Rank      Q     ° Ruta m  O2 min", fontsize=9, va="top", family="monospace", color="#475467")
    missing_text = panel.text(0, 0.68, "", fontsize=9, color="#A51D2D", va="top")
    for station_id in ROLES:
        role_records = [record for record in records if record["station_id"] == station_id]
        for index, record in enumerate(role_records):
            text_value = f"{record['label']:<3} {record['rank']:>4} {record['Qi']:>6.3f} {record['slope_deg']:>5.1f} {record['walking_distance_m']:>6.0f} {record['oxygen_to_habitat_min']:>6.1f}"
            artist = panel.text(0.02, 0.697 - index * 0.037, text_value, fontsize=9.3, va="top", family="monospace", picker=True)
            artists[artist] = record["candidate_id"]
            text_artists[record["candidate_id"]] = artist
    y = 0.26
    panel.text(0, y, "ÁREA COMPLETA Y PREFERENCIAS" if full_area else "CÓMO SE DEFINE CADA ZONA", fontsize=10, fontweight="bold", va="top")
    y -= 0.032
    for station_id in ROLES:
        panel.text(0, y, f"{station_id}: {evidence['definitions'][station_id]}", fontsize=8.6, color=ROLES[station_id]["color"], va="top")
        y -= 0.026
    footnote = f"Las 3 WS usan el mismo alcance de {args.max_distance:g} m.\nP: pendiente · R: rugosidad · M: margen plano\nE: entorno · B: profundidad local · A: altura local\nTenue: alcanzable · intenso: instalable\nEl relieve es una preferencia, no un recorte." if full_area else f"Zonas recortadas al alcance caminable de {args.max_distance:g} m.\nP: pendiente · R: rugosidad · M: margen plano\nD: distancia al punto del rol · Z: elevación\nO2: minutos equivalentes de consumo nominal.\nLas etiquetas se apartan; los puntos no se mueven."
    panel.text(0, y - 0.01, footnote, fontsize=8.8, color="#475467", va="top", linespacing=1.4)
    heading = "Estaciones meteorológicas · propuestas según terreno y VIKOR"
    if args.example:
        heading = "EJEMPLO CON TERRENO SINTÉTICO · no son ubicaciones reales de Jezero"
    fig.suptitle(heading, x=0.045, ha="left", y=0.98, fontsize=18, fontweight="bold")
    limits = f"Instalación: pendiente ≤ {args.site_slope:g}° · rugosidad ≤ {args.site_roughness:g} m · hazard = 0 · margen ≥ {args.setback:g} m · ruta ≤ {args.max_distance:g} m"
    fig.text(0.045, 0.937, limits, fontsize=10, color="#475467")
    status_text = fig.text(0.65, 0.055, "", fontsize=9.5, color="#27364A", va="center")
    empty_zones = evidence.get("empty_geographic_zones", [])
    if empty_zones:
        diagnostic = f"Revisa centro/borde: radio {evidence['radius_m']:.0f} m; sin zona geográfica: {', '.join(empty_zones)}."
        fig.text(0.045, 0.02, diagnostic, fontsize=8.5, color="#A51D2D")

    def refresh():
        active = state["active_role"]
        if full_area:
            for station_id, image in zone_images.items():
                image.set_visible(station_id == active)
            for station_id, contour in zone_contours.items():
                contour.set_visible(station_id == active)
        for cid, ring in rings.items():
            chosen = choices.get(by_id[cid]["station_id"]) == cid
            visible = by_id[cid]["station_id"] == active or chosen
            ring.set_visible(chosen)
            points[cid].set_visible(visible)
            annotations[cid].set_visible(visible)
            artist = text_artists[cid]
            artist.set_visible(by_id[cid]["station_id"] == active)
            artist.set_fontweight("bold" if chosen else "normal")
            artist.set_bbox({"facecolor": "#E8EEF5" if chosen else "none", "edgecolor": "none", "pad": 2})
        for station_id, tab in tab_labels.items():
            tab.set_color(ROLES[station_id]["color"] if station_id == active else "#667085")
            tab.get_bbox_patch().set_facecolor("#E4EBF5" if station_id == active else "white")
        role_heading.set_text(f"{active} · {names[active]}")
        role_heading.set_color(ROLES[active]["color"])
        summary = summaries[active]
        abbreviations = {"slope_deg": "P", "roughness_m": "R", "oxygen_to_habitat_min": "O2", "clearance_m": "M", "role_distance_m": "D", "elevation_m": "Z", "local_relief_m": "E", "terrain_position_m": "T", "depth_below_context_m": "B", "height_above_context_m": "A"}
        values = summary.get("vikor", {}).get("weights", {})
        weight_heading.set_text("Pesos %: " + " · ".join(f"{abbreviations[key]} {value * 100:.1f}" for key, value in values.items()))
        missing_text.set_text(f"Sin candidatas: {summary.get('first_empty_filter')} deja 0." if summary["status"] != "proposal" else "")
        status_text.set_text(state["warning"] or "Elegidas: " + " · ".join(choices.get(station_id, f"{station_id}: ninguna") for station_id in ROLES))
        fig.canvas.draw_idle()

    def set_role(station_id):
        state["active_role"] = station_id
        state["warning"] = ""
        refresh()

    def on_pick(event):
        if event.artist in role_artists:
            set_role(role_artists[event.artist])
            return
        cid = artists.get(event.artist)
        if cid is not None:
            mouse = event.mouseevent
            if event.artist is annotations.get(cid):
                box = annotations[cid].get_bbox_patch().get_window_extent(fig.canvas.get_renderer())
                if not box.contains(mouse.x, mouse.y):
                    return
            if event.artist is points.get(cid):
                visible = [key for key, point in points.items() if point.get_visible()]
                nearest = min(visible, key=lambda key: np.linalg.norm(ax.transData.transform((by_id[key]["column"], by_id[key]["row"])) - [mouse.x, mouse.y]))
                if cid != nearest:
                    return
            target = by_id[cid]
            occupied = {(by_id[other]["row"], by_id[other]["column"]) for station_id, other in choices.items() if station_id != target["station_id"]}
            if (target["row"], target["column"]) in occupied:
                state["warning"] = "Celda elegida en otra WS; escoge otra alternativa."
                refresh()
                return
            choices[by_id[cid]["station_id"]] = cid
            state["active_role"] = by_id[cid]["station_id"]
            state["warning"] = ""
            refresh()

    def restore(event=None):
        choices.clear()
        choices.update(automatic_choices(records))
        state["warning"] = ""
        refresh()

    def accept(event=None):
        plt.close(fig)

    def on_key(event):
        if event.key in ("enter", "return"):
            accept()
        elif event.key in ("r", "R"):
            restore()
        elif event.key in ("1", "2", "3"):
            set_role(f"WS-{event.key}")

    def on_resize(event):
        fig._station_label_boxes = spread_labels(ax, annotations, records, choices, [habitat_label, center_label])
        refresh()

    fig._station_label_boxes = spread_labels(ax, annotations, records, choices, [habitat_label, center_label])
    refresh()
    if interactive:
        fig.canvas.mpl_connect("pick_event", on_pick)
        fig.canvas.mpl_connect("key_press_event", on_key)
        fig.canvas.mpl_connect("resize_event", on_resize)
        accept_button = Button(fig.add_axes([0.65, 0.012, 0.16, 0.028]), "Guardar selección")
        reset_button = Button(fig.add_axes([0.83, 0.012, 0.15, 0.028]), "Restaurar recomendadas")
        accept_button.on_clicked(accept)
        reset_button.on_clicked(restore)
        fig._station_buttons = (accept_button, reset_button)
    fig._station_callbacks = {"pick": on_pick, "key": on_key, "restore": restore, "role": set_role}
    fig._station_annotations = annotations
    fig._station_state = state
    fig._station_zone_images = zone_images
    return fig


def save_atlas_views(fig, output_dir):
    """Una vista por rol para que también se puedan escoger alternativas sin GUI."""
    previous = fig._station_state["active_role"]
    for station_id in ROLES:
        fig._station_callbacks["role"](station_id)
        fig.savefig(output_dir / f"weather_stations_{station_id}.png", dpi=160)
    fig._station_callbacks["role"](previous)
    fig.savefig(output_dir / "weather_stations.png", dpi=160)


def save_csv(path, records, columns):
    temporary = path.with_name(path.name + ".tmp")
    with temporary.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=columns, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(records)
    temporary.replace(path)


def save_outputs(output_dir, meta, selection, evidence, records, summaries, choices, args):
    features = []
    full_area = getattr(args, "zone_mode", "crater") == "full-area"
    recommended = automatic_choices(records)
    for record in records:
        record["selected"] = choices.get(record["station_id"]) == record["candidate_id"]
        if not record["selected"]:
            continue
        station_id = record["station_id"]
        properties = {**record, "id": station_id, "kind": "weather_station", "station_type": FULL_AREA_TYPES[station_id] if full_area else ROLES[station_id]["role"], "purpose": ROLES[station_id]["purpose"], "source": SOURCE, "selection_method": "automatic_distinct_rank_choice" if recommended.get(station_id) == record["candidate_id"] else "user_selected_ranked_alternative", "requires_visual_review": True, "requires_planner_validation": True, "notes": "Terrain-screened proposal; local low/high ground is a preference, not a confirmed crater classification. No measured wind, dust or unobstructed sensor exposure is inferred from the DEM."}
        features.append({"type": "Feature", "geometry": {"type": "Point", "coordinates": [record["longitude"], record["latitude"]]}, "properties": properties})
    assumptions = {"team_configurable": True, "site_slope_deg": args.site_slope, "site_roughness_m": args.site_roughness, "setback_m": args.setback, "setback_metric": "Euclidean distance to nearest non-installable cell center; does not certify subpixel clearance", "max_shortest_walking_distance_m": args.max_distance, "candidate_mode": args.candidate_mode, "max_alternatives_per_role": args.alternatives, "automatic_depression_search": {"radii_m": args.crater_radii, "minimum_detrended_depth_m": args.crater_min_depth, "minimum_raised_ring_sectors": 6, "total_ring_sectors": 8, "ordering": "feasible roles descending, raised sectors descending, depth/radius descending, worst closest-to-habitat O2 cost ascending"}, "weights": "Equal among varying criteria by default: w_j=1/n_active; constant criteria get zero. These are team preferences, not weights learned from NASA weather data.", "v": args.v, "operation_grid": "8 neighbors, meta.cell_m; nominal-energy-equivalent O2 minutes from the planner's exported cost_grid.f32", "georeferencing": "north-up equirectangular bbox matching the terrain exporter; output uses pixel centers"}
    assumptions.update({"zone_mode": "full-area" if full_area else "crater", "all_roles_use_complete_operation_area": full_area, "local_terrain_window_m": evidence.get("local_window_m"), "automatic_combination": "Distinct cells; minimize worst ordinal rank, then sum of ranks, then role-order tie break. Q values are not compared between roles."})
    if full_area:
        assumptions["weights"] = "By default the role-specific terrain preference gets role_weight and the four common criteria share 1-role_weight equally. Constant criteria are removed and weights renormalized. This is a configurable team assumption, not a learned NASA weather model. Explicit --weights overrides this policy per role."
        assumptions["default_requested_role_weight"] = args.role_weight
    assumptions["automatic_depression_search"]["enabled"] = not full_area
    metadata = {"source": SOURCE, "complete": len(features) == 3, "selection": selection, "search_area": evidence, "assumptions": assumptions, "roles": summaries, "example_synthetic": bool(args.example), "score_scope": "Qi is role-relative; a lowest-Qi proposal is not a unique compromise unless both VIKOR C1/C2 tests pass.", "review": "Inspect rocks, local obstructions, sensor exposure and full EVA route in the planner before adoption.", "vikor_reference": "Opricovic & Tzeng (2004), DOI:10.1016/S0377-2217(03)00020-1"}
    if not full_area:
        metadata["crater"] = evidence
    cells = {(feature["properties"]["row"], feature["properties"]["column"]) for feature in features}
    if len(cells) != len(features):
        raise ValueError("Dos estaciones no pueden exportarse en la misma celda; elige alternativas distintas.")
    write_json(output_dir / "weather_stations.geojson", {"type": "FeatureCollection", "metadata": metadata, "features": features})
    candidate_columns = ["station_id", "candidate_id", "selected", "rank", "longitude", "latitude", "row", "column", "elevation_m", "slope_deg", "roughness_m", "walking_distance_m", "oxygen_to_habitat_min", "clearance_m", "local_relief_m", "terrain_position_m", "depth_below_context_m", "height_above_context_m", "role_distance_m", "Si", "Ri", "Qi", "compromise"]
    save_csv(output_dir / "weather_station_candidates.csv", records, candidate_columns)
    audit = [{"station_id": station_id, **row} for station_id, summary in summaries.items() for row in summary.get("vikor", {}).get("weight_audit", [])]
    save_csv(output_dir / "weather_station_weights.csv", audit, ["station_id", "criterion", "direction", "minimum", "maximum", "active", "raw_weight", "weight", "method"])
    return features


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--site-dir", type=Path, default=ROOT / "web/public/data/jezero")
    parser.add_argument("--params", type=Path, default=ROOT / "web/public/data/common/params.json")
    parser.add_argument("--cost-grid", type=Path, default=ROOT / "pipeline/validation/cost_grid.f32")
    parser.add_argument("--output-dir", type=Path, default=ROOT / "pipeline/validation")
    parser.add_argument("--zone-mode", choices=["full-area", "crater"], default="full-area", help="full-area: las tres funciones usan todo el alcance; crater: conserva zonas geométricas anteriores.")
    parser.add_argument("--terrain-window", type=float, default=300.0, help="Lado aproximado de la ventana de contexto topográfico, en metros; se redondea a un número impar de celdas.")
    parser.add_argument("--role-weight", type=float, default=0.5, help="Peso previo a normalización de la preferencia científica en full-area; el resto se reparte entre cuatro criterios comunes.")
    parser.add_argument("--center", nargs=2, type=float, metavar=("ROW", "COLUMN"))
    parser.add_argument("--rim", nargs=2, type=float, metavar=("ROW", "COLUMN"))
    parser.add_argument("--reference", nargs=2, type=float, metavar=("ROW", "COLUMN"), help="Preferencia blanda para WS-1; no recorta su zona.")
    parser.add_argument("--keep-crater", action="store_true", help="Conserva el cráter guardado o indicado; no busca otro si faltan funciones.")
    parser.add_argument("--rescan-craters", action="store_true", help="Busca de nuevo una depresión que permita las tres funciones dentro del alcance.")
    parser.add_argument("--crater-radii", nargs="+", type=float, default=[30, 45, 65, 90, 125, 175, 250, 350])
    parser.add_argument("--crater-min-depth", type=float, default=1.0, help="Profundidad mínima del núcleo bajo el plano del anillo, en metros; supuesto configurable.")
    parser.add_argument("--headless", action="store_true", help="Guarda directamente las A o las alternativas de --choose.")
    parser.add_argument("--choose", nargs="*", default=[], metavar="WS-1=B")
    parser.add_argument("--max-distance", type=float, default=800.0)
    parser.add_argument("--site-slope", type=float, default=5.0)
    parser.add_argument("--site-roughness", type=float, default=None)
    parser.add_argument("--setback", type=float, default=15.0)
    parser.add_argument("--alternatives", type=int, default=10)
    parser.add_argument("--candidate-mode", choices=["top", "spaced"], default="top", help="top: primeras 10 del ranking; spaced: alternativas separadas físicamente.")
    parser.add_argument("--separation", type=float, default=30.0)
    parser.add_argument("--v", type=float, default=0.5)
    parser.add_argument("--weights", type=Path, help="JSON por WS con pesos de todos sus criterios; se normalizan después de quitar constantes.")
    parser.add_argument("--example", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()
    numeric = [args.max_distance, args.site_slope, args.setback, args.separation, args.v]
    if not np.isfinite(numeric).all() or min(numeric[:-1]) < 0 or not 1 <= args.alternatives <= 10 or not 0 <= args.v <= 1:
        parser.error("Revisa distancias, pendiente, alternativas (1–10) y v (0–1).")
    if not np.isfinite(args.crater_min_depth) or args.crater_min_depth <= 0 or not np.isfinite(args.crater_radii).all() or min(args.crater_radii) <= 0:
        parser.error("Las escalas y profundidad de la búsqueda de depresiones deben ser positivas y finitas.")
    if args.keep_crater and args.rescan_craters:
        parser.error("Usa --keep-crater o --rescan-craters, no ambos.")
    if args.keep_crater:
        args.zone_mode = "crater"
    if not np.isfinite(args.terrain_window) or args.terrain_window <= 0:
        parser.error("terrain-window debe ser positiva y finita.")
    if not np.isfinite(args.role_weight) or not 0 < args.role_weight < 1:
        parser.error("role-weight debe estar entre cero y uno, sin incluir los extremos.")
    meta, params = read_json(args.site_dir / "meta.json"), read_json(args.params)
    validate_meta(meta)
    for key in ("slope_forbidden_deg", "rough_forbidden_m", "rough_caution_m"):
        if not np.isfinite(params[key]) or params[key] < 0:
            parser.error(f"Parámetro inválido: {key}.")
    args.site_slope = min(args.site_slope, params["slope_forbidden_deg"])
    args.site_roughness = params["rough_caution_m"] if args.site_roughness is None else args.site_roughness
    if not np.isfinite(args.site_roughness) or args.site_roughness < 0:
        parser.error("site-roughness debe ser finita y no negativa.")
    args.site_roughness = min(args.site_roughness, params["rough_forbidden_m"])
    shape = (meta["height"], meta["width"])
    layers = {name: load_layer(args.site_dir / filename, shape, dtype) for name, filename, dtype in (("elevation", "elevation.f32", "<f4"), ("slope", "slope.f32", "<f4"), ("roughness", "roughness.f32", "<f4"), ("hazard", "hazard.u8", "u1"))}
    costs = load_layer(args.cost_grid, shape, "<f4")
    if np.isnan(costs).any() or (costs < 0).any():
        raise ValueError("cost_grid contiene NaN o costos negativos; +Infinity sí se permite.")
    z, slope, rough, hazard = layers["elevation"], layers["slope"], layers["roughness"], layers["hazard"]
    valid = np.isfinite(z) & np.isfinite(slope) & np.isfinite(rough) & (slope >= 0) & (rough >= 0)
    walkable = valid & np.isfinite(costs) & (hazard < 2) & (slope <= params["slope_forbidden_deg"]) & (rough <= params["rough_forbidden_m"])
    habitat = habitat_to_cell(meta)
    cell_m = float(meta["cell_m"])
    distance_m = path_field(np.where(walkable, 1.0, np.inf), habitat, cell_m)
    oxygen = path_field(np.where(walkable, costs, np.inf), habitat, cell_m)
    reachable = np.isfinite(distance_m) & np.isfinite(oxygen)
    operation = reachable & (distance_m <= args.max_distance)
    flat = walkable & (hazard == 0) & (slope <= args.site_slope) & (rough <= args.site_roughness)
    clearance = ndimage.distance_transform_edt(np.pad(flat, 1, mode="constant", constant_values=False), sampling=(cell_m, cell_m))[1:-1, 1:-1]
    stages = {"alcanzable": reachable, "radio": distance_m <= args.max_distance, "hazard0": hazard == 0, "pendiente": slope <= args.site_slope, "rugosidad": rough <= args.site_roughness, "margen": clearance >= args.setback}
    allowed = flat & operation & (clearance >= args.setback)
    args.output_dir.mkdir(parents=True, exist_ok=True)
    signature = {name: meta[name] for name in ("bbox", "width", "height", "cell_m")}
    if args.zone_mode == "full-area":
        selection_path = args.output_dir / "weather_station_search.json"
        previous_selection = None
        selection, raw_masks, evidence, terrain_position, local_relief = full_area_search(z, operation, meta, args)
        role_distances = {}
        layers.update({"terrain_position": terrain_position, "local_relief": local_relief})
        print(f"Área completa: cada WS usa las mismas {int(operation.sum())} celdas alcanzables a ≤{args.max_distance:g} m del hábitat; contexto topográfico de {evidence['local_window_m']:g} m, sin recorte por radio de cráter.")
    else:
        selection_path = args.output_dir / "weather_station_regions.json"
        if (args.center is None) != (args.rim is None):
            parser.error("Indica --center y --rim juntos, en orden FILA COLUMNA.")
        if args.center is not None:
            selection = {"center": args.center, "rim": args.rim}
        elif selection_path.is_file():
            saved = read_json(selection_path)
            if saved.get("grid") != signature:
                if args.keep_crater:
                    raise ValueError("Cambió el grid; define el mismo cráter sobre el grid nuevo con --center y --rim.")
                print("Cambió el grid; se buscan depresiones en el grid actual, sin reutilizar coordenadas antiguas.")
                selection = None
            else:
                selection = {name: saved["selection"][name] for name in ("center", "rim")}
        else:
            selection = None
        previous_selection = None if selection is None else dict(selection)
        if args.reference is not None and selection is not None:
            selection["reference"] = args.reference
        resolved, crater_proposals = resolve_crater(selection, z, meta, allowed, oxygen, args)
        selection, raw_masks, role_distances, evidence = resolved
        evidence["search_mode"] = "crater"
        print(f"Geometría del cráter: centro={selection['center']}, borde={selection['rim']}, radio={evidence['radius_m']:.1f} m; grid={meta['height']}×{meta['width']}.")
        if evidence["empty_geographic_zones"]:
            print(f"Zonas geográficas vacías: {evidence['empty_geographic_zones']}; revisa el centro y borde guardados.")
    masks = {station_id: region & operation for station_id, region in raw_masks.items()}
    evidence["operational_clipping_m"] = args.max_distance
    evidence["zone_cells_before_operation"] = {station_id: int(region.sum()) for station_id, region in raw_masks.items()}
    evidence["zone_cells_inside_operation"] = {station_id: int(region.sum()) for station_id, region in masks.items()}
    weights = read_json(args.weights) if args.weights else {}
    if not isinstance(weights, dict) or set(weights) - set(ROLES):
        raise ValueError("El JSON de pesos sólo admite WS-1, WS-2 y WS-3.")
    records, summaries = propose_stations(meta, layers, distance_m, oxygen, clearance, raw_masks, role_distances, stages, weights, args)
    choices = automatic_choices(records)
    valid_ids = {record["candidate_id"] for record in records}
    for instruction in args.choose:
        station_id, separator, letter = instruction.upper().partition("=")
        cid = f"{station_id}-{letter}"
        if not separator or cid not in valid_ids:
            raise ValueError(f"Alternativa desconocida: {instruction}; disponibles: {sorted(valid_ids)}.")
        choices[station_id] = cid
    by_id = {record["candidate_id"]: record for record in records}
    selected_cells = [(by_id[cid]["row"], by_id[cid]["column"]) for cid in choices.values()]
    if len(set(selected_cells)) != len(selected_cells):
        raise ValueError("Las selecciones de --choose repiten una celda; elige alternativas distintas para las tres estaciones.")
    write_json(selection_path, {"grid": signature, "coordinate_frame": "row,column pixel-center coordinates", "selection": selection, "previous_selection": previous_selection, "selection_method": evidence.get("selection_method")})
    features = save_outputs(args.output_dir, meta, selection, evidence, records, summaries, choices, args)
    interactive = choose_backend(args.headless)
    fig = atlas(z, walkable, operation, allowed, habitat, selection, masks, evidence, records, summaries, choices, args, interactive)
    save_atlas_views(fig, args.output_dir)
    if interactive:
        print("Candidatas calculadas: cambia de WS con las pestañas o teclas 1/2/3; pulsa una etiqueta o fila; Enter guarda. La selección inicial ya está exportada.")
        plt.show(block=True)
        features = save_outputs(args.output_dir, meta, selection, evidence, records, summaries, choices, args)
        fig = atlas(z, walkable, operation, allowed, habitat, selection, masks, evidence, records, summaries, choices, args, False)
        save_atlas_views(fig, args.output_dir)
    plt.close(fig)
    for feature in features:
        row = feature["properties"]
        print(f"{row['candidate_id']} elegida: lon={row['longitude']:.8f}, lat={row['latitude']:.8f}, Q={row['Qi']:.4f}, slope={row['slope_deg']:.2f}°, ruta={row['walking_distance_m']:.1f} m, O2={row['oxygen_to_habitat_min']:.1f} min nominales.")
    print(f"Propuestas: {len(features)}/3; v={args.v:g}; pesos exactos en weather_station_weights.csv; mismos límites para todas las alternativas.")
    print(f"Mapa: {(args.output_dir / 'weather_stations.png').resolve()}")
    print(f"Archivos: weather_stations.geojson, weather_station_candidates.csv y weather_station_weights.csv en {args.output_dir.resolve()}.")
    print("Cada Qi se compara dentro de su rol; si faltan candidatas, se informa el filtro y no se relaja automáticamente.")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, RuntimeError, KeyError) as error:
        raise SystemExit(f"ERROR: {error}") from error

