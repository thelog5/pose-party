/* The party results board: where Figma's confetti lands, and what paints over
   the logo. Reports each scrap's box as a percentage of the stage (compare it
   with the node's rectangle in 203:367 / 203:581), reports the logo band, and
   shoots the whole board plus its top-left corner at 3v3, 2v2 and 1v1.

   The two logo tapes are pointer-events:none, so `elementFromPoint` answers
   with the card underneath whichever way they paint: this reads the
   z-indexes and leaves the corner crop to the eye.

   Against a static host on 8124:
     cd pose-charades-external-data && python3 -m http.server 8124
     cd e2e && node _confshot.mjs                 # shots land in ./shots */
import puppeteer from "puppeteer-core";
import { mkdir } from "node:fs/promises";
import { passCameraGate } from "./_gate.mjs";

const APP = process.env.APP_URL || "http://localhost:8124";
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
await page.goto(APP + "/?dev", { waitUntil: "networkidle2", timeout: 60000 });
await passCameraGate(page);
await page.waitForFunction(() => document.getElementById("status").style.display === "none", { timeout: 60000 });

/* devResults() seeds its stills asynchronously, so the clicks have to be one
   at a time: fired in a burst, an earlier call finishes last and wins. */
const dev = async kind => {
  for (let i = 0; i < 8; i++) {
    const at = await page.evaluate(() =>
      document.getElementById("btnDevResults").dataset.kind || "breakdown");
    if (at === kind) return;
    await page.click("#btnDevResults");
    await sleep(1400);
  }
  throw new Error("could not reach " + kind);
};

const report = async label => {
  const data = await page.evaluate(() => {
    const st = document.getElementById("resStage");
    const r = st.getBoundingClientRect();
    const pct = el => {
      const b = el.getBoundingClientRect();
      return {
        left: +((b.left - r.left) / r.width * 100).toFixed(3),
        top: +((b.top - r.top) / r.height * 100).toFixed(3),
        w: +(b.width / r.width * 100).toFixed(3),
        h: +(b.height / r.height * 100).toFixed(3),
      };
    };
    const conf = [...st.querySelectorAll(".rs-conf")].map(el => ({
      cls: el.className,
      shown: getComputedStyle(el).display !== "none",
      box: pct(el),
      z: getComputedStyle(el).zIndex,
    }));
    const zOf = sel => getComputedStyle(st.querySelector(sel)).zIndex;
    return {
      size: st.dataset.size, mode: st.dataset.mode, page: st.dataset.page,
      conf,
      /* the tapes are drawn after the Title Card in Figma, so they must paint
         over it. Both are pointer-events:none, so elementFromPoint answers
         with the card whatever the order: read the z-indexes and the crop. */
      z: { title: zOf(".rs-title"), tapeY: zOf(".rs-tape-logo-yellow"), tapeC: zOf(".rs-tape-logo-cream") },
      logoCorner: pct(st.querySelector(".rs-title")),
    };
  });
  console.log(label, JSON.stringify(data, null, 1));
  await page.screenshot({ path: `${OUT}/conf-${label}.png` });
  const st = await page.$("#resStage");
  const r = await st.boundingBox();
  await page.screenshot({
    path: `${OUT}/logo-${label}.png`,
    clip: { x: r.x, y: r.y, width: r.width * .22, height: r.height * .3 },
  });
};

await dev("3v3"); await report("3v3");
await dev("2v2"); await report("2v2");
await dev("1v1"); await report("1v1");

await dev("2v2");

/* HOVER. The lift is written with the individual transform properties, so it
   has to survive alongside the tap reaction's own `transform`. The pointer
   goes on the INK, not the box centre: a triangle's centre is paper, but the
   star's is too thin in places to trust, so each piece is probed at a point
   the alpha map accepts. */
const hover = await (async () => {
  const at = await page.evaluate(() => {
    const el = document.querySelector("#resStage .rs-conf-bm");
    const b = el.getBoundingClientRect();
    /* the red triangle's ink is the lower middle of its box */
    return { x: b.left + b.width * .5, y: b.top + b.height * .62 };
  });
  await page.mouse.move(at.x, at.y);
  await sleep(320);
  const on = await page.evaluate(() => {
    const el = document.querySelector("#resStage .rs-conf-bm");
    const s = getComputedStyle(el);
    return { translate: s.translate, scale: s.scale, rotate: s.rotate,
             pe: el.style.pointerEvents || "(auto)" };
  });
  await page.mouse.move(at.x, at.y - 400);
  await sleep(320);
  const off = await page.evaluate(() => {
    const s = getComputedStyle(document.querySelector("#resStage .rs-conf-bm"));
    return { translate: s.translate, scale: s.scale, rotate: s.rotate };
  });
  return { on, off };
})();
console.log("hover", JSON.stringify(hover));

/* ALPHA ROUTING. A transparent corner of the scrap must hand the pointer to
   whatever is under it, or a square box swallows a seat's clicks. */
const alpha = await (async () => {
  const at = await page.evaluate(() => {
    const el = document.querySelector("#resStage .rs-conf-bm");
    const b = el.getBoundingClientRect();
    return { x: b.left + 3, y: b.top + 3 };          // top-left: empty paper
  });
  await page.mouse.move(at.x, at.y);
  await sleep(120);
  return page.evaluate(p => {
    const el = document.querySelector("#resStage .rs-conf-bm");
    const under = document.elementFromPoint(p.x, p.y);
    return { pe: el.style.pointerEvents || "(auto)",
             under: under && (under.id || under.className || under.tagName) };
  }, at);
})();
console.log("alpha corner", JSON.stringify(alpha));

/* a tap must make one of the three reactions land */
const tapped = await page.evaluate(async () => {
  const el = document.querySelector("#resStage .rs-conf-bm");
  const b = el.getBoundingClientRect();
  el.click();
  await new Promise(r => requestAnimationFrame(r));
  return { classes: el.className, anim: getComputedStyle(el).animationName,
           cursor: getComputedStyle(el).cursor, box: [b.width | 0, b.height | 0] };
});
console.log("tap", JSON.stringify(tapped));
console.log("errors", errs);
await browser.close();
