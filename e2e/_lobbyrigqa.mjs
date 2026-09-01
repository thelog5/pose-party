/* QA probe for the lobby rig: hover bookkeeping, the 404 hunt, and the cost of
   a frame (eleven layers, each carrying Figma's per-layer drop shadow). */
import puppeteer from "puppeteer-core";

import { passCameraGate } from "./_gate.mjs";
const APP = process.env.APP_URL || "http://localhost:8123";
const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const sleep = ms => new Promise(r => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--no-first-run"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 810, deviceScaleFactor: 2 });
page.on("response", r => { if (r.status() >= 400) console.log("HTTP", r.status(), r.url()); });
page.on("pageerror", e => console.log("PAGEERROR", e.message));
await page.goto(APP, { waitUntil: "networkidle2", timeout: 60000 });
await passCameraGate(page);
await page.waitForFunction(() => document.getElementById("status").style.display === "none", { timeout: 60000 });
await page.click("#modeVS");
await page.waitForFunction(() => document.body.dataset.screen === "lobby", { timeout: 15000, polling: 40 });
await sleep(2400);

const hoverState = () => page.evaluate(() => {
  const rw = document.getElementById("lobbyRobotWait");
  return {
    hover: rw.matches(":hover"),
    lifted: getComputedStyle(rw).translate,
    top: +rw.getBoundingClientRect().top.toFixed(1),
    disabled: [...rw.querySelectorAll("img")].filter(i => i.style.pointerEvents === "none").length,
  };
});

for (const at of [[1400, 420], [1010, 300], [70, 300], [1010, 700]]) {
  await page.mouse.move(at[0], at[1]);
  await sleep(400);
  console.log("at", at.join(","), JSON.stringify(await hoverState()));
}

/* frame cost: eleven transforms + eleven drop shadows, measured over 3s */
await page.mouse.move(1300, 300);
const fps = await page.evaluate(() => new Promise(res => {
  const t = [];
  let last = performance.now();
  const tick = now => { t.push(now - last); last = now; if (t.length < 180) requestAnimationFrame(tick); else res(t); };
  requestAnimationFrame(tick);
}));
const sorted = fps.slice(5).sort((a, b) => a - b);
console.log("frame ms  median", sorted[sorted.length >> 1].toFixed(2),
  "p95", sorted[Math.floor(sorted.length * .95)].toFixed(2),
  "max", sorted[sorted.length - 1].toFixed(2));

/* the wave has to come back when the cursor stops mattering */
await page.evaluate(() => document.documentElement.dispatchEvent(new PointerEvent("pointerleave")));
await sleep(1600);
const waving = await page.evaluate(() => {
  const rot = () => {
    const m = new DOMMatrixReadOnly(getComputedStyle(document.querySelector('#lobbyRobotWait .pr-part[data-j="uarmL"]')).transform);
    return Math.atan2(m.b, m.a) * 180 / Math.PI;
  };
  return new Promise(res => {
    const seen = [];
    const t = setInterval(() => { seen.push(rot()); if (seen.length === 24) { clearInterval(t); res(seen); } }, 70);
  });
});
console.log("wave swing", (Math.max(...waving) - Math.min(...waving)).toFixed(2), "deg");

await browser.close();
