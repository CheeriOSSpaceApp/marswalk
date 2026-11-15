import json
from pathlib import Path
import re
import requests
import numpy as np

from io import StringIO
from urllib.parse import urljoin

def main():
    repo_root = Path(__file__).resolve().parents[1]
    data_dir = repo_root / "web/public/data/jezero"
    with (data_dir / "meta.json").open("r", encoding="utf-8") as file:
        meta = json.load(file)
    #cords for the habitat gotten from meta foun in the meta.json file
    longitude, latitude = meta["habitat"]
    # Mismo valor usado al generar env.json en tu ejemplo
    ls_deg = 270.0
    ltst, zenith = get_solar_data(longitude, latitude, ls_deg)

    sunrise, sunset = find_sunrise_sunset(ltst, zenith)
    print(f"\nAmanecer: {sunrise:.4f} h LTST")
    print(f"Atardecer: {sunset:.4f} h LTST")

    sunrise_lmst = ltst_to_lmst(sunrise, ls_deg)
    sunset_lmst = ltst_to_lmst(sunset, ls_deg)

    print(f"\nAmanecer: {sunrise_lmst:.4f} h LMST")
    print(f"Atardecer: {sunset_lmst:.4f} h LMST")
    # checkhours.py está dentro de pipeline/
    repo_root = Path(__file__).resolve().parents[1]

    # Cambia esta ruta para elegir el directorio de destino
    output_dir = repo_root / "web/public/data/common"

    save_solar_times(params_path=output_dir / "params.json",sunrise_lmst=sunrise_lmst,sunset_lmst=sunset_lmst,ls_deg=ls_deg,longitude=longitude,latitude=latitude,)

def get_solar_data(longitude, latitude, ls_deg):
    url = ("https://www-mars.lmd.jussieu.fr/mcd_python/cgi-bin/mcdcgi.py")

    query = {
        "var1": "solzenang",  # Ángulo cenital solar
        "var2": "none",
        "var3": "none",
        "var4": "none",
        "datekeyhtml": 1,     # Consultar usando Ls
        "ls": ls_deg,
        "localtime": "all",   # Recorrer todo el sol
        "longitude": longitude,
        "latitude": latitude,
        "altitude": 2,
        "zkey": 3,            # Altura sobre la superficie
        "dust": 1,
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
    # MCD devuelve una página con el enlace a la tabla
    response = requests.get(url, params=query, timeout=90)
    response.raise_for_status()
    match = re.search(r"""href\s*=\s*["']([^"']+\.txt)["']""", response.text,)
    if match is None:
        raise RuntimeError("MCD no devolvió el enlace a los datos.")

    # download table of numbers
    table_url = urljoin(response.url, match.group(1))

    response = requests.get(table_url, timeout=90)
    response.raise_for_status()

    table = np.loadtxt(StringIO(response.text), comments="#")

    ltst = table[:, 0]
    zenith = table[:, 1]

    return ltst, zenith

def find_sunrise_sunset(ltst, zenith):
    sunrise = None
    sunset = None
    for i in range(len(ltst) - 1):
        t1, t2 = ltst[i], ltst[i + 1]
        z1, z2 = zenith[i], zenith[i + 1]
        # Amanecer: el ángulo baja y cruza 90°
        if z1 > 90 and z2 <= 90:
            sunrise = t1 + (90 - z1) / (z2 - z1) * (t2 - t1)
        # Atardecer: el ángulo sube y cruza 90°
        elif z1 <= 90 and z2 > 90:
            sunset = t1 + (90 - z1) / (z2 - z1) * (t2 - t1)
    if sunrise is None or sunset is None:
        raise ValueError("No se encontraron ambos cruces de 90°.")

    return sunrise, sunset

def ltst_to_lmst(ltst_hour, ls_deg):
    # Conversión aproximada de LMD, en horas marcianas
    correction = (0.712 * np.sin(np.radians(ls_deg - 251.0))- 0.190 * np.sin(np.radians(2.0 * ls_deg)))

    return (ltst_hour + correction) % 24
def save_solar_times(
    params_path,
    sunrise_lmst,
    sunset_lmst,
    ls_deg,
    longitude,
    latitude,
    mcd_version="6.2",
):
    params_path = Path(params_path)

    params = json.loads(
        params_path.read_text(encoding="utf-8")
    )

    source = (
        f"MCD v{mcd_version}; Ls={ls_deg:g} deg; "
        f"habitat: {longitude:.8f} E, {latitude:.8f} N; "
        "hourly solar zenith crossing 90 deg; "
        "linear interpolation; approximate LTST-to-LMST "
        "conversion from LMD; flat horizon; "
        "decimal Martian hours. "
        "https://www-mars.lmd.jussieu.fr/mcd_python/"
    )

    for key, value in {
        "sunrise_lmst": sunrise_lmst,
        "sunset_lmst": sunset_lmst,
    }.items():
        params[key]["value"] = round(float(value), 4)
        params[key]["source"] = source

    content = json.dumps(params, indent=2, ensure_ascii=False, allow_nan=False) + "\n"

    temporary_path = params_path.with_suffix(".json.tmp")
    temporary_path.write_text(content, encoding="utf-8")
    temporary_path.replace(params_path)

    print("Horas guardadas en:", params_path)

if __name__ == "__main__":
    main()