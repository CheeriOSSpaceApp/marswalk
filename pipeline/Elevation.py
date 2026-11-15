import rasterio
from pathlib import Path
from pyproj import CRS, Transformer
from rasterio.windows import from_bounds
import json
from rasterio.enums import Resampling
import numpy as np
import matplotlib.pyplot as plt
from bbox import load_targets


url_dtm = ("https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/mars2020_trn/HiRISE/JEZ_hirise_soc_006_DTM_MOLAtopography_DeltaGeoid_1m_Eqc_latTs0_lon0_blend40.tif")

def main():
    repo_root = Path(__file__).resolve().parent.parent
    meta_path = repo_root / "web/public/data/jezero/meta.json"
    with meta_path.open("r", encoding="utf-8") as file:
        meta = json.load(file)

    with meta_path.open("r", encoding="utf-8") as file:
        meta = json.load(file)
    elevation, dx_m, dy_m = map(meta)
    slope = elevcalc(elevation, dx_m, dy_m)
    graph(slope, meta)
    roughness = roughcalc(elevation)

    print("Roughness grid shape:", roughness.shape)
    print("Minimum roughness:", np.nanmin(roughness), "m")
    print("Maximum roughness:", np.nanmax(roughness), "m")

def map(meta):
    lon_min, lat_min, lon_max, lat_max = meta["bbox"]

    with rasterio.open(url_dtm) as dtm:
        map_crs = CRS.from_user_input(dtm.crs)
        #read the elevations inside bounding box
        transformer = Transformer.from_crs(map_crs.geodetic_crs,map_crs, always_xy=True)

        x_min, y_min, x_max, y_max = transformer.transform_bounds(lon_min, lat_min, lon_max, lat_max)

        window = from_bounds(x_min, y_min, x_max, y_max,transform=dtm.transform)
        #fit in a 1000 by 1000
        elevation = dtm.read(1,window=window,out_shape=(meta["height"], meta["width"]),resampling=Resampling.bilinear,masked=True)

        #calcualte distance between cells
        geod = map_crs.get_geod()

        lon_mid = (lon_min + lon_max) / 2
        lat_mid = (lat_min + lat_max) / 2

        _, _, width_m = geod.inv(lon_min, lat_mid, lon_max, lat_mid)
        _, _, height_m = geod.inv(lon_mid, lat_min, lon_mid, lat_max)

        dx_m = width_m / elevation.shape[1]
        dy_m = height_m / elevation.shape[0]
    return elevation, dx_m, dy_m

def graph(slope,meta):
    repo_root = Path(__file__).resolve().parent.parent
    targets_path = repo_root / "web/public/data/jezero/targets.geojson"
    targets = load_targets(targets_path)

    research = targets[targets["kind"] != "habitat"]

    lon_min, lat_min, lon_max, lat_max = meta["bbox"]
    habitat_lon, habitat_lat = meta["habitat"]

    fig, ax = plt.subplots(figsize=(8, 8))

    image = ax.imshow(slope,cmap="YlOrRd",origin="upper",vmin=0,extent=(lon_min, lon_max, lat_min, lat_max))

    fig.colorbar(image, ax=ax, label="Slope (degrees)")

    ax.scatter(research["lon"], research["lat"],color="blue", marker="x", s=45,label="Research targets")

    ax.scatter(habitat_lon, habitat_lat,color="green", marker="p", s=180, edgecolors="black", label="Habitat")

    ax.set_xlim(lon_min, lon_max)
    ax.set_ylim(lat_min, lat_max)

    lat_center = (lat_min + lat_max) / 2
    ax.set_aspect(1 / np.cos(np.radians(lat_center)))

    ax.set_xlabel("Longitude (°)")
    ax.set_ylabel("Latitude (°)")
    ax.set_title("Jezero slopes, research targets and habitat")
    ax.legend()

    plt.tight_layout()
    plt.show()

# slope grid in degrees
def elevcalc(elevation, dx_m, dy_m):
    z = elevation.filled(np.nan)

    dz_dy, dz_dx = np.gradient(z, dy_m, dx_m)

    slope_ratio = np.sqrt(dz_dx ** 2 + dz_dy ** 2)
    slope_deg = np.degrees(np.arctan(slope_ratio))

    slope_deg[~np.isfinite(z)] = np.nan
    return slope_deg

def roughcalc(elevation):
    z = elevation.astype(np.float64).filled(np.nan)

    padded = np.pad(z, 2, mode="symmetric")

    windows = np.lib.stride_tricks.sliding_window_view(
        padded, (5, 5)
    )

    roughness = np.std(windows, axis=(-2, -1))

    return roughness

if __name__ == "__main__":
    main()