/* The lobby rig has no `data-rig-room`, so its far arm gets the full
   ARM_R_REACH. Check the shoulder cap stays hidden by the torso at the limit. */
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
await page.click("#modeVS");
await page.waitForFunction(() => document.body.dataset.screen === "lobby", { timeout:15000, polling:40 });
await sleep(2200);
for (const [n, x, y] of [["farleft",6,300],["left",760,300],["right",1434,300],["down",1000,800]]) {
  await page.mouse.move(x, y); await sleep(60); await page.mouse.move(x + 1, y);
  await sleep(1400);
  const a = await page.evaluate(() => {
    const r = j => { const m = new DOMMatrixReadOnly(getComputedStyle(
      document.querySelector(`#lobbyRobotWait .pr-part[data-j="${j}"]`)).transform);
      return +(Math.atan2(m.b, m.a) * 180 / Math.PI).toFixed(1); };
    return { t:r("torso"), n:r("uarmL"), f:r("uarmR") };
  });
  console.log(n.padEnd(8), "near", String(+(a.n - a.t).toFixed(1)).padStart(6),
              " far", String(+(a.f - a.t).toFixed(1)).padStart(6));
  await page.screenshot({ path: `${OUT}/lobbyarm-${n}.png`, clip:{x:880,y:120,width:400,height:420} });
}
await browser.close();
