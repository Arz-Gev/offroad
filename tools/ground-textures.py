# Rebuilds public/ground/: downloads the ground layers' Poly Haven textures (CC0, 1k) and packs each into two AVIFs,
# <layer>-a.avif (albedo rgb, height a) and <layer>-n.avif (OpenGL normal rgb). Roughness and cavity are made in
# the game's bake (textures.js). Needs Pillow 11+ (AVIF):  python3 tools/ground-textures.py
import io, os, urllib.request
import numpy as np
from PIL import Image

LAYERS = {   # game layer -> Poly Haven id (textures.js PHOTO)
    'grass': 'forrest_ground_01', 'dirt': 'rocky_trail_02', 'rock': 'rock_face_03', 'mud': 'brown_mud_02',
    'sand': 'rocky_trail', 'forest': 'forrest_ground_03', 'soil': 'brown_mud_dry',
}
OUT = os.path.join(os.path.dirname(__file__), '..', 'public', 'ground')

def get(pid, kind, ext):
    url = f'https://dl.polyhaven.org/file/ph-assets/Textures/{ext}/1k/{pid}/{pid}_{kind}_1k.{ext}'
    return Image.open(io.BytesIO(urllib.request.urlopen(url).read()))

def gray(im):
    a = np.asarray(im).astype(np.float32)
    if a.ndim == 3: a = a[..., 0]
    return a / (65535.0 if a.max() > 255 else 255.0)

os.makedirs(OUT, exist_ok=True)
for name, pid in LAYERS.items():
    diff = np.asarray(get(pid, 'diff', 'jpg').convert('RGB'))
    h = gray(get(pid, 'disp', 'png'))
    lo, hi = np.percentile(h, 0.5), np.percentile(h, 99.5)   # stretch the height to the full range
    h = np.clip((h - lo) / max(hi - lo, 1e-6), 0, 1)
    nrm = np.asarray(get(pid, 'nor_gl', 'png').convert('RGB'))
    Image.fromarray(np.dstack([diff, (h * 255 + 0.5).astype(np.uint8)]), 'RGBA').save(f'{OUT}/{name}-a.avif', quality=60, subsampling='4:2:0', speed=3)
    Image.fromarray(nrm, 'RGB').save(f'{OUT}/{name}-n.avif', quality=58, subsampling='4:4:4', speed=3)
    print(name, pid)
