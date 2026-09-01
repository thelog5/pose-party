/* Home-robot screenshot harness: the rig at rest and reaching, with the
   speech bubble in frame so the tail can be checked against his head. */
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
const errs = [];
page.on("console", m => { if (m.type() === "error") errs.push(m.text()); });
page.on("pageerror", e => errs.push("PAGEERROR: " + e.message));
page.on("response", r => { if (r.status() >= 400) errs.push("HTTP " + r.status() + " " + r.url()); });
await page.goto(APP, { waitUntil: "networkidle2", timeout: 60000 });
await passCameraGate(page);
await page.waitForFunction(() => document.getElementById("status").style.display === "none", { timeout: 60000 });
await sleep(2500);

const geo = () => page.evaluate(() => {
  const st = document.getElementById("homeStage").getBoundingClientRect();
  const pct = r => ({ l:+((r.left-st.left)/st.width*100).toFixed(2), t:+((r.top-st.top)/st.height*100).toFixed(2),
                      r:+((r.right-st.left)/st.width*100).toFixed(2), b:+((r.bottom-st.top)/st.height*100).toFixed(2) });
  const head = document.querySelector('#homeRobot .pr-part[data-j="head"]>img').getBoundingClientRect();
  const bub = document.getElementById("speechBubble").getBoundingClientRect();
  return { stage:[+st.width.toFixed(0),+st.height.toFixed(0)], headBox:pct(head), bubble:pct(bub),
           bubbleText:document.getElementById("bubbleText").textContent.trim() };
});
console.log("geometry", JSON.stringify(await geo()));

for (const [name, at] of [["rest",null],["right",[1380,300]],["low",[700,760]],["far",[1430,760]]]) {
  if (at) { await page.mouse.move(at[0], at[1]); await sleep(60); await page.mouse.move(at[0]+1, at[1]); }
  await sleep(name === "rest" ? 3000 : 900);
  await page.screenshot({ path: `${OUT}/home-${name}.png`, clip: { x: 0, y: 200, width: 720, height: 610 } });
}
await page.screenshot({ path: `${OUT}/home-stage.png` });

/* the bubble still cycles, still fits, and the tap still reaches the rig */
const before = await page.evaluate(() => document.getElementById("bubbleText").textContent);
await page.click('#homeRobot .pr-part[data-j="torso"]>img');
await sleep(300);
const after = await page.evaluate(() => ({
  text: document.getElementById("bubbleText").textContent,
  fits: (() => { const n = document.getElementById("bubbleText");
    return n.scrollWidth <= n.clientWidth + 1 && n.scrollHeight <= n.clientHeight + 1; })(),
}));
console.log("tap:", JSON.stringify({ before, ...after }));
await sleep(200);
await page.screenshot({ path: `${OUT}/home-cheer.png`, clip: { x: 0, y: 200, width: 720, height: 610 } });

/* every phrase must fit the paper */
const worst = await page.evaluate(async app => {
  const mod = await import(app + "/js/homeAlive.js");
  const n = document.getElementById("bubbleText");
  const bad = [];
  for (const p of mod.HOME_ROBOT_PHRASES) {
    document.getElementById("speechBubble").click();
    await new Promise(r => requestAnimationFrame(r));
  }
  for (let i = 0; i < mod.HOME_ROBOT_PHRASES.length; i++) {
    document.getElementById("speechBubble").click();
    await new Promise(r => requestAnimationFrame(r));
    if (n.scrollWidth > n.clientWidth + 1 || n.scrollHeight > n.clientHeight + 1)
      bad.push(n.textContent);
  }
  return bad;
}, APP);
console.log("phrases that overflow:", worst.length ? worst : "none");
console.log("console errors:", errs.length ? errs : "none");
await browser.close();
