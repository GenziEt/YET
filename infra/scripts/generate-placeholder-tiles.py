#!/usr/bin/env python3
"""YET Phase 0: generate procedural placeholder PNG tiles around Addis Ababa.
Used until tileserver-gl renders the real Ethiopia style. Serves at /tiles/{z}/{x}/{y}.png."""
import zlib, struct, os, math

W = H = 256
ROOT = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(ROOT, '..', 'tiles', 'rendered')

def chunk(typ, data):
    c = typ + data
    return struct.pack('>I', len(data)) + c + struct.pack('>I', zlib.crc32(c) & 0xffffffff)

def color(z, x, y):
    h = (x * 73856093) ^ (y * 19349663) ^ (z * 83492791)
    return ((200 + (h >> 3) % 40) % 256, (220 + (h >> 7) % 25) % 256, (190 + (h >> 11) % 40) % 256)

def make_tile(z, x, y):
    col = color(z, x, y)
    rows = []
    for py in range(H):
        row = bytearray(b'\x00')
        for px in range(W):
            if px % 64 == 0 or py % 64 == 0:
                row += bytes((150, 160, 150))
            elif abs(px - py) < 3 or abs(px + py - H) < 3:
                row += bytes((250, 240, 200))
            else:
                row += bytes(col)
        rows.append(bytes(row))
    raw = b''.join(rows)
    return (b'\x89PNG\r\n\x1a\n'
            + chunk(b'IHDR', struct.pack('>IIBBBBB', W, H, 8, 2, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(raw, 6))
            + chunk(b'IEND', b''))

count = 0
for z in range(6, 11):
    n = 2 ** z
    x = int((38.74 + 180) / 360 * n)
    y = int((1 - math.asinh(math.tan(math.radians(9.035))) / math.pi) / 2 * n)
    for dx in range(-1, 2):
        for dy in range(-1, 2):
            tx, ty = x + dx, y + dy
            if not (0 <= tx < n and 0 <= ty < n):
                continue
            d = os.path.join(OUT, str(z), str(tx))
            os.makedirs(d, exist_ok=True)
            with open(os.path.join(d, f'{ty}.png'), 'wb') as f:
                f.write(make_tile(z, tx, ty))
            count += 1
print(f'generated {count} placeholder tiles under {os.path.relpath(OUT)}')
