"""Utilidades compartidas de la validación (Bloque 4, Marco).

Convenciones del proyecto (CONTRACTS.md):
  Mars 2000 planetocéntrico, lon 0-360 E, lat +N, malla equirectangular sobre el AOI,
  fila 0 = norte, columna 0 = oeste, binarios little-endian, row-major.
El bbox de meta.json se interpreta como BORDES EXTERIORES del raster (verificado en el
Bloque 3: así la celda mide exactamente 3.0000 m).

Métrica local: equirectangular centrada en el AOI, R = 3 396 190 m (CONTRACTS.md).
  x = (lon - lonMin) * cos(lat_c) * R * pi/180     (m hacia el este desde el borde O)
  y = (latMax - lat) * R * pi/180                  (m hacia el sur desde el borde N)
En esta métrica col = x / dx y fila = y / dy, con dx = dy = 3.0 m: la transformación es lineal y
exacta respecto al grid, así que no se asigna ningún CRS terrestre.
"""
import json
import math

import numpy as np

R_MARS = 3_396_190.0


class Grid:
    def __init__(self, meta_path):
        m = json.load(open(meta_path))
        self.meta = m
        self.lon0, self.lat0, self.lon1, self.lat1 = m["bbox"]
        self.W, self.H = int(m["width"]), int(m["height"])
        self.latc = 0.5 * (self.lat0 + self.lat1)
        k = R_MARS * math.pi / 180.0
        self.kx = k * math.cos(math.radians(self.latc))
        self.ky = k
        self.dx = (self.lon1 - self.lon0) * self.kx / self.W
        self.dy = (self.lat1 - self.lat0) * self.ky / self.H
        self.habitat = m.get("habitat")

    # lon/lat -> metros locales
    def to_xy(self, lon, lat):
        lon = np.asarray(lon, float); lat = np.asarray(lat, float)
        return (lon - self.lon0) * self.kx, (self.lat1 - lat) * self.ky

    def to_lonlat(self, x, y):
        return self.lon0 + np.asarray(x) / self.kx, self.lat1 - np.asarray(y) / self.ky

    # metros locales -> fila/col (enteros)
    def xy_to_rc(self, x, y):
        c = np.floor(np.asarray(x) / self.dx).astype(int)
        r = np.floor(np.asarray(y) / self.dy).astype(int)
        return np.clip(r, 0, self.H - 1), np.clip(c, 0, self.W - 1)

    # centro de celda -> metros
    def rc_to_xy(self, r, c):
        return (np.asarray(c) + 0.5) * self.dx, (np.asarray(r) + 0.5) * self.dy

    def load(self, path, dtype):
        a = np.fromfile(path, dtype=dtype)
        if a.size != self.W * self.H:
            raise SystemExit(f"{path}: {a.size} valores, se esperaban {self.W*self.H}")
        return a.reshape(self.H, self.W)


def load_traverse(path):
    """Devuelve la lista de Features (LineString por sol) en el orden del archivo."""
    g = json.load(open(path))
    feats = g["features"] if g.get("type") == "FeatureCollection" else [g]
    out = []
    for f in feats:
        geom = f["geometry"]
        if geom["type"] == "LineString":
            parts = [geom["coordinates"]]
        elif geom["type"] == "MultiLineString":
            parts = geom["coordinates"]
        else:
            raise SystemExit(f"Geometría no soportada: {geom['type']}")
        for p in parts:
            out.append({"props": f.get("properties", {}), "coords": np.asarray(p, float)})
    return g, out


def densify_xy(x, y, step):
    """Puntos a lo largo de la polilínea cada <= step m (incluye vértices).
    Devuelve x, y y la longitud que representa cada punto (para ponderar por longitud)."""
    xs, ys = [x[0]], [y[0]]
    for i in range(len(x) - 1):
        L = math.hypot(x[i+1] - x[i], y[i+1] - y[i])
        n = max(1, int(math.ceil(L / step)))
        t = np.arange(1, n + 1) / n
        xs.extend(x[i] + t * (x[i+1] - x[i])); ys.extend(y[i] + t * (y[i+1] - y[i]))
    return np.array(xs), np.array(ys)


def cells_with_length(x, y, grid):
    """Celdas atravesadas por la polilínea (supercobertura exacta por cruces de bordes de celda)
    y la longitud (m) recorrida dentro de cada una. Devuelve dict {(r,c): metros}."""
    acc = {}
    for i in range(len(x) - 1):
        x0, y0, x1, y1 = x[i], y[i], x[i+1], y[i+1]
        L = math.hypot(x1 - x0, y1 - y0)
        if L == 0:
            continue
        ts = [0.0, 1.0]
        for a0, a1, d in ((x0, x1, grid.dx), (y0, y1, grid.dy)):
            if a1 != a0:
                lo, hi = sorted((a0, a1))
                k0 = math.floor(lo / d) + 1; k1 = math.ceil(hi / d) - 1
                for k in range(k0, k1 + 1):
                    ts.append((k * d - a0) / (a1 - a0))
        ts = np.unique(np.clip(ts, 0, 1))
        for ta, tb in zip(ts[:-1], ts[1:]):
            if tb - ta <= 0:
                continue
            tm = 0.5 * (ta + tb)
            r, c = grid.xy_to_rc(x0 + tm * (x1 - x0), y0 + tm * (y1 - y0))
            key = (int(r), int(c))
            acc[key] = acc.get(key, 0.0) + (tb - ta) * L
    return acc
