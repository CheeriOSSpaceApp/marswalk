import json
import requests
import pandas as pd
import numpy as np
import matplotlib.pyplot as plt

url_waypoints = "https://mars.nasa.gov/mmgis-maps/M20/Layers/json/M20_waypoints.json"
sol_start = 640
sol_end = 700
file_path = "/Users/gabrielburbano/Desktop/hack/targets.geojson"

def main():
    response = requests.get(url_waypoints, timeout=10)
    response.raise_for_status()
    waypoints = pandaconv(response)
    targets = load_targets(file_path)
    bbox = calcbbox(waypoints)
    print("Bounding box:", bbox)
    checkbbox(waypoints, bbox)
    plotbbox(waypoints, targets, bbox)



def pandaconv(response):
    data = response.json()
    df = pd.json_normalize(data["features"])
    waypoints = df[["properties.sol", "properties.lon", "properties.lat", "properties.elev_geoid"]] #creates data fram with only these

    waypoints = waypoints.drop_duplicates() #clean data
    waypoints.columns = ["sol", "lon", "lat", "elevation"] #renames colums to this
    waypoints = waypoints.dropna(subset=["sol", "lon", "lat"])# clean data
    waypoints = waypoints[waypoints["sol"].between(sol_start, sol_end)] # Drops all values outside the range
    return waypoints

def calcbbox(waypoints):
    lons = waypoints["lon"]
    lats = waypoints["lat"]
    lon_center = (lons.min() + lons.max()) / 2
    lat_center = (lats.min() + lats.max()) / 2
    mars_radius = 3396190  # meters
    AOI_M = 3000  #  Side length of the square in meters
    meters_per_degree = (2 * np.pi * mars_radius) / 360
    half_side = AOI_M / 2 #needs to exten 1500 meter per side,
    delta_lat = half_side / meters_per_degree
    delta_lon = half_side / (meters_per_degree * np.cos(np.radians(lat_center)))
    bbox = [
        lon_center - delta_lon,
        lat_center - delta_lat,
        lon_center + delta_lon,
        lat_center + delta_lat
    ] # boundaries of the BBOX
    return np.round(bbox, 6)

def checkbbox(waypoints, bbox):

    inside = (
        (waypoints["lon"] >= bbox[0]) &
        (waypoints["lon"] <= bbox[2]) &
        (waypoints["lat"] >= bbox[1]) &
        (waypoints["lat"] <= bbox[3])
    )

    total = len(waypoints)
    points_inside = inside.sum()
    points_outside = (~inside).sum()

    print("Total waypoints:", total)
    print("Points inside:", points_inside)
    print("Points outside:", points_outside)

def plotbbox(waypoints, targets, bbox):

    fig, ax = plt.subplots(figsize=(8, 8))

    ax.scatter(
        waypoints["lon"],
        waypoints["lat"],
        color="red",
        s=20,
        label="Waypoints"
    )
    research = targets[targets["kind"] != "habitat"]
    habitat = targets[targets["kind"] == "habitat"]

    # Plot research targets
    ax.scatter(
        research["lon"],
        research["lat"],
        color="blue",
        marker="D",
        s=45,
        label="Research Targets"
    )

    # Plot habitat
    ax.scatter(
        habitat["lon"],
        habitat["lat"],
        color="green",
        marker="*",
        s=180,
        label="Habitat"
    )
    ax.plot(
        [bbox[0], bbox[2], bbox[2], bbox[0], bbox[0]],
        [bbox[1], bbox[1], bbox[3], bbox[3], bbox[1]],
        color="black",
        linewidth=2,
        label="Bounding Box"
    )
    ax.set_xlabel("Longitude (°)")
    ax.set_ylabel("Latitude (°)")
    ax.set_title("Mars Perseverance Waypoints")
    ax.set_aspect(1 / np.cos(np.radians(waypoints["lat"].mean())))
    ax.legend()
    ax.grid(True)

    plt.show()


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


if __name__ == "__main__":
    main()
