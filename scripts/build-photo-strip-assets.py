"""Build the ps-*.png papers for the PHOTO STRIPS page from raw Figma fills.
    python3 scripts/build-photo-strip-assets.py <raw-dir>

<raw-dir> holds the ORIGINAL imageRef bytes, fetched through
/v1/files/:key/images (cheap, not rate-limited), one file per key below.
Frames: "1v1 photo strips" 377:498, "Party photo strips" 381:616,
"Single Player photo strips" 381:757.

Why a script and not a straight copy: the tapes, stars and triangles are
component children with an IMAGE fill that carries an `imageTransform`. That
transform CROPS the source to its middle before Figma stretches it over the
rectangle, so the raw file is the wrong picture (a small scrap floating in a
large transparent square). The crop table below is those transforms, read
off the nodes verbatim: [scaleX, 0, offsetX], [0, scaleY, offsetY], all in
fractions of the source.

The strip, the tags, the title and the background are FILL (cover) with no
transform, and each of their rectangles has the same aspect as the source
(the party strip is the one exception, and photoStrips.js does its cover
crop at runtime), so those are only resized and palette-quantized.
"""
import sys, os
from PIL import Image

DST = os.path.join(os.path.dirname(__file__), "..",
                   "client", "assets", "ui", "figma")

# key -> (output name, crop [sx, ox, sy, oy] or None, max long edge)
JOBS = {
    "strip":     ("ps-strip.png",       None, 1536),
    "title":     ("ps-title.png",       None, 1188),
    "tagblue":   ("ps-tag-blue.png",    None, 1086),
    "tagred":    ("ps-tag-red.png",     None, 1086),
    "tapelong":  ("ps-tape-yellow.png", (0.5587301850318909, 0.2349206507205963,
                                         0.7184765338897705, 0.14076173305511475), 420),
    "tapecream": ("ps-tape-cream.png",  (0.5839999914169312, 0.23042376339435577,
                                         0.3500000238418579, 0.3231152594089508), 300),
    "tapeblue":  ("ps-tape-blue.png",   (0.5106081962585449, 0.26591232419013977,
                                         0.41926345229148865, 0.2889518439769745), 380),
    "tri_blue":  ("ps-tri-blue.png",    (0.5059999823570251, 0.24799999594688416,
                                         0.5920000076293945, 0.23800000548362732), 300),
    "tri_red":   ("ps-tri-red.png",     (0.5339999794960022, 0.26600000262260437,
                                         0.5400000214576721, 0.1900000125169754), 300),
    "star":      ("ps-star.png",        (0.695067286491394, 0.16816143691539764,
                                         0.6860986948013306, 0.11434978246688843), 360),
}


def crop(im, c):
    sx, ox, sy, oy = c
    w, h = im.size
    box = (round(ox * w), round(oy * h), round((ox + sx) * w), round((oy + sy) * h))
    return im.crop(box)


def fit(im, edge):
    k = min(1, edge / max(im.size))
    if k < 1:
        im = im.resize((round(im.width * k), round(im.height * k)), Image.LANCZOS)
    return im


def main(raw):
    for key, (name, c, edge) in JOBS.items():
        im = Image.open(os.path.join(raw, key + ".bin")).convert("RGBA")
        if c:
            im = crop(im, c)
        im = fit(im, edge)
        im.quantize(256, method=Image.Quantize.FASTOCTREE).save(
            os.path.join(DST, name), optimize=True)
        print(name, im.size)
    bg = Image.open(os.path.join(raw, "bg.bin")).convert("RGB")
    bg.save(os.path.join(DST, "ps-bg.jpg"), quality=86, optimize=True)
    print("ps-bg.jpg", bg.size)


if __name__ == "__main__":
    main(sys.argv[1])
