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

if __name__ == "__main__":
    main()