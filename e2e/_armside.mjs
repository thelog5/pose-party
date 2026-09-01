/* Which arm reaches, and how far, as the cursor crosses him. Shoots Home at
   five cursor positions so the handover can be seen, not only measured. */
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
await sleep(2400);
const rot = () => page.evaluate(() => {
  const r = j => { const m = new DOMMatrixReadOnly(getComputedStyle(
    document.querySelector(`#homeRobot .pr-part[data-j="${j}"]`)).transform);
    return +(Math.atan2(m.b, m.a) * 180 / Math.PI).toFixed(1); };
  return { torso:r("torso"), nearArm:r("uarmL"), farArm:r("uarmR") };
});
for (const [n, x, y] of [["farleft",8,430],["left",180,430],["under",300,700],
                         ["right",900,430],["farright",1430,430]]) {
  await page.mouse.move(x, y); await sleep(60); await page.mouse.move(x + 1, y);
  await sleep(1400);
  const a = await rot();
  /* the composed rotations include the body, so subtract it for the joint angle */
  console.log(n.padEnd(9), "near", String(+(a.nearArm - a.torso).toFixed(1)).padStart(6),
              " far", String(+(a.farArm - a.torso).toFixed(1)).padStart(6));
  await page.screenshot({ path: `${OUT}/arm-${n}.png`, clip:{x:0,y:270,width:700,height:540} });
}
await browser.close();
