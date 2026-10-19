#!/usr/bin/env python3
"""Generate Hackclock icons: a lit seven-segment 3 over a gauge bar, on ink blue."""
import sys
from PIL import Image, ImageDraw

OUT = sys.argv[1] if len(sys.argv) > 1 else "src/assets"
INK = (11, 22, 38, 255)
PAPER = (241, 236, 223, 255)
AMBER = (245, 184, 46, 255)
GHOST = (241, 236, 223, 26)


def hexh(x1, y, x2):
    return [(x1, y), (x1 + 5, y - 5), (x2 - 5, y - 5), (x2, y), (x2 - 5, y + 5), (x1 + 5, y + 5)]


def hexv(x, y1, y2):
    return [(x, y1), (x + 5, y1 + 5), (x + 5, y2 - 5), (x, y2), (x - 5, y2 - 5), (x - 5, y1 + 5)]


SEGS = {
    "a": hexh(8, 5, 48), "b": hexv(51, 8, 45), "c": hexv(51, 51, 88), "d": hexh(8, 91, 48),
    "e": hexv(5, 51, 88), "f": hexv(5, 8, 45), "g": hexh(8, 48, 48),
}
LIT = "abcdg"  # the digit 3


def render(size, maskable):
    S = size * 4
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if maskable:
        d.rectangle([0, 0, S, S], fill=INK)
    else:
        d.rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.22), fill=INK)

    # digit: 56x96 units, centred; keep inside the maskable safe zone (80%)
    scale = S * (0.46 if maskable else 0.52) / 96
    w, h = 56 * scale, 96 * scale
    ox = (S - w) / 2 - 3 * scale
    oy = S * (0.14 if maskable else 0.12)
    skew = 0.105

    def tx(p):
        x, y = p
        return (ox + (x - skew * y + skew * 96 / 2) * scale, oy + y * scale)

    for name, poly in SEGS.items():
        d.polygon([tx(p) for p in poly], fill=PAPER if name in LIT else GHOST)

    # gauge bar
    bw = S * (0.56 if maskable else 0.64)
    bh = S * 0.045
    bx = (S - bw) / 2
    by = S * (0.78 if maskable else 0.80)
    d.rounded_rectangle([bx, by, bx + bw, by + bh], radius=bh / 2, fill=(255, 255, 255, 40))
    d.rounded_rectangle([bx, by, bx + bw * 0.62, by + bh], radius=bh / 2, fill=AMBER)
    return img.resize((size, size), Image.LANCZOS)


render(512, False).save(f"{OUT}/icon-512.png")
render(192, False).save(f"{OUT}/icon-192.png")
render(180, True).save(f"{OUT}/apple-touch-icon.png")  # iOS applies its own rounding
render(512, True).save(f"{OUT}/icon-512-maskable.png")

# SVG favicon, same geometry
def pts(poly, sx=1.0):
    return " ".join(f"{x:.1f},{y:.1f}" for x, y in poly)

scale = 0.52 * 512 / 96
ox = (512 - 56 * scale) / 2 - 3 * scale
oy = 512 * 0.12
skew = 0.105
def txp(poly):
    return [(ox + (x - skew * y + skew * 48) * scale, oy + y * scale) for x, y in poly]
polys = []
for name, poly in SEGS.items():
    fill = "#f1ecdf" if name in LIT else "#f1ecdf22"
    polys.append(f'<polygon points="{pts(txp(poly))}" fill="{fill}"/>')
bw, bh = 512 * 0.64, 512 * 0.045
bx, by = (512 - bw) / 2, 512 * 0.80
svg = (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">'
    '<rect width="512" height="512" rx="112" fill="#0b1626"/>'
    + "".join(polys)
    + f'<rect x="{bx:.1f}" y="{by:.1f}" width="{bw:.1f}" height="{bh:.1f}" rx="{bh/2:.1f}" fill="#ffffff28"/>'
    + f'<rect x="{bx:.1f}" y="{by:.1f}" width="{bw*0.62:.1f}" height="{bh:.1f}" rx="{bh/2:.1f}" fill="#f5b82e"/>'
    "</svg>"
)
open(f"{OUT}/icon.svg", "w").write(svg)
print("icons written to", OUT)
