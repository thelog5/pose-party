/* QA scratch: the slam, frame-exact.
   page.screenshot costs ~150ms, so a real-time strip cannot resolve a 1.45s
   beat. This PAUSES every animation on the rig and steps currentTime by hand
   (including the --talk-gap-x CSSTransition), so each frame is the true state
   at that millisecond.
   node _robotslam.mjs [solo|v1|party] outdir */
import puppeteer from "puppeteer-core";
import { mkdir, writeFile } from "node:fs/promises";

import { passCameraGate } from "./_gate.mjs";
const APP = process.env.APP_URL || "http://localhost:8123";
const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const MODE = process.argv[2] || "solo";
const OUT = process.argv[3] || "./qa-slam";
const VW = Number(process.env.VW) || 1440;
const VH = Number(process.env.VH) || 810;
const sleep = ms => new Promise(r => setTimeout(r, ms));
await mkdir(OUT, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: "new",
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--no-first-run"],
});
const page = await browser.newPage();
await page.setViewport({ width: VW, height: VH, deviceScaleFactor: 2 });
const errs = [];
page.on("console", m => { if (m.type() === "error") errs.push(m.text()); });
page.on("pageerror", e => errs.push("PAGEERROR: " + e.message));
await page.goto(APP, { waitUntil: "networkidle2", timeout: 60000 });
await passCameraGate(page);
await page.waitForFunction(() => document.getElementById("status").style.display === "none", { timeout: 60000 });

let RIG = "#spRobot";
if (MODE === "solo") {
  await page.click("#modeAI");
  await page.waitForFunction(() =>
    !document.getElementById("howToPlay").classList.contains("hidden"), { timeout: 8000, polling: 25 });
  await page.click("#htpReady");
  await page.waitForFunction(() => document.body.dataset.state === "playing", { timeout: 20000, polling: 50 });
} else {
  RIG = MODE === "v1" ? "#v1RobotYou" : "#pmRobotMine";
  await page.evaluate(m => {
    const id = m === "v1" ? "scrMatch" : "scrPartyMatch";
    document.querySelectorAll("section.screen").forEach(s => s.classList.add("hidden"));
    document.getElementById(id).classList.remove("hidden");
    document.body.dataset.screen = m === "v1" ? "match" : "pmatch";
  }, MODE);
}
await sleep(1500);
await page.evaluate(async app => {
  window.__rb = await import(app + "/js/robot.js");
  window.__st = (await import(app + "/js/state.js")).state;
  try { window.__sr = await import(app + "/js/soloRound.js"); } catch { window.__sr = null; }
}, APP);
const feed = conf => page.evaluate((rig, conf) => {
  clearInterval(window.__feed);
  const word = window.__st?.game?.word;
  window.__feed = setInterval(() => {
    if (word && window.__sr?.setModelOutput) {
      window.__sr.setModelOutput(word, conf);
      window.__st.smooth[word] = conf;
    }
    window.__rb.robotCharge(rig.slice(1), conf);
  }, 60);
}, RIG, conf);

await feed(.93);
await sleep(1400);

/* tight clip: his head + the whole balloon */
const CLIP = await page.evaluate(rig => {
  const r = document.querySelector(rig).getBoundingClientRect();
  return {
    x: Math.max(0, Math.round(r.left - r.width * 1.35)),
    y: Math.max(0, Math.round(r.top - r.height * .55)),
    width: Math.round(r.width * 2.9), height: Math.round(r.height * 1.25),
  };
}, RIG);
CLIP.width = Math.min(CLIP.width, VW - CLIP.x);
CLIP.height = Math.min(CLIP.height, VH - CLIP.y);

await page.evaluate(rig => {
  window.__rb.robotGot(rig.slice(1));
  const g = document.querySelector(rig);
  window.__anims = [g, ...g.querySelectorAll("*")].flatMap(e => e.getAnimations({ subtree: false }));
  /* pseudo-element animations too (the glow) */
  window.__anims.forEach(a => { a.pause(); });
}, RIG);

const seek = t => page.evaluate(t => {
  window.__anims.forEach(a => { try { a.currentTime = t; } catch {} });
  return window.__anims.map(a => a.animationName || a.transitionProperty || "?");
}, t);

const geom = () => page.evaluate(rig => {
  const g = document.querySelector(rig);
  const b = g.querySelector(".rb-bubble");
  const R = e => { const r = e.getBoundingClientRect(); return { l: r.left, t: r.top, w: r.width, h: r.height }; };
  const eye = { x0: 241 / 640, x1: 294 / 640, y0: 183 / 640, y1: 235 / 640 };
  const paper = { x0: 20 / 1356, x1: 1318 / 1356, y0: 18 / 880, y1: 704 / 880 };
  const sub = (r, f) => ({ l: r.l + r.w * f.x0, r: r.l + r.w * f.x1, t: r.t + r.h * f.y0, b: r.t + r.h * f.y1 });
  const E = sub(R(g.querySelector(".rb-eye-l")), eye);
  const Er = sub(R(g.querySelector(".rb-eye-r")), eye);
  const B = sub(R(b), paper);
  const ov = a => Math.max(0, Math.min(a.r, B.r) - Math.max(a.l, B.l)) *
                  Math.max(0, Math.min(a.b, B.b) - Math.max(a.t, B.t));
  const cs = getComputedStyle(b);
  return { gap: cs.getPropertyValue("--talk-gap-x").trim(), op: +Number(cs.opacity).toFixed(2),
    overlap: Math.round(ov(E) + ov(Er)), paperRight: Math.round(B.r), paperBottom: Math.round(B.b),
    eyeL: Math.round(E.l), eyeT: Math.round(E.t), eyeB: Math.round(E.b) };
}, RIG);

const names = await seek(0);
const log = { names, frames: [] };
const TS = [];
for (let t = 0; t <= 1450; t += 50) TS.push(t);
for (const t of TS) {
  await seek(t);
  await page.screenshot({ path: `${OUT}/${MODE}-t${String(t).padStart(4, "0")}.png`, clip: CLIP });
  log.frames.push({ t, ...(await geom()) });
}
log.errs = errs;
await writeFile(`${OUT}/${MODE}-slam.json`, JSON.stringify(log, null, 2));
console.log(JSON.stringify(log.names));
console.log(log.frames.map(f => `t=${f.t} gap=${f.gap} op=${f.op} overlap=${f.overlap} paperR=${f.paperRight} eyeL=${f.eyeL} paperB=${f.paperBottom} eyeT=${f.eyeT}`).join("\n"));
await browser.close();
