/* HOW TO PLAY contact sheet. Opens the one shared card in each of its three
   modes and captures the panel alone, so the shipped screens can be laid
   beside Figma's own renders of 268:596 / 312:642 / 312:641. It also reports
   every laid-out box as a percentage of the panel, which is the form the
   Figma rects are in — a number that drifts is easier to see than a pixel. */
import puppeteer from "puppeteer-core";
import { mkdir } from "node:fs/promises";
import { passCameraGate } from "./_gate.mjs";

/* Layout only, so a static host is enough — same default as
   offline.test.mjs: `cd client && python3 -m http.server 8123`.
   Point APP_URL at the game server instead if you want a live room. */
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

await page.evaluate(async app => {
  window.__htp = await import(app + "/js/howToPlay.js");
}, APP);

/* every visible piece, as a percentage of the panel — Figma's own units */
const measure = () => page.evaluate(() => {
  const panel = document.getElementById("htpPanel").getBoundingClientRect();
  const out = [];
  for (const el of document.querySelectorAll("#htpPanel *")) {
    if (!el.offsetParent && getComputedStyle(el).position !== "fixed") continue;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    out.push({
      sel: el.tagName.toLowerCase() + (el.className && typeof el.className === "string"
        ? "." + el.className.trim().split(/\s+/).join(".") : ""),
      text: (el.textContent || "").trim().slice(0, 22),
      L: +((r.left - panel.left) / panel.width * 100).toFixed(3),
      T: +((r.top - panel.top) / panel.height * 100).toFixed(3),
      W: +(r.width / panel.width * 100).toFixed(3),
      H: +(r.height / panel.height * 100).toFixed(3),
      ar: +(r.width / r.height).toFixed(4),
    });
  }
  return out;
});

for (const mode of ["ai", "1v1", "party"]) {
  await page.evaluate(m => window.__htp.showHowToPlay({ mode: m, ready(){}, back(){} }), mode);
  await sleep(900);   // the drop animation must finish before anything is measured
  const rows = await measure();
  console.log(`\n===== ${mode} =====  (% of the 1088x643 panel)`);
  for (const r of rows)
    console.log(`  ${String(r.L).padStart(7)} ${String(r.T).padStart(7)} ${String(r.W).padStart(7)} ` +
                `${String(r.H).padStart(7)}  ar ${String(r.ar).padStart(7)}  ${r.sel}${r.text ? "  :: " + r.text : ""}`);
  const panel = await page.$("#htpPanel");
  await panel.screenshot({ path: `${OUT}/htp-${mode}.png`, omitBackground: true });
  await page.evaluate(() => window.__htp.hideHowToPlay());
  await sleep(200);
}

console.log("\nconsole errors:", errs.length ? errs : "none");
await browser.close();
