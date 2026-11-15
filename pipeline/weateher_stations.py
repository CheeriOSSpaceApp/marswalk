"""Zonas, candidatas VIKOR y selección de estaciones meteorológicas.

Guardar en pipeline/weateher_stations.py y ejecutar:
    .venv/bin/python pipeline/weateher_stations.py
Sin ventana: añadir --headless. Escoger alternativas: --choose WS-1=B WS-3=C.

Reutiliza validation/weather_station_regions.json de la versión anterior.
Si no existe: --center FILA COLUMNA --rim FILA COLUMNA define el cráter.
No pide clics sobre un mapa vacío: primero calcula y muestra las candidatas.
Requisitos: numpy scipy pandas matplotlib scikit-image.
VIKOR: Opricovic & Tzeng (2004), DOI:10.1016/S0377-2217(03)00020-1.
Los pesos iguales, las zonas y los umbrales de instalación son supuestos del equipo.
"""

import argparse
import csv
import json
import math
import sys
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
from matplotlib.colors import to_rgba
from matplotlib.lines import Line2D
from matplotlib.patches import Patch
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
        raise ValueError("El relieve no confirma una depresión. Revisa --center y --rim; no se mueve el cráter automáticamente.")
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
    evidence = {"radius_m": radius, "floor_median_m": floor_median, "north_rim_median_m": rim_median, "midpoint_elevation_m": midpoint, "definitions": definitions, "reference_anchor_is_soft_preference": True, "cell_m": cell_m}
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
        data = {"row": rows, "column": cols, "elevation_m": layers["elevation"][allowed], "slope_deg": layers["slope"][allowed], "roughness_m": layers["roughness"][allowed], "walking_distance_m": distance_m[allowed], "oxygen_to_habitat_min": oxygen[allowed], "clearance_m": clearance[allowed], "role_distance_m": role_distances[station_id][allowed]}
        directions = {"slope_deg": "cost", "roughness_m": "cost", "oxygen_to_habitat_min": "cost", "clearance_m": "benefit", "role_distance_m": "cost"}
        if station_id != "WS-1":
            directions["elevation_m"] = "cost" if station_id == "WS-2" else "benefit"
        ranking, details = vikor(pd.DataFrame(data), directions, weights.get(station_id), args.v)
        shortlist = spaced_candidates(ranking, args.alternatives, args.separation, float(meta["cell_m"]))
        for number, (_, row) in enumerate(shortlist.iterrows()):
            cell = (int(row["row"]), int(row["column"]))
            lon, lat = cell_to_coordinates(cell, meta)
            record = {"station_id": station_id, "candidate_id": f"{station_id}-{chr(65 + number)}", "label": f"{station_id[-1]}{chr(65 + number)}", "name": role["name"], "alternative": chr(65 + number), "rank": int(row["rank"]), "longitude": lon, "latitude": lat, "row": cell[0], "column": cell[1], "compromise": bool(row["compromise"])}
            record.update({key: float(row[key]) for key in (*directions, "walking_distance_m", "Si", "Ri", "Qi")})
            record["elevation_m"] = float(row["elevation_m"])
            records.append(record)
        summary.update({"status": "proposal", "vikor": details, "reported_alternatives": len(shortlist)})
        weight_text = ", ".join(f"{LABELS[name]}={100 * weight:.1f}%" for name, weight in details["weights"].items())
        print(f"{station_id}: {len(ranking)} celdas factibles; {len(shortlist)} alternativas separadas ≥{args.separation:g} m; pesos {weight_text}.")
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


