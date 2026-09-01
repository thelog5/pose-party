/* Renders the gameplay rig in every mood and saves one frame each, so the
   anatomy can be judged from the art instead of from the sign of an angle. */
import puppeteer from "puppeteer-core";
import { mkdir } from "node:fs/promises";
import { passCameraGate } from "./_gate.mjs";
const APP = process.env.APP_URL || "http://localhost:8123";
const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const OUT = process.env.OUT || "./shots";
const sleep = ms => new Promise(r => setTimeout(r, ms));
await mkdir(OUT, { recursive: true });
const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new",
  args: ["--use-fake-device-for-media-stream","--use-fake-ui-for-media-stream","--no-first-run"] });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 810, deviceScaleFactor: 2 });
await page.goto(APP, { waitUntil: "networkidle2", timeout: 60000 });
await passCameraGate(page);
await page.waitForFunction(() => document.getElementById("status").style.display === "none", { timeout: 60000 });
await page.click("#modeAI");
await page.waitForFunction(() => !document.getElementById("howToPlay").classList.contains("hidden"), { timeout: 8000, polling: 25 });
await page.click("#htpReady");
await page.waitForFunction(() => document.body.dataset.state === "playing", { timeout: 20000, polling: 50 });
await sleep(1500);
await page.evaluate(async app => { window.__rb = await import(app + "/js/robot.js"); }, APP);

/* Feed the charge EVERY FRAME. One call is overridden by the idle-beat loop,
   which is what made the first version of this probe report `idle` for every
   band. The suite's own band sampler does the same thing for the same reason. */
const BANDS = [["idle",0],["watch",.3],["read",.55],["close",.9]];
for (const [name, v] of BANDS) {
  await page.evaluate(v => new Promise(done => {
    const end = performance.now() + 900;
    const step = () => { window.__rb.robotCharge("spRobot", v);
      performance.now() < end ? requestAnimationFrame(step) : done(); };
    requestAnimationFrame(step);
  }), v);
  await sleep(120);
  const pose = await page.evaluate(() => document.getElementById("spRobot").dataset.pose);
  await (await page.$("#spRobot")).screenshot({ path: `${OUT}/pose-${name}-${pose}.png` });
  console.log(name.padEnd(6), "->", pose);
}
/* the celebrate slam and the reset poses */
await page.evaluate(() => window.__rb.robotGot("spRobot"));
await sleep(900);
await (await page.$("#spRobot")).screenshot({ path: `${OUT}/pose-slam.png` });
console.log("slam   ->", await page.evaluate(() => document.getElementById("spRobot").dataset.pose));
await browser.close();
