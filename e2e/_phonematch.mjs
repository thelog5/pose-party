/* Phone-landscape QA for the two online match boards. Plays a real 1v1 (two
   players) and a real 2v2 Party (four players) against a game server, then
   resizes player A through the phone sizes and screenshots the board, listing
   every text that runs out of its box SIDEWAYS (vertical ink past a tight
   line-height is normal and not reported).

     cd server && PORT=3199 RATE_CREATE=500 RATE_JOIN=500 node index.js
     APP_URL=http://localhost:3199 node _phonematch.mjs        (ONLY=1v1|party) */
import puppeteer from "puppeteer-core";
import { mkdir } from "node:fs/promises";
import { passCameraGate } from "./_gate.mjs";

const APP = process.env.APP_URL || "http://localhost:3199";
const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const OUT = process.env.OUT || "./shots/phone";
const ONLY = process.env.ONLY || "";
const VIEWPORTS = (process.env.VIEWPORTS || "667x375,750x340,844x390,932x430,1440x810")
  .split(",").map(s => s.split("x").map(Number));
const sleep = ms => new Promise(r => setTimeout(r, ms));
await mkdir(OUT, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: "new",
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--no-first-run"],
});

const sideways = () => {
  const out = [];
  const shown = el => {
    for (let a = el; a && a !== document.documentElement; a = a.parentElement) {
      const cs = getComputedStyle(a);
      if (cs.display === "none" || cs.visibility === "hidden" || +cs.opacity < .05 ||
          a.classList.contains("hidden")) return false;
    }
    return true;
  };
  for (const el of document.querySelectorAll("body *")) {
    if (/^(SCRIPT|STYLE|svg|use|symbol|OPTION)$/i.test(el.tagName)) continue;
    if (![...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim()) || !shown(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1) continue;
    const rg = document.createRange(); rg.selectNodeContents(el);
    const t = rg.getBoundingClientRect();
    const over = Math.max(r.left - t.left, t.right - r.right);
    if (over > 2 && !el.classList.contains("sr-only")) out.push(
      `${el.id || el.className} "${el.textContent.trim().slice(0, 30)}" +${Math.round(over)}px`);
  }
  return out;
};

async function player(name) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: 844, height: 390, deviceScaleFactor: 2, isMobile: true, hasTouch: true, isLandscape: true });
  await page.evaluateOnNewDocument(n => { try { localStorage.setItem("poseCharadesName", n);
    localStorage.setItem("posePartyOnlineAge", "ok"); } catch (e) {} }, name);
  page.on("pageerror", e => console.log("  PAGEERROR", name, e.message));
  await page.goto(APP, { waitUntil: "networkidle2", timeout: 60000 });
  await passCameraGate(page);
  await page.waitForFunction(() => document.getElementById("status").style.display === "none", { timeout: 60000 });
  await sleep(1800);
  return { ctx, page };
}
const readyUp = async p => {
  await p.waitForFunction(() => !document.getElementById("howToPlay").classList.contains("hidden"),
    { timeout: 15000 }).catch(() => {});
  if (await p.evaluate(() => !document.getElementById("howToPlay").classList.contains("hidden")))
    await p.evaluate(() => document.getElementById("htpReady").click());
};
/* Headless tabs in the background are throttled, so the first player is
   brought to the front while the room counts in. */
async function waitPlaying(pages) {
  for (let i = 0; i < 60; i++) {
    const st = await pages[0].evaluate(() => document.body.dataset.state);
    if (st === "playing") return;
    await pages[0].bringToFront(); await sleep(1000);
  }
  throw new Error("match never reached playing");
}
async function shoot(page, tag) {
  for (const [w, h] of VIEWPORTS) {
    await page.setViewport({ width: w, height: h, deviceScaleFactor: 2, isMobile: true, hasTouch: true, isLandscape: true });
    await sleep(700);
    await page.screenshot({ path: `${OUT}/${w}x${h}-${tag}.png` });
    const o = await page.evaluate(sideways);
    console.log(`  ${w}x${h}-${tag}: ${o.length ? o.join(" | ") : "clean"}`);
  }
}

if (!ONLY || ONLY === "1v1") {
  console.log("1v1 match");
  const [A, B] = await Promise.all([player("Alexandria"), player("Bartholomew")]);
  await A.page.click("#modeVS");
  await A.page.waitForFunction(() => /^[A-Z2-9]{6}$/.test(document.getElementById("roomCodeText").textContent), { timeout: 15000 });
  const code = await A.page.evaluate(() => document.getElementById("roomCodeText").textContent);
  await B.page.evaluate(c => { location.hash = "#join-" + c; }, code);
  await A.page.waitForFunction(() => !document.getElementById("btnStartMatch").disabled, { timeout: 20000 });
  await sleep(800);
  await shoot(A.page, "lobby-1v1-joined");
  await A.page.evaluate(() => document.getElementById("btnStartMatch").click());
  await Promise.all([readyUp(A.page), readyUp(B.page)]);
  await waitPlaying([A.page, B.page]);
  await sleep(1500);
  await shoot(A.page, "match-1v1");
  await A.ctx.close(); await B.ctx.close();
}

if (!ONLY || ONLY === "party") {
  console.log("party match");
  const ps = await Promise.all(["Alexandria", "Bartholomew", "Cara", "Dan"].map(player));
  const A = ps[0].page;
  await A.click("#modeParty");
  await A.waitForFunction(() => /^[A-Z2-9]{6}$/.test(document.getElementById("roomCodeText").textContent), { timeout: 15000 });
  const code = await A.evaluate(() => document.getElementById("roomCodeText").textContent);
  for (const { page: p } of ps.slice(1)) {
    await p.click("#modeParty");
    await p.waitForFunction(() => /^[A-Z2-9]{6}$/.test(document.getElementById("roomCodeText").textContent), { timeout: 15000 });
    await p.evaluate(() => { document.getElementById("joinCode").value = ""; });
    await p.type("#joinCode", code);
    await p.click("#btnJoinRoom");
    await p.waitForFunction(c => document.getElementById("roomCodeText").textContent === c, { timeout: 15000 }, code);
  }
  await A.waitForFunction(() => !document.getElementById("btnStartMatch").disabled, { timeout: 20000 });
  await sleep(800);
  await shoot(A, "lobby-party-full");
  await A.evaluate(() => document.getElementById("btnStartMatch").click());
  await Promise.all(ps.map(({ page }) => readyUp(page)));
  await waitPlaying(ps.map(p => p.page));
  await sleep(1500);
  await shoot(A, "match-party");

  for (const p of ps) await p.ctx.close();
}

await browser.close();
