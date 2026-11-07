#!/usr/bin/env python3
"""Slim the gameplay rig's arms to Figma's baked `body_xxx` poses.

`rig.json` names those sprites (286:610-286:617) as this pack's own source, so
they are the reference, not the Home/lobby `Robot RIg`. Measured against
`body_idle` at matched body height:

    limb width / body height   ours 0.110   reference 0.088   -> x0.81
    arm reach below shoulder   ours 0.377   reference 0.320   -> x0.85

So the arm is both thicker AND longer than the art it was cut from. A single
scale about the SHOULDER fixes both at once, and it is the only transform that
keeps the chain intact: the shoulder maps to itself, and the elbow and wrist
pivots move by the same factor, so every segment still meets the next one.
Scaling each part about its OWN pivot instead would shrink the art while
leaving the pivots where they were, and the arm would come apart at the elbow.

The hand gets a little back (`HAND_EXTRA`) because at the chain factor alone it
lands at 0.095 of body height against the reference's 0.107.

Idempotent: originals live in rig-body-src/deployed-arms-orig/ and every run
scales from those. ARM=1.0 HAND_EXTRA=1.0 reverts.
"""
import os, sys
from PIL import Image

HERE = os.path.dirname(__file__)
RIG  = os.path.join(HERE, "..", "client", "assets", "ui", "rig")
ORIG = os.path.join(HERE, "..", "rig-body-src", "deployed-arms-orig")
HANDS_ORIG = os.path.join(HERE, "..", "rig-body-src", "deployed-hands-orig")
os.makedirs(ORIG, exist_ok=True)

C = 640
ARM        = float(os.environ.get("ARM", "0.82"))
HAND_EXTRA = float(os.environ.get("HAND_EXTRA", "1.12"))

SHOULDER = {"left": (421.875, 365.0), "right": (218.125, 365.0)}
ELBOW    = {"left": (423.75, 435.0),  "right": (216.25, 435.0)}
WRIST    = {"left": (423.125, 511.0), "right": (216.875, 511.0)}

PARTS = [
    ("upper_arm_character_%s.png", None),
    ("forearm_character_%s.png",   None),
    ("hand_character_%s.png",      "wrist"),
    ("thumbsup_hand_character_%s.png", "wrist"),
]

def affine(im, a, e, d, f):
    """forward p -> (a*x + e, d*y + f); PIL wants the inverse."""
    return im.transform((C, C), Image.AFFINE,
                        (1/a, 0, -e/a, 0, 1/d, -f/d), resample=Image.BICUBIC)

for side in ("left", "right"):
    sx, sy = SHOULDER[side]
    nw = (sx + (WRIST[side][0]-sx)*ARM, sy + (WRIST[side][1]-sy)*ARM)
    for pattern, extra in PARTS:
        name = pattern % side
        path = os.path.join(RIG, name)
        if not os.path.exists(path):
            continue
        # the hands were scaled by an earlier pass; always start from ITS backup
        src = os.path.join(HANDS_ORIG, name)
        if not os.path.exists(src):
            src = os.path.join(ORIG, name)
            if not os.path.exists(src):
                Image.open(path).save(src)
        im = Image.open(src).convert("RGBA")
        if im.size != (C, C):
            sys.exit("%s is not %dx%d — the pack must stay on one canvas." % (name, C, C))
        s = ARM
        im = affine(im, s, sx - sx*s, s, sy - sy*s)          # about the shoulder
        if extra == "wrist" and HAND_EXTRA != 1.0:
            h = HAND_EXTRA
            im = affine(im, h, nw[0] - nw[0]*h, h, nw[1] - nw[1]*h)  # about the NEW wrist
        im.save(path)
        print("%-38s x%.2f about shoulder%s" % (name, s, "  +x%.2f about wrist" % HAND_EXTRA if extra else ""))

print()
print("NEW PIVOTS — put these in js/robot.js JOINTS and assets/ui/rig/rig.json:")
for side, jl in (("left","L"), ("right","R")):
    sx, sy = SHOULDER[side]
    for label, tbl in (("farm", ELBOW), ("hand", WRIST)):
        px = sx + (tbl[side][0]-sx)*ARM
        py = sy + (tbl[side][1]-sy)*ARM
        print("  %s%s: px %.4f  py %.4f" % (label, jl, px, py))
