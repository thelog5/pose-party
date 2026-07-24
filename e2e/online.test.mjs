/* Online 1v1 E2E: real Node server, two headless-Chrome players in isolated
   contexts, real Socket.IO + WebRTC, new POSE PARTY lobby flow (auto-created
   room, host settings, host-controlled start). Only the vision input is
   simulated. */
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

/* fast match via env defaults; the UI will drive settings down further */
const server = spawn("node", ["index.js"], {
  cwd: SERVER_DIR,
  env: { ...process.env, PORT: String(PORT), PRECOUNT_MS: "1500", BETWEEN_ROUNDS_MS: "900", RATE_CREATE: "30", RATE_JOIN: "60" },
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
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setBypassCSP(true); // for the test's own evaluate() scripts only
  page.on("console", m => { if (m.type() === "error") errors[tag].push(m.text()); });
  page.on("pageerror", e => errors[tag].push("PAGEERROR: " + e.message));
  await page.goto(APP, { waitUntil: "networkidle2", timeout: 60000 });
  await page.waitForFunction(() => document.getElementById("status").style.display === "none", { timeout: 60000, polling: 400 });
  return page;
}
async function act(page, fn){ await page.bringToFront(); return fn(); }
const evalIn = (page, expr) => page.evaluate(`(async () => (${expr}))()`);
const stateOf = page => page.evaluate(() => document.body.dataset.state);
const txt = (page, sel) => page.evaluate(s => document.querySelector(s)?.textContent ?? null, sel);
const waitState = (page, st, t=10000) => page.waitForFunction(
  s => document.body.dataset.state === s, { timeout: t, polling: 300 }, st);
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
  await act(A, () => A.evaluate(() => { localStorage.setItem("poseCharadesName", "Alice"); }));
  await act(A, () => A.click("#modeVS"));
  // room auto-creates; code appears on the invite card
  await A.waitForFunction(() => /^[A-Z2-9]{6}$/.test(document.getElementById("roomCodeText").textContent), { timeout: 10000, polling: 300 });
  const code = await txt(A, "#roomCodeText");
  ok(/^[A-Z2-9]{6}$/.test(code), `room auto-created with code ${code}`);
  ok(await A.evaluate(() => document.getElementById("btnStartMatch").disabled), "START faded/disabled before rival joins");
  ok(await A.evaluate(() => !document.getElementById("lobbyStage").classList.contains("joined")), "waiting robot visible before join");
  ok(await A.evaluate(() => document.getElementById("lobbyName").value) === "Alice", "name tag prefilled from storage");

  // host tunes the time-based settings: match 3:00 -> 2:00, word 30 -> 20s
  await act(A, () => A.click("#matchMinus"));
  await act(A, () => A.click("#matchMinus"));
  await act(A, () => A.click("#wordMinus"));
  await act(A, () => A.click("#wordMinus"));
  ok(await txt(A, "#setMatch") === "2:00" && await txt(A, "#setWord") === "20s", `host adjusted settings (${await txt(A,"#setMatch")}, ${await txt(A,"#setWord")})`);

  // B joins via the share LINK (exercises #join-CODE handling)
  await act(B, () => B.evaluate(() => localStorage.setItem("poseCharadesName", "Bob")));
  // simulate pasting the link into the open tab (hash-only navigation)
  await act(B, () => B.evaluate(c => { location.hash = "#join-" + c; }, code));
  await B.waitForFunction(() => document.body.dataset.state === "lobby", { timeout: 20000, polling: 300 });
  await B.waitForFunction(() => /waiting for .{1,20} to start/i.test(document.getElementById("lobbyStatus").textContent), { timeout: 15000, polling: 300 });
  ok(true, "B joined via link, sees waiting-for-host");
  ok(await txt(B, "#setMatch") === "2:00", "B received host's settings (2:00 match)");
  ok(await B.evaluate(() => document.getElementById("matchMinus").disabled), "B cannot edit settings");
  ok(await B.evaluate(() => document.getElementById("lobbyStage").classList.contains("joined")), "B's lobby switched to joined state");
  const badge = await txt(B, "#lobbyOppName");
  ok(badge === "ALICE", `B sees host name on the opponent chip (${badge})`);

  // host START unlocks and begins
  await A.waitForFunction(() => !document.getElementById("btnStartMatch").disabled, { timeout: 10000, polling: 300 });
  ok(true, "host START unlocked when both ready");
  await act(A, () => A.click("#btnStartMatch"));

  console.log("match:");
  await waitState(A, "countdown"); await waitState(B, "countdown");
  ok(true, "both players entered synced countdown");
  await waitState(A, "playing"); await waitState(B, "playing");
  ok(await A.evaluate(() => document.body.dataset.screen) === "match", "match screen shown");
  const wordA = await txt(A, "#vsWord"), wordB = await txt(B, "#vsWord");
  ok(wordA === wordB && wordA.length > 0, `same word on both screens: "${wordA}"`);
  ok(await A.evaluate(() => document.querySelector(".statpill.round .lab").textContent) === "Match", "round pill relabeled to match clock");
  ok(/^\d+:\d\d$/.test(await txt(A, "#pillRound")), `match clock ticking (${await txt(A, "#pillRound")})`);

  // WebRTC both ways
  await A.waitForFunction(() => {
    const v = document.getElementById("videoRemote");
    return !v.classList.contains("hidden") && v.videoWidth > 0;
  }, { timeout: 12000, polling: 400 }).catch(() => {});
  const rtcA = await A.evaluate(() => document.getElementById("videoRemote").videoWidth || 0);
  const rtcB = await B.evaluate(() => document.getElementById("videoRemote").videoWidth || 0);
  ok(rtcA > 0, `A sees B's video (${rtcA}px)`);
  ok(rtcB > 0, `B sees A's video (${rtcB}px)`);

  console.log("round 1 — Alice performs the word:");
  await winNow(A);
  await waitState(A, "word-won", 5000);
  ok(true, "A: claim accepted -> word-won");
  await waitState(B, "word-won", 5000);
  ok(/Alice wins/i.test(await txt(B, "#pointHeadline")), `B sees rival banner ("${await txt(B, "#pointHeadline")}")`);
  ok(await txt(A, "#pillScore") === "1", "A score pill = 1 (server points)");

  console.log("round 2 — Bob wins; then leaves:");
  await waitState(B, "playing", 8000);
  await winNow(B);
  await waitState(A, "word-won", 5000);
  await waitState(A, "playing", 8000); // time-based mode rolls straight into round 3
  ok(await txt(A, "#pillScore") === "1" && await txt(B, "#pillScore") === "1", "both players' score pills read 1");
  await act(B, () => B.click("#btnExitMatch"));
  await waitState(B, "results", 5000);
  ok(true, "quitter lands on results");
  await waitState(A, "results", 6000);
  ok(/left early/i.test(await txt(A, "#rescard .sub")), `peer sees early end ("${await txt(A, "#rescard .sub")}")`);

  console.log("replay -> fresh lobby + join by typed code:");
  await act(A, () => A.click("#btnAgain")); // online replay -> fresh lobby
  await A.waitForFunction(c => {
    const t = document.getElementById("roomCodeText").textContent;
    return /^[A-Z2-9]{6}$/.test(t) && t !== c;
  }, { timeout: 10000, polling: 300 }, code);
  const code2 = await txt(A, "#roomCodeText");
  ok(code2 !== code, `replay creates a fresh room (${code2})`);
  await act(B, () => B.click("#btnAgain"));
  await waitState(B, "lobby", 10000);
  await act(B, () => B.evaluate(() => { document.getElementById("joinCode").value = ""; }));
  await act(B, () => B.type("#joinCode", code2));
  await act(B, () => B.click("#btnJoinRoom"));
  await A.waitForFunction(() => !document.getElementById("btnStartMatch").disabled, { timeout: 10000, polling: 300 });
  ok(true, "typed-code join unlocked the host's START");

  console.log("party lobby (live):");
  // A opens a party room from home
  await act(A, () => A.click("#btnExitLobby"));
  await A.waitForFunction(() => document.body.dataset.state === "menu", { timeout: 8000, polling: 300 });
  await act(A, () => A.click("#modeParty"));
  await A.waitForFunction(() => /^[A-Z2-9]{6}$/.test(document.getElementById("roomCodeText").textContent), { timeout: 10000, polling: 300 });
  const pcode = await txt(A, "#roomCodeText");
  ok(/^[A-Z2-9]{6}$/.test(pcode), `party room created (${pcode})`);
  ok(await A.evaluate(() => document.querySelector('#ptB0 .pt-name')?.textContent) === "YOU", "host camera tile on blue with YOU chip");
  ok(await A.evaluate(() => document.getElementById("cameraDock").parentElement.id) === "ptB0", "host camera mounted in the team tile");

  // B joins the party by typing the code while in party mode
  await act(B, () => B.click("#btnExitLobby"));
  await B.waitForFunction(() => document.body.dataset.state === "menu", { timeout: 8000, polling: 300 });
  await act(B, () => B.click("#modeParty"));
  await B.waitForFunction(() => /^[A-Z2-9]{6}$/.test(document.getElementById("roomCodeText").textContent), { timeout: 10000, polling: 300 });
  await act(B, () => B.evaluate(() => { document.getElementById("joinCode").value = ""; }));
  await act(B, () => B.type("#joinCode", pcode));
  await act(B, () => B.click("#btnJoinRoom"));
  await B.waitForFunction(c => document.getElementById("roomCodeText").textContent === c, { timeout: 10000, polling: 300 }, pcode);
  ok(true, "B joined the party by code");
  await B.waitForFunction(() => document.querySelector('#ptO0 .pt-name')?.textContent === "YOU", { timeout: 8000, polling: 300 });
  ok(true, "B auto-balanced onto orange");
  await A.waitForFunction(() => !!document.querySelector('#ptO0 video'), { timeout: 8000, polling: 300 });
  ok(true, "A sees B's tile appear (confetti poofed)");
  // mesh video: B's feed lands in A's orange tile
  await A.waitForFunction(() => {
    const v = document.querySelector('#ptO0 video');
    return v && v.videoWidth > 0;
  }, { timeout: 15000, polling: 400 }).catch(() => {});
  ok(await A.evaluate(() => (document.querySelector('#ptO0 video')?.videoWidth || 0) > 0), "mesh video flowing A<-B");

  // gate: 1v1 split cannot start
  ok(await A.evaluate(() => document.getElementById("btnStartMatch").disabled), "START stays gated below 2v2");
  ok(/need 2 per team/i.test(await txt(A, "#lobbyStatus")), `host sees the gate hint ("${await txt(A, "#lobbyStatus")}")`);

  // B switches to blue via the JOIN THIS TEAM button
  await act(B, () => B.click("#btnJoinBlue"));
  await B.waitForFunction(() => document.querySelector('#ptB1 .pt-name')?.textContent === "YOU", { timeout: 8000, polling: 300 });
  ok(true, "B switched to blue (second tile)");
  await A.waitForFunction(() => !!document.querySelector('#ptB1 video'), { timeout: 8000, polling: 300 });
  ok(await A.evaluate(() => !document.querySelector('#ptO0 video')), "A's orange tile emptied after the switch");
  ok(await B.evaluate(() => !document.getElementById("btnJoinBlue").disabled), "blue JOIN still visible (room for a third)");
  await act(B, () => B.click("#btnExitLobby"));
  await act(A, () => A.click("#btnExitLobby"));

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
