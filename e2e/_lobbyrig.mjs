/* Lobby-robot screenshot harness. Walks Home → 1v1 lobby, settles the
   entrance, then parks the cursor at a few corners and photographs the rig so
   the reach can be checked against the Figma art rather than described. */
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

await page.click("#modeVS");
await page.waitForFunction(() => document.body.dataset.screen === "lobby", { timeout: 15000, polling: 40 });
await sleep(2200);

const probe = () => page.evaluate(() => {
  const rd = j => {
    const el = document.querySelector(`#lobbyRobotWait .pr-part[data-j="${j}"]`);
    if (!el) return null;
    const m = new DOMMatrixReadOnly(getComputedStyle(el).transform);
    return { x: +m.e.toFixed(2), y: +m.f.toFixed(2), r: +(Math.atan2(m.b, m.a) * 180 / Math.PI).toFixed(2) };
  };
  const box = document.querySelector("#lobbyRobotWait .pr-canvas").getBoundingClientRect();
  return {
    box: [box.left, box.top, box.width, box.height].map(v => +v.toFixed(1)),
    hips: rd("waist"), torso: rd("torso"), head: rd("head"),
    eyes: rd("eyes"), uarmL: rd("uarmL"), handL: rd("handL"), uarmR: rd("uarmR"),
  };
});

const shot = async (name) => {
  await page.screenshot({ path: `${OUT}/lobbyrig-${name}.png`, clip: { x: 700, y: 90, width: 700, height: 560 } });
};

const spots = [
  ["rest", null],
  ["upright", [1400, 90]],
  ["right", [1400, 420]],
  ["low", [1050, 780]],
  ["left", [70, 300]],
  ["near", [1120, 330]],
];
for (const [name, at] of spots) {
  if (at) { await page.mouse.move(at[0], at[1]); await sleep(60); await page.mouse.move(at[0] + 1, at[1]); }
  await sleep(name === "rest" ? 3400 : 900);
  console.log(name, JSON.stringify(await probe()));
  await shot(name);
}
await page.screenshot({ path: `${OUT}/lobbyrig-stage.png` });

console.log("console errors:", errs.length ? errs : "none");
await browser.close();
