/* ROUND 2 — the nine poses at TRUE GAMEPLAY SIZE, on the real Solo board.
   deviceScaleFactor 1, screenshotted as a fixed viewport clip around the rig
   (never an element crop, which lies once --rb-scale or the slam is running).
   Also dumps the four eye states, seven mouth shapes and a blink frame.

   node _r2poses.mjs [outdir]
*/
import puppeteer from "puppeteer-core";
import { mkdir, writeFile } from "node:fs/promises";

import { passCameraGate } from "./_gate.mjs";
const APP = process.env.APP_URL || "http://localhost:8123";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const OUT = process.argv[2] || "./r2poses";
const VW = Number(process.env.VW) || 1440, VH = Number(process.env.VH) || 810;
const DSF = Number(process.env.DSF) || 1;
const sleep = ms => new Promise(r => setTimeout(r, ms));
await mkdir(OUT, { recursive: true });

const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new",
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--no-first-run"] });
const page = await browser.newPage();
await page.setViewport({ width: VW, height: VH, deviceScaleFactor: DSF });
const errs = [];
page.on("console", m => { if (m.type() === "error") errs.push(m.text()); });
page.on("pageerror", e => errs.push("PAGEERROR: " + e.message));
await page.goto(APP, { waitUntil: "networkidle2", timeout: 60000 });
await passCameraGate(page);
await page.waitForFunction(() => document.getElementById("status").style.display === "none", { timeout: 60000 });
await page.click("#modeAI");
await page.waitForFunction(() => !document.getElementById("howToPlay").classList.contains("hidden"), { timeout: 8000, polling: 25 });
await page.click("#htpReady");
await page.waitForFunction(() => document.body.dataset.state === "playing", { timeout: 20000, polling: 50 });
await sleep(1400);
await page.evaluate(async app => { window.__rb = await import(app + "/js/robot.js"); }, APP);

/* stop the solo loop fighting us for the meter, and hide the bubble so the
   BODY is what is judged */
await page.evaluate(() => {
  const b = document.getElementById("spRobot").querySelector(".rb-bubble");
  b.style.display = "none";
});

const RIG = "spRobot";
const box = await page.evaluate(id => {
  const r = document.getElementById(id).getBoundingClientRect();
  return { l: r.left, t: r.top, w: r.width, h: r.height };
}, RIG);
const clip = {
  x: Math.max(0, Math.round(box.l - box.w * .45)),
  y: Math.max(0, Math.round(box.t - box.h * .2)),
  width: Math.round(box.w * 1.9), height: Math.round(box.h * 1.35),
};

const charge = v => page.evaluate((id, v) => {
  clearInterval(window.__feed);
  window.__feed = setInterval(() => window.__rb.robotCharge(id, v), 50);
}, RIG, v);

const grab = async name => {
  const pose = await page.evaluate(id => document.getElementById(id).dataset.pose, RIG);
  await page.screenshot({ path: `${OUT}/pose-${name}.png`, clip });
  return pose;
};

const got = {};
for (const [key, v] of [["idle", 0], ["watch", .25], ["read", .6], ["close", .93]]) {
  await charge(v); await sleep(1000); got[key] = await grab(key);
}
await page.evaluate(id => window.__rb.robotGot(id), RIG); await sleep(1000); got.got = await grab("got");
await sleep(700); got.proud = await grab("proud");
await page.evaluate(id => window.__rb.robotMiss(id, "skip"), RIG); await sleep(950); got.lost = await grab("lost");
await sleep(500);
await page.evaluate(id => window.__rb.robotMiss(id, "timeout"), RIG); await sleep(950); got.down = await grab("down");
await charge(0);
let ok = false;
for (let i = 0; i < 700; i++) {
  if (await page.evaluate(id => document.getElementById(id).dataset.pose, RIG) === "peek") {
    await sleep(550); got.peek = await grab("peek"); ok = true; break;
  }
  await sleep(110);
}
if (!ok) console.error("!! peek never reached");
await page.evaluate(() => clearInterval(window.__feed));

/* ---- the FACE parts alone, forced, at 3x, cropped to the head ---- */
await page.setViewport({ width: VW, height: VH, deviceScaleFactor: 3 });
await sleep(400);
const head = await page.evaluate(id => {
  const r = document.getElementById(id).getBoundingClientRect();
  return { x: Math.round(r.left + r.width * .10), y: Math.round(r.top - r.height * .02),
    width: Math.round(r.width * .82), height: Math.round(r.height * .42) };
}, RIG);
const dress = (eyes, mouth) => page.evaluate((id, eyes, mouth) => {
  const n = document.getElementById(id);
  n.querySelector(".rb-eye-l").src = "assets/ui/rig/" + eyes + "_left.png";
  n.querySelector(".rb-eye-r").src = "assets/ui/rig/" + eyes + "_right.png";
  const V = ["A_AH", "E_EE", "O_OH", "M_BP", "FV"];
  n.querySelector(".rb-mouth").src = "assets/ui/rig/" + (V.includes(mouth) ? "phoneme_" + mouth : mouth) + ".png";
}, RIG, eyes, mouth);
for (const e of ["open", "happy", "worried", "blink"]) {
  await dress(e, "smile"); await sleep(220);
  await page.screenshot({ path: `${OUT}/eye-${e}.png`, clip: head });
}
for (const m of ["smile", "frown", "A_AH", "E_EE", "O_OH", "M_BP", "FV"]) {
  await dress("open", m); await sleep(220);
  await page.screenshot({ path: `${OUT}/mouth-${m}.png`, clip: head });
}
await writeFile(`${OUT}/poses.json`, JSON.stringify({ box, clip, head, got, errs }, null, 2));
console.log(JSON.stringify({ box, clip, got, errs }, null, 2));
await browser.close();
