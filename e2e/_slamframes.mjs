/* Screenshot the recognition slam at the exact offsets QA flagged as the paper
   crossing his eye (35/52/68/85/100ms), by driving the animations off a fake
   clock so each frame is deterministic instead of a race. Throwaway. */
import puppeteer from "puppeteer-core";
import { mkdir } from "node:fs/promises";
import { passCameraGate } from "./_gate.mjs";
const APP = process.env.APP_URL || "http://localhost:8123";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const OUT = process.argv[2] || "./slamframes";
const sleep = ms => new Promise(r => setTimeout(r, ms));
await mkdir(OUT, { recursive: true });

const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new",
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--no-first-run"] });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 810, deviceScaleFactor: 3 });
await page.goto(APP, { waitUntil: "networkidle2", timeout: 60000 });
await passCameraGate(page);
await page.waitForFunction(() => document.getElementById("status").style.display === "none", { timeout: 60000 });
await page.click("#modeAI");
await page.waitForFunction(() => !document.getElementById("howToPlay").classList.contains("hidden"), { timeout: 8000, polling: 25 });
await page.click("#htpReady");
await page.waitForFunction(() => document.body.dataset.state === "playing", { timeout: 20000, polling: 50 });
await sleep(1200);
await page.evaluate(async app => { window.__rb = await import(app + "/js/robot.js"); }, APP);

for (const t of [200, 261, 400]) {
  await page.evaluate(() => window.__rb.resetRobot("spRobot"));
  await sleep(420);
  await page.evaluate(() => window.__rb.robotGot("spRobot"));
  /* Freeze every running animation at exactly `t` — Chrome exposes the
     WAAPI timeline for CSS animations, so this is the real composited state
     at that instant rather than whatever the sampler happened to catch. */
  await page.evaluate(t => {
    for (const a of document.getElementById("spRobot").getAnimations({ subtree: true })) {
      a.pause(); a.currentTime = t;
    }
  }, t);
  await page.screenshot({ path: `${OUT}/slam-${String(t).padStart(4,"0")}ms.png`, clip:{x:820,y:120,width:620,height:480} });
}
console.log("wrote", OUT);
await browser.close();
