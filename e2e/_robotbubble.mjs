/* QA scratch: the speech paper, hard.
   Captures the SAME slam twice at the same timestamps — once with the bubble
   visible, once with it hidden — into a fixed viewport clip, so a python diff
   can say exactly which of his pixels the paper ate and when.
   node _robotbubble.mjs [solo|v1|party] outdir */
import puppeteer from "puppeteer-core";
import { mkdir, writeFile } from "node:fs/promises";

import { passCameraGate } from "./_gate.mjs";
const APP = process.env.APP_URL || "http://localhost:8123";
const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const MODE = process.argv[2] || "solo";
const OUT = process.argv[3] || "./qa-bubble";
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

/* ONE fixed clip for the whole study, so frames are directly comparable */
const box = await page.evaluate(rig => {
  const r = document.querySelector(rig).getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
}, RIG);
const CLIP = {
  x: Math.max(0, Math.round(box.x - box.w * 1.0)),
  y: Math.max(0, Math.round(box.y - box.h * .70)),
};
CLIP.width = Math.min(Math.round(box.w * 3.0), VW - CLIP.x);
CLIP.height = Math.min(Math.round(box.h * 1.6), VH - CLIP.y);

const geom = () => page.evaluate(rig => {
  const g = document.querySelector(rig);
  const b = g.querySelector(".rb-bubble");
  const eL = g.querySelector(".rb-eye-l"), eR = g.querySelector(".rb-eye-r");
  const R = e => { const r = e.getBoundingClientRect(); return { l: r.left, t: r.top, w: r.width, h: r.height }; };
  const cs = getComputedStyle(b);
  /* ink fractions on the shared 640 canvas / on the 1356x880 paper */
  const eye = { x0: 241 / 640, x1: 294 / 640, y0: 183 / 640, y1: 235 / 640 };
  const paper = { x0: 20 / 1356, x1: 1318 / 1356, y0: 18 / 880, y1: 704 / 880 };  // balloon body only
  const sub = (r, f) => ({ l: r.l + r.w * f.x0, r: r.l + r.w * f.x1, t: r.t + r.h * f.y0, b: r.t + r.h * f.y1 });
  const E = sub(R(eL), eye), Er = sub(R(eR), eye), B = sub(R(b), paper);
  const ov = a => Math.max(0, Math.min(a.r, B.r) - Math.max(a.l, B.l)) *
                  Math.max(0, Math.min(a.b, B.b) - Math.max(a.t, B.t));
  return {
    pose: g.dataset.pose,
    op: Number(cs.opacity).toFixed(2),
    gap: cs.getPropertyValue("--talk-gap-x").trim(),
    talkX: cs.getPropertyValue("--talk-x").trim(),
    talkY: cs.getPropertyValue("--talk-y").trim(),
    eyeOverlapPx2: Math.round(ov(E) + ov(Er)),
    bubbleRight: Math.round(B.r), eyeLeft: Math.round(E.l), eyeTop: Math.round(E.t),
    balloonBottom: Math.round(B.b),
  };
}, RIG);

const N = Number(process.env.N) || 26;
const GAP = Number(process.env.GAP) || 60;

async function runSlam(tag, hideBubble) {
  await feed(.93);
  await sleep(900);
  await page.evaluate((rig, hide) => {
    document.querySelector(rig + " .rb-bubble").style.visibility = hide ? "hidden" : "";
    window.__rb.robotNewWord(rig.slice(1));
  }, RIG, hideBubble);
  await sleep(500);
  await feed(.93);
  await sleep(500);
  const t0 = Date.now();
  await page.evaluate(rig => window.__rb.robotGot(rig.slice(1)), RIG);
  const g = [];
  for (let i = 0; i < N; i++) {
    await page.screenshot({ path: `${OUT}/${MODE}-${tag}-${String(i).padStart(2, "0")}.png`, clip: CLIP });
    g.push({ i, t: Date.now() - t0, ...(await geom()) });
    const target = t0 + (i + 1) * GAP;
    const w = target - Date.now();
    if (w > 0) await sleep(w);
  }
  return g;
}

const withB = await runSlam("slamB", false);
await sleep(2500);
const noB = await runSlam("slamN", true);

/* resting line, and the two other bands, with the paper up */
await page.evaluate(rig => {
  document.querySelector(rig + " .rb-bubble").style.visibility = "";
}, RIG);
await feed(0);
await sleep(900);
await feed(.6);        // crossing into `read` makes him say a line
await sleep(400);
await page.screenshot({ path: `${OUT}/${MODE}-rest-line-a.png`, clip: CLIP });
await sleep(500);
await page.screenshot({ path: `${OUT}/${MODE}-rest-line-b.png`, clip: CLIP });
const restGeom = await geom();
await feed(0); await sleep(800);
await feed(.93); await sleep(500);
await page.screenshot({ path: `${OUT}/${MODE}-close-line.png`, clip: CLIP });
const closeGeom = await geom();
/* the whole board while a line is up */
await page.screenshot({ path: `${OUT}/${MODE}-board-line.png` });

await writeFile(`${OUT}/${MODE}-bubble.json`,
  JSON.stringify({ clip: CLIP, withB, noB, restGeom, closeGeom, errs }, null, 2));
console.log(JSON.stringify({ withBubble: withB, restGeom, closeGeom, errs }, null, 2));
await browser.close();
