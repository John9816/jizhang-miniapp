"""Generate the miniapp's local, antialiased 24-unit line icons (requires Pillow)."""
from pathlib import Path
from math import cos, sin, pi
from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parents[1] / 'images' / 'ui'
OUT.mkdir(parents=True, exist_ok=True)
SCALE = 16

def render(name, color):
    canvas = Image.new('RGBA', (24 * SCALE, 24 * SCALE))
    draw = ImageDraw.Draw(canvas)
    width = 1.8
    def line(points, stroke=width):
        pts = [(round(x*SCALE), round(y*SCALE)) for x, y in points]
        draw.line(pts, fill=color, width=round(stroke*SCALE), joint='curve')
        r = stroke*SCALE/2
        for x, y in pts:
            draw.ellipse((x-r, y-r, x+r, y+r), fill=color)
    def oval(box):
        draw.ellipse(tuple(round(v*SCALE) for v in box), outline=color, width=round(width*SCALE))
    def rect(box):
        draw.rounded_rectangle(tuple(round(v*SCALE) for v in box), radius=SCALE,
                               outline=color, width=round(width*SCALE))
    if name == 'home':
        line([(3, 10.5), (12, 3.5), (21, 10.5)])
        line([(5.5, 9), (5.5, 20), (18.5, 20), (18.5, 9)])
        line([(10, 20), (10, 14), (14, 14), (14, 20)])
    elif name == 'stats':
        rect((4, 13, 7.5, 20))
        rect((10.25, 8, 13.75, 20))
        rect((16.5, 4, 20, 20))
    elif name == 'profile':
        oval((8, 3.5, 16, 11.5))
        line([(4.5, 20), (4.5, 18.5), (5.5, 16), (8.5, 14.5), (15.5, 14.5),
              (18.5, 16), (19.5, 18.5), (19.5, 20), (4.5, 20)])
    elif name == 'plus':
        line([(5, 12), (19, 12)], 2)
        line([(12, 5), (12, 19)], 2)
    elif name == 'settings':
        points = []
        for k in range(32):
            angle = -pi/2 + k * 2*pi/32
            radius = 9 if k % 4 in (1, 2) else 7.4
            points.append((12 + radius*cos(angle), 12 + radius*sin(angle)))
        line(points + [points[0]], 1.6)
        oval((8.6, 8.6, 15.4, 15.4))
    return canvas.resize((96, 96), Image.Resampling.LANCZOS)

for icon in ('home', 'stats', 'profile'):
    render(icon, '#9A896D').save(OUT / f'{icon}.png')
    render(icon, '#8C641E').save(OUT / f'{icon}-active.png')
for icon in ('plus', 'settings'):
    render(icon, '#3B2A18').save(OUT / f'{icon}.png')
