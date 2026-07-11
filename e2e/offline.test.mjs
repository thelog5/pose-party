/* Offline E2E: drives the POSE PARTY UI in headless Chrome with a fake
   camera against a static host. Vision input is simulated by seeding
   state.smooth (classifier output) and calling gameCheck(); everything else
   (FSM, scoring, DOM, dataset load, MediaPipe boot) is the real app. */
import puppeteer from "puppeteer-core";

const APP = process.env.APP_URL || "http://localhost:8123";
const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const sleep = ms => new Promise(r => setTimeout(r, ms));

let fails = 0;
const ok = (cond, msg) => { console.log((cond ? "  ok  " : "  FAIL") + " " + msg); if (!cond) fails++; };

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--no-first-run"],
});
const page = await browser.newPage();

const consoleErrors = [];
page.on("console", m => { if (m.type() === "error") consoleErrors.push(m.text() + " @" + (m.location()?.url || "")); });
page.on("pageerror", e => consoleErrors.push("PAGEERROR: " + e.message));
page.on("response", r => { if (r.status() >= 400) consoleErrors.push(`HTTP ${r.status()} ${r.url()}`); });

await page.goto(APP, { waitUntil: "networkidle2", timeout: 60000 });

const mod = (path) => `(await import('${APP}/js/${path}'))`;
const evalApp = (expr) => page.evaluate(`(async () => (${expr}))()`);
const txt = sel => page.evaluate(s => document.querySelector(s)?.textContent ?? null, sel);
const fsmState = () => evalApp(`${mod("fsm.js")}.gameState()`);
const bodyScreen = () => page.evaluate(() => document.body.dataset.screen);

// ---- boot ----
await page.waitForFunction(() => document.getElementById("status").style.display === "none", { timeout: 60000 });
console.log("boot:");
ok(true, "engine + camera booted (status overlay hidden)");
ok(await bodyScreen() === "home", "home screen visible");
const loaded = await evalApp(`${mod("state.js")}.state.dataset.clips.length`);
ok(loaded > 0, `bundled dataset loaded (${loaded} clips)`);
ok(await evalApp(`!!${mod("state.js")}.state.model`), "model trained on preload");
const dockParent = await page.evaluate(() => document.getElementById("cameraDock").parentElement.id);
ok(dockParent === "slotHome", `camera dock mounted on home (${dockParent})`);

// ---- solo: LET'S GO -> countdown -> playing ----
console.log("solo play:");
await page.click("#btnLetsGo");
ok(await fsmState() === "countdown", "LET'S GO -> countdown");
ok(!(await page.evaluate(() => document.getElementById("countdown").classList.contains("hidden"))), "countdown overlay visible");
await sleep(2900);
ok(await fsmState() === "playing", "countdown -> playing");
ok(await bodyScreen() === "solo", "solo screen shown");
ok(await page.evaluate(() => document.getElementById("cameraDock").parentElement.id) === "slotSolo", "camera dock moved to solo");
const word = await txt("#soloWord");
ok(word && word !== "—", `word displayed: "${word}"`);
ok(await txt("#pillRound") === "1 / 5", "round pill 1 / 5");
ok(/^\d\d:\d\d$/.test(await txt("#pillTime")), `timer is mm:ss (${await txt("#pillTime")})`);
ok(await txt("#pillStreak") === "x1", "streak starts at x1");

// win the word (fast => (100+100)*1 = 200)
const winScript = `(async () => {
  const { state } = await import('${APP}/js/state.js');
  const { gameCheck } = await import('${APP}/js/game.js');
  const w = state.game.word;
  for (const l of state.model.labels) state.smooth[l] = 0.01;
  state.smooth[w] = 0.9;
  gameCheck();
  await new Promise(r => setTimeout(r, 300));
  gameCheck();
  return w;
})()`;
const wonWord = await page.evaluate(winScript);
ok(await fsmState() === "word-won", "stable correct guess -> word-won");
ok(await page.evaluate(() => document.getElementById("pointBurst").classList.contains("show")), "point burst showing");
const score1 = await txt("#pillScore");
ok(score1 === "200", `fast win pays 200 (got ${score1})`);

// double-award attempt while locked
await page.evaluate(`(async () => { const { gameCheck } = await import('${APP}/js/game.js'); gameCheck(); gameCheck(); })()`);
ok(await txt("#pillScore") === score1, "scoring locked in word-won (no double award)");

