"""RE-RUN THIS WHENEVER rb-face-*.png IS RE-EXPORTED FROM FIGMA.
    python3 scripts/split-robot-faces.py

Split each rb-face-*.png into an EYES layer and a MOUTH layer on the SAME
canvas, so compositing the two back reproduces the original EXACTLY.

js/robot.js dresses rb-eyes-<mood>.png and rb-mouth-<mood>.png as a pair and
never touches rb-face-*.png at gameplay size — but the face sprites are still
the source of truth, and HOW TO PLAY's static illustration rigs still use them
whole. If you re-export the faces and forget this step, the live rig silently
keeps wearing the old expressions.

Why this way: the faces are already separate yellow blobs on transparency —
two eyes above, one mouth below, with clear air between them. Connected
components find the blobs; a horizontal cut through that empty band then
assigns *every* pixel, including the faint anti-aliased fringe, so the split
is lossless by construction. Both layers keep the original canvas, so
registration is automatic: no offsets to author, no drift, and at rest the
composited rig is pixel-identical to the single-image version it replaces.

This is "cut, don't generate". Nothing is redrawn.
"""
from PIL import Image
import numpy as np
import glob, os
from collections import deque

SRC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "pose-charades-external-data", "assets", "ui", "figma")


def components(mask):
    h, w = mask.shape
    lab = np.zeros((h, w), np.int32)
    n = 0
    for sy in range(h):
        for sx in range(w):
            if not mask[sy, sx] or lab[sy, sx]:
                continue
            n += 1
            q = deque([(sy, sx)])
            lab[sy, sx] = n
            while q:
                y, x = q.popleft()
                for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    ny, nx = y + dy, x + dx
                    if 0 <= ny < h and 0 <= nx < w and mask[ny, nx] and not lab[ny, nx]:
                        lab[ny, nx] = n
                        q.append((ny, nx))
    return lab, n


rows = []
for path in sorted(glob.glob(os.path.join(SRC, "rb-face-*.png"))):
    name = os.path.basename(path).replace("rb-face-", "").replace(".png", "")
    im = Image.open(path).convert("RGBA")
    a = np.array(im)
    alpha = a[..., 3]

    lab, n = components(alpha > 24)          # solid ink only, for finding blobs
    blobs = []
    for i in range(1, n + 1):
        ys, xs = np.nonzero(lab == i)
        blobs.append(dict(n=len(xs), cy=ys.mean(), y0=int(ys.min()), y1=int(ys.max())))
    biggest = max(b["n"] for b in blobs)
    blobs = [b for b in blobs if b["n"] > biggest * .02]
    blobs.sort(key=lambda b: b["cy"])
    mouth, eyes = blobs[-1], blobs[:-1]

    # The cut goes through the empty band between the lowest eye and the top of
    # the mouth. If they overlapped vertically this would slice a shape in half,
    # so it is checked rather than assumed.
    eye_bottom = max(b["y1"] for b in eyes)
    gap = mouth["y0"] - eye_bottom
    if gap < 2:
        rows.append((name, len(eyes), gap, "REFUSED — eyes and mouth overlap vertically"))
        continue
    cut = (eye_bottom + mouth["y0"]) // 2

    ys = np.arange(alpha.shape[0])[:, None]
    for layer, keep in (("eyes", ys <= cut), ("mouth", ys > cut)):
        out = a.copy()
        out[..., 3] = np.where(keep, alpha, 0)
        Image.fromarray(out).save(os.path.join(SRC, f"rb-{layer}-{name}.png"))

    e = np.array(Image.open(os.path.join(SRC, f"rb-eyes-{name}.png")))[..., 3]
    mo = np.array(Image.open(os.path.join(SRC, f"rb-mouth-{name}.png")))[..., 3]
    lossless = np.array_equal(e + mo, alpha)          # disjoint, so a sum is exact
    rows.append((name, len(eyes), gap, f"cut@{cut}  lossless={lossless}"))

for r in rows:
    print("%-11s eyes=%d gap=%-4d %s" % r)
