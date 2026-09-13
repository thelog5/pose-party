/* PHOTO STRIPS — Figma "1v1 photo strips" (377:498), "Party photo strips"
   (381:616) and "Single Player photo strips" (381:757).

   One board per mode, filled with the stills results.js kept during the
   match, and saved as one picture. The board is drawn TWICE from the same
   table: once as DOM (the screen) and once onto a canvas (the saved image).
   Neither copy places anything by eye, so the file you save is the screen
   you were looking at.

   THE TABLE IS THE FIGMA MATRICES, COMPOSED. Each row is one image-filled
   rectangle: [art, x, y, w, h, rotation, flip, shadow]. x/y is the world
   position of the rectangle's ORIGIN corner (not its axis-aligned box), w/h
   is its own size before rotation, and flip marks a matrix with a negative
   determinant. Two things in these frames make that the only safe form:
   - Party's strips are instances of a COMPONENT whose child is itself
     rotated, so a strip's angle is the SUM of two transforms. Reading
     absoluteBoundingBox would place the expanded box of a box.
   - Three of Party's six strips are MIRRORED (Figma reports them at ~180deg
     with det -1). Re-derived as an angle they land upside down.
   `shadow` is 1 for Figma's DROP_SHADOW (y 7, blur 4, black 35%), 0 for none,
   and 2 where Figma stacks two identical instances on one spot. Those twins
   are merged into one piece so a tap moves ONE triangle, and the doubled
   shadow is kept (1 - .65^2), which is what the Figma render shows.

   THE SHADOW IS IN WORLD SPACE. Figma drops it straight down however the
   paper is turned; a CSS filter on a rotated element turns with it, which
   put a tape at -35deg casting its shadow down and to the LEFT. Each piece
   gets its offset rotated back into its own frame (--sx/--sy), so the
   filter can sit on the art alone. That is what lets a strip's frame cast
   its shadow ONTO the photos inside it, the way paper over prints would.

   Rebuild the table with scripts/photo-strip-layout.mjs; the art comes from
   scripts/build-photo-strip-assets.py. */

import { blip } from "./audio.js";

const FRAME_W = 1440, FRAME_H = 810;
const DIR = "assets/ui/figma/";

/* fit: Figma FILL is cover, STRETCH is fill. `hit` is the part of the art
   that answers the pointer: "alpha" samples the paper, "ink" takes the
   strip's whole outline, because with photos in its windows it is solid. */
const ART = {
  "bg":          { src:"ps-bg.webp",          fit:"cover", hit:null },
  "title":       { src:"ps-title.webp",       fit:"cover", hit:"alpha", kind:"title" },
  "strip":       { src:"ps-strip.webp",       fit:"cover", hit:"ink",   kind:"strip" },
  "tag-blue":    { src:"ps-tag-blue.webp",    fit:"cover", hit:"alpha", kind:"tag", side:"blue" },
  "tag-red":     { src:"ps-tag-red.webp",     fit:"cover", hit:"alpha", kind:"tag", side:"orange" },
  "tape-yellow": { src:"ps-tape-yellow.webp", fit:"fill",  hit:"alpha", kind:"tape" },
  "tape-cream":  { src:"ps-tape-cream.webp",  fit:"fill",  hit:"alpha", kind:"tape" },
  "tape-blue":   { src:"ps-tape-blue.webp",   fit:"fill",  hit:"alpha", kind:"tape" },
  "tri-blue":    { src:"ps-tri-blue.webp",    fit:"fill",  hit:"alpha", kind:"conf" },
  "tri-red":     { src:"ps-tri-red.webp",     fit:"fill",  hit:"alpha", kind:"conf" },
  "star":        { src:"ps-star.webp",        fit:"fill",  hit:"alpha", kind:"conf" },
};

/* ps-strip.webp is 1024x1536, and STRIP_INK is the frame's own ink box.

   THE PHOTOS ARE PRINTS STUCK ON THE STRIP, IN FRONT OF IT. They first sat
   BEHIND the paper, each cut to the torn edge of its window, and read as
   holes in a frame rather than as a photo strip. Now each is one clean
   rectangle laid over the paper: the same size in all four slots, spaced
   evenly, bigger than any window, with an even cream margin between them.
   Every print still covers its whole window, so no torn edge shows through:
     window (alpha)          print
     271,144 .. 752,435      258,136 .. 764,442
     274,482 .. 753,767      258,469 .. 764,775
     276,814 .. 752,1100     258,802 .. 764,1108
     277,1147 .. 752,1415    258,1135 .. 764,1441
   Re-check that table if ps-strip.webp is ever re-exported. */
