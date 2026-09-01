/* QA scratch: a clean, padded still of EVERY mood, plus face crops.
   node _robotpose.mjs [solo|v1|party] outdir */
import puppeteer from "puppeteer-core";
import { mkdir, writeFile } from "node:fs/promises";

import { passCameraGate } from "./_gate.mjs";
const APP = process.env.APP_URL || "http://localhost:8123";
const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const MODE = process.argv[2] || "solo";
const OUT = process.argv[3] || "./qa-poses";
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

let RIG = "#spRobot";
if (MODE === "solo") {
  await page.click("#modeAI");
  await page.waitForFunction(() =>
    !document.getElementById("howToPlay").classList.contains("hidden"), { timeout: 8000, polling: 25 });
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
  window.__st = (await import(app + "/js/state.js")).state;
  try { window.__sr = await import(app + "/js/soloRound.js"); } catch { window.__sr = null; }
}, APP);

/* Solo runs its OWN robotCharge every frame from the real meter, so a naked
   robotCharge here just fights it. Feed the classifier channel instead. */
const feed = conf => page.evaluate((rig, conf) => {
  clearInterval(window.__feed);
  const word = window.__st?.game?.word;
  window.__feed = setInterval(() => {
    if (word && window.__sr?.setModelOutput) {
      window.__sr.setModelOutput(word, conf);
      window.__st.smooth[word] = conf;
    }
    window.__rb.robotCharge(rig.slice(1), conf);
  }, 60);
}, RIG, conf);

const hideBubble = on => page.evaluate((rig, on) => {
  document.querySelector(rig + " .rb-bubble").style.visibility = on ? "hidden" : "";
}, RIG, on);

/* PADDED clip: his canvas overflows .grobot, so an element screenshot beheads him */
const padShot = async (name, padL = .55, padR = .55, padT = .35, padB = .35) => {
  const box = await page.evaluate(rig => {
    const r = document.querySelector(rig).getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  }, RIG);
  const clip = {
    x: Math.max(0, box.x - box.w * padL), y: Math.max(0, box.y - box.h * padT),
    width: box.w * (1 + padL + padR), height: box.h * (1 + padT + padB),
  };
  clip.width = Math.min(clip.width, VW - clip.x);
  clip.height = Math.min(clip.height, VH - clip.y);
  await page.screenshot({ path: `${OUT}/${name}.png`, clip });
};

const poseNow = () => page.evaluate(rig => document.querySelector(rig).dataset.pose, RIG);

await hideBubble(true);
const seen = {};

/* --- the four band poses --- */
for (const [name, conf] of [["idle", 0], ["watch", .25], ["read", .6], ["close", .93]]) {
  await feed(conf);
  await sleep(1100);
  await padShot(`${MODE}-pose-${name}`);
  seen[name] = await poseNow();
}

/* --- celebrate, with the slam transform stripped so the JOINTS are visible --- */
await feed(.93);
await page.evaluate(rig => {
  window.__rb.robotGot(rig.slice(1));
  setTimeout(() => document.querySelector(rig + " .rb-rig").classList.remove("slam"), 30);
}, RIG);
await sleep(1150);
await padShot(`${MODE}-pose-got`);
seen.got = await poseNow();
await sleep(700);      // now proud
await padShot(`${MODE}-pose-proud`);
seen.proud = await poseNow();

/* --- shrug --- */
await page.evaluate(rig => window.__rb.robotMiss(rig.slice(1), "skip"), RIG);
await sleep(750);
await padShot(`${MODE}-pose-lost`);
seen.lost = await poseNow();

/* --- sad --- */
await sleep(800);
await page.evaluate(rig => window.__rb.robotMiss(rig.slice(1), "timeout"), RIG);
await sleep(750);
await padShot(`${MODE}-pose-down`);
seen.down = await poseNow();

/* --- peek: only the idle beat loop reaches it --- */
await sleep(1400);
await feed(0);
let got = false;
for (let i = 0; i < 900; i++) {
  if ((await poseNow()) === "peek") {
    await sleep(650);
    await padShot(`${MODE}-pose-peek`);
    seen.peek = await poseNow();
    got = true; break;
  }
  await sleep(120);
}
if (!got) seen.peek = "NEVER REACHED";

await writeFile(`${OUT}/${MODE}-poses.json`, JSON.stringify({ seen, errs }, null, 2));
console.log(JSON.stringify({ seen, errs }, null, 2));
await browser.close();
