#!/usr/bin/env python3
"""Build a transparent CollPro document logo from the dark website mark.

Does not redesign the artwork. Flood-fills only the outer near-black field
from the edges so interior blacks (house, nameplate) stay. Edge pixels are
decontaminated to avoid a dark halo. Bottom slogan lettering is remapped
to dark ink so it stays readable on white paper.
"""
from __future__ import annotations

import collections
from pathlib import Path

from PIL import Image

SRC = Path("/workspace/public/brand/collpro-logo.png")
DST = Path("/workspace/public/brand/collpro-logo-document.png")

BG_MAX_DIST = 14.0
EDGE_SOFT_LO = 8.0
EDGE_SOFT_HI = 48.0
EDGE_BAND_PX = 3
SLOGAN_NAVY = (16, 24, 38)
PAD = 18


def dist(a, b):
    return ((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2) ** 0.5


def median_color(colors):
    if not colors:
        return (6, 6, 6)
    rs, gs, bs = zip(*colors)
    mid = len(colors) // 2

    def med(values):
        ordered = sorted(values)
        return ordered[mid]

    return (med(rs), med(gs), med(bs))


def distance_to_background(bg_mask, width, height, limit=EDGE_BAND_PX):
    dist_map = [[limit + 1] * width for _ in range(height)]
    queue = collections.deque()
    for y in range(height):
        for x in range(width):
            if bg_mask[y][x]:
                dist_map[y][x] = 0
                queue.append((x, y))
    while queue:
        x, y = queue.popleft()
        current = dist_map[y][x]
        if current >= limit:
            continue
        for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
            if 0 <= nx < width and 0 <= ny < height and dist_map[ny][nx] > current + 1:
                dist_map[ny][nx] = current + 1
                queue.append((nx, ny))
    return dist_map


def flood_background(pixels, width, height, bg):
    seen = [[False] * width for _ in range(height)]
    bg_mask = [[False] * width for _ in range(height)]
    queue = collections.deque()

    def consider(x, y):
        if x < 0 or y < 0 or x >= width or y >= height or seen[y][x]:
            return
        seen[y][x] = True
        if dist(pixels[x, y], bg) <= BG_MAX_DIST:
            bg_mask[y][x] = True
            queue.append((x, y))

    for x in range(width):
        consider(x, 0)
        consider(x, height - 1)
    for y in range(height):
        consider(0, y)
        consider(width - 1, y)

    while queue:
        x, y = queue.popleft()
        for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
            consider(nx, ny)
    return bg_mask


def decontaminate(color, bg, alpha):
    if alpha <= 0:
        return (0, 0, 0, 0)
    if alpha >= 255:
        return (*color, 255)
    a = alpha / 255.0
    rgb = []
    for channel, base in zip(color, bg):
        value = (channel - (1.0 - a) * base) / a
        rgb.append(max(0, min(255, int(round(value)))))
    return (*rgb, alpha)


def slogan_band(pixels, bg_mask, width, height):
    white_rows = []
    y0 = int(height * 0.72)
    for y in range(y0, height):
        white = 0
        for x in range(width):
            if bg_mask[y][x]:
                continue
            r, g, b = pixels[x, y]
            if r > 170 and g > 170 and b > 170:
                white += 1
        if white > width * 0.012:
            white_rows.append(y)
    if not white_rows:
        return None
    return max(0, white_rows[0] - 6), min(height - 1, white_rows[-1] + 6)


def main():
    src = Image.open(SRC).convert("RGB")
    width, height = src.size
    pixels = src.load()
    edge = []
    for x in range(width):
        edge.append(pixels[x, 0])
        edge.append(pixels[x, height - 1])
    for y in range(height):
        edge.append(pixels[0, y])
        edge.append(pixels[width - 1, y])
    bg = median_color(edge)
    bg_mask = flood_background(pixels, width, height, bg)

    out = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    dest = out.load()
    band = slogan_band(pixels, bg_mask, width, height)
    edge_dist = distance_to_background(bg_mask, width, height)

    for y in range(height):
        for x in range(width):
            color = pixels[x, y]
            if bg_mask[y][x]:
                dest[x, y] = (0, 0, 0, 0)
                continue
            d = dist(color, bg)
            near_edge = edge_dist[y][x] <= EDGE_BAND_PX
            if near_edge:
                if d <= EDGE_SOFT_LO:
                    dest[x, y] = (0, 0, 0, 0)
                    continue
                t = (d - EDGE_SOFT_LO) / (EDGE_SOFT_HI - EDGE_SOFT_LO)
                t = max(0.0, min(1.0, t))
                t = t * t * (3.0 - 2.0 * t)
                # Dark leftover fringe stays mostly transparent.
                lum = 0.2126 * color[0] + 0.7152 * color[1] + 0.0722 * color[2]
                if lum < 28:
                    t *= 0.12
                elif lum < 55:
                    t *= 0.45
                dest[x, y] = decontaminate(color, bg, int(round(t * 255)))
            else:
                dest[x, y] = (*color, 255)

            if band and band[0] <= y <= band[1]:
                r, g, b, a = dest[x, y]
                lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
                if a > 0 and lum > 130 and max(abs(r - g), abs(g - b), abs(r - b)) < 28:
                    strength = min(1.0, (lum - 90) / 150.0)
                    dest[x, y] = (*SLOGAN_NAVY, max(a, int(round(255 * strength))))

    bbox = out.getbbox()
    if bbox:
        left, top, right, bottom = bbox
        left = max(0, left - PAD)
        top = max(0, top - PAD)
        right = min(width, right + PAD)
        bottom = min(height, bottom + PAD)
        out = out.crop((left, top, right, bottom))

    out.save(DST, "PNG", optimize=True)
    print(f"wrote {DST} {out.size} mode={out.mode}")


if __name__ == "__main__":
    main()
