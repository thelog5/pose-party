#!/usr/bin/env node
/* Shrink a Training export to what the game reads, and prove nothing changed.

   node scripts/slim-pose-deck.mjs <export.json> [out.json]
   (out defaults to the shipped deck, assets/data/pose-charades-data.json)

   A Training export is ~6x bigger than the game needs:
   · Each frame is 57 points: 15 body joints and 42 HAND points. The
     classifier reads only the body (MODEL_POINTS). decodePoseDataset pads a
     short frame back to FRAME_POINTS with zeros, so the hands can go.
   · `visibility` is float32 noise to 16 digits. The game only asks one
     question of it: is it >= POSE_VISIBILITY. Two decimals keep every answer
     the same (the rounding is clamped so no value crosses the line).
   · `timestamps` carry the same float noise. A tenth of a millisecond is
     plenty; they must stay strictly increasing.

   The script then runs the game's own loader and section cutter on BOTH
   files and exits non-zero if any clip comes out different. Keep the
   original export: the hand points are gone from the output for good. */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const JS = path.join(ROOT, "pose-charades-external-data", "js");
const { JOINTS } = await import(path.join(JS, "constants.js"));
const { decodePoseDataset } = await import(path.join(JS, "poseData.js"));
const { clipSegments, POSE_VISIBILITY } = await import(path.join(JS, "poseInput.js"));

const [src, out = path.join(ROOT, "pose-charades-external-data/assets/data/pose-charades-data.json")] =
  process.argv.slice(2);
if(!src){ console.error("usage: node scripts/slim-pose-deck.mjs <export.json> [out.json]"); process.exit(2); }

const deck = JSON.parse(fs.readFileSync(src, "utf8"));
const round = (v, places) => { const f = 10 ** places; return Math.round(v * f) / f + 0; };

function slimVisibility(v){
  let r = round(v, 2);
  if(v < POSE_VISIBILITY && r >= POSE_VISIBILITY) r = round(POSE_VISIBILITY - .01, 2);
  if(v >= POSE_VISIBILITY && r < POSE_VISIBILITY) r = POSE_VISIBILITY;
  return r;
}

function slimTimestamps(ts){
  const outTs = [];
  for(const t of ts){
    const r = round(t, 1);
    outTs.push(outTs.length && r <= outTs[outTs.length - 1] ? t : r);
  }
  return outTs;
}

const slim = {
  ...deck,
  clips: deck.clips.map(clip => {
    const c = { ...clip, frames: clip.frames.map(f => f.slice(0, JOINTS.length).map(p => [round(p[0], 3), round(p[1], 3)])) };
    if(clip.visibility) c.visibility = clip.visibility.map(row => row.map(slimVisibility));
    if(clip.timestamps) c.timestamps = slimTimestamps(clip.timestamps);
    return c;
  }),
};

/* Same loader, same cutter, both files: the sections the model trains on
   must match point for point (coordinates already come at 3 decimals). */
const before = decodePoseDataset(deck), after = decodePoseDataset(JSON.parse(JSON.stringify(slim)));
let bad = 0;
before.forEach((clip, i) => {
  const a = clipSegments(clip), b = clipSegments(after[i]);
  const same = a.length === b.length && a.every((sec, s) => sec.length === b[s].length &&
    sec.every((frame, f) => frame.slice(0, JOINTS.length).every((p, j) =>
      Math.abs(p[0] - b[s][f][j][0]) < 6e-4 && Math.abs(p[1] - b[s][f][j][1]) < 6e-4)));
  if(!same){ bad++; console.error(`clip ${i} (${clip.label}) changed`); }
});
if(bad){ console.error(`${bad} clips changed; nothing written`); process.exit(1); }

const text = JSON.stringify(slim);
fs.writeFileSync(out, text);
const mb = n => (n / 1e6).toFixed(1) + " MB";
console.log(`${deck.clips.length} clips, all identical to the game`);
console.log(`${mb(fs.statSync(src).size)} -> ${mb(Buffer.byteLength(text))}  ${out}`);
