/* Party E2E: real Node server, four headless-Chrome players in isolated
   contexts, real Socket.IO + WebRTC mesh. Drives the party lobby to a start
   and then plays a round — only the vision input is simulated (recognition
   is injected at the same funnel the classifier feeds). */
import puppeteer from "puppeteer-core";
import { installVisionFixture } from "./vision-fixture.mjs";
import { spawn } from "child_process";
import { fileURLToPath } from "url";

const PORT = 3461;
const APP = `http://localhost:${PORT}`;
const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const SERVER_DIR = fileURLToPath(new URL("../server", import.meta.url));

const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0;
const ok = (cond, msg) => { console.log((cond ? "  ok  " : "  FAIL") + " " + msg); if (!cond) fails++; };

const server = spawn("node", ["index.js"], {
  cwd: SERVER_DIR,
  env: { ...process.env, PORT: String(PORT), PRECOUNT_MS: "1200",
         TUTORIAL_GRACE_MS: "6000", BETWEEN_ROUNDS_MS: "900",
         RATE_CREATE: "40", RATE_JOIN: "80" },
  stdio: "pipe",
});
await new Promise((res, rej) => {
  server.stdout.on("data", d => String(d).includes("server running") && res());
  setTimeout(() => rej(new Error("server failed to start")), 5000);
});

if(process.env.PARTY_DEBUG) server.stdout.on("data", d => process.stdout.write("[srv] " + d));

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: "new",
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--no-first-run"],
});

const TAGS = ["A", "B", "C", "D"];
const errors = Object.fromEntries(TAGS.map(t => [t, []]));
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
  /* a returning adult player: the online age check (ageGate.js) is answered.
     The age card itself is tested in offline.test.mjs on a page of its own. */
  await page.evaluate(() => { try{ localStorage.setItem("posePartyOnlineAge", "ok"); }catch(e){} });
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

async function player(tag, name){
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  /* the owner's tools (gear, sound, DEV bar) are dev-only; the suites use them */
  await page.evaluateOnNewDocument(() => { try{ localStorage.setItem("posePartyDev", "1"); }catch(e){} });
  await page.setViewport({ width: 1280, height: 720 });
  await page.setBypassCSP(true);
  page.on("console", m => { if (m.type() === "error") errors[tag].push(m.text()); });
  page.on("pageerror", e => errors[tag].push("PAGEERROR: " + e.message));
  page.on("response", r => { if (r.status() >= 400) errors[tag].push("HTTP " + r.status() + " " + r.url()); });
  await page.evaluateOnNewDocument(n => localStorage.setItem("poseCharadesName", n), name);
  await page.goto(APP, { waitUntil: "networkidle2", timeout: 60000 });
  await passCameraGate(page);
  await page.waitForFunction(() => document.getElementById("status").style.display === "none",
    { timeout: 60000, polling: 400 });
  page.tag = tag;
  await installVisionFixture(page);
  return page;
}

const ev = (p, expr) => p.evaluate(`(async () => (${expr}))()`);
const mod = m => `(await import('${APP}/js/${m}'))`;
const txt = (p, sel) => p.evaluate(s => document.querySelector(s)?.textContent ?? null, sel);

