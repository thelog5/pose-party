/* ENABLE CAMERA vertical placement probe.

   The card is a composition whose BOX is not its visual mass: the panel
   rectangle runs from the title card hanging off the top (.6849%) to the
   bottom of the cream paper (~99.2%), but the paper itself only starts at
   16.301%. So centring the box leaves the paper sitting below the middle of
   the screen, which is what reads as "too low".

   Reports, per viewport: the panel box, the paper inside it, and the scrim
   left above and below each. Shoots a screenshot beside it. */
import puppeteer from "puppeteer-core";
import { mkdir } from "node:fs/promises";

const APP = process.env.APP_URL || "http://localhost:8123";
const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const OUT = process.env.OUT || "./shots";
await mkdir(OUT, { recursive: true });

const VIEWPORTS = [
  ["16x9",  1440, 810],
  ["16x10", 1512, 945],
  ["5x4",   1280, 1024],
  ["fhd",   1920, 1080],
];

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--no-first-run"],
});
const page = await browser.newPage();

for(const [name, width, height] of VIEWPORTS){
  await page.setViewport({ width, height, deviceScaleFactor: 1 });
  await page.goto(APP, { waitUntil: "networkidle2", timeout: 60000 });
  await page.waitForFunction(() => {
    const g = document.getElementById("camGate");
    return g && !g.classList.contains("hidden");
  }, { timeout: 30000, polling: 50 });
  /* the card drops in on htpDrop; measure it landed, not mid-flight */
  await new Promise(r => setTimeout(r, 900));

  const m = await page.evaluate(() => {
    const r = el => { const b = el.getBoundingClientRect();
      return { top:b.top, bottom:b.bottom, h:b.height, w:b.width }; };
    return {
      vh: innerHeight,
      panel: r(document.querySelector(".cg-panel")),
      paper: r(document.querySelector(".cg-paper")),
      title: r(document.querySelector(".cg-titlecard")),
      btn:   r(document.querySelector("#cgEnable")),
    };
  });
  const pct = v => (v / m.vh * 100).toFixed(1);
  console.log(`\n${name} ${width}x${height}`);
  console.log(`  panel   top ${pct(m.panel.top)}%  bottom ${pct(m.panel.bottom)}%  (above ${pct(m.panel.top)}%, below ${pct(m.vh - m.panel.bottom)}%)`);
  console.log(`  paper   top ${pct(m.paper.top)}%  bottom ${pct(m.paper.bottom)}%  (above ${pct(m.paper.top)}%, below ${pct(m.vh - m.paper.bottom)}%)`);
  console.log(`  paper centre  ${pct(m.paper.top + m.paper.h/2)}%  (50% = optically centred)`);
  console.log(`  button centre ${pct(m.btn.top + m.btn.h/2)}%`);
  console.log(`  title top ${pct(m.title.top)}%`);

  await page.screenshot({ path: `${OUT}/gate-${name}.png` });
}
await browser.close();
