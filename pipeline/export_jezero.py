"""
Exportador de Jezero.

Genera:
    elevation.f32
    slope.f32
    roughness.f32
    hazard.u8
    hillshade.png
    slope.png
    ortho.png
    env.json

Solo ortho.png y env.json:
    .venv/bin/python pipeline/export_jezero.py --only ortho env --ls 270

Solo env.json:
    .venv/bin/python pipeline/export_jezero.py --only env --ls 270

Todos los archivos:
    .venv/bin/python pipeline/export_jezero.py --ls 270

Ls=270 es una estación fija de ejemplo.
env.json contiene climatología modelada, no observaciones actuales.
"""

import argparse
import hashlib
import json
import re
import ssl
import sys
import time

from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlencode, urljoin
from urllib.request import Request, urlopen

import certifi
import numpy as np
import rasterio

from PIL import Image
from pyproj import CRS, Transformer
from rasterio.enums import Resampling
from rasterio.windows import from_bounds
from scipy import ndimage


ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "web" / "public" / "data"

ORTHO_URL = (
    "https://asc-pds-services.s3.us-west-2.amazonaws.com/"
    "mosaic/mars2020_trn/HiRISE/"
    "JEZ_hirise_soc_006_orthoMosaic_25cm_Eqc_latTs0_lon0_first.tif"
)

MCD_BASE = "https://www-mars.lmd.jussieu.fr/mcd_python/"
MCD_CGI = MCD_BASE + "cgi-bin/mcdcgi.py"

SCENARIOS = {
    "clear": (8, "cold: low dust, minimum solar EUV"),
    "dusty": (7, "warm: dusty, maximum solar EUV"),
    "storm": (5, "dust storm, average solar EUV"),
}

MCD_LABELS = {
    "Temperature (K)": "temp_K",
    "Pressure (Pa)": "pressure_Pa",
    "Horizontal wind speed (m/s)": "wind_ms",
    "Daily mean dust column visible optical depth above surface": "tau",
}


def read_json(path):
    with Path(path).open("r", encoding="utf-8") as file:
        return json.load(file)


