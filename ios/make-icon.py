#!/usr/bin/env python3
# Regenerates the iOS app icon in `DevboxApp/Assets.xcassets/AppIcon.appiconset/`.
#
# Same mark as the mac notifier icon (`listener/notifier/make-icon.py`): an amber
# background and a dark ">_" prompt — so the app and the mac notifications visibly belong
# together. Three variants per Apple HIG for iOS 18 (Xcode 16+ takes them from one
# appiconset via `appearances` in Contents.json):
#
#   AppIcon1024.png         light — amber + dark mark, NO alpha (App Store rejects
#                           transparency in the primary icon; verified with build 2)
#   AppIcon1024-dark.png    dark — dark background + amber mark
#   AppIcon1024-tinted.png  tinted — just a grayscale mark on a transparent background; the
#                           system adds color and background from the Home Screen tint
#
# Full-bleed 1024×1024; iOS rounds the corners itself (squircle mask), so none are
# drawn here. The mark is centered at ~50 % of the canvas — the mask clips the corners, and a
# smaller margin than on the mac (54 %) would look cropped.
#
# Run: python3 ios/make-icon.py   (needs Pillow)
from pathlib import Path

from PIL import Image, ImageDraw

S = 1024
SS = 2         # supersampling — edges are rendered at 2048 and scaled down with LANCZOS
AMBER = (236, 176, 79)        # #ecb04f — same as listener/devbox-icon.png
AMBER_DEEP = (222, 158, 58)   # bottom of a subtle gradient, so the icon is not flat
DARK = (33, 22, 3)            # #211603
DARK_BG = (24, 18, 8)         # dark variant — warm black, not a cold #000
OUT_DIR = Path(__file__).resolve().parent / "DevboxApp" / "Assets.xcassets" / "AppIcon.appiconset"


def mark(color: tuple[int, ...], scale: float = 0.50) -> Image.Image:
    """>_" mark (RGBA, transparent background) centered on the 1024 canvas and scaled to
    `scale` of the longer side. Drawn at SS times the size, then scaled — clean edges."""
    size = S * SS
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    w = 82 * SS

    def stroke(p1, p2):
        d.line([p1, p2], fill=color, width=w)
        r = w // 2
        for x, y in (p1, p2):
            d.ellipse([x - r, y - r, x + r, y + r], fill=color)  # round ends and joint

    # ">" chevron
    stroke((300 * SS, 300 * SS), (500 * SS, 470 * SS))
    stroke((500 * SS, 470 * SS), (300 * SS, 640 * SS))
    # "_" cursor (rounded)
    d.rounded_rectangle([548 * SS, 596 * SS, 730 * SS, 672 * SS], radius=38 * SS, fill=color)

    cropped = img.crop(img.getbbox())
    cw, ch = cropped.size
    sc = int(S * scale) / max(cw, ch)
    cropped = cropped.resize((max(1, int(cw * sc)), max(1, int(ch * sc))), Image.LANCZOS)

    out = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    cw, ch = cropped.size
    out.paste(cropped, ((S - cw) // 2, (S - ch) // 2), cropped)
    return out


def vertical_gradient(top: tuple[int, int, int], bottom: tuple[int, int, int]) -> Image.Image:
    img = Image.new("RGB", (S, S))
    px = img.load()
    for y in range(S):
        t = y / (S - 1)
        c = tuple(round(top[i] + (bottom[i] - top[i]) * t) for i in range(3))
        for x in range(S):
            px[x, y] = c
    return img


def light() -> Image.Image:
    bg = vertical_gradient(AMBER, AMBER_DEEP)
    m = mark(DARK + (255,))
    bg.paste(m, (0, 0), m)
    return bg  # RGB — no alpha


def dark() -> Image.Image:
    bg = Image.new("RGB", (S, S), DARK_BG)
    m = mark(AMBER + (255,))
    bg.paste(m, (0, 0), m)
    return bg


def tinted() -> Image.Image:
    # Grayscale mark with alpha: the system colors it with the tint and puts its own dark
    # background under it. Light gray, not white — Apple recommends mid tones so the tint "takes".
    return mark((225, 225, 225, 255)).convert("LA").convert("RGBA")


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for name, img in (("AppIcon1024.png", light()), ("AppIcon1024-dark.png", dark()), ("AppIcon1024-tinted.png", tinted())):
        img.save(OUT_DIR / name, optimize=True)
        print("wrote", OUT_DIR / name, img.mode, img.size)
    # Safety check: the primary icon must be 1024×1024 without alpha, otherwise the App Store
    # Connect upload fails only at the very end (build 1 got through only thanks to a manual conversion).
    primary = Image.open(OUT_DIR / "AppIcon1024.png")
    assert primary.size == (S, S), primary.size
    assert primary.mode == "RGB", primary.mode


if __name__ == "__main__":
    main()
