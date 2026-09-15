/* A slow computer asks for lighter video, and gets it, on a real 1v1 link.
   Two players meet in a lobby on a real server. B is marked slow
   (setSlowComputer), then fast again. At each step this prints the video
   encoding of BOTH senders: A's link to B must go light when B is slow (so B
   decodes less), B's own must go light too (so B encodes less), and both must
   return to the browser defaults when B is fast again. */
import puppeteer from "puppeteer-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { passCameraGate } from "./_gate.mjs";

const PORT = 3459, APP = `http://localhost:${PORT}`;
const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const server = spawn("node", ["index.js"], { cwd:fileURLToPath(new URL("../server", import.meta.url)),
  env:{ ...process.env, PORT:String(PORT), ACCESS_CODE:"", RATE_CREATE:"30", RATE_JOIN:"60" }, stdio:"pipe" });
await new Promise((res, rej) => { server.stdout.on("data", d => String(d).includes("server running") && res());
  setTimeout(() => rej(new Error("server failed to start")), 5000); });
const browser = await puppeteer.launch({ executablePath:CHROME, headless:"new",
  args:["--use-fake-device-for-media-stream","--use-fake-ui-for-media-stream","--no-first-run"] });
let fails = 0;
const ok = (c, m) => { console.log((c ? "  ok  " : "  FAIL") + " " + m); if(!c) fails++; };

async function player(){
  const page = await (await browser.createBrowserContext()).newPage();
  await page.evaluateOnNewDocument(() => {
    const Real = window.RTCPeerConnection; window.__pcs = [];
    window.RTCPeerConnection = function(...a){ const pc = new Real(...a); window.__pcs.push(pc); return pc; };
    window.RTCPeerConnection.prototype = Real.prototype;
  });
  page.on("pageerror", e => console.log("PAGEERROR:", e.message));
  await page.goto(APP, { waitUntil:"networkidle2", timeout:60000 });
  await passCameraGate(page);
  await page.waitForFunction(() => document.getElementById("status").style.display === "none", { timeout:60000 });
  return page;
}
const encoding = page => page.evaluate(() => {
  const pc = window.__pcs.filter(p => p.connectionState !== "closed").at(-1);
  const s = pc?.getSenders().find(x => x.track?.kind === "video");
  const e = s?.getParameters().encodings?.[0] || {};
  return JSON.stringify({ scale:e.scaleResolutionDownBy, fps:e.maxFramerate, bitrate:e.maxBitrate });
});
const setSlow = (page, on) => page.evaluate(async on =>
  (await import("/js/speed.js")).setSlowComputer(on), on);

try{
  const [A, B] = await Promise.all([player(), player()]);
  await A.click("#modeVS");
  await A.waitForFunction(() => /^[A-Z2-9]{6}$/.test(document.getElementById("roomCodeText").textContent), { timeout:10000 });
  const code = await A.evaluate(() => document.getElementById("roomCodeText").textContent);
  await B.evaluate(c => { location.hash = "#join-" + c; }, code);
  const connected = p => p.waitForFunction(() => window.__pcs.some(pc => pc.connectionState === "connected"), { timeout:20000 });
  await Promise.all([connected(A), connected(B)]);
  await sleep(500);
  const before = [await encoding(A), await encoding(B)];
  console.log("both fast:", before);
  await setSlow(B, true); await sleep(800);
  const slow = [await encoding(A), await encoding(B)];
  console.log("B slow:   ", slow);
  const light = '{"scale":2,"fps":15,"bitrate":350000}';
  ok(slow[0] === light, "A sends B lighter video once B says it is slow");
  ok(slow[1] === light, "B encodes its own camera lighter");
  await setSlow(B, false); await sleep(800);
  const after = [await encoding(A), await encoding(B)];
  console.log("B fast:   ", after);
  ok(after[0] === before[0] && after[1] === before[1], "both links return to their normal video");
}finally{
  await browser.close(); server.kill();
}
process.exit(fails ? 1 : 0);
