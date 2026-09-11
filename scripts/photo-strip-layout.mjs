#!/usr/bin/env node
/* Print the LAYOUTS table in js/photoStrips.js from the Figma frames.

     node scripts/figma-rest.mjs get \
       "/v1/files/$FIGMA_FILE_KEY/nodes?ids=377:498,381:616,381:757&geometry=paths" \
       > /tmp/strips.json
     node scripts/photo-strip-layout.mjs /tmp/strips.json

   `geometry=paths` is what makes the REST API return relativeTransform and
   size; without it there is only absoluteBoundingBox, which for a rotated
   node is the box the rotation EXPANDS to and cannot be placed again.

   Every image-filled rectangle becomes one row: its WORLD matrix (the product
   of every ancestor's relativeTransform, so a rotated child of a rotated,
   mirrored component instance comes out right), reduced to origin corner,
   own size, angle and a flip flag for a negative determinant. A drop shadow
   on any ancestor instance counts for the rectangle it draws. Two identical
   rows (Figma stacks the same instance twice in places) are merged, with the
   shadow count kept so the doubled shadow survives. */
import fs from "node:fs";

const ART = {
  "336be4008daee324cb3cb1bf0978d93970e1f8d4": "bg",
  "63fc056a2e8f9aa608cd405cb72b2f310e4a5f36": "title",
  "015dd2cefe32213c7b25cd345a52495dcd4f4c75": "strip",
  "ce7ebe6ca5e8f65f344bb9288d06b1366204b5a3": "tag-red",
  "0d0d44a6a9424f8f6574a8172129166fae4c8002": "tag-blue",
  "9273dfa6a70f54b5fafae7ba617cd6187b01e0f1": "tape-yellow",
  "85ad3ba246912db6516e557716b043637c40a7d6": "tape-cream",
  "d6a6cdcfb1342d94a5e862d6efaf578bcfc3597e": "tape-blue",
  "cd5f124fed0824990903efc70db4c76dd206c8da": "tri-blue",
  "4dfc9591ab70d31d4947d26e05b7b0d220d3e1a4": "tri-red",
  "2b4f86d36aedf21989ad060413f19acd2bcf0071": "star",
};
const mul = (A, B) => [
  [A[0][0]*B[0][0] + A[0][1]*B[1][0], A[0][0]*B[0][1] + A[0][1]*B[1][1], A[0][0]*B[0][2] + A[0][1]*B[1][2] + A[0][2]],
  [A[1][0]*B[0][0] + A[1][1]*B[1][0], A[1][0]*B[0][1] + A[1][1]*B[1][1], A[1][0]*B[0][2] + A[1][1]*B[1][2] + A[1][2]],
];
const round = (n, d = 3) => Math.round(n * 10 ** d) / 10 ** d;

const json = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
for(const node of Object.values(json.nodes)){
  const frame = node.document;
  const rows = [];
  const walk = (n, M, shadow) => {
    if(n.visible === false) return;
    const W = mul(M, n.relativeTransform);
    const sh = shadow || (n.effects || []).some(e => e.type === "DROP_SHADOW" && e.visible !== false);
    const img = (n.fills || []).find(f => f.type === "IMAGE" && f.visible !== false);
    if(img){
      const [[a, b, x], [c, d, y]] = W;
      rows.push({ art: ART[img.imageRef] || img.imageRef, x: round(x), y: round(y),
        w: round(n.size.x), h: round(n.size.y), r: round(Math.atan2(c, a) * 180 / Math.PI, 4),
        f: a * d - b * c < 0 ? 1 : 0, s: sh ? 1 : 0 });
    }
    (n.children || []).forEach(k => walk(k, W, sh));
  };
  frame.children.forEach(k => walk(k, [[1, 0, 0], [0, 1, 0]], false));
  const merged = [];
  for(const p of rows){
    const twin = merged.find(q => ["art", "x", "y", "w", "h", "r", "f"].every(k => q[k] === p[k]));
    if(twin) twin.s += p.s; else merged.push(p);
  }
  console.log(`  /* ${frame.id} ${frame.name} */`);
  for(const p of merged)
    console.log(`    [${JSON.stringify(p.art)}, ${p.x}, ${p.y}, ${p.w}, ${p.h}, ${p.r}, ${p.f}, ${p.s}],`);
}
