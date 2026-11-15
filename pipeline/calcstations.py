import json
from pathlib import Path
import numpy as np
from scipy import ndimage
import matplotlib.pyplot as plt
from matplotlib.colors import LinearSegmentedColormap
from skimage.graph import MCP_Geometric

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

    roughness_path = data_dir / "jezero/roughness.f32"
    roughness = np.fromfile(roughness_path,dtype="<f4").reshape(height, width)
    max_roughness = params["rough_forbidden_m"]
    terrain_allowed = (slope_allowed & np.isfinite(roughness)& (roughness <= max_roughness))


    hazard = np.fromfile(data_dir / "jezero/hazard.u8",dtype="u1").reshape(height, width)
    walkable = terrain_allowed & (hazard < 2)

    habitat_row, habitat_col = habitat_to_cell(meta)

    reachable = find_reachable(walkable,(habitat_row, habitat_col))
    #graph to maps points
    distance_m = walking_distances(walkable,(habitat_row, habitat_col), meta["cell_m"] )

    coverage_zone = reachable & (distance_m <= 1770.0)
    cost_grid = load_cost_grid(meta)

    print("Cost grid shape:", cost_grid.shape)
    print("Cost at habitat:", cost_grid[habitat_row, habitat_col])
    # Abrir la gráfica después de calcular e imprimir.
    stations, history, before, after = greedy_stations(
        cost_grid,
        coverage_zone,
        (habitat_row, habitat_col),
        meta["cell_m"],
        max_stations=3,
        threshold=10.0
    )

    print("Caches (row, column):", stations)

    for entry in history:
        print(f"k={entry['k']}: "f"{entry['worst_o2_min']:.2f} nominal O2 min")
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

    neighbors = np.ones((3, 3), dtype=bool)

    reachable = ndimage.binary_propagation(seed,structure=neighbors,mask=walkable)

    return reachable

def plot_reachable(slope, reachable, habitat_row, habitat_col):
    display = np.where(reachable, slope, np.nan)

    cmap = LinearSegmentedColormap.from_list(
        "access_purple",
        ["#F1E6FF", "#BA80E6", "#692399"]
    ).with_extremes(bad="black")

    fig, ax = plt.subplots(figsize=(9, 9))
    ax.set_facecolor("black")

    image = ax.imshow(display,cmap=cmap,origin="upper",vmin=0,interpolation="nearest")

    ax.scatter(habitat_col,habitat_row,color="cyan",marker="*",edgecolors="black",s=180,label="Habitat")

    fig.colorbar(image,ax=ax,label="Slope on reachable terrain (degrees)")

    ax.set_xlabel("Grid column")
    ax.set_ylabel("Grid row")
    ax.set_title("Reachable terrain from habitat")
    ax.legend()

    plt.tight_layout()
    plt.show()
def walking_distances(walkable, start, cell_m):
    if not walkable[start]:
        raise ValueError("The habitat is in a blocked cell.")
    costs = np.where(walkable, 1.0, np.inf)
    solver = MCP_Geometric(costs,fully_connected=True,sampling=(cell_m, cell_m))

    distances, _ = solver.find_costs(starts=[start])

    return distances

#loasts de oxygen cost file
def load_cost_grid(meta):
    cost_path = (Path(__file__).resolve().parent/ "validation"/ "cost_grid.f32")
    costs = np.fromfile(cost_path, dtype="<f4")
    expected = meta["height"] * meta["width"]
    if costs.size != expected:
        raise ValueError(f"Expected {expected} costs, found {costs.size}.")
    return costs.reshape(meta["height"], meta["width"])


def cost_to_safety(cost_grid, sources, cell_m):
    for source in sources:
        if not np.isfinite(cost_grid[source]):
            raise ValueError("A safety source is in blocked terrain.")
    solver = MCP_Geometric(cost_grid,fully_connected=True,sampling=(cell_m, cell_m))

    cost_field, _ = solver.find_costs(starts=sources)

    return cost_field

def choose_station(cost_field, coverage_zone):
    if not coverage_zone.any():
        raise ValueError("The coverage zone is empty.")
    candidates = np.where(coverage_zone,cost_field,-np.inf)
    flat_index = np.argmax(candidates)
    row, col = np.unravel_index(flat_index, cost_field.shape )

    return int(row), int(col)
def greedy_stations(cost_grid,
    coverage_zone,
    habitat_cell,
    cell_m,
    max_stations=3,
    threshold=10.0):
    if not coverage_zone.any():
        raise ValueError("The coverage zone is empty.")
    sources = [habitat_cell]
    stations = []
    history = []
    field = cost_to_safety(cost_grid, sources, cell_m)
    before = field.copy()
    for k in range(max_stations + 1):
        if not np.isfinite(field[coverage_zone]).all():
            raise ValueError("Some coverage cells cannot reach a source.")

        worst = float(field[coverage_zone].max())
        history.append({"k": k,"worst_o2_min": worst})
        if worst <= threshold or k == max_stations:
            break
        station = choose_station(field, coverage_zone)
        stations.append(station)
        sources.append(station)
        field = cost_to_safety(cost_grid, sources, cell_m)
    return stations, history, before, field
if __name__ == "__main__":
    main()