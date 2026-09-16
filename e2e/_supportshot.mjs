/* BUY ME A RED BULL + the boot gate's agreement notice.

   Two pieces of chrome that both sit on a strip of somebody else's
   composition, so both have to be measured rather than eyeballed:

   - Home's support paper rides the legal row on the blue wave. The wave is
     the only clear strip along the bottom: the robot's boots hold the left,
     the SOLO card the right, and the maker's boat starts at 65.5%. This
     reports the row's box against the boat and against the stage edges.
   - The gate's notice replaced two bare links with a sentence, so it can now
     WRAP. This reports its box against the card above it and the screen
     bottom below it, and flags any horizontal overflow.

   Serve the game folder on 8123 first, e.g.
     (cd pose-charades-external-data && python3 -m http.server 8123)
   then  node _supportshot.mjs                                          */
import puppeteer from "puppeteer-core";
import { mkdir } from "node:fs/promises";

const APP = process.env.APP_URL || "http://localhost:8123";
const CHROME = process.env.CHROME_PATH ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const OUT = process.env.OUT || "./shots";
await mkdir(OUT, { recursive: true });

const VIEWPORTS = [
  ["16x9",  1440, 810],
  ["5x4",   1280, 1024],
  ["fhd",   1920, 1080],
  ["phone", 844, 390],
  ["phone-narrow", 667, 375],
  ["phone-short", 750, 340],
];

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream",
         "--no-first-run"],
});
const page = await browser.newPage();
/* every entry point has to answer the camera card; this one also has to see
   the card before it answers it */
await page.evaluateOnNewDocument(() => {
  try{ localStorage.setItem("posePartyOnlineAge", "ok"); }catch(e){}
});
const sleep = ms => new Promise(r => setTimeout(r, ms));

for(const [name, w, h] of VIEWPORTS){
  await page.setViewport({ width:w, height:h });
  await page.goto(APP, { waitUntil:"networkidle2" });
  await page.waitForSelector("#cgEnable", { visible:true });
  await sleep(400);

  const gate = await page.evaluate(() => {
    const el = document.getElementById("cgLegal");
    const panel = document.getElementById("cgPanel");
    const r = el.getBoundingClientRect(), p = panel.getBoundingClientRect();
    return {
      text: el.textContent.replace(/\s+/g, " ").trim(),
      links: [...el.querySelectorAll("a")].map(a => a.textContent.trim()),
      lines: Math.round(r.height / parseFloat(getComputedStyle(el).lineHeight)),
      overflowsX: r.left < 0 || r.right > innerWidth,
      gapUnderCard: +(r.top - p.bottom).toFixed(1),
      gapToBottom: +(innerHeight - r.bottom).toFixed(1),
    };
  });
  console.log(`\n[${name} ${w}x${h}] GATE`);
  console.log("  ", gate.text);
  console.log("   links:", gate.links.join(" / "),
    "| lines:", gate.lines,
    "| overflow:", gate.overflowsX,
    "| under card:", gate.gapUnderCard, "| to bottom:", gate.gapToBottom);
  await page.screenshot({ path:`${OUT}/gate-legal-${name}.png` });

  await page.click("#cgEnable");
  await page.waitForFunction(() => document.body.dataset.screen === "menu",
    { timeout:15000 }).catch(() => {});
  await sleep(900);

  const home = await page.evaluate(() => {
    const el = document.getElementById("homeSupport");
    if(el) el.hidden = false;      // the probe shows it whatever SUPPORT_URL says
    const stage = document.querySelector(".homestage");
    const s = stage.getBoundingClientRect();
    /* the NAV BOX is fixed at 40%..60%; what can actually collide is the
       CONTENT, which is centred and free to overflow that box both ways */
    const kids = [...document.querySelector(".home-legal").children]
      .map(n => n.getBoundingClientRect());
    const nav = {
      left: Math.min(...kids.map(r => r.left)),
      right: Math.max(...kids.map(r => r.right)),
      bottom: Math.max(...kids.map(r => r.bottom)),
      top: Math.min(...kids.map(r => r.top)),
    };
    const navTop = nav.top;
    const boat = document.getElementById("homeBoat").getBoundingClientRect();
    const pct = (v, base, origin) => +(((v - origin) / base) * 100).toFixed(2);
    return {
      shown: !!el,
      row: { l:pct(nav.left, s.width, s.left), r:pct(nav.right, s.width, s.left),
             b:+(s.bottom - nav.bottom).toFixed(1) },
      boatL: pct(boat.left, s.width, s.left),
      /* a true rect intersection, not an x test: the boat hangs off the
         bottom of the board and its box may not reach the row's line at all */
      clearsBoat: !(nav.right > boat.left && nav.left < boat.right &&
                    nav.bottom > boat.top && navTop < boat.bottom),
      xOverlapOnly: nav.right > boat.left,
      insideStage: nav.left >= s.left && nav.right <= s.right,
    };
  });
  console.log(`[${name}] HOME support row`,
    `x ${home.row.l}%..${home.row.r}% | boat starts ${home.boatL}%`,
    `| clears boat: ${home.clearsBoat} | on stage: ${home.insideStage}`,
    `| ${home.row.b}px off the bottom`);
  await page.screenshot({ path:`${OUT}/home-support-${name}.png` });
}

await browser.close();
