#!/usr/bin/env node
/* Test a pose deck the only honest way it can be tested: leave one clip out.

   For each clip, build the model from every OTHER clip, classify the held-out
   clip's windows, and score the result. A label with two takes is therefore
   tested against a model that holds exactly one take of it, which is the
   situation a real player is in: the model has never seen THEM.

   It imports the shipped classifier. Every weighting is learned on the
   training fold only, never on the held-out clip:

     shipped THE SHIPPED MODEL: buildModel(clips), i.e. FEATURE_WEIGHTING
             and WORD_JOINT_WEIGHTS as constants.js sets them.
     none    no weighting at all: {weigh:false, wordWeights:{}}.
     global  the learned global weighting and nothing else. One weight per
             dimension for every word. A dimension counts for more when word
             means differ on it and takes of one word agree on it.
     take    one weight vector PER WORD. Same ratio, but "differ" is this
             word against the rest, and "agree" is between this word's takes.
             With one take left in the fold, the spread is within-clip wobble.
     hybrid  "take" for words with at least two takes in the fold, no
             weighting for the others.
     mixed   "take" for words with at least two takes, "global" for the rest.

   Usage:
     node scripts/pose-deck-eval.mjs [deck.json] [--word "<label>"] [--drop "a,b"]
                                     [--modes none,global] [--jitter 0.02] [--quick]

   --drop tests the deck as if those words were not in it.
   --modes picks the weightings to compare ("shipped", "none" and "global"
   are always included).

   --jitter sets the hip/knee/ankle noise, in torso lengths (default .02).
   --quick skips the hip-jitter pass (about half the run time).
   --word prints every held-out clip of one word, window by window. */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const JS = path.join(ROOT, "client/js");
const { buildModel, classify, classifyDetailed, features, windowsOf, l2 } = await import(path.join(JS, "classifier.js"));
const { JOINTS, K } = await import(path.join(JS, "constants.js"));
const { CHARGE_PROFILES } = await import(path.join(JS, "recognition.js"));
const { clipSegments, canonicalClip } = await import(path.join(JS, "poseInput.js"));

const args = process.argv.slice(2);
const flag = n => args.includes(n);
const opt = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const VALUED = ["--word", "--jitter", "--modes", "--drop"];
const deckPath = args.find((a, i) => !a.startsWith("--") && !VALUED.includes(args[i - 1]))
  || path.join(ROOT, "client/assets/data/pose-charades-data.json");
const focusWord = opt("--word");
const QUICK = flag("--quick");

const deck = JSON.parse(fs.readFileSync(deckPath, "utf8"));
if(JSON.stringify(deck.joints) !== JSON.stringify(JOINTS))
  throw new Error("deck joints do not match constants.js JOINTS");
/* --drop "a,b" tests the deck as it would be with those words removed. */
const dropped = (opt("--drop") || "").split(",").map(x => x.trim()).filter(Boolean);
for(const w of dropped) if(!deck.clips.some(c => c.label === w)) throw new Error(`--drop: no word "${w}" in the deck`);
const clips = deck.clips.filter(c => !dropped.includes(c.label));

/* The easiest gate a Solo word ever asks for (the end of the word clock). A
   window whose target score never reaches it cannot charge the meter at all. */
const GATE_LATE = CHARGE_PROFILES.solo.gateTo;
const GATE_EARLY = CHARGE_PROFILES.solo.gateFrom;

/* Hips, knees and ankles. The tracker is least sure of these, and the deck is
   hip-centred and torso-scaled, so their noise is what a live room adds. */
const JITTER_JOINTS = [23, 24, 25, 26, 27, 28].map(j => JOINTS.indexOf(j));
/* .02, not the .06 in CLAUDE.md's older notes: on the 2026-09-11 deck .06
   takes every weighting to 10-15% and the pass stops telling them apart. */
const JITTER_SD = Number(opt("--jitter") ?? 0.02);