def roughness(z, k=5, cell_m=3.0):
    """Desviación estándar después de quitar el plano local."""
    valid = np.isfinite(z)

    zf = np.where(valid, z, np.nanmean(z)).astype(np.float64)

    off = (np.arange(k) - k // 2) * cell_m

    X = np.tile(off, (k, 1)) / (k * k)
    Y = X.T.copy()

    mz = ndimage.uniform_filter(zf, k)
    mz2 = ndimage.uniform_filter(zf ** 2, k)

    czx = ndimage.correlate(zf, X)
    czy = ndimage.correlate(zf, Y)

    varx = np.mean(np.tile(off, (k, 1)) ** 2)

    var_resid = (
        (mz2 - mz ** 2)
        - czx ** 2 / varx
        - czy ** 2 / varx
    )

    r = np.sqrt(np.maximum(var_resid, 0))

    bad = ndimage.maximum_filter(
        ~valid,
        size=k,
        mode="reflect"
    )

    r[bad] = np.nan

    return r


def hazard(slope, rough, p):
    """0 libre, 1 precaución, 2 prohibido."""
    s_c = p["slope_caution_deg"]
    s_f = p["slope_forbidden_deg"]

    r_c = p["rough_caution_m"]
    r_f = p["rough_forbidden_m"]

    hz = np.zeros(slope.shape, dtype=np.uint8)

    hz[(slope > s_c) | (rough > r_c)] = 1

    hz[
        (slope > s_f)
        | (rough > r_f)
        | ~np.isfinite(slope)
        | ~np.isfinite(rough)
    ] = 2

    return hz


def hillshade(z, dx, dy, az=315, alt=45):
    zf = np.where(
        np.isfinite(z),
        z,
        np.nanmean(z)
    )

    gy, gx = np.gradient(zf, dy, dx)

    slope = np.arctan(np.hypot(gx, gy))
    aspect = np.arctan2(-gx, gy)

    az = np.radians(az)
    alt = np.radians(alt)

    hs = (
        np.sin(alt) * np.cos(slope)
        + np.cos(alt)
        * np.sin(slope)
        * np.cos(az - aspect)
    )

    out = (np.clip(hs, 0, 1) * 255).astype(np.uint8)

    out[~np.isfinite(z)] = 0

    return out


def slope_png(slope, vmax):
    sn = np.clip(
        np.nan_to_num(slope, nan=vmax) / vmax,
        0,
        1
    )

    rgb = np.stack(
        [
            sn * 255,
            (1 - np.abs(sn - 0.5) * 2) * 200,
            (1 - sn) * 255
        ],
        axis=-1
    ).astype(np.uint8)

    return rgb


def export(z, dx, dy, meta, params, out):
    from Elevation import elevcalc

    height = meta["height"]
    width = meta["width"]

    assert z.shape == (height, width), (
        f"elevation shape {z.shape} != meta {(height, width)}"
    )

    z = np.asarray(z, dtype=np.float64)

    slope = elevcalc(
        np.ma.masked_invalid(z),
        dx,
        dy
    )

    rough = roughness(z, 5, (dx + dy) / 2)
    hz = hazard(slope, rough, params)

    out.mkdir(parents=True, exist_ok=True)

    layers = [
        ("elevation.f32", z, "<f4"),
        ("slope.f32", slope, "<f4"),
        ("roughness.f32", rough, "<f4"),
        ("hazard.u8", hz, "u1"),
    ]

    for name, array, dtype in layers:
        np.asarray(array).astype(dtype).tofile(out / name)

    Image.fromarray(
        hillshade(z, dx, dy)
    ).save(out / "hillshade.png")

    vmax = max(params["slope_forbidden_deg"] * 2, 30)

    Image.fromarray(
        slope_png(slope, vmax)
    ).save(out / "slope.png")

    nan_count = int(np.sum(~np.isfinite(z)))

    print(
        f"cell {dx:.2f} x {dy:.2f} m | "
        f"elevation {np.nanmin(z):.1f}..{np.nanmax(z):.1f} m | "
        f"NaN cells {nan_count}"
    )

    print(
        f"slope max {np.nanmax(slope):.1f} deg | "
        f"hazard free {np.mean(hz == 0):.1%} "
        f"caution {np.mean(hz == 1):.1%} "
        f"forbidden {np.mean(hz == 2):.1%}"
    )

    print(f"wrote {out}")


def projected_window(src, meta):
    """Convierte el bbox de Marte al sistema del raster."""
    if src.crs is None:
        raise ValueError(
            "El raster no tiene sistema de coordenadas."
        )

    if (
        src.transform.b != 0
        or src.transform.d != 0
        or src.transform.a <= 0
        or src.transform.e >= 0
    ):
        raise ValueError(
            "Se requiere un raster orientado al norte, sin rotación."
        )

    crs = CRS.from_user_input(src.crs)

    transformer = Transformer.from_crs(
        crs.geodetic_crs,
        crs,
        always_xy=True
    )

    bounds = transformer.transform_bounds(
        *meta["bbox"],
        errcheck=True
    )

    return from_bounds(
        *bounds,
        transform=src.transform
    )


def ortho_png(meta, source=ORTHO_URL):
    """Lee la ortoimagen con el mismo bbox y dimensiones."""
    with rasterio.open(source) as src:
        window = projected_window(src, meta)

        bands = [1, 2, 3] if src.count >= 3 else [1]

        is_byte = all(
            src.dtypes[band - 1] == "uint8"
            for band in bands
        )

        pixels = src.read(
            indexes=bands,
            window=window,
            out_shape=(
                len(bands),
                meta["height"],
                meta["width"]
            ),
            out_dtype="float32",
            resampling=Resampling.average,
            boundless=True,
            masked=True,
        )

    values = pixels.filled(np.nan)

    valid = np.isfinite(values).all(axis=0)

    if not valid.any():
        raise ValueError(
            "La ortoimagen no tiene datos válidos dentro del AOI."
        )

    if is_byte:
        display = np.clip(
            np.nan_to_num(values, nan=0.0),
            0,
            255
        )

    else:
        low, high = np.percentile(
            values[:, valid],
            [1, 99]
        )

        if high <= low:
            high = low + 1.0

        display = (
            np.clip((values - low) / (high - low), 0, 1)
            * 255
        )

        display = np.nan_to_num(display, nan=0.0)

    rgb = np.moveaxis(
        display.astype(np.uint8),
        0,
        -1
    )

    if rgb.shape[2] == 1:
        rgb = np.repeat(rgb, 3, axis=2)

    alpha = np.where(valid, 255, 0).astype(np.uint8)

    return np.dstack([rgb, alpha])


def export_ortho(meta, out, source=ORTHO_URL):
    source = str(source)
    remote = source.startswith((
        "http://", "https://", "/vsicurl/http://", "/vsicurl/https://"
    ))
    options = {
        "GDAL_DISABLE_READDIR_ON_OPEN": "EMPTY_DIR",
        "GDAL_HTTP_CONNECTTIMEOUT": 30,
        "GDAL_HTTP_TIMEOUT": 120,
        "GDAL_HTTP_MAX_RETRY": 3,
        "GDAL_HTTP_RETRY_DELAY": 2,
        "GDAL_HTTP_MULTIRANGE": "SERIAL",
    }

    if remote:
        # Al cerrar el raster se descartan los fragmentos descargados.
        options["CPL_VSIL_CURL_NON_CACHED"] = (
            source if source.startswith("/vsicurl/") else "/vsicurl/" + source
        )

    attempts = 3 if remote else 1

    for attempt in range(1, attempts + 1):
        print(
            f"Leyendo ortoimagen, solo la ventana del AOI "
            f"(intento {attempt}/{attempts})...",
            flush=True
        )
        try:
            with rasterio.Env(**options):
                rgba = ortho_png(meta, source)
            break
        except rasterio.errors.RasterioIOError:
            if attempt == attempts:
                raise
            print(
                "Falló la lectura remota; se reabrirá el raster y se reintentará.",
                flush=True
            )
            time.sleep(2 * attempt)

    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)

    temporary = out / ".ortho.png.tmp"

    Image.fromarray(rgba).save(
        temporary,
        format="PNG"
    )

    temporary.replace(out / "ortho.png")

    print(
        f"Guardado: {out / 'ortho.png'} "
        f"({meta['width']} x {meta['height']})."
    )


