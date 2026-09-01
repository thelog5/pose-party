#!/usr/bin/env python3
"""Refit the articulated arm chain to the canonical Figma body proportions.

The delivered rig registered its forearm pivot in transparent pixels and its
shoulder-to-wrist reach was about 20% shorter than the `body_xxx` references.
That combination made the hands look toy-small and let the elbow open into a
visible hole during folded poses.

This build keeps the original paper art, enlarges it around measured joint
centres, and moves the elbow/wrist pivots onto opaque overlap. It is
idempotent: pristine inputs live in `rig-body-src/`, never in the output path.

Usage:
    python3 scripts/refit-rig-limbs.py --seed  # once, before the first build
    python3 scripts/refit-rig-limbs.py
    python3 scripts/refit-rig-limbs.py --dry-run
"""

from __future__ import annotations

import shutil
import sys
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image

REPO = Path(__file__).resolve().parent.parent
SRC = REPO / "rig-body-src"
OUT = REPO / "pose-charades-external-data/assets/ui/rig"
CANVAS = 640


@dataclass(frozen=True)
class Refit:
    file: str
    old_anchor: tuple[float, float]
    new_anchor: tuple[float, float]
    scale: tuple[float, float]


# Character-relative sides. The new elbow is the centre of the upper-arm /
# forearm overlap after the upper arm grows 20%; the new wrist is the centre of
# the scaled blue cuff. Every pivot therefore lands on opaque art.
REFITS = (
    Refit("upper_arm_character_right.png", (218.125, 365), (218.125, 365), (1.18, 1.20)),
    Refit("upper_arm_character_left.png",  (421.875, 365), (421.875, 365), (1.18, 1.20)),
    Refit("forearm_character_right.png",   (216.25, 423),  (216.25, 435),  (1.24, 1.25)),
    Refit("forearm_character_left.png",    (423.75, 423),  (423.75, 435),  (1.24, 1.25)),
    Refit("hand_character_right.png",      (216.875, 485), (216.875, 511), (1.25, 1.20)),
    Refit("hand_character_left.png",       (423.125, 485), (423.125, 511), (1.25, 1.20)),
)


def seed_sources() -> None:
    SRC.mkdir(exist_ok=True)
    for spec in REFITS:
        source = OUT / spec.file
        target = SRC / spec.file
        if target.exists():
            print(f"keep {target.relative_to(REPO)}")
            continue
        shutil.copy2(source, target)
        print(f"seed {target.relative_to(REPO)}")


def premultiplied_affine(img: Image.Image, spec: Refit) -> Image.Image:
    rgba = np.asarray(img.convert("RGBA")).astype(np.float64)
    alpha = rgba[..., 3:4] / 255.0
    premul = np.concatenate([rgba[..., :3] * alpha, rgba[..., 3:4]], axis=2)
    source = Image.fromarray(np.clip(premul + .5, 0, 255).astype(np.uint8))

    old_x, old_y = spec.old_anchor
    new_x, new_y = spec.new_anchor
    sx, sy = spec.scale
    # PIL wants destination -> source. Forward is:
    # destination = new_anchor + scale * (source - old_anchor).
    inverse = (1 / sx, 0, old_x - new_x / sx,
               0, 1 / sy, old_y - new_y / sy)
    warped = source.transform(
        (CANVAS, CANVAS), Image.Transform.AFFINE, inverse,
        Image.Resampling.BICUBIC,
    )
    out = np.asarray(warped).astype(np.float64)
    out_alpha = out[..., 3:4] / 255.0
    rgb = np.divide(out[..., :3], np.where(out_alpha > 0, out_alpha, 1.0))
    return Image.fromarray(np.concatenate([
        np.clip(rgb + .5, 0, 255).astype(np.uint8),
        np.clip(out[..., 3:4] + .5, 0, 255).astype(np.uint8),
    ], axis=2))


def ink_box(img: Image.Image) -> tuple[int, int, int, int]:
    box = img.getchannel("A").point(lambda a: 255 if a > 8 else 0).getbbox()
    if not box:
        raise RuntimeError("refit produced an empty layer")
    return box


def main() -> None:
    if "--seed" in sys.argv:
        seed_sources()
        return
    dry = "--dry-run" in sys.argv
    missing = [spec.file for spec in REFITS if not (SRC / spec.file).is_file()]
    if missing:
        raise SystemExit("missing pristine limb sources; run with --seed first: "
                         + ", ".join(missing))

    for spec in REFITS:
        source = Image.open(SRC / spec.file).convert("RGBA")
        if source.size != (CANVAS, CANVAS):
            raise SystemExit(f"{spec.file}: expected 640x640, got {source.size}")
        result = premultiplied_affine(source, spec)
        if not dry:
            result.save(OUT / spec.file)
        print(f"{spec.file:36s} {ink_box(source)} -> {ink_box(result)}"
              + (" (dry run)" if dry else ""))


if __name__ == "__main__":
    main()