def atlas(z, walkable, operation, allowed, habitat, selection, masks, evidence, records, summaries, choices, args, interactive=False):
    fig = plt.figure(figsize=(18, 11), facecolor="#F6F7F9")
    ax = fig.add_axes([0.045, 0.14, 0.57, 0.74])
    panel = fig.add_axes([0.65, 0.11, 0.335, 0.81])
    panel.set_axis_off()
    finite = z[np.isfinite(z)]
    vmin, vmax = np.percentile(finite, [2, 98])
    if vmax <= vmin:
        vmax = vmin + 1
    ax.imshow(z, cmap="gray", vmin=vmin, vmax=vmax, origin="upper", interpolation="nearest")
    blocked = np.zeros((*z.shape, 4), dtype=np.float32)
    blocked[~walkable] = [0, 0, 0, 0.65]
    ax.imshow(blocked, origin="upper", interpolation="nearest")
    for station_id, region in masks.items():
        rgba = np.zeros((*z.shape, 4), dtype=np.float32)
        rgba[region] = to_rgba(ROLES[station_id]["color"], 0.23)
        rgba[region & allowed] = to_rgba(ROLES[station_id]["color"], 0.67)
        ax.imshow(rgba, origin="upper", interpolation="nearest")
        if region.any() and not region.all():
            ax.contour(region.astype(np.uint8), levels=[0.5], colors=[ROLES[station_id]["color"]], linewidths=1.0)
    if operation.any() and not operation.all():
        ax.contour(operation.astype(np.uint8), levels=[0.5], colors=["#101820"], linewidths=1.1, linestyles="--")
    center, rim = selection["center"], selection["rim"]
    circle = plt.Circle((center[1], center[0]), evidence["radius_m"] / evidence["cell_m"], fill=False, edgecolor="white", linestyle=":", linewidth=1.3)
    ax.add_patch(circle)
    ax.scatter(habitat[1], habitat[0], c="#FFDF00", marker="*", s=230, edgecolors="black", linewidths=1.2, zorder=8)
    ax.annotate("Hábitat", (habitat[1], habitat[0]), xytext=(9, -14), textcoords="offset points", fontsize=9, bbox={"facecolor": "white", "alpha": 0.9, "edgecolor": "none", "pad": 2})
    ax.plot([center[1], rim[1]], [center[0], rim[0]], color="white", linestyle=":", linewidth=1.0)
    ax.annotate("Centro", (center[1], center[0]), xytext=(-8, 10), textcoords="offset points", fontsize=8, ha="right", color="white", bbox={"facecolor": "#20252D", "alpha": 0.75, "edgecolor": "none"})
    ax.annotate("N", xy=(0.04, 0.95), xytext=(0.04, 0.85), xycoords="axes fraction", ha="center", fontsize=11, fontweight="bold", arrowprops={"arrowstyle": "-|>", "color": "black", "lw": 1.5})
    ax.set_xlabel("Columna del grid · este →")
    ax.set_ylabel("Fila del grid · sur →")
    ax.set_title("Zonas y alternativas factibles", loc="left", fontsize=15, fontweight="bold", pad=12)
    handles = [Patch(facecolor=role["color"], alpha=0.7, label=f"{station_id}: {role['name']}") for station_id, role in ROLES.items()]
    handles.extend([Line2D([0], [0], color="#101820", linestyle="--", label=f"Ruta ≤ {args.max_distance:g} m"), Line2D([0], [0], marker="o", color="none", markeredgecolor="black", markerfacecolor="none", markersize=11, label="Anillo negro: elegida")])
    ax.legend(handles=handles, loc="upper center", bbox_to_anchor=(0.5, -0.08), ncol=2, fontsize=9, frameon=False)
    panel.text(0, 1.0, "ELIGE ENTRE CANDIDATAS", fontsize=15, fontweight="bold", va="top")
    panel.text(0, 0.961, "A = menor Qi del rol · clic en punto o fila\nEnter o cerrar: guardar · R: restaurar las A", fontsize=10, va="top", color="#475467")
    artists, text_artists, rings = {}, {}, {}
    by_id = {record["candidate_id"]: record for record in records}
    for index, record in enumerate(records):
        station_id, cid = record["station_id"], record["candidate_id"]
        point = ax.scatter(record["column"], record["row"], c=ROLES[station_id]["color"], marker="o", s=62, edgecolors="white", linewidths=1.1, zorder=6, picker=7)
        artists[point] = cid
        ring = ax.scatter(record["column"], record["row"], s=190, facecolors="none", edgecolors="black", linewidths=2.1, zorder=7)
        rings[cid] = ring
        offset = (8 if index % 2 == 0 else -8, 9 if index % 2 == 0 else -17)
        annotation = ax.annotate(record["label"], (record["column"], record["row"]), xytext=offset, textcoords="offset points", fontsize=8, fontweight="bold", ha="left" if offset[0] > 0 else "right", bbox={"facecolor": "white", "edgecolor": ROLES[station_id]["color"], "alpha": 0.95, "pad": 1.5}, zorder=9, picker=True)
        artists[annotation] = cid
    y = 0.89
    row_step = 0.026
    for station_id, role in ROLES.items():
        summary = summaries[station_id]
        panel.text(0, y, f"{station_id} · {role['name']}", color=role["color"], fontsize=11, fontweight="bold", va="top")
        y -= 0.035
        if "vikor" in summary:
            abbreviations = {"slope_deg": "P", "roughness_m": "R", "oxygen_to_habitat_min": "O2", "clearance_m": "M", "role_distance_m": "D", "elevation_m": "Z"}
            weight_text = " · ".join(f"{abbreviations[key]} {value * 100:.0f}" for key, value in summary["vikor"]["weights"].items())
            panel.text(0.02, y, f"Pesos %: {weight_text}", fontsize=8.2, color="#475467", va="top")
            y -= 0.034
        role_records = [record for record in records if record["station_id"] == station_id]
        if not role_records:
            panel.text(0, y, f"Sin candidatas: {summary['first_empty_filter']} deja 0.", fontsize=9, color="#A51D2D", va="top")
            y -= 0.035
        for record in role_records:
            text_value = f"{record['label']}   Q={record['Qi']:.3f}   {record['slope_deg']:.1f}°   {record['walking_distance_m']:.0f} m   O2 {record['oxygen_to_habitat_min']:.1f}"
            artist = panel.text(0.02, y, text_value, fontsize=9, va="top", family="monospace", picker=True)
            artists[artist] = record["candidate_id"]
            text_artists[record["candidate_id"]] = artist
            y -= row_step
        y -= 0.022
    panel.text(0, y, "CÓMO SE DEFINE CADA ZONA", fontsize=10, fontweight="bold", va="top")
    y -= 0.032
    for station_id in ROLES:
        panel.text(0, y, f"{station_id}: {evidence['definitions'][station_id]}", fontsize=8.6, color=ROLES[station_id]["color"], va="top")
        y -= 0.026
    panel.text(0, y - 0.01, "Tenue: zona · intenso: instala y opera.\nP: pendiente · R: rugosidad · M: margen plano\nD: distancia al punto de referencia del rol · Z: elevación\nO2: minutos equivalentes de consumo nominal.\nQ menor es mejor sólo dentro del mismo rol.", fontsize=8.8, color="#475467", va="top", linespacing=1.4)
    heading = "Estaciones meteorológicas · propuestas según terreno y VIKOR"
    if args.example:
        heading = "EJEMPLO CON TERRENO SINTÉTICO · no son ubicaciones reales de Jezero"
    fig.suptitle(heading, x=0.045, ha="left", y=0.98, fontsize=18, fontweight="bold")
    limits = f"Instalación: pendiente ≤ {args.site_slope:g}° · rugosidad ≤ {args.site_roughness:g} m · hazard = 0 · margen ≥ {args.setback:g} m · ruta ≤ {args.max_distance:g} m"
    fig.text(0.045, 0.937, limits, fontsize=10, color="#475467")
    status_text = fig.text(0.65, 0.055, "", fontsize=9.5, color="#27364A", va="center")

    def refresh():
        for cid, ring in rings.items():
            chosen = choices.get(by_id[cid]["station_id"]) == cid
            ring.set_visible(chosen)
            artist = text_artists[cid]
            artist.set_fontweight("bold" if chosen else "normal")
            artist.set_bbox({"facecolor": "#E8EEF5" if chosen else "none", "edgecolor": "none", "pad": 2})
        status_text.set_text("Elegidas: " + " · ".join(choices.get(station_id, f"{station_id}: ninguna") for station_id in ROLES))
        fig.canvas.draw_idle()

    def on_pick(event):
        cid = artists.get(event.artist)
        if cid is not None:
            choices[by_id[cid]["station_id"]] = cid
            refresh()

    def restore(event=None):
        choices.update({record["station_id"]: record["candidate_id"] for record in records if record["alternative"] == "A"})
        refresh()

    def accept(event=None):
        plt.close(fig)

    def on_key(event):
        if event.key in ("enter", "return"):
            accept()
        elif event.key in ("r", "R"):
            restore()

    refresh()
    if interactive:
        fig.canvas.mpl_connect("pick_event", on_pick)
        fig.canvas.mpl_connect("key_press_event", on_key)
        accept_button = Button(fig.add_axes([0.65, 0.012, 0.16, 0.028]), "Guardar selección")
        reset_button = Button(fig.add_axes([0.83, 0.012, 0.15, 0.028]), "Restaurar mejores A")
        accept_button.on_clicked(accept)
        reset_button.on_clicked(restore)
        fig._station_buttons = (accept_button, reset_button)
    fig._station_callbacks = {"pick": on_pick, "key": on_key, "restore": restore}
    return fig


