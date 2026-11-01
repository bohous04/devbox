#!/usr/bin/env python3
# Regenerate listener/devbox-icon.png — an amber square with a centered ">_" prompt.
# Full-bleed (macOS rounds the corners itself); the mark is centered with a margin so
# it doesn't look cropped/zoomed in a notification. Run: python3 listener/notifier/make-icon.py
from pathlib import Path
from PIL import Image, ImageDraw

S = 1024
AMBER = (236, 176, 79, 255)   # #ecb04f
DARK  = (33, 22, 3, 255)      # #211603
OUT = Path(__file__).resolve().parent.parent / "devbox-icon.png"

mark = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(mark)
w = 82

def stroke(p1, p2):
    d.line([p1, p2], fill=DARK, width=w)
    r = w // 2
    for x, y in (p1, p2):
        d.ellipse([x - r, y - r, x + r, y + r], fill=DARK)  # round caps/joint

# ">" chevron
stroke((300, 300), (500, 470))
stroke((500, 470), (300, 640))
# "_" cursor bar (rounded)
d.rounded_rectangle([548, 596, 730, 672], radius=38, fill=DARK)

# center the whole mark and scale it to ~54% of the canvas (macOS-style margin)
cropped = mark.crop(mark.getbbox())
cw, ch = cropped.size
sc = int(S * 0.54) / max(cw, ch)
cropped = cropped.resize((max(1, int(cw * sc)), max(1, int(ch * sc))), Image.LANCZOS)

img = Image.new("RGBA", (S, S), AMBER)
cw, ch = cropped.size
img.paste(cropped, ((S - cw) // 2, (S - ch) // 2), cropped)
img.convert("RGB").save(OUT)
print("wrote", OUT)
