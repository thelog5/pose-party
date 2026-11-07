#!/usr/bin/env python3
"""Scale the gameplay rig's hands about their wrist pivots.

The hands measured 0.116 of body height across, against 0.150 on Figma's
`Robot RIg` (353:752) — the reference the Home and lobby robots are built
from. They read as stubs rather than hands. A hand is a LEAF joint, so
scaling it about its own wrist pivot changes nothing else in the skeleton:
the pivot maps to itself, so the cuff still covers the join.

Idempotent. The first run copies the originals to
`rig-body-src/deployed-hands-orig/`, and every run scales from those, so the
factor can be changed, or reverted, by re-running with FACTOR=1.0.
"""
import os, sys
from PIL import Image

RIG = os.path.join(os.path.dirname(__file__), "..",
                   "client", "assets", "ui", "rig")
# Originals live OUTSIDE the served directory, next to the pack's other
# pristine sources — an unreferenced `*.orig.png` in assets/ui/rig is dead
# weight on a static host.
ORIG = os.path.join(os.path.dirname(__file__), "..", "rig-body-src", "deployed-hands-orig")
os.makedirs(ORIG, exist_ok=True)
C = 640
FACTOR = float(os.environ.get("FACTOR", "1.29"))
# wrist pivots, straight out of rig.json
PIVOT = {
    "hand_character_left.png":           (423.125, 511.0),
    "hand_character_right.png":          (216.875, 511.0),
    "thumbsup_hand_character_left.png":  (423.125, 511.0),
    "thumbsup_hand_character_right.png": (216.875, 511.0),
}

for name, (px, py) in PIVOT.items():
    path = os.path.join(RIG, name)
    orig = os.path.join(ORIG, name)
    if not os.path.exists(orig):
        Image.open(path).save(orig)
    im = Image.open(orig).convert("RGBA")
    if im.size != (C, C):
        sys.exit("%s is %dx%d, expected %dx%d — the pack must stay on one "
                 "shared canvas or the puppet comes apart." % (name, *im.size, C, C))
    s = FACTOR
    # about the pivot: p -> (p - pivot)*s + pivot ; PIL AFFINE wants the inverse
    m = (1 / s, 0, px - px / s, 0, 1 / s, py - py / s)
    im.transform((C, C), Image.AFFINE, m, resample=Image.BICUBIC).save(path)
    print("%-38s x%.3f about (%.3f, %.1f)" % (name, s, px, py))
