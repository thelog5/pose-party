/* PHOTO STRIPS probe.

   For each of the three boards (1v1 377:498, Party 381:616, Solo 381:757):
   - opens it for real through the dev results fixture and SEE PHOTO STRIPS,
     and shoots it at the four target viewports;
   - mounts it EMPTY (no photos, no labels, which is what the Figma frame
     is) at 1440x810 and shoots just the stage, for a pixel diff against the
     Figma render of that frame;
   - writes out the picture SAVE PHOTO STRIPS would download.

     APP_URL=http://localhost:8123 node _stripshot.mjs
*/
import puppeteer from "puppeteer-core";
import { mkdir, writeFile } from "node:fs/promises";
import { passCameraGate } from "./_gate.mjs";

const APP = process.env.APP_URL || "http://localhost:8123";
const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const OUT = process.env.OUT || "./shots";
await mkdir(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

const VIEWPORTS = [
  ["16x9",  1440, 810],
  ["16x10", 1512, 945],
  ["5x4",   1280, 1024],
  ["fhd",   1920, 1080],
  /* a laptop browser: a little taller than 16:9, which is what left thin
     page-coloured bars along two edges before the board filled the window */
  ["mbp",   1512, 860],
];
const BOARDS = [["1v1", "1v1-breakdown"], ["party", "breakdown"], ["solo", "solo"]];

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--no-first-run"],
});
const page = await browser.newPage();
const errors = [];
page.on("pageerror", e => errors.push(String(e)));
page.on("console", m => { if(m.type() === "error") errors.push(m.text()); });

await page.setViewport({ width:1440, height:810, deviceScaleFactor:1 });
await page.goto(APP, { waitUntil:"networkidle2", timeout:60000 });
await passCameraGate(page);
await page.waitForFunction(() => document.getElementById("video")?.videoWidth > 0,
  { timeout:60000, polling:100 });

for(const [layout, kind] of BOARDS){
  await page.evaluate(async kind => {
    const m = await import("/js/results.js");
    await m.devResults(kind);
  }, kind);
  await sleep(400);
  await page.click("#rsSeeStrips");
  await sleep(1800);
  const info = await page.evaluate(() => ({
    open: document.getElementById("resStage").dataset.strips,
    pieces: document.querySelectorAll("#psBoard .ps-piece").length,
    shots: document.querySelectorAll("#psBoard .ps-shot").length,
    labels: [...document.querySelectorAll("#psBoard .ps-label")].map(b => b.textContent),
  }));
  console.log(layout, JSON.stringify(info));

  for(const [name, width, height] of VIEWPORTS){
    await page.setViewport({ width, height, deviceScaleFactor:1 });
    await sleep(250);
    await page.screenshot({ path:`${OUT}/strips-${layout}-${name}.png` });
  }
  await page.setViewport({ width:1440, height:810, deviceScaleFactor:1 });
  await sleep(250);

  /* the saved picture */
  const b64 = await page.evaluate(async () => {
    const r = await import("/js/results.js");
    return r._renderStripsForTest ? await r._renderStripsForTest() : null;
  });
  if(b64) await writeFile(`${OUT}/strips-${layout}-saved.jpg`, Buffer.from(b64, "base64"));

  /* the empty board, against the Figma frame */
  await page.evaluate(async layout => {
    const ps = await import("/js/photoStrips.js");
    ps.mountPhotoStrips(document.getElementById("psBoard"), { layout, labels:{}, photos:{} });
  }, layout);
  await sleep(1900);
  const box = await page.evaluate(() => {
    const r = document.getElementById("resStage").getBoundingClientRect();
    return { x:r.x, y:r.y, width:r.width, height:r.height };
  });
  await page.screenshot({ path:`${OUT}/strips-${layout}-empty.png`, clip:box });

  await page.keyboard.press("Escape");
  await sleep(300);
  const closed = await page.evaluate(() => !document.getElementById("resStage").dataset.strips);
  console.log(layout, "Esc closes:", closed);
}

console.log(errors.length ? "ERRORS:\n" + errors.join("\n") : "no page errors");
await browser.close();
