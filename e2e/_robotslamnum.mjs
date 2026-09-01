/* QA scratch: the slam measured IN PAGE, one sample per animation frame.
   No screenshots in the loop, so the numbers are the real timeline.
   node _robotslamnum.mjs [solo|v1|party] outdir */
import puppeteer from "puppeteer-core";
import { mkdir, writeFile } from "node:fs/promises";

import { passCameraGate } from "./_gate.mjs";
const APP = process.env.APP_URL || "http://localhost:8123";
const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const MODE = process.argv[2] || "solo";
const OUT = process.argv[3] || "./qa-slamnum";
const VW = Number(process.env.VW) || 1440;
const VH = Number(process.env.VH) || 810;
const sleep = ms => new Promise(r => setTimeout(r, ms));
await mkdir(OUT, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: "new",
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--no-first-run"],
});
const page = await browser.newPage();
await page.setViewport({ width: VW, height: VH, deviceScaleFactor: 1 });
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
await page.evaluate((rig) => {
  const word = window.__st?.game?.word;
  window.__feed = setInterval(() => {
    if (word && window.__sr?.setModelOutput) {
      window.__sr.setModelOutput(word, .93);
      window.__st.smooth[word] = .93;
    }
    window.__rb.robotCharge(rig.slice(1), .93);
  }, 60);
}, RIG);
await sleep(1400);

const out = await page.evaluate(rig => new Promise(res => {
  const g = document.querySelector(rig);
  const b = g.querySelector(".rb-bubble");
  const eL = g.querySelector(".rb-eye-l"), eR = g.querySelector(".rb-eye-r");
  const mo = g.querySelector(".rb-mouth");
  /* ink boxes on the shared 640 canvas / the 1356x880 paper */
  const EYE = { x0: 241 / 640, x1: 294 / 640, y0: 183 / 640, y1: 235 / 640 };
  const PAPER = { x0: 20 / 1356, x1: 1318 / 1356, y0: 18 / 880, y1: 704 / 880 };  // balloon body, no tail
  const TAIL = { x0: 250 / 1356, x1: 440 / 1356, y0: 704 / 880, y1: 853 / 880 };
  const sub = (e, f) => { const r = e.getBoundingClientRect();
    return { l: r.l ?? r.left + r.width * f.x0, r: 0 }; };
  const box = (e, f) => { const r = e.getBoundingClientRect(); return {
    l: r.left + r.width * f.x0, r: r.left + r.width * f.x1,
    t: r.top + r.height * f.y0, b: r.top + r.height * f.y1 }; };
  const inter = (a, c) => Math.max(0, Math.min(a.r, c.r) - Math.max(a.l, c.l)) *
                          Math.max(0, Math.min(a.b, c.b) - Math.max(a.t, c.t));
  const samples = [];
  const t0 = performance.now();
  window.__rb.robotGot(rig.slice(1));
  const gr = () => g.getBoundingClientRect();
  function step(now) {
    const t = now - t0;
    const cs = getComputedStyle(b);
    const B = box(b, PAPER), T = box(b, TAIL);
    const E = box(eL, EYE), Er = box(eR, EYE);
    const G = gr();
    const rigCS = getComputedStyle(g.querySelector(".rb-rig"));
    samples.push({
      t: Math.round(t),
      pose: g.dataset.pose,
      gap: cs.getPropertyValue("--talk-gap-x").trim(),
      talkX: cs.getPropertyValue("--talk-x").trim(),
      talkY: cs.getPropertyValue("--talk-y").trim(),
      op: +Number(cs.opacity).toFixed(3),
      rigT: rigCS.transform,
      /* how far the opaque balloon overlaps the eye ink, in % of his own width */
      eyeOv: +(((inter(E, B) + inter(Er, B)) / (G.width * G.height)) * 100).toFixed(3),
      paperR_pctOfHim: +(((B.r - G.left) / G.width) * 100).toFixed(2),
      eyeL_pctOfHim: +(((E.l - G.left) / G.width) * 100).toFixed(2),
      paperB_pctOfHim: +(((B.b - G.top) / G.height) * 100).toFixed(2),
      eyeT_pctOfHim: +(((E.t - G.top) / G.height) * 100).toFixed(2),
      /* the tail tip vs his mouth ink centre */
      tailTipX: +(((T.l + (T.r - T.l) * .1 - G.left) / G.width) * 100).toFixed(2),
      tailTipY: +(((T.b - G.top) / G.height) * 100).toFixed(2),
      mouthCx: +(((box(mo, { x0: 289 / 640, x1: 345 / 640, y0: 228 / 640, y1: 290 / 640 }).l +
                   box(mo, { x0: 289 / 640, x1: 345 / 640, y0: 228 / 640, y1: 290 / 640 }).r) / 2 - G.left) / G.width * 100).toFixed(2),
      mouthCy: +(((box(mo, { x0: 289 / 640, x1: 345 / 640, y0: 228 / 640, y1: 290 / 640 }).t +
                   box(mo, { x0: 289 / 640, x1: 345 / 640, y0: 228 / 640, y1: 290 / 640 }).b) / 2 - G.top) / G.height * 100).toFixed(2),
    });
    if (t < 1800) requestAnimationFrame(step);
    else res(samples);
  }
  requestAnimationFrame(step);
}), RIG);

await writeFile(`${OUT}/${MODE}-slamnum.json`, JSON.stringify({ out, errs }, null, 2));
const keep = out.filter((s, i) => i % 2 === 0 || s.t < 320);
console.log(keep.map(s => `t=${String(s.t).padStart(4)} ${s.pose.padEnd(10)} gap=${s.gap.padEnd(9)} op=${String(s.op).padEnd(5)} eyeOv=${String(s.eyeOv).padEnd(6)} paperR=${String(s.paperR_pctOfHim).padEnd(6)} eyeL=${String(s.eyeL_pctOfHim).padEnd(6)} paperB=${String(s.paperB_pctOfHim).padEnd(6)} eyeT=${String(s.eyeT_pctOfHim).padEnd(6)} tail=(${s.tailTipX},${s.tailTipY}) mouth=(${s.mouthCx},${s.mouthCy})`).join("\n"));
console.log("errs", errs);
await browser.close();
