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
ok(dockParent === "slotHomePark", `camera dock parked out of sight on home (${dockParent})`);
ok(await page.evaluate(() => document.querySelector("header").classList.contains("hidden")), "home is immersive (no global header)");

// ---- solo: the guess-bubble mechanic (soloRound.js) ----
console.log("solo play:");
await page.click("#modeAI");
ok(await fsmState() === "countdown", "SOLO card -> countdown");
await sleep(2900);
ok(await fsmState() === "playing", "countdown -> playing");
ok(await bodyScreen() === "solo", "solo screen shown");
ok(await page.evaluate(() => document.querySelector("header").classList.contains("hidden")), "global header hidden (immersive)");
const rstate = () => page.evaluate(() => document.getElementById("scrSolo").dataset.rstate);
ok(await rstate() === "guessing", "round state GUESSING");
const word = await txt("#promptWord");
ok(word && word !== "—", `prompt bar shows target word: "${word}"`);
ok(!/%/.test(await page.evaluate(() => document.getElementById("promptBar").innerText)), "prompt bar never shows a percentage");
ok(/^ROUND 1\/5$/.test(await txt("#soloRoundLab")), "round label 1/5");
ok(/^\d\d:\d\d$/.test(await txt("#soloTime")), `timer mm:ss (${await txt("#soloTime")})`);
ok(await page.evaluate(() => getComputedStyle(document.querySelector("#guessBubble .bmark.ok")).display) === "none", "no checkmark while GUESSING (single-state render)");

// feed the model funnel with the correct word at high confidence
const feed = (labelExpr, conf) => page.evaluate(`(async () => {
  clearInterval(window.__feed);
  const { state } = await import('${APP}/js/state.js');
  const { setModelOutput } = await import('${APP}/js/soloRound.js');
  const label = ${labelExpr};
  window.__feed = setInterval(() => setModelOutput(label, ${conf}), 80);
})()`);
await feed("state.game.word", 0.95);
await sleep(380);
ok(await txt("#bubbleLabel") === "…", "label debounce: bubble not swapped before 600ms");
ok(await page.evaluate(() => document.getElementById("bubbleFill").style.width) === "0%", "fill waits for the debounced label (no snap)");
await sleep(500);
ok((await txt("#bubbleLabel")).endsWith("?"), `bubble swapped after debounce ("${await txt("#bubbleLabel")}")`);
const w1 = await page.evaluate(() => parseInt(document.getElementById("bubbleFill").style.width));
await sleep(280);
const w2 = await page.evaluate(() => parseInt(document.getElementById("bubbleFill").style.width));
ok(w2 > w1 && w2 < 100, `fill lerps up smoothly (${w1}% -> ${w2}%)`);

// lock sequence
await page.waitForFunction(() => document.getElementById("scrSolo").dataset.rstate === "locked", { timeout: 6000 });
ok(true, "displayed fill crossed threshold on target -> HITSTOP -> LOCKED");
ok((await txt("#bubbleLabel")).endsWith("!"), `same bubble transformed in place ("${await txt("#bubbleLabel")}")`);
ok(await page.evaluate(() => getComputedStyle(document.querySelector("#promptBar .pmark")).display) !== "none", "prompt bar matched state flips with the lock");
ok(await page.evaluate(() => document.getElementById("mascotImg").dataset.pose) === "excited", "mascot swapped to excited");
ok(await page.evaluate(() => !!document.querySelector(".burstwrap")) , "celebration particles fired");
ok(await txt("#soloScoreVal") === "0", "score NOT incremented while chip is in flight");
const t1 = await txt("#soloTime");
await sleep(420);
ok(await txt("#soloTime") === t1, "timer frozen through the lock sequence");
await page.waitForFunction(() => document.getElementById("scrSolo").dataset.rstate === "round_end", { timeout: 3000 });
ok(await txt("#soloScoreVal") === "200", `chip arrived: score incremented to 200 (fast win)`);

// next round: state machine loops back
await page.waitForFunction(() => document.getElementById("scrSolo").dataset.rstate === "guessing", { timeout: 4000 });
ok(true, "ROUND_END -> next round GUESSING");
ok(/^ROUND 2\/5$/.test(await txt("#soloRoundLab")), "round advanced to 2/5");
ok(await page.evaluate(() => document.getElementById("bubbleHistory").children.length) === 0, "history cleared for the new round");