const STRIP_NAT = [1024, 1536];
const STRIP_INK = [216, 88, 811, 1473];
const PRINT = { x: 258, w: 506, h: 306, tops: [136, 469, 802, 1135] };
const SLOTS = PRINT.tops.length;
/* Stills are 3:2 and the prints are ~1.65:1, so a little comes off the top
   and bottom. Take more from the bottom: the face is the photo. */
const SHOT_POS_Y = .4;
/* A print sits ON the paper, so it drops a small, tight shadow onto it:
   2px down, sigma 1.5, the same world-space rule as every other shadow. */
const PRINT_SHADOW = { y: 2, sigma: 1.5, alpha: .3 };

/* Figma's radius is a box-shadow blur (sigma = radius / 2), and so is canvas
   shadowBlur. CSS drop-shadow() takes sigma itself, so the DOM gets HALF the
   radius. Swept against the Figma render of 377:498: CSS blur 2 is the
   closest fit under a doubled triangle (2.69 mean error) and 4, the
   figure the other boards here would have used, the worst (4.44). */
const SHADOW = { y: 7, blur: 4, alpha: .35 };
const CSS_BLUR = SHADOW.blur / 2;

const LAYOUTS = {
  /* 377:498 */
  "1v1": [
    ["bg", -49, -59, 1489, 937, 0, 0, 0],
    ["title", 465, -28, 510, 170, 0, 0, 1],
    ["strip", 0, 142.363, 453.459, 680.189, -3.0798, 0, 1],
    ["strip", 312.129, 121.3, 453.459, 680.189, 1.7447, 0, 1],
    ["strip", 672, 145.363, 453.459, 680.189, -3.0798, 0, 1],
    ["strip", 984.129, 124.3, 453.459, 680.189, 1.7447, 0, 1],
    ["tag-red", 884, 99, 341, 113, 0, 0, 0],
    ["tag-blue", 213, 96, 328, 109, 0, 0, 0],
    ["tape-yellow", 49, 183.609, 125.542, 80.603, -28.3472, 0, 1],
    ["tape-yellow", 449.882, 20.257, 89.098, 57.205, -34.7933, 0, 1],
    ["tape-cream", 611.77, 142.158, 98.113, 58.8, 22.36, 0, 1],
    ["tape-cream", 798.77, 741.158, 98.113, 58.8, 22.36, 0, 1],
    ["tape-blue", 1171.838, 99, 83.515, 34.239, 37.4893, 0, 1],
    ["tri-blue", 40.48, 31.13, 68.31, 79.92, 0, 0, 2],
    ["tri-red", 190.738, 66.67, 49.662, 50.22, 0, 0, 2],
    ["tri-blue", 29.48, 691.13, 68.31, 79.92, 0, 0, 1],
    ["tri-blue", 675.48, 406.13, 68.31, 79.92, 0, 0, 1],
    ["tri-blue", 657.48, 707.13, 68.31, 79.92, 0, 0, 1],
    ["tri-blue", 1378.103, 185.288, 68.31, 79.92, 28.0438, 0, 1],
    ["tri-blue", 1377.574, 716, 68.31, 79.92, 28.0438, 0, 1],
    ["tri-red", 53.659, 260.771, 71.556, 72.36, 52.2742, 0, 1],
    ["star", 334.08, 7.447, 93.139, 91.937, 9.8999, 0, 1],
    ["star", 38.284, 419.375, 70.582, 69.672, 9.8999, 0, 1],
    ["tri-blue", 1036.547, 16.826, 68.31, 79.92, 22.4268, 0, 1],
    ["tri-red", 1212.534, 18.762, 62.461, 63.162, 39.2367, 0, 1],
    ["tri-red", 1412.969, 542.675, 89.179, 90.181, 39.2367, 0, 1],
    ["tri-red", 750.026, 562.893, 62.461, 63.162, 39.2367, 0, 1],
    ["tri-red", 40.026, 586.893, 62.461, 63.162, 39.2367, 0, 1],
    ["star", 1394.649, -11.644, 93.139, 91.937, 62.8109, 0, 1],
    ["star", 1395.688, 408.614, 53.21, 52.523, 84.7959, 0, 1],
    ["star", 697.284, 238.375, 70.582, 69.672, 9.8999, 0, 1],
  ],
  /* 381:616 — no shadows on its strips, tapes or title: that is the frame */
  "party": [
    ["bg", -49, -59, 1489, 937, 0, 0, 0],
    ["title", 440, -35, 594, 198, 0, 0, 0],
    ["strip", -65, 191.647, 404.074, 632.192, -3.2129, 0, 0],
    ["tape-yellow", -22.241, 223.91, 116.67, 74.908, -28.3472, 0, 0],
    ["strip", 178.864, 172.281, 404.098, 632.229, 2.3876, 0, 0],
    ["strip", 361.776, 202.312, 404.098, 632.229, -5.9271, 0, 0],
    ["strip", 1520, 192.647, 404.074, 632.192, -176.7871, 1, 0],
    ["strip", 1275.6, 180.908, 404.259, 632.48, 177.6124, 1, 0],
    ["strip", 1092.854, 202.316, 404.118, 632.261, -174.0729, 1, 0],
    ["tape-yellow", 1396.728, 155.402, 116.67, 74.908, 30.4991, 0, 0],
    ["tape-yellow", 449.882, 20.257, 89.098, 57.205, -34.7933, 0, 0],
    ["tape-yellow", 726.36, 200.437, 116.67, 74.908, -21.0993, 0, 0],
    ["tape-cream", 429.132, 183.487, 101.574, 60.875, 10.6746, 0, 0],
    ["tape-cream", 1167.366, 162.638, 101.574, 60.875, 22.36, 0, 0],
    ["tag-blue", 147, 109, 423, 141, 0, 0, 0],
    ["tag-red", 892, 104, 438, 146, 0, 0, 0],
    ["tri-blue", 33.48, 27.819, 68.31, 79.92, 0, 0, 1],
    ["tri-red", 183.738, 63.359, 49.662, 50.22, 0, 0, 1],
    ["star", 327.08, 4.137, 93.139, 91.937, 9.8999, 0, 1],
    ["tri-blue", 1060.193, 14.473, 68.31, 79.92, 22.4268, 0, 1],
    ["tri-red", 1205.534, 15.452, 62.461, 63.162, 39.2367, 0, 1],
    ["star", 1387.649, -14.955, 93.139, 91.937, 62.8109, 0, 1],
    ["star", 682.17, 133.124, 73.073, 72.13, 9.8999, 0, 1],
    ["tape-blue", 1055.898, 104, 122.578, 50.253, 11.3598, 0, 1],
    ["tape-yellow", 304.404, 94, 116.67, 74.908, 2.6045, 0, 0],
  ],
  /* 381:757 */
  "solo": [
    ["bg", -49, -59, 1489, 937, 0, 0, 0],
    ["title", 465, -28, 510, 170, 0, 0, 1],
    ["strip", 64, 134.77, 461.034, 691.552, -3.0798, 0, 1],
    ["strip", 369.055, 130, 461.034, 691.552, 1.7447, 0, 1],
    ["strip", 619, 171.709, 461.034, 691.552, -6.8151, 0, 1],
    ["strip", 968.296, 106, 461.034, 691.552, 1.5989, 0, 1],
    ["tag-blue", 556, 101, 343, 114, 0, 0, 0],
    ["tape-yellow", 95, 166.605, 127.639, 81.95, -28.3472, 0, 1],
    ["tape-yellow", 449.882, 20.257, 89.098, 57.205, -34.7933, 0, 1],
    ["tape-cream", 1026.094, 157.115, 99.751, 59.783, -28.3386, 0, 1],
    ["tape-cream", 429.537, 170.367, 99.751, 59.783, -23.5523, 0, 1],
    ["tri-blue", 40.48, 31.13, 68.31, 79.92, 0, 0, 2],
    ["tri-red", 190.738, 66.67, 49.662, 50.22, 0, 0, 2],
    ["tri-blue", 78.48, 693.13, 68.31, 79.92, 0, 0, 1],
    ["tri-blue", 1378.103, 185.288, 68.31, 79.92, 28.0438, 0, 1],
    ["tri-blue", 1377.574, 716, 68.31, 79.92, 28.0438, 0, 1],
    ["tri-red", 53.659, 260.771, 71.556, 72.36, 52.2742, 0, 1],
    ["star", 334.08, 7.447, 93.139, 91.937, 9.8999, 0, 1],
    ["star", 95.284, 419.375, 70.582, 69.672, 9.8999, 0, 1],
    ["tri-blue", 1036.547, 16.826, 68.31, 79.92, 22.4268, 0, 1],
    ["tri-red", 1212.534, 18.762, 62.461, 63.162, 39.2367, 0, 1],
    ["tri-red", 1398.969, 550.675, 89.179, 90.181, 39.2367, 0, 1],
    ["tri-red", 40.026, 586.893, 62.461, 63.162, 39.2367, 0, 1],
    ["star", 1394.649, -11.644, 93.139, 91.937, 62.8109, 0, 1],
    ["star", 1395.688, 368.614, 53.21, 52.523, 84.7959, 0, 1],
    ["tape-cream", 779.435, 749.278, 99.751, 59.783, 22.36, 0, 1],
  ],
};

