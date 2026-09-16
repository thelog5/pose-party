/* A DROPPED SOCKET IS A HICCUP, NOT A DEPARTURE.
   Two real players in a real 1v1 match; one of them loses the network for a
   couple of seconds, the way a phone does when wifi hands over to cellular or
   a lock screen freezes the tab. Before this existed, the server's disconnect
   handler ran `store.leave`, which in 1v1 DESTROYS the room, and the client
   ended the match in the same instant — so a two-second blip on one phone
   ended the game for both people while socket.io was already reconnecting
   underneath it.
   The drop is done by closing the live transport from inside the page, which
   leaves everything else standing — the same shape as the real fault. The
   server half is proved in server/test/integration.test.js; this is the client
   half, which that test cannot see.

   Run: node e2e/_reconnect.mjs     (spawns its own server on 3461) */
import puppeteer from "puppeteer-core";
import { installVisionFixture } from "./vision-fixture.mjs";
import { spawn } from "child_process";
import { fileURLToPath } from "url";

const PORT = 3461;
const APP = `http://localhost:${PORT}`;
const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const SERVER_DIR = fileURLToPath(new URL("../server", import.meta.url));

let fails = 0;
const ok = (cond, msg) => { console.log((cond ? "  ok  " : "  FAIL") + " " + msg); if(!cond) fails++; };

const server = spawn("node", ["index.js"], {
  cwd: SERVER_DIR,
  env: { ...process.env, PORT: String(PORT), PRECOUNT_MS: "1500",
         TUTORIAL_GRACE_MS: "3000", BETWEEN_ROUNDS_MS: "900",
         RATE_CREATE: "30", RATE_JOIN: "60" },
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

async function player(name){
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.evaluateOnNewDocument(() => { try{ localStorage.setItem("posePartyDev", "1"); }catch(e){} });
  await page.setBypassCSP(true);
  await page.goto(APP, { waitUntil: "networkidle2", timeout: 60000 });
  await page.waitForFunction(() =>
    !document.getElementById("camGate").classList.contains("hidden"),
    { timeout: 30000, polling: 50 });
  await page.evaluate(() => { try{ localStorage.setItem("posePartyOnlineAge", "ok"); }catch(e){} });
  await page.click("#cgEnable");
  await page.waitForFunction(() => document.getElementById("status").style.display === "none",
    { timeout: 60000, polling: 400 });
  await installVisionFixture(page);
  await page.evaluate(n => { localStorage.setItem("poseCharadesName", n); }, name);
  return page;
}

/* What the player is told, which is the whole client-side contract here: the
   drop is reported as something being fixed, not as the game ending. The
   session-level facts underneath it (the id survives, the seat is held, the
   socket comes back RECOVERED rather than as a stranger) are asserted in
   server/test/integration.test.js, where they can be read directly. */
const toastOf = page => page.evaluate(() =>
  document.getElementById("toastText")?.textContent || "");
const waitToast = (page, re, t = 25000) => page.waitForFunction(
  src => new RegExp(src, "i").test(document.getElementById("toastText")?.textContent || ""),
  { timeout: t, polling: 200 }, re);

const readyUp = async page => {
  const open = await page.evaluate(() =>
    !document.getElementById("howToPlay").classList.contains("hidden"));
  if(open) await page.click("#htpReady");
};

try {
  console.log("boot:");
  const [A, B] = await Promise.all([player("Alice"), player("Bob")]);
  ok(true, "two players booted");

  await A.bringToFront();
  await A.click("#modeVS");
  await A.waitForFunction(() => /^[A-Z2-9]{6}$/.test(document.getElementById("roomCodeText").textContent),
    { timeout: 15000, polling: 300 });
  const code = await A.evaluate(() => document.getElementById("roomCodeText").textContent);
  /* the share link, the same way online.test.mjs gets its second player in */
  await B.bringToFront();
  await B.evaluate(c => { location.hash = "#join-" + c; }, code);
  await B.waitForFunction(() => document.body.dataset.state === "lobby",
    { timeout: 25000, polling: 300 });
  await A.waitForFunction(() => !document.getElementById("btnStartMatch").disabled,
    { timeout: 20000, polling: 300 });
  ok(true, `both in room ${code}`);

  await A.bringToFront();
  await A.click("#btnStartMatch");
  await Promise.all([readyUp(A), readyUp(B)]);
  await A.waitForFunction(() => document.body.dataset.state === "playing",
    { timeout: 25000, polling: 200 });
  ok(true, "a real 1v1 match is running");

  console.log("blip:");
  /* `page.setOfflineMode` is NOT the simulation to reach for here: it blocks
     new requests but leaves an established WebSocket open, so the client never
     notices and nothing under test runs. Closing the engine is what a phone
     actually does to a socket, and it is what the server test does too. */
  const sess = await A.evaluate(async () => {
    const { _socketForTest } = await import("/js/online.js");
    const s = _socketForTest();
    const id = s.id;
    s.io.engine.close();
    return id;
  });
  ok(Boolean(sess), `dropped a live socket (${String(sess).slice(0,6)})`);
  await waitToast(A, "getting you back in", 8000).catch(() => {});
  const during = await A.evaluate(() => document.body.dataset.state);
  ok(/getting you back in/i.test(await toastOf(A)),
    `the player is told it is coming back, not that it ended (${JSON.stringify(await toastOf(A))})`);
  ok(during === "playing" || during === "word-won",
    `and the match keeps running while the network is gone (${during})`);
  ok(await B.evaluate(() => ["playing", "word-won"].includes(document.body.dataset.state)),
    "the other player's match is untouched");

  console.log("back:");
  await waitToast(A, "back in the game");
  ok(true, "the socket rejoins on its own and says so");
  ok(await A.evaluate(async id => {
    const { _socketForTest } = await import("/js/online.js");
    const s = _socketForTest();
    return s.connected && s.recovered && s.id === id;
  }, sess), "it came back RECOVERED and on the same id, not as a stranger");
  ok(await A.evaluate(() => ["playing", "word-won", "countdown"].includes(document.body.dataset.state)),
    "the player is still in the match, not back at the menu");
  ok(await B.evaluate(() => ["playing", "word-won", "countdown"].includes(document.body.dataset.state)),
    "and so is their rival");
  /* The seat is only really still there if the server still answers for it. */
  const roundOk = await A.evaluate(async () => {
    const { state } = await import("/js/state.js");
    return Boolean(state.game && state.game.mode === "online");
  });
  ok(roundOk, "and the client still holds a live online game");
} catch (e) {
  fails++;
  console.log("  FAIL (exception):", e.message);
} finally {
  await browser.close();
  server.kill();
}

console.log(fails ? `\n${fails} FAILURES` : "\nRECONNECT PROBE PASSED");
process.exit(fails ? 1 : 0);