// label swap pushes the old guess into the faded history stack
await feed("state.model.labels.filter(l=>l!==state.game.word&&l!=='idle')[0]", 0.55);
await sleep(900);
const wrongShown = await txt("#bubbleLabel");
ok(wrongShown.endsWith("?"), `wrong label debounced in ("${wrongShown}")`);
await feed("state.model.labels.filter(l=>l!==state.game.word&&l!=='idle')[1]", 0.5);
await sleep(900);
ok(await page.evaluate(() => document.getElementById("bubbleHistory").children.length) === 1, "previous guess moved into history stack");

// near-miss: peak high on a wrong label, then crash
await feed("state.model.labels.filter(l=>l!==state.game.word&&l!=='idle')[1]", 0.97);
await page.waitForFunction(() => parseInt(document.getElementById("bubbleFill").style.width) >= 70, { timeout: 5000 });
await feed("state.model.labels.filter(l=>l!==state.game.word&&l!=='idle')[1]", 0.04);
await page.waitForFunction(() => document.getElementById("mascotImg").dataset.pose === "confused", { timeout: 4000 });
ok(true, "near-miss: confidence collapse -> confused mascot + shake");
await page.waitForFunction(() => document.getElementById("mascotImg").dataset.pose === "thinking", { timeout: 3000 });
ok(true, "mascot back to thinking after ~900ms");
await page.evaluate(() => clearInterval(window.__feed));

// skip: failed bubble, penalty on resolve, no celebration
await page.click("#btnSkipSolo");
ok(await rstate() === "round_end", "skip -> ROUND_END (no hitstop)");
ok(await page.evaluate(() => document.getElementById("guessBubble").classList.contains("failed")), "bubble in failed state");
ok(await page.evaluate(() => getComputedStyle(document.querySelector("#promptBar .pmark")).display) === "none", "no matched state on a failed round");
ok(await txt("#soloScoreVal") === "0", "skip cost 500 (floored at 0)");
await page.waitForFunction(() => document.getElementById("scrSolo").dataset.rstate === "guessing", { timeout: 4000 });
ok(/^ROUND 3\/5$/.test(await txt("#soloRoundLab")), "advanced to round 3/5 after skip");

// exit -> results
await page.click("#btnExitSolo");
ok(await fsmState() === "results", "exit -> results");
ok(/SCORE 0/.test(await txt("#rescard h2")), `results title (${await txt("#rescard h2")})`);

console.log("replay + training:");
await page.click("#btnAgain");
ok(await fsmState() === "countdown", "play again -> countdown");
await page.click("#btnExitSolo");
ok(await fsmState() === "results", "exit during countdown -> results");
ok(await evalApp(`${mod("state.js")}.state.game === null`), "abandoned game torn down");
ok(await page.evaluate(() => document.getElementById("countdown").classList.contains("hidden")), "countdown overlay cancelled");
await page.click("#btnHome");
ok(await fsmState() === "menu", "home from results");
await page.click("#btnHomeGear");
ok(await fsmState() === "training", "home gear opens training");
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
ok(await fsmState() === "party", "PARTY card opens the party waiting room");
ok(await bodyScreen() === "party", "party screen shown");
const code = await txt("#partyCode");
ok(/^[A-Z2-9]{6}$/.test(code), `party room code rendered (${code})`);
ok(await page.evaluate(() => document.getElementById("cameraDock").parentElement.id) === "partySlot", "your live tile holds the camera");
ok(await txt("#blueCnt") === "2 / 4", "blue team 2/4 (you + robot)");
ok(await page.evaluate(() => document.querySelectorAll("#blueGrid .ptile").length === 4 && document.querySelectorAll("#orangeGrid .ptile").length === 4), "party renders exactly four slots per team");
await page.click("#partyName", { clickCount: 3 });
await page.type("#partyName", "Logan");
await page.keyboard.press("Enter");
ok(await page.evaluate(() => localStorage.getItem("poseCharadesName")) === "Logan", "party name editor persists the player name");
ok((await txt("#blueGrid .pname")).includes("Logan"), "party tile updates to the edited name");
await page.click("#btnJoinOrange");
ok(await txt("#orangeCnt") === "2 / 4", "switched to orange (2/4)");
ok(await txt("#blueCnt") === "0 / 4", "blue emptied after switch");
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
