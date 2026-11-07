#!/usr/bin/env python3
"""
refit-rig-faces.py — build and place the mascot rig's FACE ink.

Three stages, one script:

  DERIVE  — build the face layers the pack does not ship, out of the ones it
            does (a vertical flip is a whole emotion) plus the authored Figma
            shape in `rig-face-src/ref/`. Output: `rig-face-src/derived/`.
  REFIT   — rescale every face layer's ink onto the shared 640x640 canvas at
            the size and centre Figma authors, and assert it landed.
  EXPRESS — register the eight exact `face_xxx` expressions on that same
            canvas. These are the resting faces used by the live robot; the
            refitted pack mouths remain available as speech visemes.

WHY THIS EXISTS
---------------
The rig pack's eye art is far too small for the blue head screen. Measured
against Figma's `face_*` sprites (the authored faces the robot is supposed to
wear), the eyes are 1.4x to 2.8x too small; the mouth is already about right.
On screen he reads as a robot with pin-prick eyes.

And three of the shapes are the wrong drawing entirely — see DERIVE below.

WHY THE ART AND NOT THE LAYOUT
------------------------------
Every rig layer lives on the SAME 640x640 canvas and is drawn at `inset:0`;
that shared registration is load-bearing (see CLAUDE.md, "THE ROBOT IS A
JOINTED PUPPET") and `js/robot.js` composes each part's joint chain as
percentages of that one box. Adding per-layer CSS geometry would put a second
owner on the same transform and break the "registration is a property of the
art" rule. So this script rescales each face PNG's ink IN PLACE, about its
target centre, on the same 640x640 canvas. Everything downstream — CSS, the
compose() chain, the gaze parallax, the blink — keeps working untouched.

SOURCES: `rig-face-src/` (repo root, NOT served)
------------------------------------------------
    rig-face-src/           the 14 pristine pack layers. NEVER written.
    rig-face-src/ref/       authored Figma face renders, used as shape sources.
    rig-face-src/derived/   written by DERIVE. Committed, but regenerable.

The script reads pristine copies of the shipped face layers and writes over
`client/assets/ui/rig/`, so it is idempotent: re-running
it always resamples from the original art, never from its own output (which
would compound resampling loss every run). DERIVE obeys the same rule — every
recipe reads only from `rig-face-src/` and `rig-face-src/ref/`, never from
`derived/`, so the two stages can be re-run in any order any number of times.

`rig-face-src/` is deliberately left TRACKED, not gitignored. The repo's
`.gitignore` carries only `.env` and `graphify-out/` — it does not ignore build
inputs anywhere, so there is no precedent to follow, and these PNGs ARE the
source of truth: without them a re-run has nothing pristine to resample from
and the refit is unrepeatable. It is 21 small files across the three dirs.

DERIVE — three shapes the pack gets wrong or does not have at all
-----------------------------------------------------------------
Checked against the authored Figma faces (`face_sad` 286:609, `face_neutral`
286:606, `face_happy` 286:608), box-normalised silhouette IoU:

1. `worried_*` IS AN ANGRY EYEBROW. The pack draws two straight diagonal
   slashes angled down toward the nose. IoU against `face_sad`'s eye is 0.511
   and against `face_confused`'s 0.544 — it is neither. `face_sad`'s eye is a
   DOWNTURNED CRESCENT, and measurement says it is literally the happy arch
   upside down: `face_happy` eye flipped vertically scores IoU 0.846/0.850
   against `face_sad`'s (0.515 unflipped). So the pack's own `happy_*`, flipped
   vertically, IS the sad eye: 0.891/0.884 against the reference — as faithful
   as `happy_*` is to the face it was drawn for (0.910/0.887).

2. THE PACK HAS NO FROWN. Six mouths, all neutral-or-up, so `sad` could not
   make a sad mouth by any assignment. `face_sad`'s mouth is `face_happy`'s
   flipped vertically (IoU 0.917), and the pack's `smile` flipped scores 0.873
   against it — again better than `smile` scores against the smile it copies
   (0.829). `frown.png` is that flip.

3. THE OPEN EYE IS A ROUNDED SQUARE. The pack draws a narrow stadium (19x29,
   flat left and right sides). Stretched 2.3x to the authored width those flat
   sides stay flat and he wears two LED indicators. `face_neutral`'s eye is a
   DOME: semicircular top, sides curving down to a nearly flat base. IoU cannot
   see this (stadium 0.935 vs circle 0.925 vs superellipse 0.930 — all the
   same number) which is why it has to be looked at. So `open_*`'s silhouette
   comes from the Figma render in `ref/` and its PAINT is the pack's own
   `open_*` measured away from its edge — see `interior_colour()`: authored
   outline, this pack's material.

A flip is not a re-draw, and neither is a re-mask. Every derived layer is the
pack's own ink and the pack's own palette; nothing here was invented.

MEASUREMENT CONVENTION
----------------------
Ink bbox is taken at `alpha > INK_ALPHA` (8) with a half-open box, which
reproduces the brief's measured table exactly on all 14 layers. Alpha 1..8 is
the soft antialias fringe; including it inflates every box by ~2px a side.
The resample crops at the SAME threshold, deliberately — see `resample()`.
Cropping at alpha > 0 drags in sparse alpha-1..5 noise specks sitting a few
pixels outside the shape, and on a 2.3x upscale Lanczos ringing lifts them
back over the threshold, so the corrective loop oscillates and never lands.

WHY EVERY VISEME GETS ITS OWN BOX (and why one shared affine failed)
--------------------------------------------------------------------
This used to run ONE affine — the one `smile` needs — over all six mouths, on
the reasoning that normalising them into a single box would flatten the
lip-sync. The reasoning was right and the result was still wrong, because the
three flat shapes started out nearly the same size: after the shared affine
`E_EE` was 56x28, `FV` 49x18 and `M_BP` 44x17. `.grobot` measures 226px in
Solo at 1440x810 and less in Party, so this canvas renders at 0.28-0.35 and
those three arrived on screen 15-20px wide and 6-10px tall —
indistinguishable. `speakTrack()` was producing "bar, bar, big-oval,
bar, round-oval, bar" and the rhythm the design banks on never reached the
player.

The fix is the opposite of normalising: each viseme gets a target box chosen to
EXAGGERATE what it is, taken from its Figma counterpart where one exists
(mouth widths there span 64..154px on a 526px face rect — a 2.4x range, far
wider than anything the shared affine could produce). `M_BP` is the closed
mouth and is now the smallest thing on his face; `E_EE` is the widest and
thinnest; `FV` keeps its curve at an in-between size; `A_AH` stays tall and
`O_OH` round. See MOUTH_TARGETS.

Figma centres EVERY mouth on the same point (all seven `face_*` mouths measure
to canvas y 257.9-258.1, x 317.2), so a wide-open `A_AH` is not offset downward
— the jaw drop is drawn into the shape, not into the placement.

The two eyes are NOT levelled: they sit at slightly different heights because
the authored head has a slight tilt (measured at 17% of eye height on both
`face_neutral` and `face_happy`), and the targets encode that.

THE BLINK CARRIES THE TILT AS A FRACTION, NOT AS PIXELS
-------------------------------------------------------
The open eyes' centres are 7.6px apart vertically, which is 17.7% of their
43px height — the authored tilt, and invisible. Handing the same 7.6px to the
blink lids put an 8px offset on a 15px-tall bar (53% of its own height): the
two closed lids barely overlapped in y and read as a broken face, not a tilted
one. `EYE_STATE_CENTRES` gives `blink` its own pair of centres carrying the
same 17.7% FRACTION of its own height, about the same midline.

USAGE
-----
    python3 scripts/refit-rig-faces.py            # refit + assert
    python3 scripts/refit-rig-faces.py --dry-run  # measure and report only

Requires PIL (Pillow) and numpy. scipy is not used.
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
from PIL import Image

REPO = Path(__file__).resolve().parent.parent
SRC_DIR = REPO / "rig-face-src"
REF_DIR = SRC_DIR / "ref"
DERIVED_DIR = SRC_DIR / "derived"
OUT_DIR = REPO / "client" / "assets" / "ui" / "rig"
FIGMA_FACE_DIR = REPO / "client" / "assets" / "ui" / "figma"

CANVAS = 640          # every rig layer shares this canvas
INK_ALPHA = 8         # see MEASUREMENT CONVENTION above
TOLERANCE = 1.0       # px, on every edge of the re-measured output box

# One face scale, everywhere. Image #3 and the authored Figma head screen put
# the face rectangle at 193.8px on this 640px rig canvas: 30.28%, rounded and
# documented as 30.3%. The checked-in `rb-face-*` files are a shared tight
# union crop, not that full rectangle. Mapping their neutral eye and mouth
# centres back to the measured Figma positions gives this one affine for all
# eight expressions. It preserves every expression's authored relative sizes
# instead of normalising each pair of eyes independently.
FACE_WIDTH_RATIO = 193.8 / CANVAS       # 30.28125%
FIGMA_UNION_SCALE = (0.51769461, 0.52200852)
FIGMA_UNION_ORIGIN = (241.19684, 183.89299)
EXPRESSIONS = (
    "neutral", "thinking", "speaking", "surprised",
    "joyful", "happy", "confused", "sad",
)

# ---------------------------------------------------------------------------
# TARGETS (from the measured brief — do not re-derive)
#
# The Figma face rect is 88.5% of the head-screen width, aspect 1.599, centred
# on the screen centre (319, 222). On the 640 canvas that is W=193.8 H=121.2,
# spanning x 222.1..415.9, y 161.4..282.6. The feature ink fractions come from
# `face_happy` (526x329) and `face_joyful` (242x152), which agree.
# ---------------------------------------------------------------------------

EYE_L_CENTRE = (267.4, 205.7)   # viewer-left eye
EYE_R_CENTRE = (370.7, 213.3)   # viewer-right eye — genuinely higher, see above

# Per eye STATE, the target ink box.
#
# THE OPEN EYE IS NARROWER THAN THE OTHER STATES — that is the design, not a
# slip, and it survived a QA claim that Figma's neutral eye is the WIDEST of
# the set. It is not: connected-component measurement over the reference
# renders puts `face_neutral` at 22.6 % / 24.0 % of the face rect against
# `face_happy`'s 27.6 %. The blanket 27.4 % in the brief comes from
# `face_happy`, whose eyes are thick upside-down-U arcs. So the open (and
# therefore blink) width is `face_neutral`'s; every other number here is the
# brief's, and the difference between the states is faithful.
#
# The SIZE was never the LED problem — the SHAPE was. See DERIVE.
#
# Measured widths as a fraction of the face rect (W=193.8 on this canvas):
#   neutral 22.6/24.0 · surprised 22.1/23.0 · speaking 26.8/26.2
#   happy 27.6/26.2   · sad 27.6/26.2 (short: 25.2 tall vs happy's 35.6)
EYE_TARGETS = {
    #  state       left w x h        right w x h
    # face_neutral — a DOME, not a blob and emphatically not the rounded square
    # the pack's stadium becomes when stretched. DERIVE reshapes it; this is
    # only the size. The rig draws a narrow oval (aspect 0.66), so this is
    # still a 2.3x horizontal stretch.
    "open":    ((44.2, 43.1), (46.5, 43.6)),
    # face_happy — thick arc, genuinely wider than the neutral dome.
    "happy":   ((53.1, 43.1), (51.0, 43.6)),
    # face_sad — same width as happy but SHORT (~25 % of the face rect).
    # DERIVE flips the happy arch to get the downturned crescent.
    "worried": ((53.1, 32.0), (51.0, 32.4)),
    # A blink is the open eye shut: it follows the open eye's width, thin.
    "blink":   ((44.2, 15.0), (46.5, 15.2)),
}

# Per-state eye centres. Only `blink` overrides — see the header note: the
# authored tilt is a FRACTION of eye height (7.6 / 43 = 17.7 %), so on a 15px
# lid it is 2.66px, not 7.6px. Same midline (209.5), same fraction, and the
# pair reads as tilted instead of broken.
_BLINK_DY = 0.5 * (EYE_R_CENTRE[1] - EYE_L_CENTRE[1]) \
    * (EYE_TARGETS["blink"][0][1] / EYE_TARGETS["open"][0][1])
_BLINK_MID = 0.5 * (EYE_L_CENTRE[1] + EYE_R_CENTRE[1])
EYE_STATE_CENTRES = {
    "blink": ((EYE_L_CENTRE[0], _BLINK_MID - _BLINK_DY),
              (EYE_R_CENTRE[0], _BLINK_MID + _BLINK_DY)),
}

# The mouth: every shape on the shared centre, each with its OWN box.
# Sizes with a Figma counterpart are that counterpart converted onto this
# canvas (face rect 193.8 x 121.2); the rest are chosen to keep all seven
# legible apart on screen. `.grobot` measures 226px in Solo at 1440x810 and
# less in Party, so this canvas renders at 0.28-0.35 and the on-screen ladder
# is roughly M_BP 11x3 · FV 15x6 · E_EE 21x7 · O_OH 12x11 · smile 19x11 ·
# frown 19x11 · A_AH 14x20 px. See the header note.
MOUTH_TGT_CENTRE = (316.9, 257.7)
MOUTH_TARGETS = {
    # name            w     h     why
    "smile":        (54.5, 31.5),  # face_happy mouth 154x85 -> 56.7x31.3
    "frown":        (53.0, 31.5),  # face_sad   mouth 144x85 -> 53.0x31.3
    "phoneme_A_AH": (41.0, 56.0),  # jaw fully down: the tallest thing he has
    "phoneme_O_OH": (33.9, 31.3),  # face_surprised mouth 92x85 -> 33.9x31.3
    "phoneme_E_EE": (60.0, 20.0),  # the WIDEST and thinnest; cf face_confused
    "phoneme_FV":   (44.0, 16.0),  # a curved lip line, mid-sized
    "phoneme_M_BP": (32.0,  9.0),  # lips CLOSED: the smallest thing he has
}

MOUTHS = list(MOUTH_TARGETS)


# ---------------------------------------------------------------------------
# measurement
# ---------------------------------------------------------------------------

def ink_box(img: Image.Image, alpha: int = INK_ALPHA):
    """Half-open (x0, y0, x1, y1) of pixels with alpha > `alpha`."""
    a = np.asarray(img.convert("RGBA"))[..., 3]
    ys, xs = np.nonzero(a > alpha)
    if len(xs) == 0:
        raise ValueError("layer has no ink")
    return int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1


def box_wh(b):
    return b[2] - b[0], b[3] - b[1]


def box_centre(b):
    return (b[0] + b[2]) / 2.0, (b[1] + b[3]) / 2.0


# ---------------------------------------------------------------------------
# resampling
# ---------------------------------------------------------------------------

def resample(img: Image.Image, scale, place_centre, anchor_centre):
    """Scale `img`'s ink by `scale` and composite it onto a fresh transparent
    CANVAS so that the point `anchor_centre` (canvas coords, pre-scale) lands
    on `place_centre`.

    The crop is taken at the INK threshold, not at alpha > 0. These layers do
    not carry a soft fringe — the edge is hard (0 -> 108 -> 255 across one
    pixel) — but they do carry sparse alpha-1..5 noise specks a few pixels
    outside the shape. Cropping at alpha > 0 pulls those specks in, which both
    inflates the box by ~2px a side and, on a 2.3x upscale, lets Lanczos
    ringing lift them over the threshold so the measured output box lands
    nowhere near the target. Cropping at INK_ALPHA drops them.

    The resample runs on PREMULTIPLIED alpha — resampling straight RGBA bleeds
    the fully-transparent pixels' colour into the edge and the paper picks up a
    grey halo.
    """
    sx, sy = scale
    full = ink_box(img)
    crop = img.crop(full)

    rgba = np.asarray(crop.convert("RGBA")).astype(np.float64)
    a = rgba[..., 3:4] / 255.0
    pre = np.concatenate([rgba[..., :3] * a, rgba[..., 3:4]], axis=2)
    pre_img = Image.fromarray(np.clip(pre + 0.5, 0, 255).astype(np.uint8))

    fw, fh = box_wh(full)
    nw = max(1, int(round(fw * sx)))
    nh = max(1, int(round(fh * sy)))
    scaled = pre_img.resize((nw, nh), Image.LANCZOS)

    out = np.asarray(scaled).astype(np.float64)
    oa = out[..., 3:4] / 255.0
    rgb = np.divide(out[..., :3], np.where(oa > 0, oa, 1.0))
    un = np.concatenate([np.clip(rgb, 0, 255), np.clip(out[..., 3:4], 0, 255)], axis=2)
    scaled = Image.fromarray((un + 0.5).astype(np.uint8))

    # where the anchor sits inside the scaled crop
    ax = (anchor_centre[0] - full[0]) * (nw / fw)
    ay = (anchor_centre[1] - full[1]) * (nh / fh)

    canvas = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    canvas.alpha_composite(scaled, (int(round(place_centre[0] - ax)),
                                    int(round(place_centre[1] - ay))))
    return canvas


def refit(img: Image.Image, target_centre, target_size, src_box=None):
    """Land `img`'s measured ink box exactly on target_centre/target_size.

    An upscale widens the antialias fringe, so the alpha>8 boundary of the
    result does not land where a single analytic scale predicts (open_* is a
    2.8x upscale). A few corrective passes measure the actual output and adjust
    the scale and offset until it converges inside TOLERANCE.
    """
    box = src_box if src_box is not None else ink_box(img)
    sw, sh = box_wh(box)
    anchor = box_centre(box)

    sx = target_size[0] / sw
    sy = target_size[1] / sh
    place = list(target_centre)

    out = None
    for _ in range(8):
        out = resample(img, (sx, sy), tuple(place), anchor)
        got = ink_box(out)
        gw, gh = box_wh(got)
        gc = box_centre(got)
        dw = target_size[0] - gw
        dh = target_size[1] - gh
        dx = target_centre[0] - gc[0]
        dy = target_centre[1] - gc[1]
        if abs(dw) <= TOLERANCE and abs(dh) <= TOLERANCE \
           and abs(dx) <= TOLERANCE and abs(dy) <= TOLERANCE:
            break
        sx *= target_size[0] / max(gw, 1e-6)
        sy *= target_size[1] / max(gh, 1e-6)
        place[0] += dx
        place[1] += dy
    return out


def resize_premultiplied(img: Image.Image, size):
    """Resize RGBA without pulling colour out of transparent pixels."""
    rgba = np.asarray(img.convert("RGBA")).astype(np.float64)
    alpha = rgba[..., 3:4] / 255.0
    premultiplied = np.concatenate(
        [rgba[..., :3] * alpha, rgba[..., 3:4]], axis=2)
    resized = Image.fromarray(
        np.clip(premultiplied + 0.5, 0, 255).astype(np.uint8)
    ).resize(size, Image.LANCZOS)
    out = np.asarray(resized).astype(np.float64)
    out_alpha = out[..., 3:4] / 255.0
    rgb = np.divide(out[..., :3], np.where(out_alpha > 0, out_alpha, 1.0))
    return Image.fromarray(np.concatenate([
        np.clip(rgb + 0.5, 0, 255).astype(np.uint8),
        np.clip(out[..., 3:4] + 0.5, 0, 255).astype(np.uint8),
    ], axis=2))


def register_figma_union(img: Image.Image):
    """Put one shared-union Figma face layer onto the rig canvas."""
    if img.size != (300, 172):
        raise ValueError(f"Figma face union is {img.size}, expected 300x172")
    width = int(round(img.width * FIGMA_UNION_SCALE[0]))
    height = int(round(img.height * FIGMA_UNION_SCALE[1]))
    layer = resize_premultiplied(img, (width, height))
    canvas = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    canvas.alpha_composite(layer, tuple(int(round(v)) for v in FIGMA_UNION_ORIGIN))
    return canvas


def build_expressions(dry):
    """Register the exact Figma `face_xxx` eyes and mouths.

    The Figma exports are already split losslessly by
    `scripts/split-robot-faces.py`. Eyes are split once more at the empty
    centre band so gaze and blink can keep using independent rig layers.
    """
    print("EXPRESS")
    rows = []
    for state in EXPRESSIONS:
        eyes_path = FIGMA_FACE_DIR / f"rb-eyes-{state}.png"
        mouth_path = FIGMA_FACE_DIR / f"rb-mouth-{state}.png"
        if not eyes_path.is_file() or not mouth_path.is_file():
            sys.exit(f"missing Figma expression source for {state}: "
                     f"run scripts/split-robot-faces.py")

        eyes = np.asarray(Image.open(eyes_path).convert("RGBA")).copy()
        mouth = Image.open(mouth_path).convert("RGBA")
        if eyes.shape[:2] != (172, 300) or mouth.size != (300, 172):
            sys.exit(f"{state}: Figma face layers must share the 300x172 union")

        for side in ("left", "right"):
            split = eyes.copy()
            if side == "left":
                split[:, 150:, 3] = 0
            else:
                split[:, :150, 3] = 0
            out = register_figma_union(Image.fromarray(split))
            name = f"face_{state}_{side}"
            if not dry:
                out.save(OUT_DIR / f"{name}.png")
            rows.append((name, ink_box(out)))

        mouth_out = register_figma_union(mouth)
        mouth_name = f"face_{state}_mouth"
        if not dry:
            mouth_out.save(OUT_DIR / f"{mouth_name}.png")
        rows.append((mouth_name, ink_box(mouth_out)))

    for name, box in rows:
        w, h = box_wh(box)
        cx, cy = box_centre(box)
        print(f"  {name:26s} {w:3d} x {h:3d}  ({cx:6.1f},{cy:6.1f})")
    print(f"  face width convention: {FACE_WIDTH_RATIO * 100:.1f}% of rig canvas")
    print()
    return rows


# ---------------------------------------------------------------------------
# DERIVE — build the layers the pack does not ship
# ---------------------------------------------------------------------------

def flip_v(name):
    """The pristine layer `name`, turned upside down about its own ink centre.

    Flipping the whole 640 canvas would work too — REFIT re-measures and
    re-places every layer anyway — but keeping the ink where it was makes the
    derived source legible next to the layer it came from.
    """
    img = Image.open(SRC_DIR / f"{name}.png").convert("RGBA")
    b = ink_box(img)
    out = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    out.alpha_composite(img.crop(b).transpose(Image.FLIP_TOP_BOTTOM), (b[0], b[1]))
    return out


def interior_colour(name):
    """The layer's own paint, measured away from its edge.

    Every layer in this pack is FLAT: erode the solid alpha by 2px and the
    remaining RGB has a standard deviation of 0.7-3.3 out of 255. What looks
    like a lighter rim in the outer 1px band is the unpremultiply artefact of
    the original export (delta 1-5, i.e. the same order as the grain), not a
    drawn highlight — so a flat fill IS this pack's material and reproducing
    the band would only carry the artefact forward.

    The colours are NOT shared between layers, though: `open_*` is
    (251,192,40) and `happy_*` is (244,190,72). Each derived layer takes its
    own donor's.
    """
    a = np.asarray(Image.open(SRC_DIR / f"{name}.png").convert("RGBA")).astype(np.float64)
    solid = a[..., 3] >= 250
    for _ in range(2):
        solid = (solid & np.roll(solid, 1, 0) & np.roll(solid, -1, 0)
                 & np.roll(solid, 1, 1) & np.roll(solid, -1, 1))
    return a[solid][:, :3].mean(axis=0)


def reshape(donor_name, ref_name, at):
    """`donor_name`'s PAINT wearing `ref_name`'s SILHOUETTE.

    The reference is an authored Figma face render, so the outline is the one
    the designer drew rather than one this script invented; the colour is the
    pack layer this replaces, so the result is the same material as the other
    thirteen.

    An earlier pass stretched the whole donor into the reference's box and just
    swapped the alpha. Do not: the donor's own 1px edge band lands INSIDE the
    new, larger silhouette and draws the old rounded-rectangle outline as a
    contour line across the middle of the dome — the exact shape this is
    supposed to be getting rid of, now visible as a seam.
    """
    ref = Image.open(REF_DIR / ref_name).convert("RGBA")
    rb = ink_box(ref)
    rw, rh = box_wh(rb)
    alpha = np.asarray(ref.crop(rb))[..., 3:4]

    rgb = np.empty((rh, rw, 3), np.float64)
    rgb[:] = interior_colour(donor_name)
    shaped = Image.fromarray(
        np.concatenate([np.clip(rgb + 0.5, 0, 255).astype(np.uint8), alpha], axis=2))

    canvas = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    canvas.alpha_composite(shaped, (int(round(at[0] - rw / 2)),
                                    int(round(at[1] - rh / 2))))
    return canvas


# name -> (recipe, note). Recipes read ONLY from SRC_DIR and REF_DIR.
DERIVED = {
    "worried_left":  (lambda: flip_v("happy_left"),
                      "face_sad eye = the happy arch upside down (IoU 0.891)"),
    "worried_right": (lambda: flip_v("happy_right"),
                      "face_sad eye = the happy arch upside down (IoU 0.884)"),
    "frown":         (lambda: flip_v("smile"),
                      "face_sad mouth = the smile upside down (IoU 0.873)"),
    "open_left":     (lambda: reshape("open_left", "neutral_eye_left.png",
                                      EYE_L_CENTRE),
                      "face_neutral's DOME, painted with the pack's own eye"),
    "open_right":    (lambda: reshape("open_right", "neutral_eye_right.png",
                                      EYE_R_CENTRE),
                      "face_neutral's DOME, painted with the pack's own eye"),
}


def derive(dry):
    """Build every derived source. Returns {name: Image}."""
    if not dry:
        DERIVED_DIR.mkdir(parents=True, exist_ok=True)
    built = {}
    for name, (recipe, note) in DERIVED.items():
        img = recipe()
        if img.size != (CANVAS, CANVAS):
            sys.exit(f"{name}: derived canvas is {img.size} — every rig layer "
                     f"must share the {CANVAS}x{CANVAS} canvas")
        built[name] = img
        if not dry:
            img.save(DERIVED_DIR / f"{name}.png")
        b = ink_box(img)
        w, h = box_wh(b)
        print(f"  derive {name:16s} {w:3d} x {h:3d}   {note}")
    return built


# ---------------------------------------------------------------------------
# plan
# ---------------------------------------------------------------------------

def build_plan():
    plan = []   # (name, target_centre, target_size)
    for state, (lt, rt) in EYE_TARGETS.items():
        cl, cr = EYE_STATE_CENTRES.get(state, (EYE_L_CENTRE, EYE_R_CENTRE))
        plan.append((f"{state}_left", cl, lt))
        plan.append((f"{state}_right", cr, rt))
    for name in MOUTHS:
        plan.append((name, MOUTH_TGT_CENTRE, MOUTH_TARGETS[name]))
    return plan


def main():
    dry = "--dry-run" in sys.argv
    if not SRC_DIR.is_dir():
        sys.exit(f"missing pristine sources: {SRC_DIR}\n"
                 f"copy the face layers out of {OUT_DIR} before the first run")

    if not REF_DIR.is_dir():
        sys.exit(f"missing authored shape sources: {REF_DIR}")

    print("DERIVE")
    built = derive(dry)
    print()

    expression_rows = build_expressions(dry)

    plan = build_plan()
    rows = []
    failures = []

    for name, tc, ts in plan:
        if name in built:
            img = built[name]
        else:
            img = Image.open(SRC_DIR / f"{name}.png").convert("RGBA")
        if img.size != (CANVAS, CANVAS):
            sys.exit(f"{name}: canvas is {img.size}, expected {CANVAS}x{CANVAS} "
                     f"— every rig layer must share one canvas")
        before = ink_box(img)
        out = refit(img, tc, ts)
        after = ink_box(out)

        if not dry:
            out.save(OUT_DIR / f"{name}.png")
            # re-measure what actually hit disk
            after = ink_box(Image.open(OUT_DIR / f"{name}.png").convert("RGBA"))

        bw, bh = box_wh(before)
        aw, ah = box_wh(after)
        bc, ac = box_centre(before), box_centre(after)
        rows.append((name, bw, bh, bc, aw, ah, ac, ts, tc))

        for label, got, want in (("w", aw, ts[0]), ("h", ah, ts[1]),
                                 ("cx", ac[0], tc[0]), ("cy", ac[1], tc[1])):
            if abs(got - want) > TOLERANCE:
                failures.append(f"{name}: {label} {got:.1f} != target {want:.1f} "
                                f"(tolerance {TOLERANCE}px)")

    hdr = (f"{'layer':16s} {'before w x h':>13s} {'before centre':>16s}   "
           f"{'after w x h':>13s} {'after centre':>16s}   {'target w x h':>13s} "
           f"{'target centre':>16s}  scale")
    print(hdr)
    print("-" * len(hdr))
    for name, bw, bh, bc, aw, ah, ac, ts, tc in rows:
        print(f"{name:16s} {bw:6d} x {bh:4d} "
              f"({bc[0]:7.1f},{bc[1]:6.1f})   "
              f"{aw:6d} x {ah:4d} ({ac[0]:7.1f},{ac[1]:6.1f})   "
              f"{ts[0]:6.1f} x {ts[1]:4.1f} ({tc[0]:7.1f},{tc[1]:6.1f})  "
              f"x{ts[0]/bw:.2f} / x{ts[1]/bh:.2f}")

    if failures:
        print("\nFAILED:")
        for f in failures:
            print("  " + f)
        sys.exit(1)
    print(f"\nOK — {len(rows)} refitted layers and {len(expression_rows)} exact "
          f"Figma expression layers"
          + ("  (dry run, nothing written)" if dry else f"  -> {OUT_DIR}"))


if __name__ == "__main__":
    main()
