#!/usr/bin/env python3
"""Generate the extension icons (pure stdlib: zlib + struct)."""
import os
import struct
import zlib

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "icons")
SIZES = (16, 48, 128)
SS = 4  # supersampling factor


def lerp(a, b, t):
    return int(round(a + (b - a) * t))


def rounded_alpha(x, y, w, h, r):
    """Return coverage 0..1 for a rounded rect, with 1px-ish smooth edge."""
    cx = min(max(x, r), w - r)
    cy = min(max(y, r), h - r)
    d = ((x - cx) ** 2 + (y - cy) ** 2) ** 0.5
    return max(0.0, min(1.0, r - d + 0.5))


def inside_triangle(px, py, pts):
    (x1, y1), (x2, y2), (x3, y3) = pts
    d1 = (px - x2) * (y1 - y2) - (x1 - x2) * (py - y2)
    d2 = (px - x3) * (y2 - y3) - (x2 - x3) * (py - y3)
    d3 = (px - x1) * (y3 - y1) - (x3 - x1) * (py - y1)
    neg = (d1 < 0) or (d2 < 0) or (d3 < 0)
    pos = (d1 > 0) or (d2 > 0) or (d3 > 0)
    return not (neg and pos)


def render(size):
    n = size * SS
    w = h = n
    r = n * 0.235
    pts = [(n * 0.375, n * 0.26), (n * 0.375, n * 0.74), (n * 0.735, n * 0.5)]
    pixels = []
    for y in range(h):
        row = bytearray()
        for x in range(w):
            a = rounded_alpha(x + 0.5, y + 0.5, w, h, r)
            if a <= 0:
                row += b"\x00\x00\x00\x00"
                continue
            t = (x / w + y / h) / 2
            cr = lerp(79, 55, t)
            cg = lerp(140, 201, t)
            cb = lerp(255, 165, t)
            if inside_triangle(x + 0.5, y + 0.5, pts):
                cr, cg, cb = 12, 20, 34
            row += bytes((cr, cg, cb, int(round(255 * a))))
        pixels.append(row)
    # box downsample
    out = bytearray()
    for y in range(size):
        out.append(0)  # PNG filter type 0
        for x in range(size):
            rr = gg = bb = aa = 0
            for dy in range(SS):
                for dx in range(SS):
                    i = (x * SS + dx) * 4  # 行内偏移
                    src = pixels[y * SS + dy]
                    rr += src[i]
                    gg += src[i + 1]
                    bb += src[i + 2]
                    aa += src[i + 3]
            k = SS * SS
            out += bytes((rr // k, gg // k, bb // k, aa // k))
    return bytes(out)


def chunk(tag, data):
    return (struct.pack(">I", len(data)) + tag + data +
            struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))


def write_png(path, size, raw):
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n")
        f.write(chunk(b"IHDR", ihdr))
        f.write(chunk(b"IDAT", zlib.compress(raw, 9)))
        f.write(chunk(b"IEND", b""))


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    for s in SIZES:
        p = os.path.join(OUT, "icon%d.png" % s)
        write_png(p, s, render(s))
        print("wrote", p, os.path.getsize(p), "bytes")
