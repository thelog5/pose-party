#!/usr/bin/env python3
"""Register the authored hand-gesture pack onto the rig's wrist pivot.

`rig-hand-src/` holds eight paper hands drawn at the mascot's own scale:
fist and index-point, each as a PALM view and a BACKHAND view, for the left
and right hand. They are standalone art on a 1254 square — nothing in them is
in register with the body — so this script is what makes them rig layers.

Why the rig needs them at all: the pack ships ONE hand per side, a splayed
open mitten, and it cannot make two of the poses the character depends on.
A splayed hand at the chin is not the thinking gesture, and five cream fingers
spread across a cream torso have almost no silhouette, so both hands used to
dissolve into the body. A fist is one compact shape and survives being cream
on cream; a raised index finger reads as "I have got it" from across a room.

Three things this has to get right:

WRIST.  These hands taper to a rounded heel with no wrist tab, so registering
the pivot at the very bottom would leave the join to a butt weld that opens
the moment the wrist turns. The pivot goes a little way UP into the heel
(WRIST_FRAC), where the hand is still wide, and the part below it tucks behind
the forearm — hands draw behind forearms in the pack's own order precisely so
the blue cuff hides the join.

SCALE.  One factor for the whole set, derived from the fist, so a fist and a
point are the same person's hand. Taking each sprite to the same width would
make the point-up hand fat, because its fingers are curled and its palm is
genuinely narrower.

BAKED ROTATION.  A hand's angle on screen is the SUM of shoulder, elbow and
wrist, so a gesture drawn upright is only upright when that sum is near zero
— and for the folded poses it is nowhere near. Rather than bend the pose to
suit the art, each gesture carries the rotation its pose needs. A hand is a
LEAF joint: nothing is parented to it, so a baked rotation cannot propagate.

Usage:
    python3 scripts/build-rig-hand-gestures.py
    python3 scripts/build-rig-hand-gestures.py --dry-run
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
from PIL import Image

REPO = Path(__file__).resolve().parent.parent
SRC = REPO / "rig-hand-src"
OUT = REPO / "client/assets/ui/rig"
CANVAS = 640

# rig.json's hand pivots, character-relative.
PIVOTS = {"left": (422.9, 484.72), "right": (217.1, 484.72)}

# Match the pack's own hand: its ink is 63px across on the 640 canvas.
FIST_WIDTH = 63.0
# How far up the heel the wrist sits, as a fraction of ink height. At 0.92 the
# hand is still ~500 source-px wide there, so the cuff has real paper to cover.
WRIST_FRAC = 0.92

# gesture -> (source stem, view, baked rotation in degrees)
#   thinking : the arm folds up the front of the body and the chain arrives at
#              about +169, so the fist is drawn -169 from upright.
#   point    : the calling-it-out arm reaches out and up; its chain lands near
#              +70, so the finger is drawn back by that much to stand vertical.
GESTURES = {
    "fist":  ("fist",     "palm",     -169.0),
    "point": ("point_up", "palm",      -70.0),
}


def ink_box(im: Image.Image):
    a = np.array(im)[:, :, 3] > 8
    ys, xs = np.nonzero(a)
    return xs.min(), ys.min(), xs.max() + 1, ys.max() + 1


def wrist_of(im: Image.Image, box):
    """Centre of the heel, WRIST_FRAC of the way down the ink."""
    a = np.array(im)[:, :, 3] > 8
    y = int(box[1] + (box[3] - 1 - box[1]) * WRIST_FRAC)
    row = np.nonzero(a[y])[0]
    return (row.min() + row.max()) / 2.0, float(y)


def build(dry: bool) -> None:
    # one scale for the whole set, taken from the fist
    ref = Image.open(SRC / "robot_right_hand_fist_backhand.png").convert("RGBA")
    rb = ink_box(ref)
    scale = FIST_WIDTH / (rb[2] - rb[0])

    for name, (stem, view, bake) in GESTURES.items():
        for side, (px, py) in PIVOTS.items():
            src = SRC / f"robot_{side}_hand_{stem}_{view}.png"
            im = Image.open(src).convert("RGBA")
            box = ink_box(im)
            wx, wy = wrist_of(im, box)
            art = im.crop(box)
            w = max(1, round(art.width * scale))
            h = max(1, round(art.height * scale))
            art = art.resize((w, h), Image.LANCZOS)
            ax, ay = (wx - box[0]) * scale, (wy - box[1]) * scale

            sheet = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
            sheet.alpha_composite(art, (round(px - ax), round(py - ay)))
            # about the WRIST, so the pivot maps to itself and the shared
            # registration every other layer depends on is untouched
            turn = bake if side == "right" else -bake
            sheet = sheet.rotate(-turn, resample=Image.BICUBIC, center=(px, py))

            out = f"{name}_hand_character_{side}.png"
            b = ink_box(sheet)
            print(f"{out:36s} {w}x{h}  ink x {b[0]}..{b[2]-1} y {b[1]}..{b[3]-1}"
                  f"  wrist -> ({px},{py})  bake {turn:+.0f}"
                  + ("  (dry run)" if dry else ""))
            if not dry:
                sheet.save(OUT / out)


if __name__ == "__main__":
    build("--dry-run" in sys.argv)
