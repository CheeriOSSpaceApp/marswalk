import json
from pathlib import Path
import numpy as np
from scipy import ndimage
import matplotlib.pyplot as plt

def main():
    repo_root = Path(__file__).resolve().parents[1]
    data_dir = repo_root / "web/public/data"
    #load map infomartion nand danger levels
    with (data_dir / "jezero/meta.json").open("r", encoding="utf-8") as file:
        meta = json.load(file)
    with (data_dir / "common/params.json").open("r", encoding="utf-8") as file:
        params = json.load(file)
    numtable(meta,params,data_dir)

#with the data accesse we creatre a matrix in numpy
def numtable(meta, params, data_dir):
    height = meta["height"]
    width = meta["width"]

    slope_path = data_dir / "jezero/slope.f32"
    slope = np.fromfile(slope_path,dtype="<f4").reshape(height, width)
    max_slope = params["slope_forbidden_deg"]
    slope_allowed = (np.isfinite(slope)& (slope <= max_slope))

    print("Cells within slope limit:", np.count_nonzero(slope_allowed))
    print("Cells excluded:", np.count_nonzero(~slope_allowed))

    roughness_path = data_dir / "jezero/roughness.f32"
    roughness = np.fromfile(roughness_path,dtype="<f4").reshape(height, width)
    max_roughness = params["rough_forbidden_m"]
    terrain_allowed = (slope_allowed & np.isfinite(roughness)& (roughness <= max_roughness))
    print("Cells within both limits:",np.count_nonzero(terrain_allowed) )
    print("Cells excluded by terrain limits:",np.count_nonzero(~terrain_allowed))

    hazard = np.fromfile(data_dir / "jezero/hazard.u8",dtype="u1").reshape(height, width)
    walkable = terrain_allowed & (hazard < 2)
    print("Cells allowed by all terrain filters:",np.count_nonzero(walkable))

    habitat_row, habitat_col = habitat_to_cell(meta)
    print("Habitat cell (row, column):",(habitat_row, habitat_col))
    print("Habitat passes terrain filters:",bool(walkable[habitat_row, habitat_col]))

    reachable = find_reachable(walkable,(habitat_row, habitat_col))
    print("Reachable cells from habitat:",np.count_nonzero(reachable))
    print("Allowed but disconnected cells:",np.count_nonzero(walkable & ~reachable))
    #graph to maps points
    plot_reachable(slope,reachable,habitat_row,habitat_col)

#starting cell for routes
def habitat_to_cell(meta):
    height = meta["height"]
    width = meta["width"]

    lon_min, lat_min, lon_max, lat_max = meta["bbox"]
    habitat_lon, habitat_lat = meta["habitat"]

    if not (lon_min <= habitat_lon <= lon_max and lat_min <= habitat_lat <= lat_max):
        raise ValueError("The habitat is outside the bounding box.")

    col = int((habitat_lon - lon_min) / (lon_max - lon_min) * width)

    row = int((lat_max - habitat_lat) / (lat_max - lat_min) * height)
    col = min(col, width - 1)
    row = min(row, height - 1)

    return row, col

def find_reachable(walkable, start):
    if not walkable[start]:
        raise ValueError("The habitat is in a blocked cell.")
    seed = np.zeros_like(walkable, dtype=bool)
    seed[start] = True
    neighbors = np.array([
        [0, 1, 0],
        [1, 1, 1],
        [0, 1, 0]
    ], dtype=bool)
    reachable = ndimage.binary_propagation(seed,structure=neighbors,mask=walkable)

    return reachable

def plot_reachable(slope, reachable, habitat_row, habitat_col):
    display = np.where(reachable, slope, np.nan)

    fig, ax = plt.subplots(figsize=(9, 9))
    ax.set_facecolor("lightgray")

    image = ax.imshow(display,cmap="YlOrRd",origin="upper",vmin=0)

    ax.scatter(habitat_col,habitat_row,color="cyan",marker="*",edgecolors="black",s=180,label="Habitat")

    fig.colorbar(image, ax=ax, label="Slope (degrees)")
    ax.set_xlabel("Grid column")
    ax.set_ylabel("Grid row")
    ax.set_title("Reachable terrain from habitat")
    ax.legend()
    plt.tight_layout()
    plt.show()
if __name__ == "__main__":
    main()