/* Measure the room around the Solo speech paper: every HUD obstacle, the
   bubble box, and the robot's eye ink at slam scale — so the slam offset is
   solved rather than guessed. Throwaway. */
import puppeteer from "puppeteer-core";
import { passCameraGate } from "./_gate.mjs";
const APP = process.env.APP_URL || "http://localhost:8123";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new",
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--no-first-run"] });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 810 });
await page.goto(APP, { waitUntil: "networkidle2", timeout: 60000 });
await passCameraGate(page);
await page.waitForFunction(() => document.getElementById("status").style.display === "none", { timeout: 60000 });
await page.click("#modeAI");
await page.waitForFunction(() => !document.getElementById("howToPlay").classList.contains("hidden"), { timeout: 8000, polling: 25 });
await page.click("#htpReady");
await page.waitForFunction(() => document.body.dataset.state === "playing", { timeout: 20000, polling: 50 });
await sleep(1200);
await page.evaluate(async app => { window.__rb = await import(app + "/js/robot.js"); }, APP);
await page.evaluate(() => window.__rb.robotGot("spRobot"));
await sleep(260);
const out = await page.evaluate(() => {
  const g = document.getElementById("spRobot").getBoundingClientRect();
  const b = document.querySelector("#spRobot .rb-bubble").getBoundingClientRect();
  const canvas = document.querySelector("#spRobot .rb-canvas").getBoundingClientRect();
  /* eye ink on the shared 640 canvas, mapped through the live head transform */
  const eye = document.querySelector("#spRobot .rb-eye-l");
  const m = new DOMMatrix(getComputedStyle(eye).transform);
  const box = (x0, y0, x1, y1) => {
    const pts = [[x0,y0],[x1,y0],[x0,y1],[x1,y1]].map(([x,y]) =>
      m.transformPoint(new DOMPoint(canvas.width * x / 640, canvas.height * y / 640)));
    return { left: canvas.left + Math.min(...pts.map(p=>p.x)), right: canvas.left + Math.max(...pts.map(p=>p.x)),
             top: canvas.top + Math.min(...pts.map(p=>p.y)), bottom: canvas.top + Math.max(...pts.map(p=>p.y)) };
  };
  const obstacles = {};
  for (const el of document.querySelectorAll("#soloStage .sp-word,#soloStage .sp-wtimer,#soloStage .sp-rtimer,#soloStage .sp-card,#soloStage .sp-guess,#soloStage .sp-skip")) {
    const r = el.getBoundingClientRect();
    if (!r.width) continue;
    obstacles[el.id || el.className] = { l: Math.round(r.left), r: Math.round(r.right), t: Math.round(r.top), b: Math.round(r.bottom) };
  }
  const stage = document.getElementById("soloStage").getBoundingClientRect();
  return {
    stage: { l: stage.left, t: stage.top, w: stage.width, h: stage.height },
    robot: { l: g.left, t: g.top, w: g.width, h: g.height },
    bubble: { l: b.left, r: b.right, t: b.top, b: b.bottom, w: b.width, h: b.height },
    eyeInkAtSlam: box(250, 187, 287, 217),          // happy_left ink box
    eyeRInkAtSlam: box(353, 189, 390, 217),
    obstacles,
  };
});
console.log(JSON.stringify(out, null, 2));
await browser.close();
