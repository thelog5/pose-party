/* Party-lobby team-panel probe. Boots the party lobby, seeds the roster
   render with fake members and screenshots each fill level, so the 2x2 grid
   (Figma `party blue` 134:320 / `party orange` 134:321) can be checked against
   the design without six headless clients. Also reports where each cell's
   painted box lands against the windows in `pt-frame-2x2.webp`. */
import puppeteer from "puppeteer-core";
import { mkdir } from "node:fs/promises";
import { passCameraGate } from "./_gate.mjs";

/* Layout only, so a static host is enough — same default as
   offline.test.mjs: `cd client && python3 -m http.server 8123`.
   Point APP_URL at the game server instead if you want a live room. */
const APP = process.env.APP_URL || "http://localhost:8123";
const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const OUT = process.env.OUT || "./shots";
const VIEWPORTS = (process.env.VIEWPORTS || "1440x810,1512x945,1280x1024,1920x1080")
  .split(",").map(v => v.split("x").map(Number));
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
/* On a static host the socket.io probe 404s by design — that is the
   "served without a game server" path the lobby detects and explains. */
const benign = t => /socket\.io|404/.test(t);
page.on("console", m => { if (m.type() === "error" && !benign(m.text())) errs.push(m.text()); });
page.on("pageerror", e => errs.push("PAGEERROR: " + e.message));

await page.goto(APP, { waitUntil: "networkidle2", timeout: 60000 });
await passCameraGate(page);
await page.waitForFunction(() => document.getElementById("status").style.display === "none", { timeout: 60000 });

await page.click("#modeParty");
await page.waitForFunction(() => document.body.dataset.screen === "lobby", { timeout: 15000, polling: 50 });
await sleep(1600);   // let the lobby entrance land before measuring anything

/* Paint the panels straight from the DOM the way renderTiles does. The real
   roster needs six sockets; what is under test here is the grid, not the mesh. */
async function fill(blue, orange) {
  await page.evaluate((blue, orange) => {
    const TILES = { blue: ["ptB0", "ptB1", "ptB2"], orange: ["ptO0", "ptO1", "ptO2"] };
    for (const [team, n] of [["blue", blue], ["orange", orange]]) {
      TILES[team].forEach((id, ix) => {
        const tile = document.getElementById(id);
        if (ix < n) {
          tile.innerHTML = '<span class="pt-name">' +
            '<img src="assets/ui/figma/lb-name-chip.webp" alt=""><b>PLAYER ' + (ix + 1) + '</b></span>';
          tile.style.background = ix % 2 ? "#2f5fb8" : "#7a5a3a";
        } else {
          tile.style.removeProperty("background");
          tile.innerHTML = '<div class="pt-empty"><img src="assets/ui/figma/pt-person.webp" alt="">' +
            '<span>WAITING FOR PLAYER</span></div>';
        }
      });
      const btn = document.getElementById(team === "blue" ? "btnJoinBlue" : "btnJoinOrange");
      btn.disabled = n >= 3;
      btn.querySelector("[data-join-label]").textContent = n >= 3 ? "TEAM IS FULL" : "JOIN THIS TEAM";
    }
  }, blue, orange);
  await sleep(260);
}

/* Where does each cell land against the frame art's own windows? The frame
   img is the reference box; the four windows were measured off the PNG alpha
   and are expressed as fractions of it. A tile must COVER its window on all
   four sides, or a strip of bare paper shows beside the video. */
const WIN = {   // [x0,x1,y0,y1] as fractions of pt-frame-2x2.webp
  TL: [97 / 1565, 701 / 1565, 78 / 1005, 462 / 1005],
  TR: [744 / 1565, 1342 / 1565, 78 / 1005, 462 / 1005],
  BL: [97 / 1565, 701 / 1565, 496 / 1005, 876 / 1005],
  BR: [744 / 1565, 1342 / 1565, 496 / 1005, 876 / 1005],
};
const coverage = () => page.evaluate(WIN => {
  const out = [];
  for (const [team, prefix, join] of [["blue", "ptB", "btnJoinBlue"], ["orange", "ptO", "btnJoinOrange"]]) {
    const frame = document.querySelector("." + (team === "blue" ? "party-blue-layer" : "party-orange-layer") + ".passthru");
    const f = frame.getBoundingClientRect();
    const cells = { TL: prefix + "0", TR: prefix + "1", BL: prefix + "2", BR: join };
    for (const [slot, id] of Object.entries(cells)) {
      const r = document.getElementById(id).getBoundingClientRect();
      const [x0, x1, y0, y1] = WIN[slot];
      const w = { left: f.left + x0 * f.width, right: f.left + x1 * f.width,
                  top: f.top + y0 * f.height, bottom: f.top + y1 * f.height };
      out.push({
        team, slot,
        /* positive = the tile overhangs the window (good); negative = a gap */
        left: +(w.left - r.left).toFixed(1),
        right: +(r.right - w.right).toFixed(1),
        top: +(w.top - r.top).toFixed(1),
        bottom: +(r.bottom - w.bottom).toFixed(1),
      });
    }
  }
  return out;
}, WIN);

for (const [w, h] of VIEWPORTS) {
  await page.setViewport({ width: w, height: h, deviceScaleFactor: 2 });
  await sleep(320);
  await fill(1, 3);
  const cov = await coverage();
  const worst = Math.min(...cov.flatMap(c => [c.left, c.right, c.top, c.bottom]));
  console.log(`\n=== ${w}x${h} ===  worst window overhang: ${worst.toFixed(1)}px ${worst < 0 ? "  <-- GAP" : ""}`);
  for (const c of cov)
    console.log(`  ${c.team.padEnd(6)} ${c.slot}  L${String(c.left).padStart(6)}  R${String(c.right).padStart(6)}` +
                `  T${String(c.top).padStart(6)}  B${String(c.bottom).padStart(6)}`);
  const stage = await page.$(".lobbystage");
  await stage.screenshot({ path: `${OUT}/party-teams-${w}x${h}.png` });
}

/* the fill levels, at the reference viewport */
await page.setViewport({ width: 1440, height: 810, deviceScaleFactor: 2 });
await sleep(320);
for (const [b, o] of [[0, 0], [1, 2], [3, 3]]) {
  await fill(b, o);
  const stage = await page.$(".lobbystage");
  await stage.screenshot({ path: `${OUT}/party-teams-fill-${b}${o}.png` });
}

console.log("\nconsole errors:", errs.length ? errs : "none");
await browser.close();
