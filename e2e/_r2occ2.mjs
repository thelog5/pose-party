/* ROUND 2 occlusion, take 2 — freeze BOTH clocks.
   The first pass paired a "with bubble" and a "no bubble" screenshot that were
   ~200ms apart in real time, so robot.js's own rAF (viseme track, joint spring,
   --talk-x) moved between them and the pair was not comparable. Here rAF is
   stubbed out after the pose has settled, so the only difference between the
   two frames is the paper.

   node _r2occ2.mjs [solo|v1|party] [outdir]   env SETTLE=ms  TIMES=csv
*/
import puppeteer from "puppeteer-core";
import { mkdir, writeFile } from "node:fs/promises";

import { passCameraGate } from "./_gate.mjs";
const APP = process.env.APP_URL || "http://localhost:8123";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const MODE = process.argv[2] || "solo";
const OUT = process.argv[3] || "./occ2";
const VW = Number(process.env.VW) || 1440, VH = Number(process.env.VH) || 810;
const sleep = ms => new Promise(r => setTimeout(r, ms));
await mkdir(OUT, { recursive: true });

const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new",
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--no-first-run"] });
const page = await browser.newPage();
await page.setViewport({ width: VW, height: VH, deviceScaleFactor: 3 });
const errs = [];
page.on("console", m => { if (m.type() === "error") errs.push(m.text()); });
page.on("pageerror", e => errs.push("PAGEERROR: " + e.message));
await page.goto(APP, { waitUntil: "networkidle2", timeout: 60000 });
await passCameraGate(page);
await page.waitForFunction(() => document.getElementById("status").style.display === "none", { timeout: 60000 });

let RIG = "spRobot";
if (MODE === "solo") {
  await page.click("#modeAI");
  await page.waitForFunction(() => !document.getElementById("howToPlay").classList.contains("hidden"), { timeout: 8000, polling: 25 });
  await page.click("#htpReady");
  await page.waitForFunction(() => document.body.dataset.state === "playing", { timeout: 20000, polling: 50 });
} else {
  RIG = MODE === "v1" ? "v1RobotYou" : "pmRobotMine";
  await page.evaluate(m => {
    const id = m === "v1" ? "scrMatch" : "scrPartyMatch";
    document.querySelectorAll("section.screen").forEach(s => s.classList.add("hidden"));
    document.getElementById(id).classList.remove("hidden");
    document.body.dataset.screen = m === "v1" ? "match" : "pmatch";
  }, MODE);
}
await sleep(1400);
await page.evaluate(async app => {
  window.__rb = await import(app + "/js/robot.js");
  window.__raf = window.requestAnimationFrame;
  window.__stopRaf = () => { window.requestAnimationFrame = () => 0; };
  window.__goRaf = () => { window.requestAnimationFrame = window.__raf; };
}, APP);

const win = await page.evaluate(id => {
  const r = document.getElementById(id).getBoundingClientRect();
  return { x: Math.max(0, Math.round(r.left - r.width * 1.0)), y: Math.max(0, Math.round(r.top - r.height * .55)),
    width: Math.round(r.width * 2.6), height: Math.round(r.height * 1.35), w: +r.width.toFixed(1), h: +r.height.toFixed(1) };
}, RIG);
const clip = { x: win.x, y: win.y, width: Math.min(win.width, VW - win.x), height: Math.min(win.height, VH - win.y) };

const TIMES = (process.env.TIMES || "60,120,200,261,400,600,900,1200,1440").split(",").map(Number);
const SETTLE = Number(process.env.SETTLE || 900);   // let the joint spring reach celebrate

for (const t of TIMES) {
  await page.evaluate(id => { window.__goRaf(); window.__rb.resetRobot(id); }, RIG);
  await sleep(450);
  await page.evaluate(id => window.__rb.robotGot(id), RIG);
  await sleep(SETTLE);                       // pose spring settles into celebrate
  await page.evaluate(() => window.__stopRaf());   // JS clock stops here
  await sleep(80);
  await page.evaluate((id, t) => {
    for (const a of document.getElementById(id).getAnimations({ subtree: true })) { a.pause(); a.currentTime = t; }
  }, RIG, t);
  const a = await page.screenshot({ clip, encoding: "base64" });
  await page.evaluate(id => { document.getElementById(id).querySelector(".rb-bubble").style.visibility = "hidden"; }, RIG);
  const b = await page.screenshot({ clip, encoding: "base64" });
  await page.evaluate(id => { document.getElementById(id).querySelector(".rb-bubble").style.visibility = ""; }, RIG);
  await writeFile(`${OUT}/${MODE}-${String(t).padStart(4, "0")}-with.png`, Buffer.from(a, "base64"));
  await writeFile(`${OUT}/${MODE}-${String(t).padStart(4, "0")}-nobubble.png`, Buffer.from(b, "base64"));
}
await writeFile(`${OUT}/${MODE}-meta.json`, JSON.stringify({ clip, win, errs }, null, 2));
console.log(JSON.stringify({ clip, win, errs }));
await browser.close();
