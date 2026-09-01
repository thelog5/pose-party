/* QA scratch: does he actually WATCH you?
   The fake camera has no body in it, so presence() never gets a fix and the
   whole gaze cascade is dead in every other capture. This feeds synthetic
   landmarks straight into presence.notePresence() and photographs his head.
   node _robotgaze.mjs [solo|v1|party] outdir */
import puppeteer from "puppeteer-core";
import { mkdir, writeFile } from "node:fs/promises";
import { passCameraGate } from "./_gate.mjs";
const APP = process.env.APP_URL || "http://localhost:8123";
const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const MODE = process.argv[2] || "solo";
const OUT = process.argv[3] || "./qa-gaze";
const VW = Number(process.env.VW) || 1440, VH = Number(process.env.VH) || 810;
const sleep = ms => new Promise(r => setTimeout(r, ms));
await mkdir(OUT, { recursive: true });
const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new",
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--no-first-run"] });
const page = await browser.newPage();
await page.setViewport({ width: VW, height: VH, deviceScaleFactor: 2 });
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
  window.__pr = await import(app + "/js/presence.js");
  window.__st = (await import(app + "/js/state.js")).state;
  try { window.__sr = await import(app + "/js/soloRound.js"); } catch { window.__sr = null; }
  /* a body: nose, ears, shoulders, plus the gesture points energy reads */
  window.__body = { x: .5, y: .45, span: .22 };
  const mk = () => {
    const { x, y, span } = window.__body;
    const lm = Array.from({ length: 33 }, () => ({ x, y, z: 0, visibility: .95 }));
    lm[0] = { x, y, z: 0, visibility: .98 };                       // nose
    lm[7] = { x: x - span * .25, y, z: 0, visibility: .95 };
    lm[8] = { x: x + span * .25, y, z: 0, visibility: .95 };
    lm[11] = { x: x - span / 2, y: y + .18, z: 0, visibility: .95 };
    lm[12] = { x: x + span / 2, y: y + .18, z: 0, visibility: .95 };
    return lm;
  };
  const pump = () => { window.__pr.notePresence(mk(), performance.now()); requestAnimationFrame(pump); };
  pump();
  const word = window.__st?.game?.word;
  window.__feed = setInterval(() => {
    if (word && window.__sr?.setModelOutput) { window.__sr.setModelOutput(word, 0); window.__st.smooth[word] = 0; }
    window.__rb.robotCharge(rig => rig, 0);
  }, 60);
}, APP);
await page.evaluate(rig => {
  clearInterval(window.__feed);
  window.__feed = setInterval(() => window.__rb.robotCharge(rig.slice(1), 0), 60);
}, RIG);
await sleep(1200);

const headClip = async () => {
  const r = await page.evaluate(rig => {
    const g = document.querySelector(rig).getBoundingClientRect();
    return { x: g.left - g.width * .35, y: g.top - g.height * .12, w: g.width * 1.7, h: g.height * .62 };
  }, RIG);
  return { x: Math.max(0, Math.round(r.x)), y: Math.max(0, Math.round(r.y)),
    width: Math.round(r.w), height: Math.round(r.h) };
};

const probe = () => page.evaluate(rig => {
  const g = document.querySelector(rig);
  const p = window.__pr.presence();
  return { seen: p.seen, px: +p.x.toFixed(3), py: +p.y.toFixed(3), scale: +p.scale.toFixed(3),
    eyeX: g.style.getPropertyValue("--rb-eye-x"), eyeY: g.style.getPropertyValue("--rb-eye-y"),
    shiftX: g.style.getPropertyValue("--rb-shift-x"),
    headTf: g.querySelector('.rp[data-j="head"]').style.transform };
}, RIG);

const log = [];
const clip = await headClip();
for (const [name, x, y] of [["centre", .5, .45], ["farleft", .05, .45], ["farright", .95, .45],
                            ["high", .5, .12], ["low", .5, .85], ["centre2", .5, .45]]) {
  await page.evaluate((x, y) => { window.__body.x = x; window.__body.y = y; }, x, y);
  await sleep(1500);
  await page.screenshot({ path: `${OUT}/${MODE}-gaze-${name}.png`, clip });
  log.push({ name, x, y, ...(await probe()) });
}
/* and: walk out of shot */
await page.evaluate(() => { window.__pr.notePresence(null, performance.now()); window.__body = null; });
await page.evaluate(() => {
  /* stop the pump feeding a body */
  window.__gone = true;
  const pump = () => { if (window.__gone) { window.__pr.notePresence(null, performance.now()); requestAnimationFrame(pump); } };
  pump();
});
await sleep(3200);
await page.screenshot({ path: `${OUT}/${MODE}-gaze-gone-a.png`, clip });
log.push({ name: "gone-a", ...(await probe()) });
await sleep(1600);
await page.screenshot({ path: `${OUT}/${MODE}-gaze-gone-b.png`, clip });
log.push({ name: "gone-b", ...(await probe()) });

await writeFile(`${OUT}/${MODE}-gaze.json`, JSON.stringify({ log, errs }, null, 2));
console.log(JSON.stringify(log, null, 2));
console.log("errs", errs);
await browser.close();
