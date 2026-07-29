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
  page.on("console", m => { if (m.type() === "error") errors[tag].push(m.text() + " @" + (m.location()?.url||"")); });
  page.on("response", r => { if (r.status() >= 400) errors[tag].push("HTTP " + r.status() + " " + r.url()); });
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
  const { renderGuesses } = await import('${APP}/js/ui.js');
  const w = state.game.word;
  for (const l of state.model.labels) state.smooth[l] = 0.01;
  state.smooth[w] = 0.9;
  /* Mirror the real inference order: paint/debounce the robot paper first,
     then let scoring inspect that same displayed state. */
  renderGuesses();
  gameCheck();
  await new Promise(r => setTimeout(r, 500));
  renderGuesses();
  gameCheck();
  await new Promise(r => setTimeout(r, 300));
  renderGuesses();
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

  // the requested scoring format now defaults to 2:00 / 20s
  ok(await txt(A, "#setMatch") === "2:00" && await txt(A, "#setWord") === "20s",
    `default settings are 2:00 / 20s (${await txt(A,"#setMatch")}, ${await txt(A,"#setWord")})`);
  // controls still round-trip to the defaults
  await act(A, () => A.click("#matchMinus"));
  await act(A, () => A.click("#matchPlus"));
  await act(A, () => A.click("#wordMinus"));
  await act(A, () => A.click("#wordPlus"));

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
  ok(await A.evaluate(() => document.querySelector("header").classList.contains("hidden")),
    "new Figma 1v1 screen owns the full viewport");
  ok(/^\d+:\d\d$/.test(await txt(A, "#v1MatchTime")), `paper match clock ticking (${await txt(A, "#v1MatchTime")})`);
  await sleep(650); // let the Figma word-card entrance settle before measuring
  const figmaLayout = await A.evaluate(() => {
    const stage=document.getElementById("matchStage").getBoundingClientRect();
    const divider=document.querySelector(".v1-divider").getBoundingClientRect();
    const word=document.getElementById("vsWordCard").getBoundingClientRect();
    const left=document.querySelector(".v1-video-side.you").getBoundingClientRect();
    const right=document.querySelector(".v1-video-side.rival").getBoundingClientRect();
    return {
      dividerX:(divider.left-stage.left)/stage.width,
      wordX:(word.left-stage.left)/stage.width,
      wordY:(word.top-stage.top)/stage.height,
      leftWidth:left.width/stage.width,
      rightWidth:right.width/stage.width,
    };
  });
  ok(Math.abs(figmaLayout.dividerX-.48333)<.003 && Math.abs(figmaLayout.wordX-.2993)<.003 &&
    Math.abs(figmaLayout.wordY-.8259)<.003 && Math.abs(figmaLayout.leftWidth-.5)<.002 &&
    Math.abs(figmaLayout.rightWidth-.5)<.002, "1v1 overlay geometry matches the 1440×810 Figma frame");

  // WebRTC both ways
  await A.waitForFunction(() => {
    const v = document.getElementById("videoRemote");
    return !v.classList.contains("hidden") && v.videoWidth > 0;
  }, { timeout: 12000, polling: 400 }).catch(() => {});
  const rtcA = await A.evaluate(() => document.getElementById("videoRemote").videoWidth || 0);
  const rtcB = await B.evaluate(() => document.getElementById("videoRemote").videoWidth || 0);
  ok(rtcA > 0, `A sees B's video (${rtcA}px)`);
  ok(rtcB > 0, `B sees A's video (${rtcB}px)`);

  ok(await A.evaluate(() => !document.getElementById("btnExitMatch")),
    "1v1 has no in-match exit control");
  ok(await A.evaluate(() =>
    parseFloat(getComputedStyle(document.getElementById("myGuessPastTape")).opacity)===0 &&
    parseFloat(getComputedStyle(document.getElementById("rivalGuessPastTape")).opacity)===0),
    "history tape stays hidden until a previous guess paper exists");
  const firstLiveGuess=await A.evaluate(async () => {
    const {state}=await import("/js/state.js");
    const {renderGuesses}=await import("/js/ui.js");
    const label=state.model.labels.find(l=>l!=="idle"&&l!==state.game.word);
    for(const key of state.model.labels) state.smooth[key]=.01;
    state.smooth[label]=.74;
    renderGuesses();
    await new Promise(r=>setTimeout(r,180));
    renderGuesses();
    return label;
  });
  await B.waitForFunction(label =>
    document.getElementById("rivalTopWord").textContent.includes(label.toUpperCase()),
    {timeout:3000,polling:100},firstLiveGuess);
  ok(await txt(B,"#rivalTopPct")==="74%",
    `opponent's live top guess and confidence appear (${firstLiveGuess}, 74%)`);
  ok(await A.evaluate(() =>
    parseFloat(getComputedStyle(document.getElementById("myGuessPastTape")).opacity)===0),
    "one current guess does not reveal an empty history tape");
  await A.evaluate(async first => {
    const {state}=await import("/js/state.js");
    const {renderGuesses}=await import("/js/ui.js");
    const next=state.model.labels.find(l=>l!=="idle"&&l!==state.game.word&&l!==first);
    for(const key of state.model.labels) state.smooth[key]=.01;
    state.smooth[next]=.7;
    renderGuesses();
    await new Promise(r=>setTimeout(r,480));
    renderGuesses();
  },firstLiveGuess);
  await A.waitForFunction(() =>
    !document.getElementById("myGuessPast").classList.contains("empty"),
    {timeout:2500,polling:100});
  await sleep(300); // history tape deliberately fades in with its paper
  ok(await A.evaluate(() =>
    parseFloat(getComputedStyle(document.getElementById("myGuessPastTape")).opacity)>.9),
    "history tape appears together with the previous-guess paper");

  console.log("round 1 — Alice first, Bob chases:");
  await winNow(A);
  await A.waitForFunction(() => document.getElementById("matchStage").dataset.phase === "chase",
    {timeout:5000,polling:100});
  await B.waitForFunction(() => document.getElementById("matchStage").dataset.phase === "chase",
    {timeout:5000,polling:100});
  const immediateA=parseInt((await txt(A,"#v1YouScore")).replace(/[^0-9]/g,""));
  ok(immediateA>=300 && immediateA<=500 &&
    /5 SECONDS LEFT/.test(await txt(A,"#v1WordTimerLabel")),
    `first recognition scored immediately and opened chase (${immediateA})`);
  ok(await A.evaluate(() =>
    document.getElementById("v1Award").classList.contains("show") &&
    document.getElementById("v1Award").querySelector("img").src.includes("sp-award.png")),
    "1v1 reuses Solo's GOT IT paper and animation");
  ok(await A.evaluate(() =>
    parseFloat(document.getElementById("v1WordFill").style.width)>=94),
    "first recognizer's meter locks full for the chase");
  ok(await B.evaluate(() =>
    document.getElementById("v1RivalAward").classList.contains("show") &&
    document.getElementById("v1RivalAwardTitle").textContent==="ALICE GOT IT!" &&
    document.getElementById("v1RivalAward").querySelector("img").src.includes("sp-award.png")),
    "the opponent's recognition animates the same GOT IT paper on their side");
  await sleep(650);
  await winNow(B);
  await waitState(A, "word-won", 5000);
  await waitState(B, "word-won", 5000);
  ok(await A.evaluate(() =>
    parseFloat(getComputedStyle(document.getElementById("v1WordFill")).width) /
      document.getElementById("vsWordCard").getBoundingClientRect().width > .9) &&
    await B.evaluate(() =>
    parseFloat(getComputedStyle(document.getElementById("v1WordFill")).width) /
      document.getElementById("vsWordCard").getBoundingClientRect().width > .9),
    "both successful players keep a full meter through the result beat");
  const round1A=parseInt((await txt(A,"#v1YouScore")).replace(/[^0-9]/g,""));
  const round1B=parseInt((await txt(A,"#v1RivalScore")).replace(/[^0-9]/g,""));
  ok(round1A>round1B && round1B>0,
    `continuous chaser decay awarded both players (${round1A} / ${round1B})`);
  ok(parseInt((await txt(B,"#v1AwardPts")).replace(/[^0-9]/g,""))===round1B,
    `chaser sees the shared paper point award (+${round1B})`);

  console.log("round 2 — Bob first, Alice misses the chase:");
  await waitState(B, "playing", 8000);
  await winNow(B);
  await B.waitForFunction(() => document.getElementById("matchStage").dataset.phase === "chase",
    {timeout:5000,polling:100});
  await waitState(A, "word-won", 8000);
  await waitState(A, "playing", 8000); // time-based mode rolls straight into round 3
  const totalA=parseInt((await txt(A,"#v1YouScore")).replace(/[^0-9]/g,""));
  const totalB=parseInt((await txt(A,"#v1RivalScore")).replace(/[^0-9]/g,""));
  ok(totalA===round1A && totalB>round1B && totalB>totalA,
    `total points, not rounds won, choose the leader (${totalA} / ${totalB})`);
  ok(await A.evaluate(() => {
    const stage=document.getElementById("matchStage");
    const crown=document.getElementById("v1RivalCrown");
    return stage.classList.contains("rival-leading") &&
      parseFloat(getComputedStyle(crown).opacity)>.9;
  }), "the current leader wears the angled paper crown");
  // There is deliberately no in-match exit UI. Simulate a tab/navigation
  // loss through the lifecycle itself so peer-left cleanup remains covered.
  await act(B, () => B.evaluate(async () => {
    const {transition}=await import("/js/fsm.js");
    transition("menu");
  }));
  await waitState(B, "menu", 10000);
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
  await act(B, () => B.click("#modeVS"));
  await B.waitForFunction(() =>
    /^[A-Z2-9]{6}$/.test(document.getElementById("roomCodeText").textContent),
    {timeout:10000,polling:300});
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
  ok(await A.evaluate(() => document.querySelector('#ptB0 .pt-name b')?.textContent) === "Alice", "host camera tile uses the saved player name");
  ok(await A.evaluate(() => document.querySelector('#ptB0 .pt-name img')?.getAttribute("src")?.endsWith("lb-name-chip.png")), "party tile uses the 1v1 torn-paper name asset");
  ok(await A.evaluate(() => document.getElementById("cameraDock").parentElement.id) === "ptB0", "host camera mounted in the team tile");
  const wideCamera = await A.evaluate(() => {
    const video = document.querySelector("#ptB0 .camdock video");
    const tile = document.getElementById("ptB0");
    return { fit:getComputedStyle(video).objectFit, width:video.getBoundingClientRect().width / tile.getBoundingClientRect().width };
  });
  ok(wideCamera.fit === "cover" && wideCamera.width > .99, "wide party camera fills its top tile without side bars");
  const hostNameLayout = await A.evaluate(() => {
    const chip = document.querySelector("#ptB0 .pt-name").getBoundingClientRect();
    const label = document.querySelector("#ptB0 .pt-name b");
    const text = label.getBoundingClientRect();
    return {
      dx:Math.abs((chip.left + chip.width / 2) - (text.left + text.width / 2)),
      dy:Math.abs((chip.top + chip.height / 2) - (text.top + text.height / 2)),
      font:parseFloat(getComputedStyle(label).fontSize),
      height:chip.height,
    };
  });
  ok(hostNameLayout.dx < 1 && hostNameLayout.dy < 1 && hostNameLayout.font / hostNameLayout.height > .4,
    "party name text is centered and fills the torn-paper tag");
  await act(A, () => A.evaluate(() => {
    const input = document.getElementById("lobbyName");
    input.value = "PartyAlice";
    input.dispatchEvent(new Event("input", { bubbles:true }));
    input.dispatchEvent(new Event("change", { bubbles:true }));
  }));
  await A.waitForFunction(() => document.querySelector('#ptB0 .pt-name b')?.textContent === "PartyAlice", { timeout: 3000, polling: 100 });
  ok(true, "editing the party name updates the local camera tile");

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
  await B.waitForFunction(() => document.querySelector('#ptO0 .pt-name b')?.textContent === "Bob", { timeout: 8000, polling: 300 });
  ok(true, "B auto-balanced onto orange");
  ok(await B.evaluate(() => document.querySelector('#ptB0 .pt-name b')?.textContent) === "PartyAlice", "party name change reached the other player");
  await A.waitForFunction(() => !!document.querySelector('#ptO0 video'), { timeout: 8000, polling: 300 });
  ok(true, "A sees B's tile appear");
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
  await B.waitForFunction(() => document.querySelector('#ptB1 .pt-name b')?.textContent === "Bob", { timeout: 8000, polling: 300 });
  ok(true, "B switched to blue (second tile)");
  await A.waitForFunction(() => !!document.querySelector('#ptB1 video'), { timeout: 8000, polling: 300 });
  ok(await A.evaluate(() => !document.querySelector('#ptO0 video')), "A's orange tile emptied after the switch");
  ok(await B.evaluate(() => !document.getElementById("btnJoinBlue").disabled), "blue JOIN still visible (room for a third)");
  await act(B, () => B.click("#btnExitLobby"));
  await act(A, () => A.click("#btnExitLobby"));

  console.log("hygiene:");
  for (const tag of ["A", "B"]) {
    const real = errors[tag].filter(e => !e.includes("favicon") &&
      !e.includes("net::ERR_") &&
      !e.includes("Created TensorFlow Lite XNNPACK delegate") &&
      !/assets\/ui\/figma\/sp-/.test(e));
    ok(real.length === 0, `player ${tag}: no console/page errors (${real.length})`);
    real.forEach(e => console.log("    " + e.slice(0, 220)));
  }
} catch (e) {
  fails++;
  console.log("  FAIL (exception):", e.message);
  for(const tag of ["A","B"])
    for(const error of errors[tag])
      console.log(`    ${tag}: ${error.slice(0,300)}`);
} finally {
  await browser.close();
  server.kill();
}
console.log(fails ? `\n${fails} FAILURES` : "\nALL ONLINE E2E CHECKS PASSED");
process.exit(fails ? 1 : 0);
