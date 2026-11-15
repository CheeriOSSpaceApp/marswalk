# change file locations
import json
import requests
import pandas as pd
import numpy as np
import matplotlib.pyplot as plt

from pathlib import Path

# Configuration
url_waypoints = "https://mars.nasa.gov/mmgis-maps/M20/Layers/json/M20_waypoints.json"
sol_start = 640
sol_end = 700
repo_root = Path(__file__).resolve().parent.parent
file_path = repo_root / "web/public/data/jezero/targets.geojson"
SITE = "jezero"
AOI_M = 3000
WIDTH = 1000
HEIGHT = 1000


def main():
    # Download NASA waypoints
    response = requests.get(url_waypoints, timeout=10)
    response.raise_for_status()

    # Load datasets
    waypoints = pandaconv(response)
    targets = load_targets(file_path)

    # Combine all geographic points
    all_points = pd.concat([
        waypoints[["lon", "lat"]],
        targets[["lon", "lat"]]
    ], ignore_index=True)

    # Calculate bounding box
    bbox = calcbbox(all_points)
    print("Bounding box:", bbox)

    # Verify all points
    checkbbox(all_points, bbox)

    # Save metadata to JSON
    output_path = repo_root / "web/public/data/jezero/meta.json"
    save_metadata(bbox, targets, output_path)

    # Plot all locations
    plotbbox(waypoints, targets, bbox)

def pandaconv(response):
    data = response.json()
    df = pd.json_normalize(data["features"])

    waypoints = df[["properties.sol","properties.lon","properties.lat","properties.elev_geoid"]].copy()
    waypoints.columns = ["sol", "lon", "lat", "elevation"]
    waypoints = waypoints.drop_duplicates()
    waypoints = waypoints.dropna(subset=["sol", "lon", "lat"])

    waypoints = waypoints[waypoints["sol"].between(sol_start, sol_end)]
    return waypoints


def load_targets(filename):
    with open(filename, "r", encoding="utf-8") as file:
        data = json.load(file)
    df = pd.json_normalize(data["features"])
    coords = pd.DataFrame(
        df["geometry.coordinates"].tolist(),
        columns=["lon", "lat"]
    )

    targets = pd.DataFrame({
        "id": df["properties.id"],
        "name": df["properties.name"],
        "kind": df["properties.kind"],
        "science_value": df["properties.science_value"],
        "lon": coords["lon"],
        "lat": coords["lat"]
    })

    return targets

def calcbbox(points):
    lons = points["lon"]
    lats = points["lat"]
    lon_center = (lons.min() + lons.max()) / 2
    lat_center = (lats.min() + lats.max()) / 2
    mars_radius = 3396190
    meters_per_degree = (2 * np.pi * mars_radius) / 360

    half_side = AOI_M / 2

    delta_lat = half_side / meters_per_degree

    delta_lon = half_side / (meters_per_degree *np.cos(np.radians(lat_center)))

    bbox = [
        lon_center - delta_lon,
        lat_center - delta_lat,
        lon_center + delta_lon,
        lat_center + delta_lat
    ]
    return np.round(bbox, 6)

def checkbbox(points, bbox):
    inside = (
        (points["lon"] >= bbox[0]) &
        (points["lon"] <= bbox[2]) &
        (points["lat"] >= bbox[1]) &
        (points["lat"] <= bbox[3])
    )
    print("Total points:", len(points))
    print("Points inside:", int(inside.sum()))
    print("Points outside:", int((~inside).sum()))

# NEW: Save metadata to JSON
def save_metadata(bbox, targets, output_path):

    # Find habitat location
    habitat = targets[
        targets["kind"] == "habitat"
    ]

    if len(habitat) != 1:
        raise ValueError(
            "Expected exactly one habitat in targets.geojson"
        )

    # Extract habitat coordinates
    habitat_coords = [float(habitat["lon"].iloc[0]),float(habitat["lat"].iloc[0])]

    # Calculate cell resolution
    cell_m = AOI_M / WIDTH

    # Create metadata dictionary
    meta = {
        "site": SITE,
        "bbox": bbox.tolist(),
        "width": WIDTH,
        "height": HEIGHT,
        "cell_m": cell_m,
        "habitat": habitat_coords
    }

    # Write JSON file
    with open(output_path, "w", encoding="utf-8") as file:
        json.dump(meta, file, indent=2)
    print("Metadata saved to:", output_path)
    return meta

def plotbbox(waypoints, targets, bbox):
    fig, ax = plt.subplots(figsize=(8, 8))
    # NASA waypoints
    ax.scatter(
        waypoints["lon"],
        waypoints["lat"],
        color="red",
        s=20,
        label="Waypoints"
    )
    research = targets[
        targets["kind"] != "habitat"
    ]
    habitat = targets[
        targets["kind"] == "habitat"
    ]
    # Research targets
    ax.scatter(
        research["lon"],
        research["lat"],
        color="blue",
        marker="D",
        s=45,
        label="Research Targets"
    )
    # Habitat
    ax.scatter(
        habitat["lon"],
        habitat["lat"],
        color="green",
        marker="*",
        s=180,
        label="Habitat"
    )
    # Bounding box
    ax.plot(
        [bbox[0], bbox[2], bbox[2], bbox[0], bbox[0]],
        [bbox[1], bbox[1], bbox[3], bbox[3], bbox[1]],
        color="black",
        linewidth=2,
        label="Bounding Box"
    )
    ax.set_xlabel("Longitude (°)")
    ax.set_ylabel("Latitude (°)")
    ax.set_title("Mars Perseverance: Waypoints and Targets")
    lat_center = (bbox[1] + bbox[3]) / 2
    ax.set_aspect(1 / np.cos(np.radians(lat_center)))
    ax.legend()
    ax.grid(True)
    plt.show()

if __name__ == "__main__":
    main()