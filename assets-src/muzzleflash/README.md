# Muzzle flash textures

`public/fx/muzzle-side.png` (3 flames seen from the side, 512x256 each, muzzle at the left edge) and
`public/fx/muzzle-front.png` (3 flashes seen down the bore, 256x256 each) are real photographed flames, keyed onto
black by `key.py` (green-channel / luminance keys, soft windows, the front views get radial jets cut from the side
flames). Additive: black = nothing. The sources are not in the repo; download them to rebuild:

| Used as | Source | Licence |
|---|---|---|
| side 1 (long jet) | [Muzzle flash VFX 2](https://commons.wikimedia.org/wiki/File:Muzzle_flash_VFX_2.png), ZunterPHOTO, cut from a US Navy photo of an M2 .50 at night → `flash/` | CC0 |
| side 2 (fireball) | ["Light 'Em Up"](https://commons.wikimedia.org/wiki/File:Light_%27Em_Up_%288601182782%29.jpg), US Marines, M2 at night (original 5616 px) → `photos/f08.jpg` | public domain |
| side 3 (plume + ball) | [Muzzle flash VFX](https://commons.wikimedia.org/wiki/File:Muzzle_flash_VFX.png), ZunterPHOTO → `flash/` | CC0 |
| fronts | [VFX 4](https://commons.wikimedia.org/wiki/File:Muzzle_flash_VFX_4.jpg), [VFX 5](https://commons.wikimedia.org/wiki/File:Muzzle_flash_VFX_5.jpg), [VFX 3](https://commons.wikimedia.org/wiki/File:Muzzle_flash_VFX_3.png), ZunterPHOTO → `flash/` | CC0 |

Looked at and not used: Sketchfab's muzzle flash models (a low-res 4-prong front atlas, a cartoon turret flash),
daylight photos (the flame washes into the sky and can't be keyed), photos with a small or noisy flash.

The pixel coordinates in `key.py` (muzzle point, bore angle, length, half-width) are for those exact files.
