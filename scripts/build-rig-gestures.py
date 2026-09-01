#!/usr/bin/env python3
"""Build alternate articulated hand layers from the canonical body_xxx art.

The base rig only ships one splayed hand. Rotating that hand can make a wave,
but it can never reproduce body_happy_thumbsup. This script cuts the authored
thumb silhouette out of rb-body-thumbsup.png, registers its wrist to the rig's
existing hand pivot, and mirrors it for the other side. Nothing is redrawn.

Usage:
    python3 scripts/build-rig-gestures.py
    python3 scripts/build-rig-gestures.py --dry-run
"""

from __future__ import annotations

import sys
from collections import deque
from pathlib import Path

import numpy as np
from PIL import Image

REPO = Path(__file__).resolve().parent.parent
SOURCE = REPO / "pose-charades-external-data/assets/ui/figma/rb-body-thumbsup.png"
OUT = REPO / "pose-charades-external-data/assets/ui/rig"
CANVAS = 640

# Measured on the shared 520x610 body export. The crop contains the raised
# hand, its blue cuff and a little forearm; colour connectivity isolates the
# cream hand because the cuff separates it from the cream forearm.
CROP = (45, 255, 132, 392)
WRIST_SOURCE = (113, 368)
TARGET_WIDTH = 64
PIVOTS = {
    "right": (216.875, 511),
    "left": (423.125, 511),
}


def components(mask):
    """Return 4-connected component coordinate lists."""
    h, w = mask.shape
    seen = np.zeros_like(mask, dtype=bool)
    found = []
    for sy, sx in zip(*np.where(mask)):
        if seen[sy, sx]:
            continue
        q = deque([(int(sy), int(sx))])
        seen[sy, sx] = True
        points = []
        while q:
            y, x = q.pop()
            points.append((y, x))
            for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                yy, xx = y + dy, x + dx
                if 0 <= yy < h and 0 <= xx < w and mask[yy, xx] \
                        and not seen[yy, xx]:
                    seen[yy, xx] = True
                    q.append((yy, xx))
        found.append(points)
    return found


def dilate(mask, radius):
    """Small dependency-free square dilation for retaining outline pixels."""
    h, w = mask.shape
    out = mask
    for _ in range(radius):
        padded = np.pad(out, 1)
        out = np.logical_or.reduce([
            padded[dy:dy + h, dx:dx + w]
            for dy in range(3) for dx in range(3)
        ])
    return out


def resize_premultiplied(img, size):
    rgba = np.asarray(img.convert("RGBA")).astype(np.float64)
    alpha = rgba[..., 3:4] / 255.0
    premultiplied = np.concatenate([rgba[..., :3] * alpha, rgba[..., 3:4]], axis=2)
    resized = Image.fromarray(
        np.clip(premultiplied + 0.5, 0, 255).astype(np.uint8)
    ).resize(size, Image.Resampling.LANCZOS)
    out = np.asarray(resized).astype(np.float64)
    out_alpha = out[..., 3:4] / 255.0
    rgb = np.divide(out[..., :3], np.where(out_alpha > 0, out_alpha, 1.0))
    return Image.fromarray(np.concatenate([
        np.clip(rgb + 0.5, 0, 255).astype(np.uint8),
        np.clip(out[..., 3:4] + 0.5, 0, 255).astype(np.uint8),
    ], axis=2))


def extract_hand():
    source = np.asarray(Image.open(SOURCE).convert("RGBA"))
    x0, y0, x1, y1 = CROP
    crop = source[y0:y1, x0:x1].copy()
    rgb = crop[..., :3].astype(np.int32)

    # Cream paper is low-saturation and bright. The largest connected cream
    # component in this crop is the fist; the next is the forearm.
    cream = (crop[..., 3] > 8) \
        & (rgb[..., 0] > 90) & (rgb[..., 1] > 80) & (rgb[..., 2] > 60) \
        & ((rgb.max(axis=2) - rgb.min(axis=2)) < 100)
    blobs = components(cream)
    if not blobs:
        raise RuntimeError("no cream component found in thumb source crop")
    fist = max(blobs, key=len)
    mask = np.zeros_like(cream)
    for y, x in fist:
        mask[y, x] = True

    # Grow back over the dark crease/outline pixels, but never into the blue
    # cuff. This preserves the Figma hand exactly, including its paper grain.
    mask = dilate(mask, 3)
    blue = (rgb[..., 2] > rgb[..., 0] * 1.25) \
        & (rgb[..., 2] > rgb[..., 1] * 1.15) & (rgb[..., 2] > 70)
    keep = mask & (crop[..., 3] > 0) & ~blue
    crop[..., 3] = np.where(keep, crop[..., 3], 0)

    ys, xs = np.where(crop[..., 3] > 0)
    box = (int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1)
    expected = (54, 275, 121, 384)
    actual = (box[0] + x0, box[1] + y0, box[2] + x0, box[3] + y0)
    if actual != expected:
        raise RuntimeError(f"thumb source moved: measured {actual}, expected {expected}")

    hand = Image.fromarray(crop).crop(box)
    scale = TARGET_WIDTH / hand.width
    size = (TARGET_WIDTH, int(round(hand.height * scale)))
    hand = resize_premultiplied(hand, size)
    anchor = (
        (WRIST_SOURCE[0] - x0 - box[0]) * size[0] / (box[2] - box[0]),
        (WRIST_SOURCE[1] - y0 - box[1]) * size[1] / (box[3] - box[1]),
    )
    return hand, anchor


def main():
    dry = "--dry-run" in sys.argv
    hand, anchor = extract_hand()
    for side in ("right", "left"):
        art = hand if side == "right" else hand.transpose(Image.Transpose.FLIP_LEFT_RIGHT)
        ax = anchor[0] if side == "right" else art.width - anchor[0]
        ay = anchor[1]
        px, py = PIVOTS[side]
        at = (int(round(px - ax)), int(round(py - ay)))
        canvas = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
        canvas.alpha_composite(art, at)
        name = f"thumbsup_hand_character_{side}.png"
        if not dry:
            canvas.save(OUT / name)
        print(f"{name}: {art.width}x{art.height}, wrist -> ({px:.1f},{py:.1f})"
              + (" (dry run)" if dry else ""))


if __name__ == "__main__":
    main()
