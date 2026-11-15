"""Pruebas sintéticas de la métrica de 20 m y de la cadena 8-conectada (no usan datos reales)."""
import sys, os, numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from shapely.geometry import LineString
from compare_rover_route import within_pct, to_8chain
from grid_utils import Grid
x = np.array([0., 100.]); y = np.array([0., 0.])
r = within_pct(x, y, LineString([(0, 10), (100, 10)]), 20); assert abs(r["pct"] - 100) < 1e-6, r
r = within_pct(x, y, LineString([(0, 30), (100, 30)]), 20); assert r["pct"] == 0, r
# recta inclinada (0,0)-(100,40): distancia perpendicular = x·sin(atan 0.4) <= 20  =>  x <= 53.85 m
r = within_pct(x, y, LineString([(0, 0), (100, 40)]), 20)
d_ok = abs(r["pct"] - 53.852) < 0.05; assert d_ok, r
# vértices irregulares no sesgan: 1000 vértices en los primeros 10 m (fuera) y 2 en los 90 m restantes (dentro)
xx = np.r_[np.linspace(0, 10, 1000), 100.]; yy = np.zeros_like(xx)
r = within_pct(xx, yy, LineString([(10, 5), (100, 5)]), 5.0001); assert abs(r["pct"] - 90) < 0.1, r
g = Grid(sys.argv[1]); ch = to_8chain(np.array([1.5, 301.5]), np.array([1.5, 151.5]), g)
print("OK: 100 %, 0 %, 53.85 % (analítico), ponderación por longitud (90 %), cadena 8-conectada de", len(ch), "celdas")
