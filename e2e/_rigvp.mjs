/* Both rigs across the four viewports CLAUDE.md requires. Every .pr-* value is
   a percentage of its stage or a cqw of the rig's own root, so the ink must
   land on the same fraction of the stage at every aspect. */
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
await page.setViewport({ width: 1440, height: 810 });
await page.goto(APP, { waitUntil: "networkidle2", timeout: 60000 });
await passCameraGate(page);
await page.waitForFunction(() => document.getElementById("status").style.display === "none", { timeout: 60000 });
await sleep(2200);
const box = (stage, sel) => page.evaluate(([s, q]) => {
  const st = document.getElementById(s).getBoundingClientRect();
  const r = document.querySelector(q).getBoundingClientRect();
  return { l:+((r.left-st.left)/st.width*100).toFixed(2), t:+((r.top-st.top)/st.height*100).toFixed(2),
           w:+(r.width/st.width*100).toFixed(2), h:+(r.height/st.height*100).toFixed(2) };
}, [stage, sel]);
const VPS = [[1440,810,"16x9"],[1512,945,"16x10"],[1280,1024,"5x4"],[1920,1080,"fhd"]];
for (const [w,h,n] of VPS) {
  await page.setViewport({ width:w, height:h }); await sleep(450);
  await page.mouse.move(Math.round(w*.7), Math.round(h*.3)); await sleep(700);
  console.log("home ", n.padEnd(6), JSON.stringify(await box("homeStage", "#homeRobot")));
  await page.screenshot({ path:`${OUT}/home-${n}.png` });
}
await page.setViewport({ width:1440, height:810 }); await sleep(300);
await page.click("#modeVS");
await page.waitForFunction(() => document.body.dataset.screen === "lobby", { timeout:15000, polling:40 });
await sleep(2200);
for (const [w,h,n] of VPS) {
  await page.setViewport({ width:w, height:h }); await sleep(450);
  await page.mouse.move(Math.round(w*.5), Math.round(h*.3)); await sleep(700);
  const b = await box("lobbyStage", "#lobbyRobotWait");
  const centred = await page.evaluate(() => {
    const slot = document.getElementById("slotLobbyRival").getBoundingClientRect();
    const rw = document.getElementById("lobbyRobotWait").getBoundingClientRect();
    /* ink is 60..1082 of the 1087 art rect */
    const s = rw.width/1087, il = rw.left+60*s, ir = rw.left+1082*s;
    return +(((il+ir)/2) - (slot.left+slot.width/2)).toFixed(1);
  });
  console.log("lobby", n.padEnd(6), JSON.stringify(b), "ink centre off panel centre:", centred + "px");
  await page.screenshot({ path:`${OUT}/lobby-${n}.png` });
}
await browser.close();
