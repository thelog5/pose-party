/* ROUND 2 — does the speech paper occlude his FACE INK, in pixels?
   Method (no element rects anywhere): freeze the slam through the WAAPI
   timeline at t, screenshot the head twice — once as shipped, once with the
   bubble PNG+text forced invisible — and diff. Any face ink (yellow) present
   in the no-bubble frame and absent in the shipped frame is occlusion, and it
   is measured in real composited pixels.

   node _r2occlude.mjs [solo|v1|party] [outdir]
*/
import puppeteer from "puppeteer-core";
import { mkdir, writeFile } from "node:fs/promises";

import { passCameraGate } from "./_gate.mjs";
const APP = process.env.APP_URL || "http://localhost:8123";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const MODE = process.argv[2] || "solo";
const OUT = process.argv[3] || "./occ";
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
await page.evaluate(async app => { window.__rb = await import(app + "/js/robot.js"); }, APP);

/* a generous window around the rig, in CSS px, so the clip is a FIXED viewport
   rect and the slam is free to overflow it */
const win = await page.evaluate(id => {
  const r = document.getElementById(id).getBoundingClientRect();
  return { x: Math.max(0, Math.round(r.left - r.width * .9)), y: Math.max(0, Math.round(r.top - r.height * .5)),
    width: Math.round(r.width * 2.9), height: Math.round(r.height * 1.7), w: r.width, h: r.height, l: r.left, t: r.top };
}, RIG);
const clip = { x: win.x, y: win.y, width: Math.min(win.width, VW - win.x), height: Math.min(win.height, VH - win.y) };

const hideBubble = on => page.evaluate((id, on) => {
  const b = document.getElementById(id).querySelector(".rb-bubble");
  b.style.visibility = on ? "hidden" : "";
}, RIG, on);

const freeze = t => page.evaluate((id, t) => {
  for (const a of document.getElementById(id).getAnimations({ subtree: true })) { a.pause(); a.currentTime = t; }
}, RIG, t);

const TIMES = (process.env.TIMES || "0,35,52,68,85,120,200,261,400,700,1000,1440").split(",").map(Number);
const rows = [];
for (const t of TIMES) {
  await page.evaluate(id => window.__rb.resetRobot(id), RIG);
  await sleep(420);
  await page.evaluate(id => window.__rb.robotGot(id), RIG);
  await sleep(30);
  await freeze(t);
  await hideBubble(false);
  const withB = await page.screenshot({ clip, encoding: "base64" });
  await hideBubble(true);
  const noB = await page.screenshot({ clip, encoding: "base64" });
  await hideBubble(false);
  await writeFile(`${OUT}/${MODE}-${String(t).padStart(4, "0")}-with.png`, Buffer.from(withB, "base64"));
  await writeFile(`${OUT}/${MODE}-${String(t).padStart(4, "0")}-nobubble.png`, Buffer.from(noB, "base64"));
  rows.push(t);
}
await writeFile(`${OUT}/${MODE}-meta.json`, JSON.stringify({ clip, win, times: rows, errs }, null, 2));
console.log(JSON.stringify({ clip, win, errs }));
await browser.close();