/* ---------------- geometry ---------------- */

function pieceOf(row, ix){
  const [art, x, y, w, h, r, f, s] = row;
  const rad = r * Math.PI / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad), flip = f ? -1 : 1;
  /* columns of the linear part: M = R(r) . diag(1, flip) */
  const m = { a: cos, b: sin, c: -sin * flip, d: cos * flip };
  const cx = x + m.a * w / 2 + m.c * h / 2;
  const cy = y + m.b * w / 2 + m.d * h / 2;
  return { ix, art, x, y, w, h, r, flip: !!f, shadows: s, m, cx, cy, spec: ART[art] };
}

/* Where each print sits, in the piece's own box (fractions). The party
   strip is 0.639 where the art is 0.667, so its FILL crops the sides: the
   prints have to go through the same cover fit as the art. */
function printRects(p){
  const s = Math.max(p.w / STRIP_NAT[0], p.h / STRIP_NAT[1]);
  const ox = (p.w - STRIP_NAT[0] * s) / 2, oy = (p.h - STRIP_NAT[1] * s) / 2;
  return PRINT.tops.map(top => ({
    x: (PRINT.x * s + ox) / p.w, y: (top * s + oy) / p.h,
    w: PRINT.w * s / p.w, h: PRINT.h * s / p.h,
  }));
}

