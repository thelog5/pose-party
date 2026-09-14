/* Probe: word stats, end to end. A real server with STATS_TOKEN, a real Solo
   run in headless Chrome: one word the AI gets (after two wrong guesses), one
   word skipped. Then the totals page must show exactly that. The vision
   fixture stops the detector, so the probe also sends the classifier ticks
   engine.js would have sent (statsTick). */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";
import { installVisionFixture } from "./vision-fixture.mjs";
import { passCameraGate } from "./_gate.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 3791, APP = `http://localhost:${PORT}`, TOKEN = "probe-token";
const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0;
const ok = (c, m) => { console.log((c ? "  ok  " : "  FAIL") + " " + m); if(!c) fails++; };

const server = spawn("node", [path.join(ROOT, "server/index.js")],
  { env: { PATH: process.env.PATH, PORT: String(PORT), STATS_TOKEN: TOKEN }, stdio: "pipe" });
await new Promise((res, rej) => { server.stdout.on("data", d => String(d).includes("server running") && res());
  setTimeout(() => rej(new Error("server did not start")), 8000); });

const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new",
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--no-first-run"] });
try{
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 810 });
  const errors = []; page.on("pageerror", e => errors.push(e.message));
  await page.goto(APP, { waitUntil: "networkidle2", timeout: 60000 });
  await passCameraGate(page);
  await page.waitForFunction(() => document.getElementById("status").style.display === "none", { timeout: 60000 });
  await installVisionFixture(page);
  await page.click("#modeAI"); await sleep(700);
  await page.click("#htpReady");
  await page.waitForFunction(async () => (await import("/js/fsm.js")).gameState() === "playing", { timeout: 15000, polling: 100 });

  const feed = (which, conf) => page.evaluate(async (which, conf) => {
    clearInterval(window.__feed);
    const { state } = await import("/js/state.js");
    const { setModelOutput } = await import("/js/soloRound.js");
    const { statsTick } = await import("/js/wordStats.js");
    const label = which === "target" ? state.game.word
      : state.model.labels.filter(l => l !== state.game.word && l !== "idle")[0];
    window.__feed = setInterval(() => {
      window.__visionTick(label); setModelOutput(label, conf);
      state.smooth[label] = conf; statsTick(label, state.smooth[state.game.word] || 0);
    }, 80);
    return { label, word: state.game.word };
  }, which, conf);

  const wrong = await feed("wrong", .5); await sleep(1500);
  const first = await feed("target", .99);
  await page.waitForFunction(() => document.getElementById("spGuessTop").classList.contains("recognized"), { timeout: 15000, polling: 100 });
  await page.evaluate(() => clearInterval(window.__feed));
  await page.waitForFunction(async w => { const { state } = await import("/js/state.js"); return state.game?.word && state.game.word !== w; },
    { timeout: 15000, polling: 200 }, first.word);
  await page.waitForFunction(async () => (await import("/js/fsm.js")).gameState() === "playing", { timeout: 15000, polling: 100 });
  const second = await feed("wrong", .4); await sleep(800);
  await page.evaluate(() => clearInterval(window.__feed));
  await page.click("#btnSkipSolo"); await sleep(1500);
  await page.keyboard.press("Escape"); await sleep(1500);

  const auth = { authorization: "Basic " + Buffer.from("x:" + TOKEN).toString("base64"), accept: "application/json" };
  const snap = await (await fetch(`${APP}/stats`, { headers: auth })).json();
  const a = snap.words[first.word], b = snap.words[second.word];
  ok(snap.reports === 2, `two words reported (${snap.reports})`);
  ok(a?.got === 1 && a.msN === 1 && a.modes.ai?.got === 1, `"${first.word}" counted as got, with a time, in Solo`);
  ok(a && a.peakSum > .9, `its peak reflects how close the AI came (${a?.peakSum})`);
  ok(b?.skip === 1 && b.got === 0, `"${second.word}" counted as skipped`);
  ok(a?.wrong && Object.keys(a.wrong).length === 0, "a word the AI got keeps no wrong guess");
  ok(b?.wrong?.[second.label] === 1, `a skip keeps what the AI said instead ("${second.label}")`);
  ok(errors.length === 0, `no page errors (${errors.length})`);
}catch(e){ fails++; console.log("  FAIL (exception):", e.message); }
finally{ await browser.close(); server.kill(); }
console.log(fails ? `\n${fails} FAILURES` : "\nWORD STATS PROBE PASSED");
process.exit(fails ? 1 : 0);
