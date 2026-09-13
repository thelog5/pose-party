/* Online 1v1 E2E: real Node server, two headless-Chrome players in isolated
   contexts, real Socket.IO + WebRTC, new POSE PARTY lobby flow (auto-created
   room, host settings, host-controlled start). Only the vision input is
   simulated. */
import puppeteer from "puppeteer-core";
import { installVisionFixture } from "./vision-fixture.mjs";
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
  env: { ...process.env, PORT: String(PORT), PRECOUNT_MS: "1500",
         TUTORIAL_GRACE_MS: "6000", BETWEEN_ROUNDS_MS: "900",
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

const errors = { A: [], B: [] };
/* THE FRONT DOOR IS ON EVERY BOOT NOW. The ENABLE CAMERA card used to be
   skipped whenever the origin already held a camera grant, which is exactly
   what --use-fake-ui-for-media-stream reports, so every suite booted straight
   into Home. It is a consent/briefing screen rather than a permission
   notification, so it is shown every run and nothing downstream (the camera,
   the status overlay, Home's entrance) happens until it is answered. */
async function passCameraGate(page){
  await page.waitForFunction(() =>
    !document.getElementById("camGate").classList.contains("hidden"),
    { timeout: 30000, polling: 50 });
  await page.click("#cgEnable");
}

/* HOW TO PLAY IS A GRACE, NOT A BARRIER. The server starts the match when the
   grace runs out whether or not anybody pressed anything, and the card counts
   that down on its own button and then fires READY itself. So a click here has
   to tolerate the card having already closed on its own — otherwise the suite
   is really asserting that four headless clients can each find a button inside
   six seconds, which is a race, not a behaviour. */
const readyUp = async page => {
  const open = await page.evaluate(() =>
    !document.getElementById("howToPlay").classList.contains("hidden"));
  if(open) await page.click("#htpReady");
  return open;
};

async function player(tag){
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setBypassCSP(true); // for the test's own evaluate() scripts only
  page.on("console", m => { if (m.type() === "error") errors[tag].push(m.text() + " @" + (m.location()?.url||"")); });
  page.on("response", r => { if (r.status() >= 400) errors[tag].push("HTTP " + r.status() + " " + r.url()); });
  page.on("pageerror", e => errors[tag].push("PAGEERROR: " + e.message));
  await page.goto(APP, { waitUntil: "networkidle2", timeout: 60000 });
  await passCameraGate(page);
  await page.waitForFunction(() => document.getElementById("status").style.display === "none", { timeout: 60000, polling: 400 });
  await installVisionFixture(page);
  return page;
}
async function act(page, fn){ await page.bringToFront(); return fn(); }
const evalIn = (page, expr) => page.evaluate(`(async () => (${expr}))()`);
const stateOf = page => page.evaluate(() => document.body.dataset.state);
const txt = (page, sel) => page.evaluate(s => document.querySelector(s)?.textContent ?? null, sel);
const waitState = (page, st, t=10000) => page.waitForFunction(
  s => document.body.dataset.state === s, { timeout: t, polling: 300 }, st);
/* Recognition is a charge meter now: the pose has to be HELD, so this drives
   sustained inference rather than firing a couple of one-shot ticks.

   The distribution is PINNED rather than assigned. The real classifier is
   running against the fake camera the whole time and rewrites state.smooth
   every CLASSIFY_EVERY_MS; a plain assignment gets stomped between ticks, and
   the two disagreeing labels then reset the guess paper's debounce candidate
   forever, so the target never reaches the paper and can never be claimed.
   Non-writable properties let the classifier's own render agree with ours.
   Restored, and the loop self-clears, so nothing bleeds into the next word. */
const winNow = page => page.evaluate(`(async () => {
  const { state } = await import('${APP}/js/state.js');
  const { gameCheck } = await import('${APP}/js/game.js');
  const { renderGuesses } = await import('${APP}/js/ui.js');
  const w = state.game.word;
  clearInterval(window.__win);
  clearTimeout(window.__winStop);
  window.__unpin?.();
  const labels = state.model.labels.slice();
  const pin = (label, value, writable) => Object.defineProperty(state.smooth, label,
    { value, writable, configurable:true, enumerable:true });
  for (const l of labels) pin(l, l === w ? 0.9 : 0.01, false);
  window.__unpin = () => {
    window.__unpin = null;
    for (const l of labels) pin(l, state.smooth[l], true);
  };
  /* Mirror the real inference order: paint/debounce the robot paper first,
     then let scoring inspect that same displayed state. */
  const rid = state.game.roundId;
  const stop = () => { clearInterval(window.__win); window.__unpin?.(); };
  const tick = () => {
    window.__visionTick();
    /* The pin must never outlive its own round: carried into the next word it
       hands that word away the instant it is dealt, which is not a thing a
       player can do and not what any of these assertions mean to measure. */
    const g = state.game;
    if(!g || g.roundId !== rid || g.roundPhase === "between") return stop();
    renderGuesses();
    gameCheck();
  };
  tick();
  window.__win = setInterval(tick, 120);
  window.__winStop = setTimeout(stop, 3200);
  await new Promise(r => setTimeout(r, 700));
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

  /* Both timers read in the same M:SS unit — adjacent controls in mixed
     units ("2:00" beside "20s") read as two different kinds of setting. */
  ok(await txt(A, "#setMatch") === "2:00" && await txt(A, "#setWord") === "0:20",
    `default settings share one unit (${await txt(A,"#setMatch")}, ${await txt(A,"#setWord")})`);
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
  ok(true, "both players entered the synchronized tutorial barrier");

  /* The match screen can assemble behind HOW TO PLAY, but the authoritative
     word and shared 3-2-1 stay absent until both tutorial tokens are
     acknowledged. Wait longer than the old PRECOUNT_MS to prove this is a
     server barrier, not a lucky client-side pause. */
  await sleep(1700);
  const heldForTutorial = await Promise.all([A, B].map(p => p.evaluate(() => ({
    state:document.body.dataset.state,
    cardOpen:!document.getElementById("howToPlay").classList.contains("hidden"),
    countdownHidden:document.getElementById("countdown").classList.contains("hidden"),
  }))));
  const noWordYet = await Promise.all([A, B].map(p => p.evaluate(async () => {
    const {state}=await import("/js/state.js");
    return !state.game?.roundId && !state.game?.word;
  })));
  ok(heldForTutorial.every(v => v.state === "countdown" && v.cardOpen &&
      v.countdownHidden) && noWordYet.every(Boolean),
    "1v1 waits past the old count-in with no visible countdown and no dealt word");

  const htp1v1 = await A.evaluate(() => {
    const card = document.getElementById("howToPlay");
    const visible = n => getComputedStyle(n).display !== "none";
    const labels = [...card.querySelectorAll(".htp-lab")].filter(visible)
      .map(n => n.textContent);
    return { open: !card.classList.contains("hidden"), mode: card.dataset.mode, labels };
  });
  ok(htp1v1.open && htp1v1.mode === "1v1", "the 1v1 How to Play card raises itself before the shared countdown");
  ok(htp1v1.labels.join("|") ===
    "SEE THE WORD AND ACT IT OUT|GET AI TO GUESS YOUR ACTION FIRST|5 SECONDS TO ACT IF YOUR OPPONENT GETS IT FIRST",
    `1v1's three columns show 1v1-specific copy (${htp1v1.labels.join(" / ")})`);
  /* 1V1: I'M READY, AND NO COUNTDOWN. The button is the card's one control
     and carries no count. A player who waits too long does not hold the room:
     when the grace runs out the match starts BEHIND their card, which stays
     up until they press. Party keeps its count (party.test.mjs). */
  const graceCount = await A.evaluate(() =>
    document.getElementById("htpCount").textContent.trim());
  ok(graceCount === "", `1v1's I'M READY carries no countdown (${JSON.stringify(graceCount)})`);
  await act(A, () => readyUp(A));
  ok(await A.evaluate(() => document.getElementById("howToPlay").classList.contains("hidden")),
    "I'M READY acknowledges and dismisses the local 1v1 card");
  await sleep(250);
  ok(await B.evaluate(async () => {
    const {state}=await import("/js/state.js");
    return document.body.dataset.state === "countdown" && !state.game?.roundId &&
      !document.getElementById("howToPlay").classList.contains("hidden") &&
      document.getElementById("countdown").classList.contains("hidden");
  }), "inside the grace, one ready player cannot start underneath the other's instructions");
  /* B never presses. */
  await B.waitForFunction(() => document.body.dataset.state === "playing",
    { timeout: 15000, polling: 50 });
  ok(await B.evaluate(() => !document.getElementById("howToPlay").classList.contains("hidden")
      && document.getElementById("vsWord").textContent.trim().length > 0),
    "a player who waits too long gets the match started BEHIND their card, first word live");
  await act(B, () => readyUp(B));
  ok(await B.evaluate(() => document.getElementById("howToPlay").classList.contains("hidden")
      && document.body.dataset.state === "playing"),
    "and their I'M READY drops them straight into the running match");

  await waitState(A, "playing"); await waitState(B, "playing");
  ok(await A.evaluate(() => document.body.dataset.screen) === "match", "match screen shown");
  const wordA = await txt(A, "#vsWord"), wordB = await txt(B, "#vsWord");
  ok(wordA === wordB && wordA.length > 0, `same word on both screens: "${wordA}"`);
  ok(await A.evaluate(() => document.querySelector("header").classList.contains("hidden")),
    "new Figma 1v1 screen owns the full viewport");
  ok(/^\d+:\d\d$/.test(await txt(A, "#v1MatchTime")), `paper match clock ticking (${await txt(A, "#v1MatchTime")})`);
  await sleep(650); // let the Figma word-card entrance settle before measuring
  const robotBubble = await A.evaluate(async () => {
    const robot=document.getElementById("v1RobotYou");
    const bubble=robot.querySelector(".rb-bubble");
    robot.dataset.pose="idle";
    bubble.querySelector("b").textContent="YOU GOT THIS!";
    bubble.classList.remove("show");
    void bubble.offsetWidth;
    bubble.classList.add("show");
    await new Promise(r=>setTimeout(r,240)); // pose anchors transition for 200ms
    const cs=getComputedStyle(bubble);
    const pct=name=>parseFloat(cs.getPropertyValue(name))/100;
    const tailX=bubble.offsetLeft+bubble.offsetWidth*.2050147493;
    const tailY=bubble.offsetTop+bubble.offsetHeight*.9659090909;
    const mouthX=robot.clientWidth*pct("--talk-x");
    const mouthY=robot.clientHeight*pct("--talk-y");
    const box=bubble.getBoundingClientRect();
    const stage=document.getElementById("matchStage").getBoundingClientRect();
    /* The rival is intentionally muted and therefore has no speech node in
       production. Mount a hidden clone long enough to exercise the mirrored
       tail equation against the rival's real right-edge geometry. */
    const rival=document.getElementById("v1RobotRival");
    const mirrored=bubble.cloneNode(true);
    mirrored.classList.remove("show");
    rival.append(mirrored);
    const mcs=getComputedStyle(mirrored);
    const mpct=name=>parseFloat(mcs.getPropertyValue(name))/100;
    const mTailX=mirrored.offsetLeft+mirrored.offsetWidth*.7949852507;
    const mTailY=mirrored.offsetTop+mirrored.offsetHeight*.9659090909;
    const mMouthX=rival.clientWidth*mpct("--talk-x");
    const mMouthY=rival.clientHeight*mpct("--talk-y");
    const mbox=mirrored.getBoundingClientRect();
    const mirror={
      gap:(mMouthX-mTailX)/rival.clientWidth,
      y:(mTailY-mMouthY)/rival.clientHeight,
      inside:mbox.left>=stage.left-1 && mbox.right<=stage.right+1,
    };
    mirrored.remove();
    return {
      gap:(tailX-mouthX)/robot.clientWidth,
      y:(tailY-mouthY)/robot.clientHeight,
      inside:box.left>=stage.left-1 && box.right<=stage.right+1,
      visible:parseFloat(cs.opacity)>.9,
      mirror,
    };
  });
  ok(robotBubble.gap>.26 && robotBubble.gap<.30 &&
    Math.abs(robotBubble.y)<.015 && robotBubble.inside && robotBubble.visible,
    `a visible 1v1 speech tail sits beside the robot's mouth (${(robotBubble.gap*100).toFixed(1)}% gap)`);
  ok(robotBubble.mirror.gap>.26 && robotBubble.mirror.gap<.30 &&
    Math.abs(robotBubble.mirror.y)<.015 && robotBubble.mirror.inside,
    `the mirrored 1v1 tail equation stays beside the rival robot (${(robotBubble.mirror.gap*100).toFixed(1)}% gap)`);
  if(process.env.ONLINE_BUBBLE_SCREENSHOT){
    await A.screenshot({path:process.env.ONLINE_BUBBLE_SCREENSHOT,fullPage:true});
    console.log(`  info 1v1 bubble screenshot: ${process.env.ONLINE_BUBBLE_SCREENSHOT}`);
  }
  await A.evaluate(() => document.querySelector("#v1RobotYou .rb-bubble")?.classList.remove("show"));
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

  /* The in-match LEAVE paper is gone: the volume control now occupies the
     slot it held, and Esc is the way out — which still has to tell the room,
     or the other player waits out someone who is not there. */
  const chromeProbe = await A.evaluate(() => {
    const stage = document.getElementById("matchStage").getBoundingClientRect();
    const b = document.getElementById("btnMatchSound");
    const cs = getComputedStyle(b);
    const r = b.getBoundingClientRect();
    return {
      exitGone: !document.getElementById("btnExitMatch") &&
        !document.querySelector("#matchStage .sp-exit"),
      label: b.getAttribute("aria-label"),
      clickable: cs.pointerEvents !== "none" && r.width > 0 && r.height > 0,
      opacity: parseFloat(cs.opacity),
      /* the vacated LEAVE slot: top-left, just under the match clock */
      inLeaveSlot: (r.left - stage.left) / stage.width < .09 &&
        (r.top - stage.top) / stage.height > .12 &&
        (r.top - stage.top) / stage.height < .26,
    };
  });
  ok(chromeProbe.exitGone, "1v1 carries no mid-match LEAVE paper");
  ok(chromeProbe.clickable === true, "the in-match volume control is hit-testable");
  ok(!!chromeProbe.label, `the volume control is labelled (${chromeProbe.label})`);
  ok(chromeProbe.inLeaveSlot,
    "the volume control sits in the slot the LEAVE paper vacated");
  ok(chromeProbe.opacity < .35,
    `it stays ghosted until sought out (${chromeProbe.opacity})`);

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
    window.__visionTick(label);
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
    window.__visionTick(next);
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

  /* Recognition is a charge meter now — a word takes a couple of seconds of
     held pose to land, so every "did the round move on" wait below is sized
     for that rather than for the old instant threshold trip. */
  console.log("round 1 — Alice first, Bob chases:");
  await winNow(A);
  await A.waitForFunction(() => document.getElementById("matchStage").dataset.phase === "chase",
    {timeout:9000,polling:100});
  await B.waitForFunction(() => document.getElementById("matchStage").dataset.phase === "chase",
    {timeout:9000,polling:100});
  ok(/5 SECONDS LEFT/.test(await txt(A,"#v1WordTimerLabel")),
    "first recognition opened the chase immediately");
  /* Recognition STAMPS the GOT IT paper on the half that earned it; nothing is
     paid until the word resolves. The paper has to be asserted before the
     total, because the total is not allowed to move until the paper carries
     it there — and that is the end of the word, not the moment of the catch. */
  await A.waitForFunction(() =>
    document.querySelector('.pp-award[data-seat="you"]')?.classList.contains("show"),
    {timeout:1500,polling:25});
  ok(await A.evaluate(() => {
    const award=document.querySelector('.pp-award[data-seat="you"]');
    const half=document.querySelector(".v1-video-side.you").getBoundingClientRect();
    const box=award.getBoundingClientRect();
    const cx=box.left+box.width/2;
    return document.getElementById("vsWordCard").classList.contains("locked") &&
      award.querySelector("img").src.includes("sp-award.webp") &&
      cx>half.left && cx<half.right;
  }), "1v1 stamps Solo's GOT IT paper on the half that earned it");
  ok(await A.evaluate(() =>
    parseInt((document.getElementById("v1YouScore").textContent||"0")
      .replace(/[^0-9]/g,""),10) === 0),
    "the total holds at zero while the paper is still sitting on the seat");
  ok(await A.evaluate(() =>
    !document.querySelector('.pp-award[data-seat="you"]').classList.contains("deliver")),
    "the stamp stays put through the chase instead of paying out on the spot");
  ok(await B.evaluate(() => {
    const award=document.querySelector('.pp-award[data-seat="rival"]');
    const half=document.querySelector(".v1-video-side.rival").getBoundingClientRect();
    const box=award.getBoundingClientRect();
    const cx=box.left+box.width/2;
    return award.classList.contains("show") &&
      award.querySelector(".aw-got").textContent==="ALICE GOT IT!" &&
      award.querySelector("img").src.includes("sp-award.webp") &&
      cx>half.left && cx<half.right;
  }), "the opponent sees the same paper stamped on that player's own half");
  const chaseClockFit=await A.evaluate(() => {
    const value=document.getElementById("v1WordTime");
    const card=document.getElementById("v1WordTimerCard");
    const label=document.getElementById("v1WordTimerLabel");
    return {
      ratio:parseFloat(getComputedStyle(value).fontSize)/card.clientWidth,
      labelScroll:label.scrollWidth,
      labelClient:label.clientWidth,
    };
  });
  ok(chaseClockFit.ratio>.23 &&
    chaseClockFit.labelScroll<=chaseClockFit.labelClient+1,
    `the chase clock retains authored enlarged type and fitted label (${chaseClockFit.ratio.toFixed(3)}, ${chaseClockFit.labelScroll}/${chaseClockFit.labelClient}px)`);
  /* A small paper clock is not enough urgency on a screen that is mostly your
     own camera — the SCREEN EDGES pulse, so the chase lands peripherally. */
  ok(await A.evaluate(() => {
    const pulse = document.getElementById("edgePulse");
    return Number.parseFloat(getComputedStyle(pulse).opacity) > .3 &&
      getComputedStyle(pulse).position === "fixed";
  }), "the chase pulses the screen edges from its own fixed layer");
  /* Sudden death inverts the whole match, so it gets the same weight TIMES UP
     gets rather than a toast nobody reads mid-pose. */
  ok(await A.evaluate(async () => {
    const { showSuddenDeath, hideSuddenDeath } = await import(location.origin + "/js/ui.js");
    const stage = document.getElementById("matchStage");
    const previous = stage.dataset.phase;
    stage.dataset.phase = "sudden";
    showSuddenDeath();
    await new Promise(r => setTimeout(r, 420));
    const card = document.getElementById("suddenDeath");
    const box = card.querySelector(".sd-card").getBoundingClientRect();
    const title = card.querySelector(".sd-title");
    const pulse = getComputedStyle(document.getElementById("edgePulse"));
    const shown = !card.classList.contains("hidden") &&
      card.classList.contains("fire") &&
      box.width > innerWidth * .3 &&
      box.left >= -1 && box.right <= innerWidth + 1 &&
      title.scrollWidth <= title.clientWidth + 1 &&
      Number.parseFloat(pulse.opacity) > .3;
    hideSuddenDeath();
    stage.dataset.phase = previous;
    return shown;
  }), "sudden death slams a full-screen Figma banner and reddens the edges");
  await sleep(300);
  await winNow(B);
  await waitState(A, "word-won", 5000);
  await waitState(B, "word-won", 5000);
  const resultMeters=await Promise.all([A,B].map(p => p.evaluate(() => {
    const fill=document.getElementById("v1WordFill");
    const card=document.getElementById("vsWordCard");
    return {
      ratio:parseFloat(getComputedStyle(fill).width) /
        parseFloat(getComputedStyle(card).width),
      inline:fill.style.width,
      phase:document.getElementById("matchStage").dataset.phase,
      locked:card.classList.contains("locked"),
    };
  })));
  ok(resultMeters.every(value => value.ratio>.9),
    `both successful players keep a full meter through the result beat (${resultMeters.map(value => value.inline+"/"+value.ratio.toFixed(2)).join(", ")})`);
  /* End of the word is where the papers are thrown and the totals move. Aim
     first, then arrival — the score is not allowed to lead the paper. */
  ok(await A.waitForFunction(() => {
    const award=document.querySelector('.pp-award[data-seat="you"]');
    if(!award?.classList.contains("deliver")) return false;
    const card=document.getElementById("v1YouScore").closest(".v1-scorecard");
    const dx=parseFloat(award.style.getPropertyValue("--fly-x"));
    const dy=parseFloat(award.style.getPropertyValue("--fly-y"));
    const from=award.getBoundingClientRect(), to=card.getBoundingClientRect();
    return Number.isFinite(dx) && Number.isFinite(dy) &&
      Math.abs((from.left+from.width/2)+dx-(to.left+to.width/2))<80 &&
      card.classList.contains("awaiting");
  }, {timeout:3000,polling:25}).then(()=>true,()=>false),
    "the word ends by aiming each paper at the score card it pays into");
  await A.waitForFunction(() =>
    parseInt((document.getElementById("v1YouScore").textContent||"0")
      .replace(/[^0-9]/g,""),10) > 0, {timeout:4000,polling:60});
  const round1A=parseInt((await txt(A,"#v1YouScore")).replace(/[^0-9]/g,""));
  const round1B=parseInt((await txt(A,"#v1RivalScore")).replace(/[^0-9]/g,""));
  ok(round1A>=300 && round1A<=500,
    `the total moves as the paper arrives (${round1A})`);
  ok(round1A>round1B && round1B>0,
    `continuous chaser decay awarded both players (${round1A} / ${round1B})`);
  const chaserPaper=await B.evaluate(() => parseInt(
    (document.querySelector('.pp-award[data-seat="you"] .aw-pts')
      ?.textContent||"0").replace(/[^0-9]/g,""),10));
  ok(chaserPaper===round1B,
    `the chaser's own stamp carried the figure it paid (paper +${chaserPaper} / card ${round1B})`);

  console.log("round 2 — Bob first, Alice misses the chase:");
  await waitState(B, "playing", 8000);
  await winNow(B);
  ok(await B.waitForFunction(() => document.getElementById("matchStage").dataset.phase === "chase",
    {timeout:9000,polling:100}).then(()=>true,()=>false),
    "round 2: Bob's held pose opens the chase");
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
  ok(/LEFT EARLY/i.test(await txt(A, "#rsHeadline")), `peer sees early end ("${await txt(A, "#rsHeadline")}")`);

  console.log("replay -> fresh lobby + join by typed code:");
  await act(A, () => A.click("#rsRematch"));
  await waitState(A, "lobby", 10000);
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
  await A.waitForFunction(() =>
    document.body.dataset.state === "party" &&
    document.getElementById("lobbyStage").dataset.mode === "party",
    { timeout: 8000, polling: 100 });
  await A.waitForFunction(previous =>
    /^[A-Z2-9]{6}$/.test(document.getElementById("roomCodeText").textContent) &&
    document.getElementById("roomCodeText").textContent !== previous,
    { timeout: 10000, polling: 300 }, code2);
  const pcode = await txt(A, "#roomCodeText");
  ok(/^[A-Z2-9]{6}$/.test(pcode), `party room created (${pcode})`);
  ok(await A.evaluate(() => document.querySelector('#ptB0 .pt-name b')?.textContent) === "Alice", "host camera tile uses the saved player name");
  ok(await A.evaluate(() => document.querySelector('#ptB0 .pt-name img')?.getAttribute("src")?.endsWith("lb-name-chip.webp")), "party tile uses the 1v1 torn-paper name asset");
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
  await B.waitForFunction(() =>
    document.body.dataset.state === "party" &&
    document.getElementById("lobbyStage").dataset.mode === "party",
    { timeout: 8000, polling: 100 });
  await B.waitForFunction(previous =>
    /^[A-Z2-9]{6}$/.test(document.getElementById("roomCodeText").textContent) &&
    document.getElementById("roomCodeText").textContent !== previous,
    { timeout: 10000, polling: 300 }, code2);
  await act(B, () => B.evaluate(() => { document.getElementById("joinCode").value = ""; }));
  await act(B, () => B.type("#joinCode", pcode));
  await act(B, () => B.click("#btnJoinRoom"));
  await B.waitForFunction(c => document.getElementById("roomCodeText").textContent === c, { timeout: 10000, polling: 300 }, pcode);
  ok(true, "B joined the party by code");
  await B.waitForFunction(() => document.querySelector('#ptO0 .pt-name b')?.textContent === "Bob", { timeout: 8000, polling: 300 });
  ok(true, "B auto-balanced onto orange");
  await B.waitForFunction(() =>
    document.querySelector('#ptB0 .pt-name b')?.textContent === "PartyAlice",
    { timeout:3000,polling:50 });
  ok(true, "party name change reached the other player");
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