/* Which strips belong to which side, in reading order (left to right), so
   the first player's photos start top-left of their own group. Solo's four
   strips are all one player's. */
function stripsBySide(layout, pieces){
  const strips = pieces.filter(p => p.art === "strip").sort((a, b) => a.cx - b.cx);
  if(layout === "solo") return { blue: strips, orange: [] };
  return { blue: strips.filter(p => p.cx < FRAME_W / 2),
           orange: strips.filter(p => p.cx >= FRAME_W / 2) };
}

const piecesFor = layout => (LAYOUTS[layout] || LAYOUTS.party).map(pieceOf);

/* How many windows each side has to fill. results.js splits them between
   that side's players; it never needs to know the geometry. */
export function stripSlots(layout){
  const sides = stripsBySide(layout, piecesFor(layout));
  return { blue: sides.blue.length * SLOTS, orange: sides.orange.length * SLOTS };
}

/* photos: { blue:[url|null...], orange:[...] } in window order. Returns
   Map(piece ix -> [url|null x4]). */
function assignPhotos(layout, pieces, photos){
  const out = new Map();
  const sides = stripsBySide(layout, pieces);
  for(const side of ["blue", "orange"]){
    const list = photos?.[side] || [];
    sides[side].forEach((p, i) =>
      out.set(p.ix, PRINT.tops.map((_, w) => list[i * SLOTS + w] || null)));
  }
  return out;
}

/* A shadow straight down in the WORLD, expressed in the piece's own frame:
   M^-1 . (0, y) with M^-1 = diag(1, flip) . R(-r). */
function localShadow(p, dist){
  return { x: dist * p.m.b, y: dist * p.m.d };
}
const shadowAlpha = n => 1 - Math.pow(1 - SHADOW.alpha, n);

/* ---------------- labels ---------------- */

const LABEL_FONT = "'Fredoka One','Baloo 2',system-ui,sans-serif";
/* The tag's torn ink runs 4-96% across and 19-82% down its box. The label
   is authored nowhere in these frames, so it takes the house name-tag look:
   white Fredoka with a hard dark offset, ~43% of the tag's height, shrunk
   to fit 82% of its width. */
const LABEL_SIZE = .43, LABEL_ROOM = .82;
/* the label's optical centre on the torn ink, and its hard shadow as a
   fraction of the type size; screens.css carries the same two numbers */
