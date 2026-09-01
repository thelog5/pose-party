/* How he picks up the cursor after a doze, and whether his balloon is
   actually tethered to him rather than nailed to the wallpaper. Samples the
   ladder easing in: eyes, then head, then torso. */
import puppeteer from "puppeteer-core";
import { passCameraGate } from "./_gate.mjs";
const APP = process.env.APP_URL || "http://localhost:8123";
const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new",
  args: ["--use-fake-device-for-media-stream","--use-fake-ui-for-media-stream","--no-first-run"] });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 810 });
await page.goto(APP, { waitUntil: "networkidle2", timeout: 60000 });
await passCameraGate(page);
await page.waitForFunction(() => document.getElementById("status").style.display === "none", { timeout: 60000 });
await sleep(2400);
const read = () => page.evaluate(() => {
  const rd = j => { const m = new DOMMatrixReadOnly(getComputedStyle(
    document.querySelector(`#homeRobot .pr-part[data-j="${j}"]`)).transform);
    return +m.e.toFixed(2); };
  const b = document.getElementById("speechBubble");
  return { eyes:rd("eyes"), head:rd("head"), torso:rd("torso"),
           bubT:getComputedStyle(b).translate, bubR:getComputedStyle(b).rotate };
});
/* park it left, let him go idle (IDLE_MS 2600) */
await page.mouse.move(120, 700); await sleep(3600);
const idle = await read();
console.log("idle       ", JSON.stringify(idle));
/* now move: sample the first second */
await page.mouse.move(1400, 120);
for (const t of [90, 180, 330, 600, 1100]) {
  await sleep(t === 90 ? 90 : t - [90,180,330,600,1100][[90,180,330,600,1100].indexOf(t)-1]);
  const r = await read();
  console.log(`t=+${String(t).padStart(4)}ms`, JSON.stringify(r));
}
/* bubble must have moved between the two extremes */
await page.mouse.move(60, 700); await sleep(900);
const left = await read();
await page.mouse.move(1400, 120); await sleep(900);
const right = await read();
console.log("bubble swing:", left.bubT, "->", right.bubT, "|", left.bubR, "->", right.bubR);
await browser.close();
