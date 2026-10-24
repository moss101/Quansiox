#!/usr/bin/env python3
"""Generate the Quansiox app icon set: a rounded-square gradient tile with a
stylised Q orbit. Writes PNGs into build/icon.iconset and an .icns via iconutil."""
import math
import pathlib
import subprocess
import sys

from PIL import Image, ImageDraw, ImageFilter

OUT = pathlib.Path(__file__).resolve().parent.parent / "build" / "icon.iconset"
OUT.mkdir(parents=True, exist_ok=True)

SIZES = [16, 32, 64, 128, 256, 512, 1024]


def rounded_tile(size: int) -> Image.Image:
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    r = size * 0.225
    # vertical gradient indigo -> deep blue
    top, bottom = (108, 140, 255), (43, 54, 130)
    grad = Image.new("RGBA", (size, size))
    gd = ImageDraw.Draw(grad)
    for y in range(size):
        t = y / max(1, size - 1)
        c = tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3)) + (255,)
        gd.line([(0, y), (size, y)], fill=c)
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size - 1, size - 1], radius=r, fill=255)
    img.paste(grad, (0, 0), mask)
    return img


def draw_q(img: Image.Image) -> Image.Image:
    size = img.size[0]
    d = ImageDraw.Draw(img)
    cx = cy = size / 2
    ring_r = size * 0.27
    width = max(2, int(size * 0.085))
    # ring: arc from ~50° to ~410° (open gap at lower-right where the tail sits)
    d.arc(
        [cx - ring_r, cy - ring_r, cx + ring_r, cy + ring_r],
        start=50, end=410, fill=(255, 255, 255, 245), width=width,
    )
    # tail
    tail = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    td = ImageDraw.Draw(tail)
    td.line(
        [(cx + ring_r * 0.45, cy + ring_r * 0.45), (cx + ring_r * 1.25, cy + ring_r * 1.25)],
        fill=(140, 220, 255, 255), width=width,
    )
    tail = tail.rotate(-25, center=(cx, cy), resample=Image.BICUBIC)
    img.alpha_composite(tail)
    # small accent dot in the ring gap
    d.ellipse(
        [cx + ring_r * 0.95 - width * 0.6, cy + ring_r * 0.95 - width * 0.6,
         cx + ring_r * 0.95 + width * 0.6, cy + ring_r * 0.95 + width * 0.6],
        fill=(140, 220, 255, 255),
    )
    return img


def main() -> int:
    for s in SIZES:
        img = draw_q(rounded_tile(s))
        name = f"icon_{s}x{s}.png" if s <= 512 else "icon_512x512@2x.png"
        if s == 1024:
            name = "icon_512x512@2x.png"
        elif s == 256:
            img.save(OUT / "icon_128x128@2x.png")
        elif s == 64:
            img.save(OUT / "icon_32x32@2x.png")
        elif s == 16:
            pass  # 16 saved below with name
        img.save(OUT / name)
    # explicit small sizes with exact names
    for s, name in [(16, "icon_16x16.png"), (32, "icon_32x32.png"), (128, "icon_128x128.png"), (256, "icon_256x256.png"), (512, "icon_512x512.png")]:
        draw_q(rounded_tile(s)).save(OUT / name)
    icns = OUT.parent / "icon.icns"
    subprocess.run(["iconutil", "-c", "icns", str(OUT), "-o", str(icns)], check=True)
    print(f"icon written: {icns}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