await sleep(1300);
ok(await fsmState() === "playing", "word-won -> playing");
ok(await txt("#pillRound") === "2 / 5", "advanced to round 2 / 5");
const word2 = await txt("#soloWord");
ok(word2 !== wonWord, `new word swapped in: "${word2}"`);

// second fast win: streak x2 => (100+100)*2 = 400 => total 600
await page.evaluate(winScript);
ok(await txt("#pillScore") === "600", `streak x2 win pays 400 (total ${await txt("#pillScore")})`);
ok(await txt("#pillStreak") === "x2", "streak pill x2");
await sleep(1300);

// skip: -500 and streak resets
await page.click("#btnSkipSolo");
ok(await fsmState() === "word-won", "skip -> word-won");
await sleep(1300);
ok(await txt("#pillScore") === "100", `skip cost 500 (total ${await txt("#pillScore")})`);
ok(await txt("#pillStreak") === "x1", "skip broke the streak");
ok(await txt("#pillRound") === "4 / 5", "skip advanced the round");

// quit -> results
await page.click("#btnExitSolo");
ok(await fsmState() === "results", "exit -> results");
ok(/SCORE 100/.test(await txt("#rescard h2")), `results title (${await txt("#rescard h2")})`);

console.log("replay + training:");
await page.click("#btnAgain");
ok(await fsmState() === "countdown", "play again -> countdown");
await page.click("#btnExitSolo"); // header shows pills during play; exit is the way out
ok(await fsmState() === "results", "exit during countdown -> results");
ok(await evalApp(`${mod("state.js")}.state.game === null`), "abandoned game torn down");
ok(await page.evaluate(() => document.getElementById("countdown").classList.contains("hidden")), "countdown overlay cancelled");
await page.click("#btnHome");
ok(await fsmState() === "menu", "home from results");
await page.click("#btnGear");
ok(await fsmState() === "training", "SETTINGS opens training");
ok(await page.evaluate(() => document.getElementById("cameraDock").parentElement.id) === "slotTrain", "camera dock on training screen");
await page.click("#btnDoneTrain");
ok(await fsmState() === "menu", "done -> home");

// ---- 1v1 lobby (static host: server unreachable, graceful message) ----
console.log("1v1 lobby (no server):");
await page.click("#modeVS");
ok(await fsmState() === "lobby", "1v1 card opens lobby");
ok(await bodyScreen() === "lobby", "lobby screen shown");
await page.waitForFunction(
  () => /Can’t reach the game server/.test(document.getElementById("lobbyStatus").textContent),
  { timeout: 20000 }
);
ok(true, "graceful no-server message shown");
ok(await page.evaluate(() => document.getElementById("btnStartMatch").disabled), "START disabled without a rival");

// ---- party waiting room ----
console.log("party lobby:");
await page.click("#logoHome");
await page.click("#modeParty");
ok(await fsmState() === "party", "Team Rush card opens party waiting room");
ok(await bodyScreen() === "party", "party screen shown");
const code = await txt("#partyCode");
ok(/^[A-Z2-9]{6}$/.test(code), `party room code rendered (${code})`);
ok(await page.evaluate(() => document.getElementById("cameraDock").parentElement.id) === "partySlot", "your live tile holds the camera");
ok(await txt("#blueCnt") === "2 / 6", "blue team 2/6 (you + robot)");
await page.click("#btnJoinOrange");
ok(await txt("#orangeCnt") === "2 / 6", "switched to orange (2/6)");
ok(await txt("#blueCnt") === "0 / 6", "blue emptied after switch");
ok(await page.evaluate(() => document.getElementById("cameraDock")?.parentElement?.id) === "partySlot", "camera dock survived the team switch");
ok(await page.evaluate(() => document.getElementById("btnPartyStart").disabled), "party START locked");
await page.click("#btnPartyBack");
ok(await fsmState() === "menu", "back to home");

// ---- console errors ----
console.log("hygiene:");
const realErrors = consoleErrors.filter(e =>
  !e.includes("favicon") && !e.includes("net::ERR_") &&
  !e.includes("socket.io") // static host has no socket endpoint — expected
);
ok(realErrors.length === 0, `no console/page errors (${realErrors.length})`);
realErrors.forEach(e => console.log("    " + e.slice(0, 200)));

await browser.close();
console.log(fails ? `\n${fails} FAILURES` : "\nALL OFFLINE E2E CHECKS PASSED");
process.exit(fails ? 1 : 0);
