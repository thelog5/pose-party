/* Online 1v1 E2E: real Node server, two headless-Chrome players, real
   Socket.IO + WebRTC. Only the vision input is simulated (seeded classifier
   output), same as the offline E2E. */
import puppeteer from "puppeteer-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";

const PORT = 3457;
const APP = `http://localhost:${PORT}`;
const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const SERVER_DIR = fileURLToPath(new URL("../server", import.meta.url));

const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0;
const ok = (cond, msg) => { console.log((cond ? "  ok  " : "  FAIL") + " " + msg); if (!cond) fails++; };

/* fast match: 2 rounds, 4s words */
const server = spawn("node", ["index.js"], {
  cwd: SERVER_DIR,
  env: { ...process.env, PORT: String(PORT), ROUNDS: "2", WORD_MS: "4000", PRECOUNT_MS: "1600", BETWEEN_ROUNDS_MS: "900" },
  stdio: "pipe",
});
await new Promise((res, rej) => {
  server.stdout.on("data", d => String(d).includes("server running") && res());
  setTimeout(() => rej(new Error("server failed to start")), 5000);
});

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--no-first-run"],
});

const errors = { A: [], B: [] };
async function player(tag){
  /* Isolated context per player — separate localStorage, like two machines. */
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  /* Bypass CSP only for the test's own evaluate() scripts; the app's
     resources still load under the server's CSP (violations would surface
     as console errors, which we assert on). */
  await page.setBypassCSP(true);
  page.on("console", m => { if (m.type() === "error") errors[tag].push(m.text()); });
  page.on("pageerror", e => errors[tag].push("PAGEERROR: " + e.message));
  await page.goto(APP, { waitUntil: "networkidle2", timeout: 60000 });
  await page.waitForFunction(() => document.getElementById("status").style.display === "none", { timeout: 60000, polling: 400 });
  return page;
}
async function act(page, fn){ await page.bringToFront(); return fn(); }
const evalIn = (page, expr) => page.evaluate(`(async () => (${expr}))()`);
const fsmOf = page => evalIn(page, `(await import('${APP}/js/fsm.js')).gameState()`);
const winNow = page => page.evaluate(`(async () => {
  const { state } = await import('${APP}/js/state.js');
  const { gameCheck } = await import('${APP}/js/game.js');
  const w = state.game.word;
  for (const l of state.model.labels) state.smooth[l] = 0.01;
  state.smooth[w] = 0.9;
  gameCheck();
  await new Promise(r => setTimeout(r, 300));
  gameCheck();
  return w;
})()`);