const LABEL_MID = .505, LABEL_SHADOW = .06;
let measureCtx = null;
function labelSize(text, p){
  const base = p.h * LABEL_SIZE;
  if(!measureCtx) measureCtx = document.createElement("canvas").getContext("2d");
  if(!measureCtx) return base;
  measureCtx.font = base + "px " + LABEL_FONT;
  const width = measureCtx.measureText(text).width;
  return width > p.w * LABEL_ROOM ? base * p.w * LABEL_ROOM / width : base;
}

/* ---------------- DOM board ---------------- */

const pct = (n, of) => (n / of * 100).toFixed(4) + "%";
const cqw = n => (n / FRAME_W * 100).toFixed(4) + "cqw";

/* Beats for the arrival, in ms: the board is laid out the way someone would
   make it — strips down first, then the tags and the tape that pins them,
   then the scraps scattered over the top. */
function beatFor(p, order){
  const k = p.spec.kind;
  if(k === "title") return 40;
  if(k === "strip") return 110 + order.strip++ * 70;
  if(k === "tag") return 420 + order.tag++ * 60;
  if(k === "tape") return 560 + order.tape++ * 45;
  return 640 + order.conf++ * 28;
}

let board = null;          // { root, layout, pieces, onMove... }

export function mountPhotoStrips(root, { layout, labels = {}, photos = {} }){
  unmountPhotoStrips();
  const pieces = piecesFor(layout);
  const filled = assignPhotos(layout, pieces, photos);
  root.dataset.layout = layout;
  root.replaceChildren();
  const order = { strip:0, tag:0, tape:0, conf:0 };
  for(const p of pieces){
    const el = document.createElement("div");
    el.className = "ps-piece";
    el.dataset.art = p.art;
    if(p.spec.kind) el.dataset.kind = p.spec.kind;
    if(p.flip) el.dataset.flip = "";
    el.style.cssText =
      "left:" + pct(p.x, FRAME_W) + ";top:" + pct(p.y, FRAME_H) +
      ";width:" + pct(p.w, FRAME_W) + ";height:" + pct(p.h, FRAME_H) +
      ";--ps-r:" + p.r + "deg;--ps-f:" + (p.flip ? -1 : 1) +
      ";--ps-in:" + beatFor(p, order) + "ms";
    if(p.shadows){
      const sh = localShadow(p, SHADOW.y);
      el.style.cssText += ";--sx:" + cqw(sh.x) + ";--sy:" + cqw(sh.y) +
        ";--sb:" + cqw(CSS_BLUR) + ";--sa:" + shadowAlpha(p.shadows).toFixed(4);
      el.dataset.shadow = "";
    }
    const turn = document.createElement("div");
    turn.className = "ps-turn";
    const live = document.createElement("div");
    live.className = "ps-live";

    const art = document.createElement("img");
    art.className = "ps-art";
    art.src = DIR + p.spec.src;
    art.alt = "";
    art.draggable = false;
    art.style.objectFit = p.spec.fit;
    live.appendChild(art);

    if(p.art === "strip"){
      const ps = localShadow(p, PRINT_SHADOW.y);
      el.style.cssText += ";--px:" + cqw(ps.x) + ";--py:" + cqw(ps.y) +
        ";--pb:" + cqw(PRINT_SHADOW.sigma) + ";--pa:" + PRINT_SHADOW.alpha;
      const urls = filled.get(p.ix) || [];
      printRects(p).forEach((r, i) => {
        if(!urls[i]) return;
        const shot = document.createElement("div");
        shot.className = "ps-shot";
        shot.style.cssText = "left:" + (r.x * 100).toFixed(4) + "%;top:" +
          (r.y * 100).toFixed(4) + "%;width:" + (r.w * 100).toFixed(4) +
          "%;height:" + (r.h * 100).toFixed(4) + "%";
        const img = document.createElement("img");
        img.src = urls[i]; img.alt = ""; img.decoding = "async";
        shot.appendChild(img);
        live.appendChild(shot);
      });
    }

    if(p.spec.kind === "tag"){
      const text = labels[p.spec.side] || "";
      const b = document.createElement("b");
      b.className = "ps-label";
      b.textContent = text;
      b.style.fontSize = cqw(labelSize(text, p));
      live.appendChild(b);
    }
    turn.appendChild(live);
    el.appendChild(turn);
    root.appendChild(el);
    p.el = el;
    p.live = live;
    p.artEl = art;
  }
  const layer = root.closest(".rs-strips") || root.parentElement;
  board = { root, layer, stage: root.closest(".resstage"), layout, pieces,
    labels, photos, hot:null };
  wireBoard(board);
  fitBoard(board);
  /* labels were sized before the font was guaranteed; re-measure once it is */
  document.fonts?.load?.("40px " + LABEL_FONT).then(() => {
    if(board?.root !== root) return;
    for(const p of pieces){
      const b = p.el.querySelector(".ps-label");
      if(b) b.style.fontSize = cqw(labelSize(b.textContent, p));
    }
  }).catch(() => {});
  /* The arrival, once per open — see screens.css. On the LAYER: the CSS
     keys it as `.rs-strips.ps-entering`, and the board is inside it. */
  layer.classList.remove("ps-entering");
  void layer.offsetWidth;
  layer.classList.add("ps-entering");
  clearTimeout(layer._enterTimer);
  layer._enterTimer = setTimeout(() => layer.classList.remove("ps-entering"), 1500);
}