class DataLinks(HTMLParser):
    """Busca el enlace al archivo ASCII de MCD."""

    def __init__(self):
        super().__init__()
        self.links = []

    def handle_starttag(self, tag, attrs):
        attributes = dict(attrs)

        if tag == "a" and attributes.get("href"):
            self.links.append(attributes["href"])


def fetch_text(url, timeout=90):
    request = Request(
        url,
        headers={
            "User-Agent": "Marswalk educational climate export"
        }
    )

    context = ssl.create_default_context()
    context.load_verify_locations(cafile=certifi.where())

    with urlopen(request, timeout=timeout, context=context) as response:
        return response.read().decode(
            "utf-8",
            errors="replace"
        )


def parse_mcd_ascii(text):
    """Lee cuatro variables y devuelve las horas locales 0–23."""
    sections = {}
    current = None

    for line in text.splitlines():
        if line.startswith("### Column 2 is "):
            label = line.split(
                "### Column 2 is ",
                1
            )[1].strip()

            current = MCD_LABELS.get(label)

            if current is not None:
                sections.setdefault(current, [])

        elif (
            current
            and line.strip()
            and not line.lstrip().startswith("#")
        ):
            fields = line.split()

            if len(fields) != 2:
                raise ValueError(
                    "MCD devolvió una tabla con columnas inesperadas."
                )

            sections[current].append(
                [
                    float(
                        value.replace("D", "E").replace("d", "e")
                    )
                    for value in fields
                ]
            )

    if set(sections) != set(MCD_LABELS.values()):
        raise ValueError(
            "Faltan temperatura, presión, viento u opacidad "
            "en la respuesta MCD."
        )

    result = {}
    hours = np.arange(24, dtype=float)

    for name, rows in sections.items():
        values = np.asarray(rows, dtype=float)

        if (
            values.ndim != 2
            or values.shape[1] != 2
            or not np.isfinite(values).all()
        ):
            raise ValueError(
                f"MCD devolvió valores inválidos para {name}."
            )

        values = values[np.argsort(values[:, 0])]

        if (
            len(values) < 24
            or values[0, 0] > 0
            or values[-1, 0] < 23
            or np.any(np.diff(values[:, 0]) <= 0)
        ):
            raise ValueError(
                f"La serie {name} no cubre las 24 horas locales."
            )

        result[name] = np.interp(
            hours,
            values[:, 0],
            values[:, 1]
        )

        if (
            np.any(result[name] < 0)
            or np.any(result[name] >= 1e20)
        ):
            raise ValueError(
                f"MCD devolvió valores fuera de rango para {name}."
            )

        if (
            name in ("temp_K", "pressure_Pa")
            and np.any(result[name] <= 0)
        ):
            raise ValueError(
                f"MCD devolvió valores no positivos para {name}."
            )

    versions = set(
        re.findall(r"MCD_v([0-9.]+)", text)
    )

    if len(versions) != 1:
        raise ValueError(
            "No se pudo identificar una única versión de MCD."
        )

    return result, versions.pop()


