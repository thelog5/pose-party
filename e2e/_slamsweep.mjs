/* Sweep --talk-gap-x during a recognition slam and measure, per rAF across the
   whole 1.45s: the overlap between the opaque speech paper and his eye ink, and
   how far the tail tip sits from his mouth. Finds the smallest gap that never
   touches the eye — QA's finding 5 (paper crosses the eye) and finding 12 (tail
   points at empty body) pull in opposite directions and the answer is whichever
   gap satisfies both. Throwaway. */
import puppeteer from "puppeteer-core";
import { passCameraGate } from "./_gate.mjs";
const APP = process.env.APP_URL || "http://localhost:8123";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const MODE = process.argv[2] || "solo";
const sleep = ms => new Promise(r => setTimeout(r, ms));

const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new",
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--no-first-run"] });
const page = await browser.newPage();
await page.setViewport({ width: Number(process.env.VW) || 1440, height: Number(process.env.VH) || 810 });
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
    document.querySelectorAll("section.screen").forEach(s => s.classList.add("hidden"));
    document.getElementById(m === "v1" ? "scrMatch" : "scrPartyMatch").classList.remove("hidden");
    document.body.dataset.screen = m === "v1" ? "match" : "pmatch";
  }, MODE);
}
await sleep(1200);
await page.evaluate(async app => { window.__rb = await import(app + "/js/robot.js"); }, APP);

/* One slam, sampled every frame. `gap` overrides --talk-gap-x inline (which
   beats the stylesheet) so a sweep needs no CSS edit per step. */
const run = (rig, gap) => page.evaluate(async (rig, gap) => {
  const node = document.querySelector(rig);
  const bub = node.querySelector(".rb-bubble");
  window.__rb.resetRobot(rig.slice(1));
  await new Promise(r => setTimeout(r, 420));
  if (gap != null) bub.style.setProperty("--talk-gap-x", gap + "%");
  else bub.style.removeProperty("--talk-gap-x");

  /* his eye ink, mapped through the LIVE head joint transform and then through
     .rb-rig's slam matrix — both have to be composed or the eye is measured
     where it would be if he were not celebrating, which is the whole bug */
  const eyeBox = () => {
    const canvas = node.querySelector(".rb-canvas");
    const c = canvas.getBoundingClientRect();
    const rig = node.querySelector(".rb-rig");
    const rm = new DOMMatrix(getComputedStyle(rig).transform);
    const ro = getComputedStyle(rig).transformOrigin.split(" ").map(parseFloat);
    const rr = rig.getBoundingClientRect();
    const pts = [];
    for (const el of [node.querySelector(".rb-eye-l"), node.querySelector(".rb-eye-r")]) {
      const m = new DOMMatrix(getComputedStyle(el).transform);
      /* happy_* ink box on the shared 640 canvas */
      for (const [x, y] of [[241,184],[294,184],[241,227],[294,227],[345,184],[397,184],[345,227],[397,227]]) {
        const p = m.transformPoint(new DOMPoint(c.width * x / 640, c.height * y / 640));
        /* into viewport, then through the rig's own slam matrix about its origin */
        let vx = c.left + p.x - rr.left - ro[0], vy = c.top + p.y - rr.top - ro[1];
        const q = rm.transformPoint(new DOMPoint(vx, vy));
        pts.push([rr.left + ro[0] + q.x, rr.top + ro[1] + q.y]);
      }
    }
    return { left: Math.min(...pts.map(p=>p[0])), right: Math.max(...pts.map(p=>p[0])),
             top: Math.min(...pts.map(p=>p[1])), bottom: Math.max(...pts.map(p=>p[1])) };
  };

  const g0 = node.getBoundingClientRect();
  const area = g0.width * g0.height;
  const out = [];
  window.__rb.robotGot(rig.slice(1));
  const t0 = performance.now();
  await new Promise(done => {
    const frame = now => {
      const t = now - t0;
      const b = bub.getBoundingClientRect();
      const e = eyeBox();
      const op = parseFloat(getComputedStyle(bub).opacity);
      /* the paper's OPAQUE body, not its transparent bounding box: the balloon
         starts 23.18% in from the tail-side edge (measured off the asset) */
      const side = node.dataset.side;
      const solid = side === "left"
        ? { left: b.left, right: b.right - b.width * .2318 }
        : { left: b.left + b.width * .2318, right: b.right };
      const w = Math.min(solid.right, e.right) - Math.max(solid.left, e.left);
      const h = Math.min(b.bottom, e.bottom) - Math.max(b.top, e.top);
      const ov = (w > 0 && h > 0 && op > .05) ? (w * h) / area * 100 : 0;
      out.push({ t: Math.round(t), op: Number(op.toFixed(2)), ov: Number(ov.toFixed(3)) });
      if (t < 1500) requestAnimationFrame(frame); else done();
    };
    requestAnimationFrame(frame);
  });

  const worst = out.reduce((a, b) => b.ov > a.ov ? b : a);
  const touched = out.filter(s => s.ov > 0).length;
  return { gap, worst, touched, frames: out.length, head: out.slice(0,22) };
}, rig, gap);

const rows = [];
for (const gap of [28]) {
  rows.push(await run(RIG, gap));
  await sleep(400);
}
console.log(MODE, JSON.stringify(rows, null, 1));
await browser.close();
