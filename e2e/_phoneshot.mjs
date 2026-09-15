/* Phone-landscape QA. Walks every screen a player can reach on one device at
   phone landscape sizes (touch, mobile viewport), screenshots each one, and
   lists every text whose ink runs past its own box.

   APP_URL must be a GAME server (the lobby needs sockets):
     cd server && PORT=3199 RATE_CREATE=500 RATE_JOIN=500 node index.js
     APP_URL=http://localhost:3199 node _phoneshot.mjs
   VIEWPORTS="844x390,667x375" limits the sizes. */
import puppeteer from "puppeteer-core";
import { mkdir } from "node:fs/promises";

const APP = process.env.APP_URL || "http://localhost:3199";
const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const OUT = process.env.OUT || "./shots/phone";
const sleep = ms => new Promise(r => setTimeout(r, ms));
await mkdir(OUT, { recursive: true });

/* iPhone SE, iPhone 14 in Safari (browser bars eat the height), iPhone 14 Pro
   Max, a common Android in Chrome. */
const VIEWPORTS = (process.env.VIEWPORTS || "667x375,750x340,844x390,932x430,780x360")
  .split(",").map(s => s.split("x").map(Number));
const ONLY = process.env.ONLY ? process.env.ONLY.split(",") : null;

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: "new",
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--no-first-run"],
});

/* Text whose ink leaves its own element's box, on the visible screen. */
const overflowScan = () => {
  const out = [];
  const shown = el => {
    for (let a = el; a && a !== document.documentElement; a = a.parentElement) {
      const cs = getComputedStyle(a);
      if (cs.display === "none" || cs.visibility === "hidden" || +cs.opacity < .05) return false;
      if (a.classList.contains("hidden")) return false;
    }
    return true;
  };
  for (const el of document.querySelectorAll("body *")) {
    if (/^(SCRIPT|STYLE|svg|use|symbol|OPTION)$/i.test(el.tagName)) continue;
    const own = [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim());
    if (!own || !shown(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    const rg = document.createRange(); rg.selectNodeContents(el);
    const t = rg.getBoundingClientRect();
    if (t.width < 1) continue;
    const over = {
      l: r.left - t.left, r: t.right - r.right, t: r.top - t.top, b: t.bottom - r.bottom,
    };
    const worst = Math.max(over.l, over.r, over.t, over.b);
    /* also: text cut by the window edge */
    const off = Math.max(-t.left, t.right - innerWidth, -t.top, t.bottom - innerHeight);
    if (worst > 2 || off > 1) out.push({
      el: (el.id ? "#" + el.id : el.tagName.toLowerCase()) +
        (typeof el.className === "string" && el.className ? "." + el.className.trim().split(/\s+/).join(".") : ""),
      text: el.textContent.trim().replace(/\s+/g, " ").slice(0, 36),
      over: Object.fromEntries(Object.entries(over).filter(([, v]) => v > 2).map(([k, v]) => [k, Math.round(v)])),
      offscreen: off > 1 ? Math.round(off) : undefined,
      font: getComputedStyle(el).fontSize,
    });
  }
  return out;
};

async function boot(w, h, { age = "ok" } = {}) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: w, height: h, deviceScaleFactor: 2, isMobile: true, hasTouch: true, isLandscape: true });
  page.on("pageerror", e => console.log("   PAGEERROR", e.message));
  await page.evaluateOnNewDocument(a => {
    try { if (a) localStorage.setItem("posePartyOnlineAge", a); else localStorage.removeItem("posePartyOnlineAge");
      localStorage.setItem("poseCharadesName", "Alexandria"); } catch (e) {}
  }, age);
  await page.goto(APP, { waitUntil: "networkidle2", timeout: 60000 });
  await page.waitForFunction(() => {
    const g = document.getElementById("camGate"); return g && !g.classList.contains("hidden");
  }, { timeout: 30000, polling: 50 });
  return { ctx, page };
}

const results = {};
async function snap(page, tag, w, h) {
  const name = `${w}x${h}-${tag}`;
  await page.screenshot({ path: `${OUT}/${name}.png` });
  const o = await page.evaluate(overflowScan);
  results[name] = o;
  console.log(`  ${name}: ${o.length ? o.length + " overflow" : "clean"}`);
  for (const x of o) console.log("     ", JSON.stringify(x));
}
const want = s => !ONLY || ONLY.includes(s);

async function atHome(w, h, opts) {
  const b = await boot(w, h, opts);
  await b.page.click("#cgEnable");
  await b.page.waitForFunction(() => document.getElementById("status").style.display === "none", { timeout: 60000 });
  await sleep(2600);
  return b;
}

for (const [w, h] of VIEWPORTS) {
  console.log(`\n== ${w}x${h}`);
  if (want("gate") || want("home")) {
    const { ctx, page } = await boot(w, h);
    await sleep(1400); await snap(page, "gate", w, h);
    await page.click("#cgEnable");
    await page.waitForFunction(() => document.getElementById("status").style.display === "none", { timeout: 60000 });
    await sleep(2600);
    await snap(page, "home", w, h);
    await ctx.close();
  }

  if (want("solo")) {
    const { ctx, page } = await atHome(w, h);
    await page.click("#modeAI");
    await page.waitForFunction(() => !document.getElementById("howToPlay").classList.contains("hidden"), { timeout: 8000 });
    await sleep(900);
    await snap(page, "solo-htp", w, h);
    await page.click("#htpReady");
    await sleep(900);
    await snap(page, "solo-framecheck", w, h);
    await page.waitForFunction(() => document.body.dataset.state === "playing", { timeout: 20000, polling: 50 });
    await sleep(1600);
    await snap(page, "solo-play", w, h);
    await page.evaluate(() => document.getElementById("btnExitSolo").click());
    await sleep(2500);
    await snap(page, "solo-results", w, h);
    await ctx.close();
  }

  if (want("lobby")) {
    let { ctx, page } = await atHome(w, h);
    await page.click("#modeVS");
    await page.waitForFunction(() => /^[A-Z2-9]{6}$/.test(document.getElementById("roomCodeText").textContent), { timeout: 10000, polling: 200 });
    await sleep(1400);
    await snap(page, "lobby-1v1", w, h);
    await ctx.close();
    ({ ctx, page } = await atHome(w, h));
    await page.click("#modeParty");
    await sleep(2400);
    await snap(page, "lobby-party", w, h);
    await ctx.close();
  }

  if (want("results")) {
    const { ctx, page } = await atHome(w, h);
    const tags = ["res-3v3", "res-2v2", "res-breakdown", "res-1v1", "res-1v1-breakdown", "res-solo"];
    for (const t of tags) {
      await page.evaluate(() => document.getElementById("btnDevResults").click());
      await sleep(1500);
      await snap(page, t, w, h);
    }
    if (await page.evaluate(() => {
      const b = document.getElementById("rsSeeStrips"); return !!b && b.offsetParent !== null;
    })) {
      await page.evaluate(() => document.getElementById("rsSeeStrips").click());
      await sleep(1800);
      await snap(page, "res-strips", w, h);
    }
    await ctx.close();
  }

  if (want("age")) {
    const { ctx, page } = await atHome(w, h, { age: null });
    await page.click("#modeVS");
    await sleep(1400);
    await snap(page, "age", w, h);
    await ctx.close();
  }
}

await browser.close();
const total = Object.values(results).reduce((n, o) => n + o.length, 0);
console.log(`\n${total} overflowing text nodes across ${Object.keys(results).length} shots`);