export function unmountPhotoStrips(){
  if(!board) return;
  board.unwire?.();
  clearTimeout(board.layer._enterTimer);
  board.layer.classList.remove("ps-entering");
  board.root.replaceChildren();
  board = null;
}

/* THE BOARD FILLS THE WINDOW. The results stage letterboxes to 16:9, and at
   any other window shape that left bars of page colour down two edges of a
   board that is otherwise all felt. The layer is now fixed to the whole
   window; the composition stays at the stage's own 16:9 box (so every Figma
   position still holds), and nothing clips it there, so the papers that
   Figma runs off the frame edge carry on into the extra space instead of
   stopping in a straight line. The felt grows to reach every edge: it is
   scaled about the frame's centre by the least amount that covers the
   window, which is exactly 1 at 16:9, so the Figma frame is untouched. */
function fitBoard(b){
  const r = b.stage?.getBoundingClientRect();
  if(!r?.width) return;
  const vw = document.documentElement.clientWidth || innerWidth;
  const vh = document.documentElement.clientHeight || innerHeight;
  b.layer.style.setProperty("--ps-x", r.left + "px");
  b.layer.style.setProperty("--ps-y", r.top + "px");
  b.layer.style.setProperty("--ps-w", r.width + "px");
  const bg = b.pieces.find(p => p.art === "bg");
  if(!bg?.live) return;
  const k = r.width / FRAME_W;
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  const ox = FRAME_W / 2 - bg.x, oy = FRAME_H / 2 - bg.y;     // centre, in the felt's box
  const need = Math.max(1,
    cx / k / ox, (vw - cx) / k / (bg.w - ox),
    cy / k / oy, (vh - cy) / k / (bg.h - oy));
  bg.live.style.transformOrigin = (ox / bg.w * 100).toFixed(4) + "% " +
    (oy / bg.h * 100).toFixed(4) + "%";
  bg.live.style.scale = need > 1 ? String(need * 1.002) : "";
}

/* ---------------- interaction ----------------
   Every paper answers like every paper on Home: it lifts under the pointer
   and a tap gets a shake, a spin or a pop. The pieces are rotated, so
   :hover and getBoundingClientRect() would both answer for the rectangle
   the rotation EXPANDS to, and a tape at -35deg would claim a big square of
   air around it. Instead the board owns the pointer: it maps the point back
   through each piece's own matrix, top piece first, and samples the art's
   alpha there. */

const alphaMaps = new Map();    // art key -> {w,h,alpha} | "pending"
function alphaMap(p){
  const key = p.art;
  const hit = alphaMaps.get(key);
  if(hit && hit !== "pending") return hit;
  if(hit === "pending") return null;
  const img = p.artEl;
  if(!img?.complete || !img.naturalWidth){
    img?.addEventListener("load", () => alphaMaps.delete(key), { once:true });
    return null;
  }
  alphaMaps.set(key, "pending");
  const k = Math.min(1, 256 / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * k));
  const h = Math.max(1, Math.round(img.naturalHeight * k));
  try{
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const ctx = c.getContext("2d", { willReadFrequently:true });
    ctx.drawImage(img, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h).data;
    const alpha = new Uint8Array(w * h);
    for(let i = 0; i < alpha.length; i++) alpha[i] = data[i * 4 + 3];
    const map = { w, h, alpha, nw: img.naturalWidth, nh: img.naturalHeight };
    alphaMaps.set(key, map);
    return map;
  }catch{
    alphaMaps.delete(key);
    return null;
  }
}