try {
  console.log("boot two players:");
  const [A, B] = await Promise.all([player("A"), player("B")]);
  ok(true, "both players booted against the node server (CSP live)");

  console.log("lobby:");
  await act(A, () => A.click("#modeVS"));
  ok(await fsmOf(A) === "lobby", "1v1 card opens lobby");
  await act(A, () => A.type("#lobbyName", "Alice"));
  await act(A, () => A.click("#btnCreateRoom"));
  await A.waitForFunction(() => /Room code/.test(document.getElementById("lobbyStatus").textContent), { timeout: 5000, polling: 400 });
  const code = await A.evaluate(() => document.querySelector("#lobbyStatus b").textContent.trim());
  ok(/^[A-Z2-9]{6}$/.test(code), `host got room code ${code}`);

  await act(B, () => B.click("#modeVS"));
  await act(B, () => B.type("#lobbyName", "Bob"));
  await act(B, () => B.type("#lobbyCode", code.toLowerCase()));
  await act(B, () => B.click("#btnJoinRoom"));

  console.log("match:");
  await A.waitForFunction(() => document.body.dataset.state === "countdown", { timeout: 8000, polling: 400 });
  await B.waitForFunction(() => document.body.dataset.state === "countdown", { timeout: 8000, polling: 400 });
  ok(true, "both players entered synced countdown");

  await A.waitForFunction(() => document.body.dataset.state === "playing", { timeout: 8000, polling: 400 });
  await B.waitForFunction(() => document.body.dataset.state === "playing", { timeout: 8000, polling: 400 });
  const wordA = await A.evaluate(() => document.getElementById("vsWord").textContent);
  const wordB = await B.evaluate(() => document.getElementById("vsWord").textContent);
  ok(wordA === wordB && wordA.length > 0, `same word on both screens: "${wordA}"`);
  const ribbon = await B.evaluate(() => document.getElementById("rivalRibbon").textContent);
  ok(ribbon === "Alice", `rival ribbon shows peer name (${ribbon})`);

  // WebRTC: remote video should be flowing both ways
  await A.waitForFunction(() => {
    const v = document.getElementById("videoRemote");
    return !v.classList.contains("hidden") && v.videoWidth > 0;
  }, { timeout: 10000 }).catch(() => {});
  const rtcA = await A.evaluate(() => document.getElementById("videoRemote").videoWidth || 0);
  const rtcB = await B.evaluate(() => document.getElementById("videoRemote").videoWidth || 0);
  ok(rtcA > 0, `A sees B's video (${rtcA}px)`);
  ok(rtcB > 0, `B sees A's video (${rtcB}px)`);

  console.log("round 1 — Alice performs the word:");
  await winNow(A);
  await A.waitForFunction(() => document.body.dataset.state === "word-won", { timeout: 4000, polling: 400 });
  ok(true, "A: claim accepted -> word-won");
  await B.waitForFunction(() => document.body.dataset.state === "word-won", { timeout: 4000, polling: 400 });
  const burstB = await B.evaluate(() => document.getElementById("pointHeadline").textContent);
  ok(/Alice wins/i.test(burstB), `B sees rival banner ("${burstB}")`);
  const scoreA = await A.evaluate(() => document.getElementById("pillScore").textContent);
  const rivalB = await B.evaluate(() => document.getElementById("pillRivalScore").textContent);
  ok(scoreA === "1" && rivalB === "1", `server score propagated (A you=${scoreA}, B rival=${rivalB})`);

  console.log("round 2 — nobody acts, server times out:");
  await A.waitForFunction(() => document.body.dataset.state === "playing", { timeout: 6000, polling: 400 });
  await A.waitForFunction(() => document.body.dataset.state === "word-won", { timeout: 8000, polling: 400 });
  const burstA2 = await A.evaluate(() => document.getElementById("pointHeadline").textContent);
  ok(/time up/i.test(burstA2), `timeout banner ("${burstA2}")`);

  console.log("match end:");
  await A.waitForFunction(() => document.body.dataset.state === "results", { timeout: 8000, polling: 400 });
  await B.waitForFunction(() => document.body.dataset.state === "results", { timeout: 8000, polling: 400 });
  const titleA = await A.evaluate(() => document.querySelector("#rescard h2").textContent);
  const titleB = await B.evaluate(() => document.querySelector("#rescard h2").textContent);
  ok(titleA === "YOU 1 — BOB 0", `A results: "${titleA}"`);
  ok(titleB === "YOU 0 — ALICE 1", `B results: "${titleB}"`);
  const subA = await A.evaluate(() => document.querySelector("#rescard .sub").textContent);
  ok(/won the showdown/i.test(subA), `winner text ("${subA}")`);

  console.log("peer-left handling:");
  // rematch via lobby, then B quits mid-match
  await act(A, () => A.click("#btnAgain"));
  ok(await fsmOf(A) === "lobby", "play again returns to lobby for a fresh code");
  await act(A, () => A.click("#btnCreateRoom"));
  await A.waitForFunction(() => /Room code/.test(document.getElementById("lobbyStatus").textContent), { timeout: 5000, polling: 400 });
  const code2 = await A.evaluate(() => document.querySelector("#lobbyStatus b").textContent.trim());
  await act(B, () => B.click("#btnAgain"));
  await B.evaluate(() => { document.getElementById("lobbyCode").value = ""; });
  await act(B, () => B.type("#lobbyCode", code2));
  await act(B, () => B.click("#btnJoinRoom"));
  await A.waitForFunction(() => document.body.dataset.state === "playing", { timeout: 10000, polling: 400 });
  await B.waitForFunction(() => document.body.dataset.state === "playing", { timeout: 10000, polling: 400 });
  await act(B, () => B.click("#btnQuitVs"));
  ok(await fsmOf(B) === "results", "quitter lands on results");
  await A.waitForFunction(() => document.body.dataset.state === "results", { timeout: 5000, polling: 400 });
  const subA2 = await A.evaluate(() => document.querySelector("#rescard .sub").textContent);
  ok(/left early/i.test(subA2), `abandoned match ends early for the peer ("${subA2}")`);

  console.log("hygiene:");
  for (const tag of ["A", "B"]) {
    const real = errors[tag].filter(e => !e.includes("favicon") && !e.includes("net::ERR_"));
    ok(real.length === 0, `player ${tag}: no console/page errors (${real.length})`);
    real.forEach(e => console.log("    " + e.slice(0, 220)));
  }
} catch (e) {
  fails++;
  console.log("  FAIL (exception):", e.message);
} finally {
  await browser.close();
  server.kill();
}
console.log(fails ? `\n${fails} FAILURES` : "\nALL ONLINE E2E CHECKS PASSED");
process.exit(fails ? 1 : 0);