def mcd_series(
    lon,
    lat,
    ls,
    altitude,
    scenario,
    refresh=False
):
    code, description = SCENARIOS[scenario]

    query = {
        "var1": "t",
        "var2": "p",
        "var3": "wind",
        "var4": "tauref",
        "datekeyhtml": 1,
        "ls": ls,
        "localtime": "0 24",
        "latitude": lat,
        "longitude": round(
            (lon + 180) % 360 - 180,
            10
        ),
        "altitude": altitude,
        "zkey": 3,
        "dust": code,
        "hrkey": 1,
        "isfixedlt": "on",
        "averaging": "off",
        "animation": "off",
        "dpi": 80,
        "islog": "off",
        "colorm": "jet",
        "proj": "cyl",
        "iswind": "off",
    }

    query_url = MCD_CGI + "?" + urlencode(query)

    key = hashlib.sha256(
        query_url.encode("utf-8")
    ).hexdigest()[:24]

    cache_path = (
        ROOT
        / "data"
        / "raw"
        / "mcd"
        / (key + ".json")
    )

    if cache_path.is_file() and not refresh:
        payload = json.loads(
            cache_path.read_text(encoding="utf-8")
        )

        print(
            f"MCD {scenario}: usando consulta guardada.",
            flush=True
        )

    else:
        print(
            f"Consultando MCD: {scenario}, "
            f"Ls={ls}, altura={altitude} m...",
            flush=True
        )

        page = fetch_text(query_url)

        links = DataLinks()
        links.feed(page)

        candidates = [
            urljoin(MCD_CGI, item)
            for item in links.links
        ]

        data_url = next(
            (
                url
                for url in candidates
                if (
                    url.startswith(MCD_BASE + "txt/")
                    and url.endswith(".txt")
                )
            ),
            None
        )

        if data_url is None:
            raise RuntimeError(
                f"MCD no devolvió datos ASCII para {scenario}. "
                "Revisa la disponibilidad del servicio y Ls. "
                "El env.json existente se conserva."
            )

        text = fetch_text(data_url)

        # Validar antes de guardar la consulta.
        parse_mcd_ascii(text)

        payload = {
            "ascii": text,
            "query_url": query_url,
            "data_url": data_url,
            "downloaded_at_utc": (
                datetime.now(timezone.utc).isoformat()
            ),
        }

        cache_path.parent.mkdir(
            parents=True,
            exist_ok=True
        )

        cache_path.write_text(
            json.dumps(payload, indent=2),
            encoding="utf-8"
        )

    series, version = parse_mcd_ascii(
        payload["ascii"]
    )

    provenance = {
        name: payload[name]
        for name in (
            "query_url",
            "data_url",
            "downloaded_at_utc"
        )
    }

    provenance.update(
        mcd_scenario_code=code,
        description=description,
        version=version
    )

    return series, provenance


