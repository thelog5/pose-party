/* QA scratch: where does the speech TAIL actually point, per pose, per mode?
   The paper is mirrored for data-side="left", so the tail's x fraction has to
   be mirrored with it — measuring the unmirrored corner is how you conclude
   the tail is 60% of his width off his face when it is not.
   Also measures blink and breath as timeseries. */
import puppeteer from "puppeteer-core";
import { mkdir, writeFile } from "node:fs/promises";
import { passCameraGate } from "./_gate.mjs";
const APP = process.env.APP_URL || "http://localhost:8123";
const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const MODE = process.argv[2] || "solo";
const OUT = process.argv[3] || "./qa-tail";
const VW = Number(process.env.VW) || 1440, VH = Number(process.env.VH) || 810;
const sleep = ms => new Promise(r => setTimeout(r, ms));
await mkdir(OUT, { recursive: true });
const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new",
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--no-first-run"] });
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
  await page.waitForFunction(() => !document.getElementById("howToPlay").classList.contains("hidden"), { timeout: 8000, polling: 25 });
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

const res = await page.evaluate((rig, mode) => new Promise(done => {
  const g = document.querySelector(rig);
  const b = g.querySelector(".rb-bubble");
  const mo = g.querySelector(".rb-mouth");
  const eL = g.querySelector(".rb-eye-l");
  const side = g.dataset.side;
  /* measured tail tip on the 1356x880 paper: x=20.50%, y=96.59% (CSS comment).
     data-side="left" mirrors the IMG, so the tip is at 1-.2050 = 79.50%. */
  const tipX = side === "left" ? 1 - .2050 : .2050, tipY = .9659;
  const MOUTH = { x0: 289 / 640, x1: 345 / 640, y0: 228 / 640, y1: 290 / 640 };
  const EYE = { x0: 241 / 640, x1: 294 / 640, y0: 183 / 640, y1: 235 / 640 };
  const pt = (e, fx, fy) => { const r = e.getBoundingClientRect();
    return { x: r.left + r.width * fx, y: r.top + r.height * fy }; };
  const ctr = (e, f) => pt(e, (f.x0 + f.x1) / 2, (f.y0 + f.y1) / 2);
  const snap = () => {
    const G = g.getBoundingClientRect();
    const T = pt(b, tipX, tipY), M = ctr(mo, MOUTH), E = ctr(eL, EYE);
    return {
      pose: g.dataset.pose, side, gw: Math.round(G.width), gh: Math.round(G.height),
      tail: [+(((T.x - G.left) / G.width) * 100).toFixed(2), +(((T.y - G.top) / G.height) * 100).toFixed(2)],
      mouth: [+(((M.x - G.left) / G.width) * 100).toFixed(2), +(((M.y - G.top) / G.height) * 100).toFixed(2)],
      dxPx: Math.round(T.x - M.x), dyPx: Math.round(T.y - M.y),
      eyeCtrPct: [+(((E.x - G.left) / G.width) * 100).toFixed(2), +(((E.y - G.top) / G.height) * 100).toFixed(2)],
      talkX: getComputedStyle(b).getPropertyValue("--talk-x").trim(),
      talkY: getComputedStyle(b).getPropertyValue("--talk-y").trim(),
      bubbleOp: +Number(getComputedStyle(b).opacity).toFixed(2),
    };
  };
  const out = { tails: [], blink: [], breath: [] };
  const word = window.__st?.game?.word;
  const drive = c => { clearInterval(window.__feed);
    window.__feed = setInterval(() => {
      if (word && window.__sr?.setModelOutput) { window.__sr.setModelOutput(word, c); window.__st.smooth[word] = c; }
      window.__rb.robotCharge(rig.slice(1), c);
    }, 60); };
  drive(0);
  /* 6 seconds of idle, sampled every frame: blink art, breath shift, tail */
  const t0 = performance.now();
  function step(now) {
    const t = now - t0;
    out.blink.push({ t: Math.round(t), eye: eL.getAttribute("src").split("/").pop(),
      mouth: mo.getAttribute("src").split("/").pop(),
      sy: g.style.getPropertyValue("--rb-shift-y"), sx: g.style.getPropertyValue("--rb-shift-x"),
      pose: g.dataset.pose });
    if (t < 9000) requestAnimationFrame(step);
    else {
      /* now a line, and the tail with it, in three poses */
      const seq = [[0, "idle"], [.25, "thinking"], [.6, "present"], [.93, "surprised"]];
      let i = 0;
      const nx = () => {
        if (i >= seq.length) { done(out); return; }
        const [c] = seq[i++]; drive(c);
        setTimeout(() => { out.tails.push(snap()); nx(); }, 1400);
      };
      nx();
    }
  }
  requestAnimationFrame(step);
}), RIG, MODE);

/* condense the blink/breath timeseries */
const b = res.blink;
const blinks = [];
for (let i = 1; i < b.length; i++)
  if (b[i].eye !== b[i - 1].eye) blinks.push({ t: b[i].t, from: b[i - 1].eye, to: b[i].eye });
const sy = b.map(s => parseFloat(s.sy) || 0);
const ds = [];
for (let i = 1; i < sy.length; i++) ds.push(Math.abs(sy[i] - sy[i - 1]));
const summary = {
  tails: res.tails,
  blinkEvents: blinks,
  breath: { min: Math.min(...sy).toFixed(3), max: Math.max(...sy).toFixed(3),
    maxStepPct: Math.max(...ds).toFixed(3), meanStepPct: (ds.reduce((a, c) => a + c, 0) / ds.length).toFixed(4),
    frames: sy.length },
  poseChanges: b.filter((s, i) => i && s.pose !== b[i - 1].pose).map(s => ({ t: s.t, pose: s.pose })),
  errs,
};
await writeFile(`${OUT}/${MODE}-tail.json`, JSON.stringify({ summary, raw: res }, null, 2));
console.log(JSON.stringify(summary, null, 2));
await browser.close();