/* WEIGHT_MIN / WEIGHT_MAX / WEIGHT_FLOOR in the environment override the
   FEATURE_WEIGHT_* constants, for a sweep. They reach the `global` row, and
   the shipped model too when FEATURE_WEIGHTING is on. */
const { FEATURE_WEIGHT_MIN, FEATURE_WEIGHT_MAX, FEATURE_WEIGHT_FLOOR } = await import(path.join(JS, "constants.js"));
const WEIGHT_LO = Number(process.env.WEIGHT_MIN ?? FEATURE_WEIGHT_MIN);
const WEIGHT_HI = Number(process.env.WEIGHT_MAX ?? FEATURE_WEIGHT_MAX);
const WEIGHT_FLOOR = Number(process.env.WEIGHT_FLOOR ?? FEATURE_WEIGHT_FLOOR);
const BUILD = { weightMin:WEIGHT_LO, weightMax:WEIGHT_HI, weightFloor:WEIGHT_FLOOR };
const MODES = (opt("--modes") || "none,global,take,hybrid,mixed").split(",");
for(const m of ["global", "none", "shipped"]) if(!MODES.includes(m)) MODES.unshift(m);
const SHIPPED = "shipped";

/* ---------- small maths ---------- */

function median(a){
  const s = Float64Array.from(a).sort(), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function rng(seed){
  let t = seed >>> 0;
  const u = () => {
    t += 0x6D2B79F5; let r = Math.imul(t ^ t >>> 15, 1 | t);
    r ^= r + Math.imul(r ^ r >>> 7, 61 | r); return ((r ^ r >>> 14) >>> 0) / 4294967296;
  };
  return () => Math.sqrt(-2 * Math.log(u() || 1e-12)) * Math.cos(2 * Math.PI * u());
}

function jitter(frames, gauss){
  return frames.map(f => f.map((p, j) =>
    JITTER_JOINTS.includes(j) ? [p[0] + gauss() * JITTER_SD, p[1] + gauss() * JITTER_SD] : p));
}

/* ---------- weights, from one training fold ---------- */

/* Per word: mean, sample spread, and one mean per take. The fold is already
   standardized, so the fold mean is zero and a word mean IS its offset. */
function wordStats(model){
  const D = model.mean.length, by = new Map();
  for(const s of model.samples){
    let w = by.get(s.label);
    if(!w){ w = { n:0, sum:new Float64Array(D), sq:new Float64Array(D), takes:new Map() }; by.set(s.label, w); }
    let t = w.takes.get(s.take);
    if(!t){ t = { n:0, sum:new Float64Array(D) }; w.takes.set(s.take, t); }
    w.n++; t.n++;
    for(let d = 0; d < D; d++){ const x = s.v[d]; w.sum[d] += x; w.sq[d] += x * x; t.sum[d] += x; }
  }
  for(const w of by.values()){
    w.mean = w.sum.map(x => x / w.n);
    w.sampleSd = w.sq.map((x, d) => Math.sqrt(Math.max(0, x / w.n - w.mean[d] ** 2)));
    w.takeMeans = [...w.takes.values()].map(t => t.sum.map(x => x / t.n));
  }
  return by;
}

function spreadOf(rows, mean){
  const D = mean.length, out = new Float64Array(D);
  for(const r of rows) for(let d = 0; d < D; d++) out[d] += (r[d] - mean[d]) ** 2;
  return out.map(x => Math.sqrt(x / rows.length));
}

function ratioWeights(between, within){
  const floor = WEIGHT_FLOOR * median(within);
  const raw = between.map((b, d) => b / (within[d] + floor + 1e-6));
  const mid = median(raw) || 1;
  return Float32Array.from(raw, x => Math.min(WEIGHT_HI, Math.max(WEIGHT_LO, x / mid)));
}

function takeWeights(w){
  const within = w.takeMeans.length >= 2 ? spreadOf(w.takeMeans, w.mean) : w.sampleSd;
  return ratioWeights(w.mean.map(Math.abs), within);
}

/* Map word -> weight vector (or null = unweighted) for a per-word mode, on
   the UNWEIGHTED model. `g` is the learned global vector. */
function weightsFor(mode, model, g){
  const stats = wordStats(model), out = new Map();
  for(const [label, w] of stats){
    const multi = w.takeMeans.length >= 2;
    if(mode === "take") out.set(label, takeWeights(w));
    else if(mode === "hybrid") out.set(label, multi ? takeWeights(w) : null);
    else if(mode === "mixed") out.set(label, multi ? takeWeights(w) : g);
  }
  return out;
}

/* A weighted metric per word, folded into each sample so a query costs the
   same as the shipped classify(): sim = z·(w²v)/(|w v| |w z|). */
function weightedModel(model, weights){
  const samples = model.samples.map(s => {
    const w = weights.get(s.label);
    if(!w) return { u:s.v.map(x => x / s.norm), label:s.label };
    const wv = s.v.map((x, d) => x * w[d]), n = l2(wv);
    return { u:wv.map((x, d) => x * w[d] / n), label:s.label };
  });
  return { samples, weights, mean:model.mean, sd:model.sd };
}

function classifyWeighted(v, wm){
  const D = v.length, z = new Float32Array(D);
  for(let d = 0; d < D; d++) z[d] = (v[d] - wm.mean[d]) / wm.sd[d];
  const qn = new Map(), plain = l2(z);
  for(const [label, w] of wm.weights){
    if(!w){ qn.set(label, plain); continue; }
    let s = 0; for(let d = 0; d < D; d++) s += (z[d] * w[d]) ** 2;
    qn.set(label, Math.sqrt(s) || 1e-9);
  }
  const sims = wm.samples.map(s => {
    let dot = 0; for(let d = 0; d < D; d++) dot += z[d] * s.u[d];
    return { sim:dot / qn.get(s.label), label:s.label };
  });
  sims.sort((a, b) => b.sim - a.sim);
  const scores = {}; let tot = 0;
  for(let i = 0; i < Math.min(K, sims.length); i++){
    const w = Math.max(sims[i].sim, 0) ** 3;
    scores[sims[i].label] = (scores[sims[i].label] || 0) + w; tot += w;
  }
  if(tot > 0) for(const k in scores) scores[k] /= tot;
  return scores;
}

/* ---------- leave one clip out ---------- */

const top = s => { let t = null; for(const k in s) if(t === null || s[k] > s[t]) t = k; return t; };
const blank = () => ({ ok:0, tot:0, reach:0, early:0, conf:0, wrong:{} });
const tally = () => ({ all:blank(), words:{} });

function score(t, label, s){
  const guess = top(s), c = s[label] || 0;
  for(const b of [t.all, t.words[label] ??= blank()]){
    b.tot++; b.conf += c;
    if(c >= GATE_LATE) b.reach++;
    if(c >= GATE_EARLY) b.early++;
    if(guess === label) b.ok++; else b.wrong[guess] = (b.wrong[guess] || 0) + 1;
  }
  return guess;
}

const results = Object.fromEntries(MODES.map(m => [m, { clean:tally(), jitter:tally() }]));
const focusRows = [];
const live = {clean:{accepted:0,right:0,rightRejected:0,wrongRejected:0},
  jitter:{accepted:0,right:0,rightRejected:0,wrongRejected:0}};
function recordLive(kind, label, v, model){
  const d=classifyDetailed(v,model,{reject:false}), b=live[kind];
  const right=d.label===label;
  if(d.accepted){b.accepted++; if(right)b.right++;}
  else if(right)b.rightRejected++; else b.wrongRejected++;
}
const gauss = rng(20260911);
const t0 = Date.now();

for(let i = 0; i < clips.length; i++){
  const held = clips[i];
  const fold = clips.filter((_, j) => j !== i);
  const plain = buildModel(fold, { weigh:false, wordWeights:{} }), shipped = buildModel(fold, BUILD);
  const global = buildModel(fold, { ...BUILD, weigh:true, wordWeights:{} });
  const wms = Object.fromEntries(MODES.filter(m => !["none", "global", SHIPPED].includes(m))
    .map(m => [m, weightedModel(plain, weightsFor(m, plain, global.weights))]));
  const cls = (m, v) => m === "none" ? classify(v, plain) : m === SHIPPED ? classify(v, shipped)
    : m === "global" ? classify(v, global) : classifyWeighted(v, wms[m]);
  const clean = windowsOf(held);
  const noisy = QUICK ? [] : windowsOf({ ...held, frames:jitter(held.frames, gauss) });
  for(const v of clean) recordLive('clean',held.label,v,shipped);
  for(const v of noisy) recordLive('jitter',held.label,v,shipped);
  for(const m of MODES){
    clean.forEach((v, wi) => {
      const s = cls(m, v), g = score(results[m].clean, held.label, s);
      if(focusWord === held.label) focusRows.push({ clip:i, wi, m, g, c:s[held.label] || 0 });
    });
    for(const v of noisy) score(results[m].jitter, held.label, cls(m, v));
  }
}

/* ---------- lookalikes: where the deck itself overlaps ---------- */

function lookalikes(){
  const model = buildModel(clips, BUILD), D = model.mean.length, cent = new Map();
  for(const s of model.samples){
    let c = cent.get(s.take);
    if(!c){ c = { label:s.label, n:0, sum:new Float64Array(D) }; cent.set(s.take, c); }
    c.n++; for(let d = 0; d < D; d++) c.sum[d] += s.v[d];
  }
  const takes = [...cent.values()].map(c => { const v = c.sum.map(x => x / c.n); return { label:c.label, v, n:l2(v) }; });
  const cos = (a, b) => { let d = 0; for(let k = 0; k < D; k++) d += a.v[k] * b.v[k]; return d / (a.n * b.n); };
  const rows = [];
  for(const label of new Set(takes.map(t => t.label))){
    const mine = takes.filter(t => t.label === label), rest = takes.filter(t => t.label !== label);
    let within = 0, pairs = 0;
    for(let a = 0; a < mine.length; a++) for(let b = a + 1; b < mine.length; b++){ within += cos(mine[a], mine[b]); pairs++; }
    /* mean against mean: the average take-to-take cosine with each other
       word, so the two numbers on a row are measured the same way */
    const other = new Map();
    for(const a of mine) for(const b of rest){
      const o = other.get(b.label) || { sum:0, n:0 }; o.sum += cos(a, b); o.n++; other.set(b.label, o);
    }
    let best = -Infinity, near = null;
    for(const [l, o] of other) if(o.sum / o.n > best){ best = o.sum / o.n; near = l; }
    rows.push({ label, within:pairs ? within / pairs : NaN, near, nearSim:best });
  }
  return rows.sort((a, b) => (b.nearSim - b.within) - (a.nearSim - a.within));
}

/* ---------- report ---------- */

const pct = (a, b) => b ? 100 * a / b : 0;
const f1 = x => x.toFixed(1).padStart(5);
const takesOf = new Map();
for(const c of clips) takesOf.set(c.label, (takesOf.get(c.label) || 0) + 1);
const words = [...takesOf.keys()].sort();
const zeroWords = t => Object.values(t.words).filter(w => w.ok === 0).length;

console.log(`deck  ${path.relative(process.cwd(), deckPath) || deckPath}` + (dropped.length ? `  (without ${dropped.join(", ")})` : ""));
console.log(`      ${clips.length} clips, ${words.length} words, ` +
  `${[...takesOf.values()].filter(n => n >= 3).length} words with 3+ takes, ` +
  `${[...takesOf.values()].filter(n => n < 2).length} with only 1 take`);
console.log(`      leave-one-clip-out, ${results.none.clean.all.tot} held-out windows, ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

console.log(`WEIGHTING           clean   jitter ${JITTER_SD.toFixed(2)}   words at 0%   reach .44   mean score`);
for(const m of MODES){
  const r = results[m];
  console.log(`  ${(m === SHIPPED ? m + " (shipped)" : m).padEnd(16)} ${f1(pct(r.clean.all.ok, r.clean.all.tot))}%   ` +
    (QUICK ? "    -    " : `${f1(pct(r.jitter.all.ok, r.jitter.all.tot))}%    `) +
    `   ${String(zeroWords(r.clean)).padStart(3)}          ${f1(pct(r.clean.all.reach, r.clean.all.tot))}%     ` +
    `${(r.clean.all.conf / r.clean.all.tot).toFixed(3)}`);
}

/* Is any other weighting better than the shipped one? Better means more
   clean accuracy without losing more than one point under hip jitter. */
const acc = (m, k) => pct(results[m][k].all.ok, results[m][k].all.tot);
const sign = x => (x >= 0 ? "+" : "") + x.toFixed(1);
let best = SHIPPED;
for(const m of MODES){
  if(acc(m, "clean") <= acc(best, "clean")) continue;
  if(!QUICK && acc(m, "jitter") < acc(SHIPPED, "jitter") - 1) continue;
  best = m;
}
console.log(`\n  shipped vs none: ${sign(acc(SHIPPED, "clean") - acc("none", "clean"))} clean` +
  (QUICK ? "" : `, ${sign(acc(SHIPPED, "jitter") - acc("none", "jitter"))} jitter`));
console.log(best === SHIPPED ? "  no other weighting beats the shipped model" :
  `  ${best} beats the shipped model: ${sign(acc(best, "clean") - acc(SHIPPED, "clean"))} clean` +
  (QUICK ? "" : `, ${sign(acc(best, "jitter") - acc(SHIPPED, "jitter"))} jitter`));

console.log("\nREJECTION  (diagnostic only: live play does not reject since 2026-09-14)");
for(const kind of QUICK ? ['clean'] : ['clean','jitter']){
  const r=live[kind];
  console.log(`  ${kind}: ${r.accepted} accepted, ${r.right} correct accepted, `+
    `${r.wrongRejected} wrong guesses rejected, ${r.rightRejected} correct guesses rejected`);
}
console.log("\nNEED LEGS  (live recognition waits for reliable knees and ankles; LEG_SHARE_MIN in constants.js)");
console.log("  " + (buildModel(clips, BUILD).legLabels.join(", ") || "none"));

/* Everything below is the game as it ships. */
const R = results[SHIPPED].clean.words;
const show = ["none", SHIPPED, ...(best === SHIPPED ? [] : [best])];
console.log(`\nPER WORD  (acc = top guess right; reach = score for the word >= ${GATE_LATE}, the easiest solo gate)`);
console.log(`  ${"word".padEnd(27)} takes  ` + show.map(m => `${m.padEnd(6)} acc  reach`).join("   ") + `   most common wrong guess (${SHIPPED})`);
const sorted = words.slice().sort((a, b) => R[a].ok / R[a].tot - R[b].ok / R[b].tot);
for(const w of sorted){
  const cols = show.map(m => {
    const r = results[m].clean.words[w];
    return `${f1(pct(r.ok, r.tot))}% ${f1(pct(r.reach, r.tot))}%`;
  }).join("   ");
  const wrong = Object.entries(R[w].wrong).sort((a, b) => b[1] - a[1])[0];
  console.log(`  ${w.padEnd(27)} ${String(takesOf.get(w)).padStart(3)}   ${cols}   ` +
    (wrong ? `${wrong[0]} (${wrong[1]}/${R[w].tot})` : ""));
}

/* A pair counts when either word loses at least 20% of its windows to the
   other. Both directions are shown: a one-way leak and a swap need different
   fixes (re-record one word, or drop one of the two). */
const CONFUSE_RATE = 0.2;
const seen = new Set(), confused = [];
for(const a of words) for(const b of words){
  if(a >= b) continue;
  const ab = (R[a].wrong[b] || 0) / R[a].tot, ba = (R[b].wrong[a] || 0) / R[b].tot;
  if(Math.max(ab, ba) >= CONFUSE_RATE) confused.push({ a, b, ab, ba });
}
confused.sort((x, y) => Math.max(y.ab, y.ba) - Math.max(x.ab, x.ba));
console.log(`\nMIGHT CONFUSE  (${SHIPPED}: a word loses ${CONFUSE_RATE * 100}%+ of its windows to the other)`);
if(!confused.length) console.log("  none");
for(const { a, b, ab, ba } of confused)
  console.log(`  ${a.padEnd(27)} <-> ${b.padEnd(27)} ${f1(ab * 100)}% -> , <- ${f1(ba * 100)}%`);

console.log("\nLOOKALIKES  (whole deck, shipped model; mean cosine between take centroids)");
console.log(`  ${"word".padEnd(27)} own takes   nearest other word               sim`);
for(const r of lookalikes().slice(0, 15)){
  const flag = r.nearSim >= r.within ? "  <- closer to another word than to itself" : "";
  console.log(`  ${r.label.padEnd(27)} ${Number.isNaN(r.within) ? "  -  " : r.within.toFixed(3)}       ${r.near.padEnd(27)} ${r.nearSim.toFixed(3)}${flag}`);
}

const weak = sorted.filter(w => R[w].ok / R[w].tot < .5 || R[w].reach / R[w].tot < .5);
console.log(`\nMIGHT NOT GET  (${SHIPPED}: under 50% accuracy or under 50% reach)`);
console.log(weak.length ? "  " + weak.join(", ") : "  none");

if(focusWord){
  console.log(`\nWORD  ${focusWord}  (clip, window: top guess / score for the word)`);
  for(const m of show){
    console.log(`  ${m}`);
    for(const r of focusRows.filter(r => r.m === m))
      console.log(`    clip ${String(r.clip).padStart(3)} w${r.wi}  ${r.g.padEnd(27)} ${r.c.toFixed(2)}`);
  }
}

if(flag('--open-set')){
  let unknown=0, rejected=0;
  for(const label of words.filter(w=>w!=='idle')){
    const model=buildModel(clips.filter(c=>c.label!==label),BUILD);
    for(const clip of clips.filter(c=>c.label===label)) for(const v of windowsOf(clip)){
      unknown++;
      if(!classifyDetailed(v,model).accepted) rejected++;
    }
  }
  let idle=0, idleWrong=0, idleUnsure=0;
  for(let i=0;i<clips.length;i++) if(clips[i].label==='idle'){
    const model=buildModel(clips.filter((_,j)=>j!==i),BUILD);
    for(const v of windowsOf(clips[i])){
      const d=classifyDetailed(v,model); idle++;
      if(!d.accepted) idleUnsure++; else if(d.label!=='idle') idleWrong++;
    }
  }
  const model=buildModel(clips,BUILD);
  let transitions=0, transitionRejected=0;
  const prepared=clips.map(c=>clipSegments(canonicalClip(c)).filter(section=>section.length>=15));
  for(let i=1;i<clips.length;i++) if(clips[i].label!==clips[i-1].label){
    const a=prepared[i-1].at(-1), b=prepared[i][0];
    if(!a || !b) continue;
    const v=features([...a.slice(-15),...b.slice(0,15)]);
    transitions++;
    if(!classifyDetailed(v,model).accepted) transitionRejected++;
  }
  console.log('\nOPEN SET DIAGNOSTICS');
  console.log(`  unseen actions (leave-one-word-out): ${rejected}/${unknown} rejected; ${unknown-rejected} still assigned a known word`);
  console.log(`  held-out idle: ${idleWrong}/${idle} false action guesses; ${idleUnsure} unsure`);
  console.log(`  synthetic action transitions: ${transitionRejected}/${transitions} rejected (diagnostic, not labeled real-camera data)`);
}
