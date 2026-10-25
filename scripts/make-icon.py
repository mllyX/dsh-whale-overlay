"""Generate assets/icon.png for dsh-whale-overlay: abstract whale-blue badge."""
from PIL import Image, ImageDraw
import os

SIZE = 128
img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

# rounded-rect badge with vertical gradient (whale blue)
top = (93, 140, 255)      # #5d8cff
bottom = (35, 74, 190)    # #234abe
radius = 28
for y in range(SIZE):
    t = y / (SIZE - 1)
    r = int(top[0] + (bottom[0] - top[0]) * t)
    g = int(top[1] + (bottom[1] - top[1]) * t)
    b = int(top[2] + (bottom[2] - top[2]) * t)
    d.line([(0, y), (SIZE, y)], fill=(r, g, b, 255))
# apply rounded mask
mask = Image.new("L", (SIZE, SIZE), 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, SIZE - 1, SIZE - 1], radius=radius, fill=255)
img.putalpha(mask)

d = ImageDraw.Draw(img)
# abstract whale: body ellipse + belly + tail + eye + spout
white = (255, 255, 255, 235)
# body
d.ellipse([26, 46, 96, 96], fill=white)
# tail
d.polygon([(90, 70), (112, 52), (108, 74), (112, 92), (90, 82)], fill=white)
# belly shade
d.chord([34, 62, 92, 100], 0, 180, fill=(219, 231, 255, 235))
# eye
d.ellipse([44, 58, 52, 66], fill=(30, 50, 120, 255))
# spout droplets
d.ellipse([52, 22, 60, 30], fill=white)
d.ellipse([64, 14, 70, 20], fill=(255, 255, 255, 190))
d.ellipse([40, 16, 45, 21], fill=(255, 255, 255, 160))

import os
target_dir = os.path.join(r"D:\DSHarness\dsh-whale-overlay", "assets")
os.makedirs(target_dir, exist_ok=True)
target = os.path.join(target_dir, "icon.png")
img.save(target)
print("written", target, os.path.getsize(target), "bytes")
