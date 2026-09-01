/* ROBOT QA CAPTURE HARNESS (throwaway — delete before commit).

   Drives the in-game rig through the REAL path: it seeds the classifier
   channel the way offline.test.mjs does, so the pose, the glow, the bob and
   the bubble all come from the game's own charge meter rather than from a
   back door that could disagree with it.

   Captures, per mode:
     · a still at each charge band (idle / watch / read / close)
     · a MOTION STRIP: N frames a fixed interval apart through a transition,
       tiled into one image, so a judgement about "janky" is made on real
       successive frames rather than on a single pose
     · the recognition slam and the miss beat
     · a geometry probe: paper-vs-eye clearance, and whether any part of the
       rig has left its own canvas

   Usage:  node _robotqa.mjs [solo|v1|party] [outdir]
*/
import puppeteer from "puppeteer-core";
import { mkdir, writeFile } from "node:fs/promises";

import { passCameraGate } from "./_gate.mjs";
const APP = process.env.APP_URL || "http://localhost:8123";
const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const MODE = process.argv[2] || "solo";
const OUT = process.argv[3] || "./qa-shots";
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

/* ---- into a board ---- */
let RIG = "#spRobot";
if (MODE === "solo") {
  await page.click("#modeAI");
  await page.waitForFunction(() =>
    !document.getElementById("howToPlay").classList.contains("hidden"), { timeout: 8000, polling: 25 });
  await page.click("#htpReady");
  await page.waitForFunction(() => document.body.dataset.state === "playing", { timeout: 20000, polling: 50 });
} else {
  /* 1v1 and Party need a room; this harness only reaches their STAGES, which
     is enough to judge placement and the bubble, by revealing the stage and
     feeding the rig directly. Motion still comes from robot.js's own loop. */
  RIG = MODE === "v1" ? "#v1RobotYou" : "#pmRobotMine";
  await page.evaluate(m => {
    const id = m === "v1" ? "scrMatch" : "scrPartyMatch";
    document.querySelectorAll("section.screen").forEach(s => s.classList.add("hidden"));
    document.getElementById(id).classList.remove("hidden");
    document.body.dataset.screen = m === "v1" ? "match" : "pmatch";
  }, MODE);
}
await sleep(1200);

/* ---- the real meter ---- */
await page.evaluate(async app => {
  window.__rb = await import(app + "/js/robot.js");
  window.__st = (await import(app + "/js/state.js")).state;
  try { window.__sr = await import(app + "/js/soloRound.js"); } catch { window.__sr = null; }
}, APP);

const drive = (rig, conf) => page.evaluate((rig, conf) => {
  clearInterval(window.__feed);
  const word = window.__st?.game?.word;
  window.__feed = setInterval(() => {
    if (word && window.__sr?.setModelOutput) {
      window.__sr.setModelOutput(word, conf);
      window.__st.smooth[word] = conf;
    }
    /* the rig's own public surface, in case this board has no solo loop */
    window.__rb.robotCharge(rig.slice(1), conf);
  }, 60);
}, rig, conf);

const stop = () => page.evaluate(() => clearInterval(window.__feed));

const probe = rig => page.evaluate(rig => {
  const node = document.querySelector(rig);
  const g = node.getBoundingClientRect();
  const b = node.querySelector(".rb-bubble").getBoundingClientRect();
  const pct = x => Number((((x - g.left) / g.width) * 100).toFixed(1));
  const parts = [...node.querySelectorAll(".rp")].map(el => {
    const r = el.getBoundingClientRect();
    return { j: el.dataset.j, l: pct(r.left), r: pct(r.right) };
  });
  return {
    pose: node.dataset.pose,
    hype: getComputedStyle(node).getPropertyValue("--rb-hype").trim(),
    bubbleOpacity: Number(getComputedStyle(node.querySelector(".rb-bubble")).opacity),
    bubble: { l: pct(b.left), r: pct(b.right) },
    parts,
  };
}, rig);

const shot = async (name, sel) => {
  const el = sel ? await page.$(sel) : null;
  if (el) await el.screenshot({ path: `${OUT}/${name}.png` });
  else await page.screenshot({ path: `${OUT}/${name}.png` });
};

/* ---- MOTION STRIP: successive frames, tiled by the page itself ---- */
const strip = async (name, rig, frames = 8, gap = 90) => {
  const shots = [];
  for (let i = 0; i < frames; i++) {
    const el = await page.$(rig);
    shots.push((await el.screenshot({ encoding: "base64" })));
    await sleep(gap);
  }
  const html = `<body style="margin:0;background:#0b2a10;display:flex">` +
    shots.map(s => `<img style="height:340px" src="data:image/png;base64,${s}">`).join("") +
    `</body>`;
  const p2 = await browser.newPage();
  await p2.setViewport({ width: Math.min(2400, 260 * frames), height: 360, deviceScaleFactor: 2 });
  await p2.setContent(html);
  await p2.screenshot({ path: `${OUT}/${name}.png` });
  await p2.close();
};

const log = {};

/* bands, climbing the way a real word does */
for (const [name, conf] of [["idle", 0], ["watch", .25], ["read", .6], ["close", .93]]) {
  await drive(RIG, conf);
  await sleep(900);
  await shot(`${MODE}-band-${name}`, RIG);
  log[`band-${name}`] = await probe(RIG);
}

/* the climb itself, as motion */
await drive(RIG, 0);
await sleep(700);
await drive(RIG, .95);
await strip(`${MODE}-motion-climb`, RIG, 8, 110);

/* the slam */
await page.evaluate(rig => window.__rb.robotGot(rig.slice(1)), RIG);
await strip(`${MODE}-motion-slam`, RIG, 9, 90);
log["slam"] = await probe(RIG);
await sleep(900);
await shot(`${MODE}-slam-settled`, RIG);

/* the miss */
await page.evaluate(rig => window.__rb.robotMiss(rig.slice(1), "timeout"), RIG);
await sleep(400);
await shot(`${MODE}-miss`, RIG);
log["miss"] = await probe(RIG);

/* idle life: is he doing anything at all when nothing is happening? */
await drive(RIG, 0);
await sleep(1500);
await strip(`${MODE}-motion-idle`, RIG, 10, 320);

/* the whole board, with a line up */
await page.evaluate(rig => window.__rb.robotGot(rig.slice(1)), RIG);
await sleep(300);
await shot(`${MODE}-board-slam`);
await sleep(1400);
await shot(`${MODE}-board-rest`);

await stop();
log["consoleErrors"] = errs;
await writeFile(`${OUT}/${MODE}-probe.json`, JSON.stringify(log, null, 2));
console.log(JSON.stringify(log, null, 2));
await browser.close();