try {
  console.log("party lobby -> match:");
  const [A, B, C, D] = await Promise.all(TAGS.map((t, i) =>
    player(t, ["Alice", "Bob", "Cara", "Dan"][i])));

  // host opens a party room
  await A.click("#modeParty");
  await A.waitForFunction(() => /^[A-Z2-9]{6}$/.test(document.getElementById("roomCodeText").textContent),
    { timeout: 15000, polling: 300 });
  const code = await txt(A, "#roomCodeText");
  ok(!!code, `party room opened (${code})`);

  /* The public UI deliberately floors matches at one minute. This suite runs
     just above the server's validated 10-second test floor so it can cover
     real results readiness, same-room restart and results-phase leaving.

     16 rather than 10 on purpose: at 10s the chase round resolved within a
     couple of hundred ms of the final whistle, and leaving gameplay sweeps
     every stamped award paper by design (clearCelebrations) — so the throw
     this suite asserts sometimes never got to start. That is the match ENDING,
     not the payoff being broken, and it is not what the assertion is about.

     30 rather than 16 for the same class of reason, one level up: the MATCH
     clock has to outlast this suite's own assertions, not just the round.
     Between the countdown and `recognize(C)` there are three dozen page
     round-trips across four headless Chromes, and on a loaded machine that
     block ran ~14 seconds — so the whistle blew before the chase the next
     assertion waits for could open, and the failure looked like "the chase
     never happened" rather than "the match was over". Timed against the
     wall clock this block is the constraint; the round it observes is not.
     The two results waits below are sized off this number. */
  await A.evaluate(async () => {
    const {lobbySettings, partyBridge}=await import("/js/online.js");
    const settings=lobbySettings();
    settings.matchSecs=30;
    /* 9, not 5: between A's recognition and C's this suite runs a dozen
       page round-trips, and on a loaded machine that block outlasted a
       five-second word — the word rolled over and blue never completed. */
    settings.wordSecs=9;
    partyBridge.settings(settings);
  });

  for (const p of [B, C, D]) {
    await p.click("#modeParty");
    await p.waitForFunction(() => /^[A-Z2-9]{6}$/.test(document.getElementById("roomCodeText").textContent),
      { timeout: 15000, polling: 300 });
    await p.evaluate(() => { document.getElementById("joinCode").value = ""; });
    await p.type("#joinCode", code);
    await p.click("#btnJoinRoom");
    await p.waitForFunction(c => document.getElementById("roomCodeText").textContent === c,
      { timeout: 15000, polling: 300 }, code);
  }
  ok(true, "three players joined the party by code");

  await A.waitForFunction(() => !document.getElementById("btnStartMatch").disabled,
    { timeout: 15000, polling: 300 });
  ok(true, "2v2 unlocked the host START button");

  await A.click("#btnStartMatch");
  for (const p of [A, B, C, D])
    await p.waitForFunction(() => document.body.dataset.screen === "pmatch",
      { timeout: 15000, polling: 200 });
  ok(true, "every player landed on the party match screen");

  /* Party enters a server-owned tutorial barrier before one synchronized
     countdown is published. Waiting longer than the old PRECOUNT_MS proves
     the first word is not quietly running under the instructions. */
  await sleep(1400);
  const partyHeld = await Promise.all([A, B, C, D].map(p => ev(p, `(async () => {
    const {state}=await import("/js/state.js");
    return document.body.dataset.state === "countdown" &&
      !state.game?.roundId && !state.game?.word &&
      !document.getElementById("howToPlay").classList.contains("hidden") &&
      document.getElementById("countdown").classList.contains("hidden");
  })()`)));
  ok(partyHeld.every(Boolean),
    "all four Party clients remain instruction-gated past the old count-in");

  const htpParty = await ev(A, `(() => {
    const card = document.getElementById("howToPlay");
    const visible = n => getComputedStyle(n).display !== "none";
    const labels = [...card.querySelectorAll(".htp-lab")].filter(visible)
      .map(n => n.textContent);
    return { open: !card.classList.contains("hidden"), mode: card.dataset.mode, labels };
  })()`);
  ok(htpParty.open && htpParty.mode === "party", "the Party How to Play card raises itself before the shared countdown");
  ok(htpParty.labels.join("|") ===
    "SEE THE WORD AND ACT IT OUT|GET AI TO GUESS YOUR ACTION FIRST|BONUS POINTS IF YOUR ENTIRE TEAM GETS IT",
    `Party's three columns show Party-specific copy (${htpParty.labels.join(" / ")})`);
  await readyUp(A);
  ok(await ev(A, `document.getElementById("howToPlay").classList.contains("hidden")`),
    "I'M READY acknowledges and dismisses the local Party card");
  await sleep(250);
  ok(await ev(B, `(async () => {
    const {state}=await import("/js/state.js");
    return !state.game?.roundId &&
      !document.getElementById("howToPlay").classList.contains("hidden") &&
      document.getElementById("countdown").classList.contains("hidden");
  })()`), "inside the grace, one Party acknowledgement cannot start beneath another player's instructions");
  await Promise.all([B, C, D].map(readyUp));
  await Promise.all([A, B, C, D].map(p => p.waitForFunction(() =>
    !document.getElementById("countdown").classList.contains("hidden"),
    {timeout:3000,polling:25})));
  ok(true, "all four ready releases the same future Party countdown at once");

  const partyBubble = await ev(A, `(async () => {
    const robot=document.getElementById("pmRobotMine");
    const bubble=robot.querySelector(".rb-bubble");
    robot.dataset.pose="idle";
    bubble.querySelector("b").textContent="YOU GOT THIS!";
    bubble.classList.remove("show");
    void bubble.offsetWidth;
    bubble.classList.add("show");
    await new Promise(r=>setTimeout(r,240));
    const cs=getComputedStyle(bubble);
    const pct=name=>parseFloat(cs.getPropertyValue(name))/100;
    const tailX=bubble.offsetLeft+bubble.offsetWidth*.2050147493;
    const tailY=bubble.offsetTop+bubble.offsetHeight*.9659090909;
    const mouthX=robot.clientWidth*pct("--talk-x");
    const mouthY=robot.clientHeight*pct("--talk-y");
    const box=bubble.getBoundingClientRect();
    const stage=document.getElementById("pmStage").getBoundingClientRect();
    /* The opposing robot is intentionally muted and has no production speech
       node. A hidden clone still lets this test cover the mirrored tail math
       against the foe's real right-edge position. */
    const foe=document.getElementById("pmRobotFoe");
    const mirrored=bubble.cloneNode(true);
    mirrored.classList.remove("show");
    foe.append(mirrored);
    const mcs=getComputedStyle(mirrored);
    const mpct=name=>parseFloat(mcs.getPropertyValue(name))/100;
    const mTailX=mirrored.offsetLeft+mirrored.offsetWidth*.7949852507;
    const mTailY=mirrored.offsetTop+mirrored.offsetHeight*.9659090909;
    const mMouthX=foe.clientWidth*mpct("--talk-x");
    const mMouthY=foe.clientHeight*mpct("--talk-y");
    const mbox=mirrored.getBoundingClientRect();
    const mirror={
      gap:(mMouthX-mTailX)/foe.clientWidth,
      y:(mTailY-mMouthY)/foe.clientHeight,
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
  })()`);
  ok(partyBubble.gap>.26 && partyBubble.gap<.30 &&
    Math.abs(partyBubble.y)<.015 && partyBubble.inside && partyBubble.visible,
    `a visible Party speech tail sits beside the robot's mouth (${(partyBubble.gap*100).toFixed(1)}% gap)`);
  ok(partyBubble.mirror.gap>.26 && partyBubble.mirror.gap<.30 &&
    Math.abs(partyBubble.mirror.y)<.015 && partyBubble.mirror.inside,
    `the mirrored Party tail equation stays beside the foe robot (${(partyBubble.mirror.gap*100).toFixed(1)}% gap)`);
  if(process.env.PARTY_BUBBLE_SCREENSHOT){
    await A.screenshot({path:process.env.PARTY_BUBBLE_SCREENSHOT,fullPage:true});
    console.log(`  info Party bubble screenshot: ${process.env.PARTY_BUBBLE_SCREENSHOT}`);
  }
  await A.evaluate(() => document.querySelector("#pmRobotMine .rb-bubble")?.classList.remove("show"));

  console.log("seating:");
  const seatInfo = await ev(A, `(() => {
    const seats = [...document.querySelectorAll('#pmStage [data-seat]')]
      .map(s => ({ seat: s.dataset.seat, name: s.querySelector('.pm-nametag b').textContent,
                   mine: s.classList.contains('mine'), hidden: getComputedStyle(s).display === 'none' }));
    return { size: document.getElementById('pmStage').dataset.size, seats };
  })()`);
  ok(seatInfo.size === "2", `2v2 collapses the stage to two seats a side (data-size=${seatInfo.size})`);
  const shown = seatInfo.seats.filter(s => !s.hidden);
  ok(shown.length === 4, `only four seats render (${shown.length})`);
  ok(seatInfo.seats.filter(s => s.hidden).map(s => s.seat).sort().join() === "blue2,orange2",
    "the bottom centre cards are the ones dropped");
  const mine = seatInfo.seats.find(s => s.mine);
  /* YOUR OWN CHIP SAYS "YOU", NOT YOUR NAME. On a six-way split the only
     thing a player hunts for is which of these unfamiliar crops is the
     mirror, and their own name answers a question nobody asked. Everyone
     else's chip still carries the name they set in the lobby. */
  ok(mine && mine.seat === "blue0" && mine.name === "YOU",
    `the local player is featured on their own side and labelled YOU (${mine?.seat} = ${mine?.name})`);
  ok(shown.every(s => s.name && s.name !== ""), "every visible seat carries a name tag");
  const names = shown.map(s => s.name).sort().join();
  ok(names === "BOB,CARA,DAN,YOU", `lobby names carried into the match for everyone else (${names})`);
  const visualContract = await ev(A, `(() => {
    const src = sel => document.querySelector(sel)?.getAttribute('src') || '';
    const stage = document.getElementById('pmStage').getBoundingClientRect();
    return {
      blue: src('[data-seat="blue1"] .pm-border-team'),
      orange: src('[data-seat="orange1"] .pm-border-team'),
      green: src('[data-seat="blue1"] .pm-border-got'),
      got: src('.pp-award img'),
      crown: src('[data-seat="blue1"] .pp-crown'),
      divider: src('.pm-divider img'),
      tapes: ['pmMatchTimerTape','pmBlueScoreTape','pmWordTimerTape',
        'pmOrangeScoreTape','pmMyTopTape','pmMyPastTape','pmFoeTopTape',
        'pmFoePastTape','pmWordRightTape','pmWordLeftTape'].map(id => {
          const el=document.getElementById(id);
          return {src:el?.getAttribute('src') || '', rotate:getComputedStyle(el).rotate};
        }),
      sound: (() => {
        const b = document.getElementById('btnPartySound');
        const cs = getComputedStyle(b), r = b.getBoundingClientRect();
        return { opacity: parseFloat(cs.opacity), label: b.getAttribute('aria-label'),
                 clickable: cs.pointerEvents !== 'none' && r.width > 0 && r.height > 0,
                 inLeaveSlot: (r.left - stage.left) / stage.width < .09 &&
                   (r.top - stage.top) / stage.height > .12 &&
                   (r.top - stage.top) / stage.height < .26 };
      })(),
      exitGone: !document.getElementById('btnExitParty') &&
        !document.querySelector('#pmStage .sp-exit'),
      historyTapesHidden: ['pmMyPastTape','pmFoePastTape'].every(id =>
        Number.parseFloat(getComputedStyle(document.getElementById(id)).opacity) === 0),
      ratio: stage.width / stage.height,
      centred: Math.abs((stage.left + stage.width / 2) - innerWidth / 2) < 1,
    };
  })()`);
  ok(/pm-border-blue\.webp$/.test(visualContract.blue) &&
     /pm-border-orange\.webp$/.test(visualContract.orange) &&
     /pm-border-green\.webp$/.test(visualContract.green),
    "party tiles use the exact blue/orange/recognized Figma borders");
  ok(/crown-paper\.webp$/.test(visualContract.crown) &&
     /pm-divider\.webp$/.test(visualContract.divider),
    "paper crown and split divider use their exact Figma exports");
  ok(visualContract.tapes.every(t =>
      /pm-tape-[a-z-]+\.webp$/.test(t.src) && (t.rotate === "none" || t.rotate === "0deg")),
    "all Party tapes use exact pre-rotated Figma node exports");
  /* No mid-match LEAVE paper any more: the volume control took its slot and
     Esc is the way out (which still tells the room). */
  ok(visualContract.exitGone, "Party carries no mid-match LEAVE paper");
  ok(visualContract.sound.clickable,
    "the in-match volume control is hit-testable");
  ok(!!visualContract.sound.label,
    `the volume control is labelled (${visualContract.sound.label})`);
  ok(visualContract.sound.inLeaveSlot,
    "the volume control sits in the slot the LEAVE paper vacated");
  ok(visualContract.sound.opacity < .35,
    `it stays ghosted until sought out (${visualContract.sound.opacity})`);
  ok(visualContract.historyTapesHidden,
    "previous-guess tape stays attached to state instead of floating by itself");
  ok(Math.abs(visualContract.ratio - 16 / 9) < .002 && visualContract.centred,
    `the 1440×810 match stage remains centred and proportional (${visualContract.ratio.toFixed(3)})`);

  console.log("round + recognition:");
  for (const p of [A, B, C, D])
    await p.waitForFunction(() => document.getElementById("pmStage").dataset.phase === "round",
      { timeout: 20000, polling: 200 });
  const word = await ev(A, `${mod("state.js")}.state.game.word`);
  ok(!!word, `word dealt to everyone ("${word}")`);
  const sameWord = await Promise.all([B, C, D].map(p => ev(p, `${mod("state.js")}.state.game.word`)));
  ok(sameWord.every(w => w === word), "all four clients share the word");
  const partyFeedbackProbe = await A.evaluate(async currentWord => {
    const {state}=await import("/js/state.js");
    const {partyCheck}=await import("/js/partyMatch.js");
    const {fitGameplayText,fitSingleLinePaperText}=
      await import("/js/gameplayFeedback.js");
    state.smooth[currentWord]=.45;
    window.__visionTick();
    partyCheck(currentWord,.45);
    /* Keep the fake camera fresh through the wait. One tick is stale after
       POSE_GAP_MS (250), so a single tick read the meter at 0 at 260ms. */
    const fresh=setInterval(()=>window.__visionTick(),80);
    await new Promise(resolve=>setTimeout(resolve,260));
    clearInterval(fresh);
    const card=document.getElementById("pmWordCard");
    const fill=document.getElementById("pmWordFill");
    const clock=document.getElementById("pmMatchTime");
    const wordNode=document.getElementById("pmWord");
    const guessNode=document.getElementById("pmMyTopWord");
    const nameNode=document.querySelector('#pmStage [data-seat]:not(.vacant) .pm-nametag b');
    const oldWord=wordNode.textContent;
    const oldGuess=guessNode.textContent;
    const oldName=nameNode?.textContent || "";
    wordNode.textContent="THE EXTRAORDINARILY LONG CURRENT ACTION";
    guessNode.textContent="EXTRAORDINARILY LONG ROBOT GUESS?";
    if(nameNode) nameNode.textContent="MAXIMILIAN";
    fitGameplayText(wordNode);
    fitGameplayText(guessNode);
    fitSingleLinePaperText(nameNode,{safety:.86,minScale:.44});
    const inside=node => node.scrollWidth<=node.clientWidth+1 &&
      node.scrollHeight<=node.clientHeight+1;
    const result={
      tracking:card.classList.contains("tracking"),
      fill:parseFloat(fill.style.width)||0,
      current:document.getElementById("pmMyTop").classList.contains("pop"),
      wordFit:inside(wordNode),
      guessFit:inside(guessNode),
      nameFit:!!nameNode && inside(nameNode),
      wraps:wordNode.classList.contains("fit-wrap") &&
        guessNode.classList.contains("fit-wrap"),
      clockFit:inside(clock) && /^\d+:\d\d$/.test(clock.textContent) &&
        !/^0\d:/.test(clock.textContent),
    };
    wordNode.textContent=oldWord;
    guessNode.textContent=oldGuess;
    if(nameNode) nameNode.textContent=oldName;
    fitGameplayText(wordNode);
    fitGameplayText(guessNode);
    fitSingleLinePaperText(nameNode,{safety:.86,minScale:.44});
    return result;
  },word);
  ok(partyFeedbackProbe.tracking && partyFeedbackProbe.fill>0 &&
     partyFeedbackProbe.fill<72 && partyFeedbackProbe.current,
    `Party uses the shared immediate robot paper + eased meter/shake (${partyFeedbackProbe.fill.toFixed(1)}%)`);
  ok(partyFeedbackProbe.wordFit && partyFeedbackProbe.guessFit &&
     partyFeedbackProbe.nameFit && partyFeedbackProbe.wraps &&
     partyFeedbackProbe.clockFit,
    "Party long word/guess/name copy and compact blue clock stay inside their papers");
  if(process.env.PARTY_SCREENSHOT){
    await sleep(700);
    await A.screenshot({path:process.env.PARTY_SCREENSHOT,fullPage:true});
    console.log(`  info party screenshot: ${process.env.PARTY_SCREENSHOT}`);
  }
  const hoverSeat = await A.$('#pmStage .pm-tile:not(.vacant):not([style*="display: none"])');
  if(hoverSeat){
    await hoverSeat.hover();
    await sleep(260);
    const hoverScale = await hoverSeat.evaluate(el => getComputedStyle(el).scale);
    ok(hoverScale !== "none" && Number.parseFloat(hoverScale) > 1,
      `player cards lift on hover (scale ${hoverScale})`);
  }else{
    ok(false, "a visible centre player card exists for hover feedback");
  }
  const wordHoverBefore = await ev(A, `(() => {
    const top = id => document.getElementById(id).getBoundingClientRect().top;
    return { card:top('pmWordCard'), left:top('pmWordLeftTape'), right:top('pmWordRightTape') };
  })()`);
  await A.hover("#pmWordCard");
  await sleep(230);
  const wordHoverAfter = await ev(A, `(() => {
    const top = id => document.getElementById(id).getBoundingClientRect().top;
    return { card:top('pmWordCard'), left:top('pmWordLeftTape'), right:top('pmWordRightTape') };
  })()`);
  const cardLift = wordHoverAfter.card - wordHoverBefore.card;
  const leftTapeLift = wordHoverAfter.left - wordHoverBefore.left;
  const rightTapeLift = wordHoverAfter.right - wordHoverBefore.right;
  ok(cardLift < -.5 && Math.abs(leftTapeLift-cardLift) < 1 &&
     Math.abs(rightTapeLift-cardLift) < 1,
    "word-card tapes stay physically attached during hover");

  /* who is on which team decides who completes first */
  const teamOf = p => ev(p, `(() => {
    const s = document.querySelector('#pmStage [data-seat].mine');
    return s ? (s.classList.contains('blue') ? 'blue' : 'orange') : null;
  })()`);
  const teams = Object.fromEntries(await Promise.all(
    [[A,"A"],[B,"B"],[C,"C"],[D,"D"]].map(async ([p, t]) => [t, await teamOf(p)])));
  ok(teams.A === "blue" && teams.C === "blue" && teams.B === "orange" && teams.D === "orange",
    `auto-balance seated A/C blue and B/D orange (${JSON.stringify(teams)})`);

  /* Read the word ON EVERY TICK rather than capturing it at setup. Captured,
     a word that rolled over between two calls left this injecting a stale
     label forever — the client simply never claimed and the next wait timed
     out eight seconds later with nothing on screen to say why. It also read
     `state.game.word` eagerly, which throws outright once a match has ended. */
  const recognize = p => p.evaluate(`(async () => {
    const { partyCheck } = await import('${APP}/js/partyMatch.js');
    const { state } = await import('${APP}/js/state.js');
    clearInterval(window.__rec);
    window.__rec = setInterval(() => {
      window.__visionTick();
      const w = state.game?.word;
      if(!w) return;
      state.smooth[w] = .95;
      partyCheck(w, .95);
    }, 70);
  })()`);

  // A is recognized first
  await recognize(A);
  await A.waitForFunction(() => document.querySelector('#pmStage [data-seat].mine.got'),
    { timeout: 8000, polling: 100 });
  ok(true, "the local player's seat turns green on recognition");
  await A.waitForFunction(() => {
    const seat = document.querySelector('#pmStage [data-seat].mine');
    const award = document.querySelector(
      '.pp-award[data-seat="' + seat.dataset.seat + '"]');
    return award?.classList.contains("show") &&
      document.getElementById("pmWordCard").classList.contains("locked");
  }, { timeout:1500,polling:25 });
  const hitFeedback = await ev(A, `(() => {
    const seat = document.querySelector('#pmStage [data-seat].mine');
    const crown = seat.querySelector('.pp-crown').getBoundingClientRect();
    const award = document.querySelector(
      '.pp-award[data-seat="' + seat.dataset.seat + '"]');
    const awardBox = award.getBoundingClientRect();
    const box = seat.getBoundingClientRect();
    return {
      award: award.classList.contains('show'),
      awardTitle: award.querySelector('.aw-got').textContent,
      awardLabel: award.querySelector('.aw-lbl').textContent,
      awardPts: award.querySelector('.aw-pts').textContent,
      awardArt: award.querySelector('img').getAttribute('src'),
      /* stamped ON the player, not floating centre stage */
      awardOnSeat: awardBox.left + awardBox.width / 2 > box.left - 4 &&
        awardBox.left + awardBox.width / 2 < box.right + 4 &&
        awardBox.top + awardBox.height / 2 > box.top - 4 &&
        awardBox.top + awardBox.height / 2 < box.bottom + 4,
      awardFits: ['.aw-got','.aw-pts','.aw-lbl'].every(sel => {
        const line = award.querySelector(sel);
        return line.scrollWidth <= line.clientWidth + 1;
      }),
      awardPaid: award.classList.contains('deliver'),
      locked: document.getElementById('pmWordCard').classList.contains('locked'),
      fill: document.getElementById('pmWordFill').style.width,
      first: seat.classList.contains('first'),
      crownVisible: Number.parseFloat(getComputedStyle(
        seat.querySelector('.pp-crown')).opacity) > .5,
      crownOnHead: crown.top + crown.height / 2 < box.top + box.height * .45,
      teamBorder: getComputedStyle(seat.querySelector('.pm-border-team') || seat).opacity,
      greenBorder: getComputedStyle(seat.querySelector('.pm-border-got') || seat).opacity,
      confetti: !!document.querySelector(".burstwrap"),
    };
  })()`);
  ok(hitFeedback.award && hitFeedback.awardLabel === "POINTS!" &&
     /^\+\d/.test(hitFeedback.awardPts),
    `recognition shows one points paper, not a placement ("${hitFeedback.awardTitle} ${hitFeedback.awardPts} ${hitFeedback.awardLabel}")`);
  ok(/1ST/.test(hitFeedback.awardTitle),
    `the award names the placement ("${hitFeedback.awardTitle}")`);
  ok(hitFeedback.locked && hitFeedback.fill === "95%",
    `the successful word state locks at a full meter (${hitFeedback.fill})`);
  ok(hitFeedback.confetti, "Party recognition erupts from the shared word card");
  ok(hitFeedback.first && hitFeedback.crownVisible && hitFeedback.crownOnHead,
    "the first player recognized wears the paper crown on their head");
  ok(hitFeedback.awardOnSeat && /sp-award\.webp$/.test(hitFeedback.awardArt) &&
     hitFeedback.awardFits,
    "the paper is Solo's own award, stamped on the seat that earned it");
  ok(!hitFeedback.awardPaid,
    "it stays on the seat rather than paying out mid-word");
  if(process.env.PARTY_GOT_SCREENSHOT){
    await A.screenshot({path:process.env.PARTY_GOT_SCREENSHOT,fullPage:true});
    console.log(`  info party recognition screenshot: ${process.env.PARTY_GOT_SCREENSHOT}`);
  }
  await B.waitForFunction(() => document.querySelector('#pmStage [data-seat="blue0"].got'),
    { timeout: 8000, polling: 100 });
  ok(true, "every other client sees that player go green too");

  // C completes blue -> +150 and a five-second chase for orange
  await recognize(C);
  await Promise.all([A, B, C, D].map(p =>
    p.waitForFunction(() => document.getElementById("pmStage").dataset.phase === "chase",
      { timeout: 10000, polling: 100 })));
  ok(true, "blue completing the team opened the final chase on every client");
  ok(/FINAL CHASE/i.test(await txt(A, "#pmWordTimerLabel")) &&
    await A.evaluate(() => {
      const label=document.getElementById("pmWordTimerLabel");
      const value=document.getElementById("pmWordTime");
      const card=document.getElementById("pmWordTimerCard");
      return label.scrollWidth<=label.clientWidth+1 &&
        parseFloat(getComputedStyle(value).fontSize)/card.clientWidth>.23;
    }), "the word clock becomes a fitted, authored-size chase clock");

  /* RECORD the throws rather than polling for them. Each paper is only
     `.deliver` for its 560ms flight, the throws are staggered 90ms apart, and
     this suite runs the server at BETWEEN_ROUNDS_MS=900 — half the shipped
     1800ms — so the whole sequence is airborne for well under a second and is
     then swept when the match ends. Sampling that on a timer meant the
     assertion was really measuring how fast four headless clients report
     "between", and any extra paint work on the board (the robot's slam, say)
     could tip it. An observer catches the class change itself, and reads the
     aim in the same microtask — before the animation has moved the rect,
     which is the only instant the check is exactly right anyway. */
  await A.evaluate(() => {
    window.__thrown = [];
    new MutationObserver(records => {
      for(const record of records){
        const award = record.target;
        if(!award.classList?.contains("pp-award")) continue;
        if(!award.classList.contains("deliver")) continue;
        if(window.__thrown.some(t => t.seat === award.dataset.seat)) continue;
        const card = document.getElementById(
          award.dataset.seat.startsWith("orange") ? "pmScoreOrange" : "pmScoreBlue");
        const dx = parseFloat(award.style.getPropertyValue("--fly-x"));
        const from = award.getBoundingClientRect(), to = card.getBoundingClientRect();
        window.__thrown.push({
          seat: award.dataset.seat,
          aimed: Number.isFinite(dx) &&
            Math.abs((from.left + from.width / 2) - (to.left + to.width / 2) + dx) < 80,
        });
      }
    }).observe(document.body, { subtree:true, attributes:true, attributeFilter:["class"] });
  });

  // B lands inside the window, D never does
  await recognize(B);
  await B.waitForFunction(() => document.querySelector('#pmStage [data-seat].mine.got'),
    { timeout: 8000, polling: 100 });
  ok(true, "a chaser recognized inside the window still scores");

  /* "between" only lasts betweenRoundsMs, so all four must be watched at
     once — waiting on them in turn would miss the window on the later ones. */
  await Promise.all([A, B, C, D].map(p =>
    p.waitForFunction(() => document.getElementById("pmStage").dataset.phase === "between",
      { timeout: 12000, polling: 100 })));
  ok(true, "the round resolved on every client once the chase window closed");

  /* The word ends by throwing every stamped paper into the team card it pays,
     and the totals only move as they land. */
  const thrown = await A.waitForFunction(
    () => window.__thrown.length ? window.__thrown : null,
    { timeout: 4000, polling: 25 }).then(h => h.jsonValue(), () => []);
  ok(thrown.length > 0 && thrown.every(t => t.aimed),
    `the word ends by throwing every stamped paper into its own team card ` +
    `(${thrown.length} thrown)`);
  await A.waitForFunction(() =>
    !document.querySelector('.pp-award.show'), { timeout: 5000, polling: 60 });
  const scores = await ev(A, `(() => ({
    blue: document.getElementById('pmBlueScore').textContent,
    orange: document.getElementById('pmOrangeScore').textContent,
  }))()`);
  const num = s => parseInt(String(s).replace(/[^0-9]/g, ""), 10);
  ok(num(scores.blue) > 0, `blue banked points (${scores.blue})`);
  ok(num(scores.blue) > num(scores.orange),
    `completing team leads on the bonus (${scores.blue} vs ${scores.orange})`);

  for (const p of [A, B, C, D]) await p.evaluate(() => clearInterval(window.__rec));

  console.log("party results + same-room rematch:");
  await Promise.all([A, B, C, D].map(p =>
    p.waitForFunction(() => document.body.dataset.screen === "results",
      { timeout: 45000, polling: 150 })));
  ok(true, "all four players reached results without leaving the party room");
  /* Candids fill the photo strips for players the AI never got, so they must
     come from every seat on the board: the remote feeds, not just the local
     camera. */
  const candidOwners = await A.evaluate(async () => {
    const r = await import("/js/results.js");
    const spec = r._stripSpecForTest();
    const ids = [...new Set([...spec.owners.blue, ...spec.owners.orange])];
    return ids.map(id => r._candidsFor(id).length);
  });
  ok(candidOwners.length === 4 && candidOwners.every(n => n > 0),
    `candids were taken from all four seats, remote feeds included (${candidOwners})`);
  ok((await txt(A, "#rsRematchLabel")).includes("0/4"),
    `results starts with the authoritative ready tally (${await txt(A, "#rsRematchLabel")})`);

  await A.click("#rsRematch");
  await Promise.all([A, B, C, D].map(p =>
    p.waitForFunction(() => /1\/4/.test(document.getElementById("rsRematchLabel").textContent),
      { timeout: 6000, polling: 100 })));
  ok(await A.evaluate(() => {
    const button=document.getElementById("rsRematch");
    const mine=document.querySelector(".rs-seat[data-pid].ready");
    return button.getAttribute("aria-pressed") === "true" && !!mine;
  }), "a party READY vote reaches every client and marks the local result seat");

  await A.click("#rsRematch");
  await Promise.all([A, B, C, D].map(p =>
    p.waitForFunction(() => /0\/4/.test(document.getElementById("rsRematchLabel").textContent),
      { timeout: 6000, polling: 100 })));
  ok(true, "the party READY vote is undoable on every client");

  await Promise.all([A, B, C, D].map(p => p.click("#rsRematch")));
  await Promise.all([A, B, C, D].map(p =>
    p.waitForFunction(() => document.body.dataset.screen === "pmatch",
      { timeout: 10000, polling: 100 })));
  ok((await txt(A, "#roomCodeText")) === code,
    "all-ready restarts the match in the SAME room with the same code");
  await Promise.all([A, B, C, D].map(p => p.waitForFunction(() =>
    !document.getElementById("howToPlay").classList.contains("hidden"),
    {timeout:3000,polling:25})));
  await Promise.all([A, B, C, D].map(readyUp));

  /* Let the short restarted match end naturally, then prove a results-phase
     leaver disappears from the survivor papers and reduces the tally. The
     authoritative deadline lets an in-flight word/chase finish, so allow the
     30s match plus count-in and its full 5s chase on slower CI machines. */
  await Promise.all([A, B, C, D].map(p =>
    p.waitForFunction(() => document.body.dataset.screen === "results",
      { timeout: 50000, polling: 150 })));
  await D.click("#rsExit");
  await D.waitForFunction(() => document.body.dataset.screen === "home",
    { timeout: 6000, polling: 100 });
  await A.waitForFunction(() =>
    /0\/3/.test(document.getElementById("rsRematchLabel").textContent) &&
    document.querySelectorAll(".rs-seat:not(.vacant)").length === 3,
    { timeout: 6000, polling: 100 });
  ok(await A.evaluate(() =>
    ![...document.querySelectorAll(".rs-seat:not(.vacant) .rs-nametag b")]
      .some(node => /DAN/.test(node.textContent))),
    "a results-phase leaver is removed and the authoritative tally drops to three");
  ok(await D.evaluate(() => !/^[A-Z2-9]{6}$/.test(
    document.getElementById("roomCodeText").textContent.trim())),
    "leaving party results clears the shared room code after one lifecycle cleanup");

  await Promise.all([A, B, C].map(p => p.click("#rsRematch")));
  await Promise.all([A, B, C].map(p =>
    p.waitForFunction(() =>
      document.getElementById("rsRematch").dataset.waiting === "need-teams",
      { timeout: 6000, polling: 100 })));
  ok(await Promise.all([A, B, C].map(p => p.evaluate(() =>
    document.body.dataset.screen === "results" &&
    /NEED\s+2\s+PER\s+TEAM/.test(document.getElementById("rsRematchLabel").textContent) &&
    /Need at least 2 players on each team to rematch/.test(
      document.getElementById("rsRematchStatus").textContent))))
    .then(values => values.every(Boolean)),
    "all-ready 2–1 roster stays on results and announces the team minimum");
  await A.click("#rsRematch");
  await Promise.all([A, B, C].map(p =>
    p.waitForFunction(() => /2\/3/.test(
      document.getElementById("rsRematchLabel").textContent),
      { timeout: 6000, polling: 100 })));
  ok(true, "a NEED TEAMS ready vote remains undoable");

  console.log("hygiene:");
  for (const tag of TAGS) {
    const real = errors[tag].filter(e => !e.includes("favicon") && !e.includes("net::ERR_") &&
      !e.includes("Created TensorFlow Lite XNNPACK delegate"));
    ok(real.length === 0, `player ${tag}: no console/page errors (${real.length})` +
      (real.length ? "\n      " + real.slice(0, 3).join("\n      ") : ""));
  }
} catch (e) {
  console.error("EXCEPTION:", e.message);
  for (const tag of TAGS)
    if (errors[tag].length) console.error(`  [${tag}] ` + errors[tag].slice(0, 6).join(`\n  [${tag}] `));
  fails++;
} finally {
  await browser.close();
  server.kill();
}

console.log(fails ? `\n${fails} FAILURES` : "\nALL PARTY E2E CHECKS PASSED");
process.exit(fails ? 1 : 0);
