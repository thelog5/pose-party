/* End-to-end drive of Pose Charades in headless Chrome with a fake camera.
   Vision input is simulated by seeding state.smooth (classifier output) and
   calling gameCheck() — everything else (FSM, game loop, DOM, dataset load,
   MediaPipe boot) is the real app. */
import puppeteer from "puppeteer-core";

const APP = process.env.APP_URL || "http://localhost:8123";
const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const sleep = ms => new Promise(r => setTimeout(r, ms));

let fails = 0;
const ok = (cond, msg) => { console.log((cond ? "  ok  " : "  FAIL") + " " + msg); if (!cond) fails++; };

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: [
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    "--no-first-run",
  ],
});
const page = await browser.newPage();

const consoleErrors = [];
page.on("console", m => { if (m.type() === "error") consoleErrors.push(m.text()); });
page.on("pageerror", e => consoleErrors.push("PAGEERROR: " + e.message));
page.on("response", r => { if (r.status() >= 400) consoleErrors.push(`HTTP ${r.status()} ${r.url()}`); });

await page.goto(APP, { waitUntil: "networkidle2", timeout: 60000 });

// helpers that reach into the live module graph (same instances the app uses)
const mod = (path) => `(await import('${APP}/js/${path}'))`;
const evalApp = (expr) => page.evaluate(`(async () => (${expr}))()`);

// ---- boot ----
await page.waitForFunction(
  () => document.getElementById("status").style.display === "none",
  { timeout: 60000 }
);
console.log("boot:");
ok(true, "engine + camera booted (status overlay hidden)");

const loaded = await evalApp(`${mod("state.js")}.state.dataset.clips.length`);
ok(loaded > 0, `bundled dataset loaded (${loaded} clips)`);
const hasModel = await evalApp(`!!${mod("state.js")}.state.model`);
ok(hasModel, "model trained on preload");

// ---- start game: countdown ----
console.log("play-with-ai:");
await page.click("#btnStart");
let st = await evalApp(`${mod("fsm.js")}.gameState()`);
ok(st === "countdown", `Start playing -> countdown (got ${st})`);
const cdVisible = await page.evaluate(() => !document.getElementById("countdown").classList.contains("hidden"));
ok(cdVisible, "countdown overlay visible");

await sleep(2900); // 3-2-1 at 800ms cadence
st = await evalApp(`${mod("fsm.js")}.gameState()`);
ok(st === "playing", `countdown -> playing (got ${st})`);
const word = await page.evaluate(() => document.getElementById("gameWord").textContent);
ok(word && word !== "—", `word displayed: "${word}"`);
const round = await page.evaluate(() => document.getElementById("pillRound").textContent);
ok(round === "1/5", `round pill 1/5 (got ${round})`);

// ---- simulate the player performing the word: seed smooth, run gameCheck ----
const winScript = `(async () => {
  const { state } = await import('${APP}/js/state.js');
  const { gameCheck } = await import('${APP}/js/game.js');
  const w = state.game.word;
  for (const l of state.model.labels) state.smooth[l] = 0.01;
  state.smooth[w] = 0.9;
  gameCheck();                       // starts holdSince
  await new Promise(r => setTimeout(r, 300));  // > HOLD_MS
  gameCheck();                       // should award
  return w;
})()`;
const wonWord = await page.evaluate(winScript);
st = await evalApp(`${mod("fsm.js")}.gameState()`);
ok(st === "word-won", `stable correct guess -> word-won (got ${st})`);
const burst = await page.evaluate(() => document.getElementById("pointBurst").classList.contains("show"));
ok(burst, "point burst animation showing");
const score1 = await page.evaluate(() => +document.getElementById("pillScore").textContent);
ok(score1 >= 100, `score awarded once (${score1} pts)`);

// double-award attempt while locked
await page.evaluate(`(async () => {
  const { gameCheck } = await import('${APP}/js/game.js');
  gameCheck(); gameCheck();
})()`);
const score2 = await page.evaluate(() => +document.getElementById("pillScore").textContent);
ok(score2 === score1, "scoring locked in word-won (no double award)");

await sleep(1300); // WORD_WON_PAUSE_MS
st = await evalApp(`${mod("fsm.js")}.gameState()`);
ok(st === "playing", `word-won -> playing (got ${st})`);
const round2 = await page.evaluate(() => document.getElementById("pillRound").textContent);
ok(round2 === "2/5", `advanced to round 2/5 (got ${round2})`);
const word2 = await page.evaluate(() => document.getElementById("gameWord").textContent);
ok(word2 !== wonWord, `new word swapped in: "${word2}"`);

// ---- skip path ----
await page.click("#btnSkip");
st = await evalApp(`${mod("fsm.js")}.gameState()`);
ok(st === "word-won", "skip -> word-won");
await sleep(1300);
const round3 = await page.evaluate(() => document.getElementById("pillRound").textContent);
ok(round3 === "3/5", `skip advanced to 3/5 (got ${round3})`);

// ---- quit -> results -> play again ----
await page.click("#btnQuit");
st = await evalApp(`${mod("fsm.js")}.gameState()`);
ok(st === "results", `quit -> results (got ${st})`);
const resTitle = await page.evaluate(() => document.querySelector("#rescard h2")?.textContent || "");
ok(/SCORE \d+/.test(resTitle), `results card rendered: "${resTitle}"`);

console.log("replay:");
await page.click("#btnAgain");
st = await evalApp(`${mod("fsm.js")}.gameState()`);
ok(st === "countdown", "play again -> countdown");

// ---- gear during countdown abandons cleanly ----
await page.click("#btnGear");
st = await evalApp(`${mod("fsm.js")}.gameState()`);
ok(st === "training", "gear during countdown -> training");
const gameGone = await evalApp(`${mod("state.js")}.state.game === null`);
ok(gameGone, "abandoned game torn down");
const cdHidden = await page.evaluate(() => document.getElementById("countdown").classList.contains("hidden"));
ok(cdHidden, "countdown overlay cancelled");

// ---- 1v1 local (robot rival) still works ----
console.log("local 1v1:");
await page.click("#btnDoneTrain");
await page.click("#modeVS");
st = await evalApp(`${mod("fsm.js")}.gameState()`);
ok(st === "lobby", `1v1 card opens lobby (got ${st})`);
const lobbyVis = await page.evaluate(() => !document.getElementById("railLobby").classList.contains("hidden"));
ok(lobbyVis, "lobby rail visible on static host (offline modes intact)");
await page.click("#btnPractice");
await sleep(2900);
st = await evalApp(`${mod("fsm.js")}.gameState()`);
const scr = await evalApp(`${mod("state.js")}.state.screen`);
ok(st === "playing" && scr === "versus", `vs mode playing on versus screen (${st}/${scr})`);
const vsWord = await page.evaluate(() => document.getElementById("vsWord").textContent);
ok(vsWord && vsWord !== "ARCHERY", `vs word is dynamic: "${vsWord}"`);
await page.click("#btnQuitVs");
st = await evalApp(`${mod("fsm.js")}.gameState()`);
ok(st === "results", "vs quit -> results");
await page.click("#btnHome");

// ---- console errors ----
console.log("hygiene:");
const realErrors = consoleErrors.filter(e =>
  !e.includes("favicon") && !e.includes("net::ERR_") // CDN hiccups aren't app bugs
);
ok(realErrors.length === 0, `no console/page errors (${realErrors.length})`);
realErrors.forEach(e => console.log("    " + e.slice(0, 200)));

await browser.close();
console.log(fails ? `\n${fails} FAILURES` : "\nALL E2E CHECKS PASSED");
process.exit(fails ? 1 : 0);