function hits(p, X, Y){
  if(!p.spec.hit) return false;
  const dx = X - p.x, dy = Y - p.y;
  /* inverse of M = R(r) . diag(1, flip) */
  const u = p.m.a * dx + p.m.b * dy;
  const v = p.m.c * dx + p.m.d * dy;
  if(u < 0 || v < 0 || u > p.w || v > p.h) return false;
  if(p.spec.hit === "ink"){
    const s = Math.max(p.w / STRIP_NAT[0], p.h / STRIP_NAT[1]);
    const ix = (u - (p.w - STRIP_NAT[0] * s) / 2) / s;
    const iy = (v - (p.h - STRIP_NAT[1] * s) / 2) / s;
    return ix >= STRIP_INK[0] && ix <= STRIP_INK[2] && iy >= STRIP_INK[1] && iy <= STRIP_INK[3];
  }
  const map = alphaMap(p);
  if(!map) return true;             // not decoded yet: the box is a fair guess
  let fx = u / p.w, fy = v / p.h;
  if(p.spec.fit === "cover"){
    const s = Math.max(p.w / map.nw, p.h / map.nh);
    fx = (u - (p.w - map.nw * s) / 2) / (map.nw * s);
    fy = (v - (p.h - map.nh * s) / 2) / (map.nh * s);
  }
  const x = Math.floor(fx * map.w), y = Math.floor(fy * map.h);
  if(x < 0 || y < 0 || x >= map.w || y >= map.h) return false;
  return map.alpha[y * map.w + x] > 40;
}

function pieceAt(b, clientX, clientY){
  const rect = b.root.getBoundingClientRect();
  if(!rect.width || !rect.height) return null;
  const X = (clientX - rect.left) / rect.width * FRAME_W;
  const Y = (clientY - rect.top) / rect.height * FRAME_H;
  for(let i = b.pieces.length - 1; i >= 0; i--)
    if(hits(b.pieces[i], X, Y)) return b.pieces[i];
  return null;
}

function setHot(b, p){
  if(b.hot === p) return;
  b.hot?.el.classList.remove("hot");
  b.hot = p;
  p?.el.classList.add("hot");
  b.layer.classList.toggle("ps-pointing", !!p);
}

/* A strip is a long sheet of paper: it shakes or bounces, it does not
   cartwheel across its neighbours. Scraps get the whole repertoire. */
const REACTIONS = {
  strip: [["shook", [440]], ["popped", [523, 392]]],
  title: [["popped", [523, 659]], ["shook", [440]]],
  tag:   [["popped", [494, 659]], ["shook", [440]]],
  tape:  [["shook", [392]]],
  conf:  [["shook", [440]], ["spun", [392, 494]], ["popped", [523, 392]]],
};
function react(p){
  const pool = REACTIONS[p.spec.kind] || REACTIONS.conf;
  const [cls, notes] = pool[Math.floor(Math.random() * pool.length)];
  p.live.classList.remove("shook", "spun", "popped");
  void p.live.offsetWidth;
  p.live.classList.add(cls);
  blip(notes, .06);
}

/* The pointer is read on the whole LAYER, not the board: papers run past
   the frame into the extra space at other window shapes, and they answer
   there too. The two buttons keep their own clicks. */
function wireBoard(b){
  const onButton = e => !!e.target.closest?.("button");
  const move = e => setHot(b, onButton(e) ? null : pieceAt(b, e.clientX, e.clientY));
  const leave = () => setHot(b, null);
  const click = e => {
    if(onButton(e)) return;
    const p = pieceAt(b, e.clientX, e.clientY);
    if(p) react(p);
  };
  const resize = () => fitBoard(b);
  /* only a reaction ending clears a reaction; the arrival ends on the same
     element and must not wipe a tap that landed during it */
  const REACTION_ANIMS = new Set(["ivshake", "ivspin", "ivpop"]);
  const done = e => {
    if(REACTION_ANIMS.has(e.animationName))
      e.target.classList?.remove("shook", "spun", "popped");
  };
  b.layer.addEventListener("pointermove", move, { passive:true });
  b.layer.addEventListener("pointerleave", leave, { passive:true });
  b.layer.addEventListener("click", click);
  b.root.addEventListener("animationend", done);
  addEventListener("resize", resize);
  b.unwire = () => {
    b.layer.removeEventListener("pointermove", move);
    b.layer.removeEventListener("pointerleave", leave);
    b.layer.removeEventListener("click", click);
    b.root.removeEventListener("animationend", done);
    removeEventListener("resize", resize);
    b.layer.classList.remove("ps-pointing");
  };
}

