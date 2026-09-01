/* Robot screenshot harness. Boots Solo, drives the rig through robot.js's own
   public surface (no second source of truth for what a pose is), and captures
   the rig plus its speech paper at rest and mid-slam. */
import puppeteer from "puppeteer-core";
import { mkdir } from "node:fs/promises";

import { passCameraGate } from "./_gate.mjs";
const APP = process.env.APP_URL || "http://localhost:8123";
const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const OUT = process.env.OUT || "./shots";
const sleep = ms => new Promise(r => setTimeout(r, ms));
await mkdir(OUT, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--no-first-run"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 810, deviceScaleFactor: 2 });
const errs = [];
page.on("console", m => { if (m.type() === "error") errs.push(m.text()); });
page.on("pageerror", e => errs.push("PAGEERROR: " + e.message));
await page.goto(APP, { waitUntil: "networkidle2", timeout: 60000 });
await passCameraGate(page);
await page.waitForFunction(() => document.getElementById("status").style.display === "none", { timeout: 60000 });

await page.click("#modeAI");
await page.waitForFunction(() =>
  !document.getElementById("howToPlay").classList.contains("hidden"), { timeout: 8000, polling: 25 });
await page.click("#htpReady");
await page.waitForFunction(() => document.body.dataset.state === "playing", { timeout: 20000, polling: 50 });
await sleep(1200);

await page.evaluate(async app => {
  window.__rb = await import(app + "/js/robot.js");
}, APP);

const charge = v => page.evaluate(v => window.__rb.robotCharge("spRobot", v), v);
const pose = () => page.evaluate(() => document.getElementById("spRobot").dataset.pose);

/* geometry probe: the opaque paper edge against his eye, in % of his own box */
const probe = () => page.evaluate(() => {
  const g = document.getElementById("spRobot").getBoundingClientRect();
  const b = document.querySelector("#spRobot .rb-bubble").getBoundingClientRect();
  const eye = document.querySelector("#spRobot .rb-eye-l").getBoundingClientRect();
  const pct = x => ((x - g.left) / g.width * 100).toFixed(1);
  return {
    pose: document.getElementById("spRobot").dataset.pose,
    bubbleVisible: getComputedStyle(document.querySelector("#spRobot .rb-bubble")).opacity,
    bubbleRightEdgePct: pct(b.right),
    bubbleLeftEdgePct: pct(b.left),
    /* the eye layer is the whole canvas, so this is the canvas, not the ink —
       the ink numbers come from the brief, this only confirms the canvas map */
    canvasPct: [pct(eye.left), pct(eye.right)],
  };
});

for (const v of [0, .2, .5, .9]) {
  await charge(v);
  await sleep(500);
  await (await page.$("#spRobot")).screenshot({ path: `${OUT}/charge-${v}.png` });
  console.log("charge", v, "pose", await pose());
}

/* rest, with a line up */
await charge(.5);
await sleep(700);
await page.evaluate(() => window.__rb.robotCharge("spRobot", .9));
await sleep(600);
console.log("REST", JSON.stringify(await probe()));
await page.screenshot({ path: `${OUT}/stage-rest.png`, clip: { x: 780, y: 100, width: 660, height: 480 } });

/* the slam — the worst case for paper vs face */
await page.evaluate(() => window.__rb.robotGot("spRobot"));
await sleep(320);
console.log("SLAM", JSON.stringify(await probe()));
await page.screenshot({ path: `${OUT}/stage-slam.png`, clip: { x: 700, y: 60, width: 740, height: 560 } });
await sleep(700);
await page.screenshot({ path: `${OUT}/stage-slam-late.png`, clip: { x: 700, y: 60, width: 740, height: 560 } });

console.log("console errors:", errs.length ? errs : "none");
await browser.close();