def export_env(meta,out,ls=270.0,altitude=2.0, refresh=False):
    """Genera tres escenarios con 24 horas locales cada uno."""
    if (
        not np.isfinite([ls, altitude]).all()
        or not 180 <= ls < 360
        or altitude <= 0
    ):
        raise ValueError(
            "Para incluir storm, usa 180 <= Ls < 360 "
            "y una altura positiva."
        )

    lon, lat = map(float, meta["habitat"])

    if (
        not np.isfinite([lon, lat]).all()
        or not -90 <= lat <= 90
    ):
        raise ValueError(
            "Las coordenadas del hábitat no son válidas."
        )

    document = {}
    sources = {}

    for scenario in SCENARIOS:
        series, provenance = mcd_series(
            lon,
            lat,
            ls,
            altitude,
            scenario,
            refresh
        )

        document[scenario] = [
            {
                "hour": hour,
                **{
                    name: float(series[name][hour])
                    for name in MCD_LABELS.values()
                }
            }
            for hour in range(24)
        ]

        sources[scenario] = provenance

    versions = {
        source["version"]
        for source in sources.values()
    }

    if len(versions) != 1:
        raise ValueError(
            "Hay versiones MCD mezcladas. "
            "Ejecuta nuevamente con --refresh-env."
        )

    document["_meta"] = {
        "site": meta.get("site", "jezero"),
        "source": "Mars Climate Database",
        "version": versions.pop(),
        "source_url": MCD_BASE,
        "model_not_observations": True,
        "habitat": [lon, lat],
        "Ls_deg": float(ls),
        "altitude_above_surface_m": float(altitude),
        "hour_basis": (
            "Local true solar time (LTST), "
            "0..23 Martian hours"
        ),
        "tau_definition": (
            "Daily mean dust column visible optical depth "
            "above surface, dimensionless"
        ),
        "note": (
            "Ls es una estación fija de simulación. "
            "cold y warm también difieren en el "
            "forzamiento solar EUV."
        ),
        "attribution": (
            "Mars Climate Database (c) "
            "LMD/OU/IAA/ESA/CNES"
        ),
        "queries": sources,
    }

    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)

    temporary = out / ".env.json.tmp"

    with temporary.open("w",encoding="utf-8") as file:json.dump(document,file,indent=2,ensure_ascii=False,allow_nan=False)

    temporary.replace(out / "env.json")

    print(
        f"Guardado: {out / 'env.json'} "
        f"(3 escenarios × 24 horas, "
        f"MCD {document['_meta']['version']})."
    )

    return document


def main():
    sys.path.insert(0,str(Path(__file__).resolve().parent))

    parser = argparse.ArgumentParser(description=__doc__)

    parser.add_argument("--only",nargs="+",choices=["terrain", "ortho", "env"],default=["terrain", "ortho", "env"])

    parser.add_argument("--ls",type=float,default=270.0,help="Estación fija Ls; 270 es un ejemplo.")

    parser.add_argument("--height",type=float,default=2.0,help="Altura atmosférica sobre el suelo, en metros.")

    parser.add_argument("--ortho-source",default=ORTHO_URL)

    parser.add_argument("--refresh-env",action="store_true")

    parser.add_argument("--selftest",action="store_true")

    args = parser.parse_args()

    if args.selftest:
        params = read_json(DATA / "common" / "params.json")

        meta = read_json(DATA / "mock" / "meta.json")

        z = np.fromfile(DATA / "mock" / "elevation.f32","<f4").reshape(meta["height"],meta["width"])

        z[:5, :5] = np.nan

        export(
            z,
            meta["cell_m"],
            meta["cell_m"],
            meta,
            params,
            ROOT / "pipeline" / "_selftest_out"
        )

        return

    meta = read_json(
        DATA / "jezero" / "meta.json"
    )

    out = DATA / "jezero"

    if "terrain" in args.only:
        params = read_json(
            DATA / "common" / "params.json"
        )

        from Elevation import map as read_dtm

        elevation, dx, dy = read_dtm(meta)

        export(np.ma.filled(elevation.astype(np.float64),np.nan),dx,dy,meta,params,out)

    ortho_error = None

    if "ortho" in args.only:
        try:
            export_ortho(meta, out, args.ortho_source)
        except rasterio.errors.RasterioIOError as error:
            ortho_error = error
            print(
                f"No se pudo generar ortho.png: {error}. "
                "Si ya existía una imagen, se conserva. "
                "Se continuará con env.json si fue solicitado.",
                file=sys.stderr,
                flush=True
            )

    if "env" in args.only:
        export_env(meta,out,args.ls,args.height,args.refresh_env)

    if ortho_error is not None:
        print(
            "Exportación incompleta: ortho.png no se actualizó. "
            "Para reintentar solo la imagen, ejecuta: "
            ".venv/bin/python pipeline/export_jezero.py --only ortho",
            file=sys.stderr,
            flush=True
        )
        raise SystemExit(1)


if __name__ == "__main__":
    main()