/* ---------------- the saved picture ----------------
   The same table, drawn onto a canvas at `scale` x the Figma frame. Canvas
   shadow offsets ignore the current transform, which is exactly Figma's
   world-space shadow, so here the offset is simply straight down. */

const loadImage = src => new Promise(resolve => {
  const img = new Image();
  img.decoding = "async";
  img.onload = () => resolve(img);
  img.onerror = () => resolve(null);
  img.src = src;
});

function drawCover(ctx, img, x, y, w, h, posY = .5){
  const iw = img.naturalWidth, ih = img.naturalHeight;
  const s = Math.max(w / iw, h / ih);
  const sw = w / s, sh = h / s;
  ctx.drawImage(img, (iw - sw) / 2, (ih - sh) * posY, sw, sh, x, y, w, h);
}

export async function renderPhotoStrips({ layout, labels = {}, photos = {} }, scale = 2){
  const pieces = piecesFor(layout);
  const filled = assignPhotos(layout, pieces, photos);
  const arts = new Map();
  await Promise.all(Object.entries(ART).map(async ([key, spec]) =>
    arts.set(key, await loadImage(DIR + spec.src))));
  const shots = new Map();
  await Promise.all([...new Set([...filled.values()].flat().filter(Boolean))]
    .map(async url => shots.set(url, await loadImage(url))));
  try{ await document.fonts?.load?.("40px " + LABEL_FONT); }catch{}

  const canvas = document.createElement("canvas");
  canvas.width = Math.round(FRAME_W * scale);
  canvas.height = Math.round(FRAME_H * scale);
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  let drawn = 0, wanted = 0;

  for(const p of pieces){
    const art = arts.get(p.art);
    ctx.setTransform(scale * p.m.a, scale * p.m.b, scale * p.m.c, scale * p.m.d,
      scale * p.x, scale * p.y);
    ctx.shadowColor = "transparent";

    if(art){
      if(p.shadows){
        ctx.shadowColor = "rgba(0,0,0," + shadowAlpha(p.shadows).toFixed(4) + ")";
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = SHADOW.y * scale;
        ctx.shadowBlur = SHADOW.blur * scale;
      }
      if(p.spec.fit === "cover") drawCover(ctx, art, 0, 0, p.w, p.h);
      else ctx.drawImage(art, 0, 0, p.w, p.h);
      ctx.shadowColor = "transparent";
    }
    if(p.art === "strip"){
      const urls = filled.get(p.ix) || [];
      printRects(p).forEach((r, i) => {
        if(!urls[i]) return;
        wanted++;
        const img = shots.get(urls[i]);
        if(!img) return;
        const x = r.x * p.w, y = r.y * p.h, w = r.w * p.w, h = r.h * p.h;
        /* the print's own shadow first, as a filled rectangle: a clipped
           drawImage cannot cast one outside its clip */
        ctx.save();
        ctx.shadowColor = "rgba(0,0,0," + PRINT_SHADOW.alpha + ")";
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = PRINT_SHADOW.y * scale;
        ctx.shadowBlur = PRINT_SHADOW.sigma * 2 * scale;
        ctx.fillStyle = "#0e1b4a";
        ctx.fillRect(x, y, w, h);
        ctx.restore();
        ctx.save();
        ctx.beginPath();
        ctx.rect(x, y, w, h);
        ctx.clip();
        /* a mirrored strip still holds photos the right way round */
        if(p.flip){ ctx.translate(x + w, y); ctx.scale(-1, 1); drawCover(ctx, img, 0, 0, w, h, SHOT_POS_Y); }
        else drawCover(ctx, img, x, y, w, h, SHOT_POS_Y);
        ctx.restore();
        drawn++;
      });
    }
    if(p.spec.kind === "tag" && labels[p.spec.side]){
      const text = labels[p.spec.side];
      const size = labelSize(text, p);
      ctx.font = size + "px " + LABEL_FONT;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const cx = p.w / 2, cy = p.h * LABEL_MID;
      ctx.fillStyle = "rgba(0,0,0,.5)";
      ctx.fillText(text, cx + size * LABEL_SHADOW, cy + size * LABEL_SHADOW);
      ctx.fillStyle = "#fff";
      ctx.fillText(text, cx, cy);
    }
  }
  const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", .92));
  return { blob, drawn, wanted };
}
