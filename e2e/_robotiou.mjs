/* QA scratch (throwaway): SILHOUETTE IoU between every pair of robot poses.

   The silhouette is composed IN THE PAGE from the live rig: every `.rp` layer
   is the full shared canvas at inset:0 with transform-origin 0 0, so reading
   its computed matrix and re-drawing the same PNG through it onto a canvas
   reproduces exactly what the browser paints — minus the eyes and mouth, which
   sit inside the head outline and cannot change a silhouette.

   Reduced motion is EMULATED on purpose: `still` zeroes the breath roll and
   the lean, both of which feed the torso and leg angles, so the measurement is
   the POSE and nothing else. Same reason `--rb-scale` never enters it — the
   .rp transforms are downstream of neither the hype scale nor the slam.

   node _robotiou.mjs [outdir]
*/
import puppeteer from "puppeteer-core";
import { mkdir, writeFile } from "node:fs/promises";

import { passCameraGate } from "./_gate.mjs";
const APP = process.env.APP_URL || "http://localhost:8123";
const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const OUT = process.argv[2] || "./qa-iou";
const sleep = ms => new Promise(r => setTimeout(r, ms));
await mkdir(OUT, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: "new",
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--no-first-run"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 810, deviceScaleFactor: 1 });
await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
const errs = [];
page.on("console", m => { if (m.type() === "error") errs.push(m.text()); });
page.on("pageerror", e => errs.push("PAGEERROR: " + e.message));
await page.goto(APP, { waitUntil: "networkidle2", timeout: 60000 });
await passCameraGate(page);
await page.waitForFunction(() => document.getElementById("status").style.display === "none", { timeout: 60000 });

/* The 1v1 RIVAL rig, on the 1v1 stage. Not Solo: Solo runs its own robotCharge off the real meter
   every frame, so a second feed here just loses the race and every band
   captured the same body. This stage has no competing loop, and the rig, the
   art and the joint driver are identical. */
await page.evaluate(() => {
  document.querySelectorAll("section.screen").forEach(s => s.classList.add("hidden"));
  document.getElementById("scrMatch").classList.remove("hidden");
  document.body.dataset.screen = "match";
});
await sleep(1200);

await page.evaluate(async app => {
  window.__rb = await import(app + "/js/robot.js");
  /* compose one silhouette from the live layer transforms */
  /* S is the rig canvas; N is a PADDED frame around it, because an arm thrown
     up in a celebration is allowed to leave the square (overflow:visible in
     screens.css) and clipping it would flatter every loud pose. */
  const S = 512, PAD = 128, N = S + PAD * 2;
  const BODY = ["legR", "legL", "uarmR", "uarmL", "handR", "handL",
    "farmR", "farmL", "torso", "head"];
  window.__silhouette = async (withFace) => {
    const node = document.getElementById("v1RobotRival");
    const canvas = node.querySelector(".rb-canvas");
    /* LAYOUT width, never getBoundingClientRect: `.grobot` carries
       `scale:var(--rb-scale)` from the meter, so its rect is up to 1.1x the
       box the .rp percentage translates actually resolve against — while the
       matrix read out of getComputedStyle is in that unscaled local space.
       Mixing them shrank every translation by 1/scale, and since the scale
       tracks the hype it did so by a DIFFERENT amount per band. */
    const s = S / parseFloat(getComputedStyle(canvas).width);
    const c = document.createElement("canvas");
    c.width = c.height = N;
    const ctx = c.getContext("2d");
    const layers = BODY.map(j => node.querySelector('.rp[data-j="' + j + '"]'))
      .filter(Boolean);
    /* the face rides the head chain and never changes the outline, so it is
       out of the silhouette — but a full-colour pass with it on is what a
       gameplay-size look at the pose is actually judged from */
    if (withFace) layers.push(...node.querySelectorAll(".rb-eye-l,.rb-eye-r,.rb-mouth"));
    for (const el of layers) {
      const m = new DOMMatrix(getComputedStyle(el).transform);
      const img = new Image();
      img.src = el.src;
      if (!img.complete) await img.decode().catch(() => {});
      ctx.setTransform(m.a, m.b, m.c, m.d, m.e * s + PAD, m.f * s + PAD);
      ctx.drawImage(img, 0, 0, S, S);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const d = ctx.getImageData(0, 0, N, N).data;
    const bits = new Uint8Array(N * N);
    for (let i = 0, p = 3; i < N * N; i++, p += 4) bits[i] = d[p] > 12 ? 1 : 0;
    return { n: N, bits: Array.from(bits), png: c.toDataURL("image/png") };
  };
}, APP);

const grab = () => page.evaluate(async () => {
  const s = await window.__silhouette(false);
  const full = (await window.__silhouette(true)).png;
  return { pose: document.getElementById("v1RobotRival").dataset.pose, ...s, full };
});

const charge = v => page.evaluate(v => {
  clearInterval(window.__feed);
  window.__feed = setInterval(() => window.__rb.robotCharge("v1RobotRival", v), 50);
}, v);

const poses = {};
const capture = async (key, expect) => {
  const s = await grab();
  poses[key] = s;
  if (expect && s.pose !== expect) console.error(`!! ${key}: expected ${expect}, got ${s.pose}`);
};

/* ---- the four band poses ---- */
for (const [key, v, expect] of [
  ["idle", 0, "idle"], ["watch", .25, "thinking"],
  ["read", .6, "present"], ["close", .93, "surprised"]]) {
  await charge(v);
  await sleep(950);
  await capture(key, expect);
}

/* ---- got / proud ---- */
await page.evaluate(() => window.__rb.robotGot("v1RobotRival"));
await sleep(950);
await capture("got", "celebrate");
await sleep(750);
await capture("proud", "thumbsup");

/* ---- shrug / sad ---- */
await page.evaluate(() => window.__rb.robotMiss("v1RobotRival", "skip"));
await sleep(950);
await capture("lost", "shrug");
await sleep(600);
await page.evaluate(() => window.__rb.robotMiss("v1RobotRival", "timeout"));
await sleep(950);
await capture("down", "sad");

/* ---- peek: only the idle beat loop reaches it ---- */
await sleep(1400);
await charge(0);
let ok = false;
for (let i = 0; i < 700; i++) {
  const p = await page.evaluate(() => document.getElementById("v1RobotRival").dataset.pose);
  if (p === "peek") { await sleep(600); await capture("peek", "peek"); ok = true; break; }
  await sleep(110);
}
if (!ok) console.error("!! peek never reached");

await page.evaluate(() => clearInterval(window.__feed));

/* ---- IoU + shape probes ---- */
const keys = Object.keys(poses);
const N = poses[keys[0]].n;
const iou = {};
for (let i = 0; i < keys.length; i++) {
  for (let j = i + 1; j < keys.length; j++) {
    const a = poses[keys[i]].bits, b = poses[keys[j]].bits;
    let inter = 0, uni = 0;
    for (let k = 0; k < a.length; k++) { const x = a[k], y = b[k]; if (x & y) inter++; if (x | y) uni++; }
    iou[keys[i] + " vs " + keys[j]] = uni ? inter / uni : 1;
  }
}

/* horizontal ink runs at a few heights + foot separation, the F4 probe */
const shape = {};
for (const k of keys) {
  const bits = poses[k].bits;
  const rows = {};
  /* ink extent, so heights are fractions of HIS ink not of the canvas */
  let y0 = N, y1 = 0, x0 = N, x1 = 0;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (bits[y * N + x]) {
    if (y < y0) y0 = y; if (y > y1) y1 = y;
    if (x < x0) x0 = x; if (x > x1) x1 = x;
  }
  const H = y1 - y0, W = x1 - x0;
  for (const f of [.55, .65, .70, .75, .80, .95]) {
    const y = Math.round(y0 + H * f);
    const runs = [];
    let start = -1;
    for (let x = 0; x <= N; x++) {
      const v = x < N && bits[y * N + x];
      if (v && start < 0) start = x;
      if (!v && start >= 0) { runs.push([start, x - 1]); start = -1; }
    }
    /* gaps BETWEEN runs only — a leading margin is not a gap in the body */
    const gaps = runs.slice(1).map((r, i) => r[0] - runs[i][1]);
    rows[f] = {
      runs: runs.length,
      spanPct: Number(((runs.length ? runs[runs.length - 1][1] - runs[0][0] : 0) / W * 100).toFixed(1)),
      gapsPct: gaps.map(g => Number((g / W * 100).toFixed(1))),
    };
  }
  shape[k] = { aspectPct: Number((W / H * 100).toFixed(1)), rows };
}

const report = { iou, shape, errs };
await writeFile(`${OUT}/iou.json`, JSON.stringify(report, null, 2));
for (const k of keys) {
  await writeFile(`${OUT}/sil-${k}.png`,
    Buffer.from(poses[k].png.split(",")[1], "base64"));
  await writeFile(`${OUT}/full-${k}.png`,
    Buffer.from(poses[k].full.split(",")[1], "base64"));
}

const order = keys;
let table = "      " + order.map(k => k.padStart(7)).join("") + "\n";
for (const a of order) {
  table += a.padEnd(6);
  for (const b of order) {
    const v = a === b ? 1 : (iou[a + " vs " + b] ?? iou[b + " vs " + a]);
    table += (v === undefined ? "" : v.toFixed(3)).padStart(7);
  }
  table += "\n";
}
console.log(table);
console.log(JSON.stringify(shape, null, 2));
if (errs.length) console.log("ERRORS", errs);
await browser.close();