def save_csv(path, records, columns):
    temporary = path.with_name(path.name + ".tmp")
    with temporary.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=columns, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(records)
    temporary.replace(path)


def save_outputs(output_dir, meta, selection, evidence, records, summaries, choices, args):
    features = []
    for record in records:
        record["selected"] = choices.get(record["station_id"]) == record["candidate_id"]
        if not record["selected"]:
            continue
        station_id = record["station_id"]
        properties = {**record, "id": station_id, "kind": "weather_station", "station_type": ROLES[station_id]["role"], "purpose": ROLES[station_id]["purpose"], "source": SOURCE, "selection_method": "lowest_Qi" if record["alternative"] == "A" else "user_selected_ranked_alternative", "requires_visual_review": True, "requires_planner_validation": True, "notes": "Terrain-screened proposal; no measured wind, dust or unobstructed sensor exposure is inferred from the DEM."}
        features.append({"type": "Feature", "geometry": {"type": "Point", "coordinates": [record["longitude"], record["latitude"]]}, "properties": properties})
    assumptions = {"team_configurable": True, "site_slope_deg": args.site_slope, "site_roughness_m": args.site_roughness, "setback_m": args.setback, "setback_metric": "Euclidean distance to nearest non-installable cell center; does not certify subpixel clearance", "max_shortest_walking_distance_m": args.max_distance, "weights": "Equal among varying criteria by default: w_j=1/n_active; constant criteria get zero. These are team preferences, not weights learned from NASA weather data.", "v": args.v, "operation_grid": "8 neighbors, meta.cell_m; nominal-energy-equivalent O2 minutes from the planner's exported cost_grid.f32", "georeferencing": "north-up equirectangular bbox matching the terrain exporter; output uses pixel centers"}
    metadata = {"source": SOURCE, "complete": len(features) == 3, "selection": selection, "crater": evidence, "assumptions": assumptions, "roles": summaries, "example_synthetic": bool(args.example), "score_scope": "Qi is role-relative; a lowest-Qi proposal is not a unique compromise unless both VIKOR C1/C2 tests pass.", "review": "Inspect rocks, local obstructions, sensor exposure and full EVA route in the planner before adoption.", "vikor_reference": "Opricovic & Tzeng (2004), DOI:10.1016/S0377-2217(03)00020-1"}
    write_json(output_dir / "weather_stations.geojson", {"type": "FeatureCollection", "metadata": metadata, "features": features})
    candidate_columns = ["station_id", "candidate_id", "selected", "rank", "longitude", "latitude", "row", "column", "elevation_m", "slope_deg", "roughness_m", "walking_distance_m", "oxygen_to_habitat_min", "clearance_m", "role_distance_m", "Si", "Ri", "Qi", "compromise"]
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
    parser.add_argument("--center", nargs=2, type=float, metavar=("ROW", "COLUMN"))
    parser.add_argument("--rim", nargs=2, type=float, metavar=("ROW", "COLUMN"))
    parser.add_argument("--reference", nargs=2, type=float, metavar=("ROW", "COLUMN"), help="Preferencia blanda para WS-1; no recorta su zona.")
    parser.add_argument("--headless", action="store_true", help="Guarda directamente las A o las alternativas de --choose.")
    parser.add_argument("--choose", nargs="*", default=[], metavar="WS-1=B")
    parser.add_argument("--max-distance", type=float, default=800.0)
    parser.add_argument("--site-slope", type=float, default=5.0)
    parser.add_argument("--site-roughness", type=float, default=None)
    parser.add_argument("--setback", type=float, default=15.0)
    parser.add_argument("--alternatives", type=int, default=5)
    parser.add_argument("--separation", type=float, default=30.0)
    parser.add_argument("--v", type=float, default=0.5)
    parser.add_argument("--weights", type=Path, help="JSON por WS con pesos de todos sus criterios; se normalizan después de quitar constantes.")
    parser.add_argument("--example", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()
    numeric = [args.max_distance, args.site_slope, args.setback, args.separation, args.v]
    if not np.isfinite(numeric).all() or min(numeric[:-1]) < 0 or not 1 <= args.alternatives <= 5 or not 0 <= args.v <= 1:
        parser.error("Revisa distancias, pendiente, alternativas (1–5) y v (0–1).")
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
    selection_path = args.output_dir / "weather_station_regions.json"
    signature = {name: meta[name] for name in ("bbox", "width", "height", "cell_m")}
    if (args.center is None) != (args.rim is None):
        parser.error("Indica --center y --rim juntos, en orden FILA COLUMNA.")
    if args.center is not None:
        selection = {"center": args.center, "rim": args.rim}
    elif selection_path.is_file():
        saved = read_json(selection_path)
        if saved.get("grid") != signature:
            raise ValueError("Cambió el grid; define el mismo cráter sobre el grid nuevo con --center y --rim.")
        selection = {name: saved["selection"][name] for name in ("center", "rim")}
    else:
        raise ValueError("Falta weather_station_regions.json de la ejecución anterior. Define sólo el cráter con --center FILA COLUMNA --rim FILA COLUMNA; después se seleccionan candidatas, no puntos vacíos.")
    if args.reference is not None:
        selection["reference"] = args.reference
    masks, role_distances, evidence = geometry_masks(selection, meta, z)
    weights = read_json(args.weights) if args.weights else {}
    if not isinstance(weights, dict) or set(weights) - set(ROLES):
        raise ValueError("El JSON de pesos sólo admite WS-1, WS-2 y WS-3.")
    records, summaries = propose_stations(meta, layers, distance_m, oxygen, clearance, masks, role_distances, stages, weights, args)
    choices = {record["station_id"]: record["candidate_id"] for record in records if record["alternative"] == "A"}
    valid_ids = {record["candidate_id"] for record in records}
    for instruction in args.choose:
        station_id, separator, letter = instruction.upper().partition("=")
        cid = f"{station_id}-{letter}"
        if not separator or cid not in valid_ids:
            raise ValueError(f"Alternativa desconocida: {instruction}; disponibles: {sorted(valid_ids)}.")
        choices[station_id] = cid
    write_json(selection_path, {"grid": signature, "coordinate_frame": "row,column pixel-center coordinates", "selection": selection})
    features = save_outputs(args.output_dir, meta, selection, evidence, records, summaries, choices, args)
    interactive = choose_backend(args.headless)
    fig = atlas(z, walkable, operation, allowed, habitat, selection, masks, evidence, records, summaries, choices, args, interactive)
    fig.savefig(args.output_dir / "weather_stations.png", dpi=160)
    if interactive:
        print("Candidatas calculadas: pulsa un marcador o una fila; Enter o cerrar guarda la selección. Las A ya están exportadas por defecto.")
        plt.show(block=True)
        features = save_outputs(args.output_dir, meta, selection, evidence, records, summaries, choices, args)
        fig = atlas(z, walkable, operation, allowed, habitat, selection, masks, evidence, records, summaries, choices, args, False)
        fig.savefig(args.output_dir / "weather_stations.png", dpi=160)
    plt.close(fig)
    for feature in features:
        row = feature["properties"]
        print(f"{row['candidate_id']} elegida: lon={row['longitude']:.8f}, lat={row['latitude']:.8f}, Q={row['Qi']:.4f}, slope={row['slope_deg']:.2f}°, ruta={row['walking_distance_m']:.1f} m, O2={row['oxygen_to_habitat_min']:.1f} min nominales.")
    print(f"Propuestas: {len(features)}/3; pesos w=1/n de criterios activos (o los manuales normalizados), v={args.v:g}; mismos límites para todas las alternativas.")
    print(f"Mapa: {(args.output_dir / 'weather_stations.png').resolve()}")
    print(f"Archivos: weather_stations.geojson, weather_station_candidates.csv y weather_station_weights.csv en {args.output_dir.resolve()}.")
    print("Cada Qi se compara dentro de su rol; si faltan candidatas, se informa el filtro y no se relaja automáticamente.")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, RuntimeError, KeyError) as error:
        raise SystemExit(f"ERROR: {error}") from error
