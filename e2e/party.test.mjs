/* Party E2E: real Node server, four headless-Chrome players in isolated
   contexts, real Socket.IO + WebRTC mesh. Drives the party lobby to a start
   and then plays a round — only the vision input is simulated (recognition
   is injected at the same funnel the classifier feeds). */
import puppeteer from "puppeteer-core";
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
         BETWEEN_ROUNDS_MS: "900", RATE_CREATE: "40", RATE_JOIN: "80" },
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
async function player(tag, name){
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  await page.setBypassCSP(true);
  page.on("console", m => { if (m.type() === "error") errors[tag].push(m.text()); });
  page.on("pageerror", e => errors[tag].push("PAGEERROR: " + e.message));
  page.on("response", r => { if (r.status() >= 400) errors[tag].push("HTTP " + r.status() + " " + r.url()); });
  await page.evaluateOnNewDocument(n => localStorage.setItem("poseCharadesName", n), name);
  await page.goto(APP, { waitUntil: "networkidle2", timeout: 60000 });
  await page.waitForFunction(() => document.getElementById("status").style.display === "none",
    { timeout: 60000, polling: 400 });
  page.tag = tag;
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

  /* The public UI deliberately floors matches at one minute. This suite uses
     the server's validated 10-second test floor so it can cover real results
     readiness, same-room restart and results-phase leaving. */
  await A.evaluate(async () => {
    const {lobbySettings, partyBridge}=await import("/js/online.js");
    const settings=lobbySettings();
    settings.matchSecs=10;
    settings.wordSecs=5;
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
  ok(mine && mine.seat === "blue0" && mine.name === "ALICE",
    `the local player is featured on their own side (${mine?.seat} = ${mine?.name})`);
  ok(shown.every(s => s.name && s.name !== ""), "every visible seat carries a name tag");
  const names = shown.map(s => s.name).sort().join();
  ok(names === "ALICE,BOB,CARA,DAN", `lobby names carried into the match (${names})`);
  const visualContract = await ev(A, `(() => {
    const src = sel => document.querySelector(sel)?.getAttribute('src') || '';
    const stage = document.getElementById('pmStage').getBoundingClientRect();
    return {
      blue: src('[data-seat="blue1"] .pm-border-team'),
      orange: src('[data-seat="orange1"] .pm-border-team'),
      green: src('[data-seat="blue1"] .pm-border-got'),
      got: src('[data-seat="blue1"] .pm-gotit img'),
      divider: src('.pm-divider img'),
      tapes: ['pmMatchTimerTape','pmBlueScoreTape','pmWordTimerTape',
        'pmOrangeScoreTape','pmMyTopTape','pmMyPastTape','pmFoeTopTape',
        'pmFoePastTape','pmWordRightTape','pmWordLeftTape'].map(id => {
          const el=document.getElementById(id);
          return {src:el?.getAttribute('src') || '', rotate:getComputedStyle(el).rotate};
        }),
      exit: (() => {
        const b = document.getElementById('btnExitParty');
        if(!b) return null;
        const cs = getComputedStyle(b), r = b.getBoundingClientRect();
        return { opacity: parseFloat(cs.opacity), label: b.getAttribute('aria-label'),
                 clickable: cs.pointerEvents !== 'none' && r.width > 0 && r.height > 0 };
      })(),
      historyTapesHidden: ['pmMyPastTape','pmFoePastTape'].every(id =>
        Number.parseFloat(getComputedStyle(document.getElementById(id)).opacity) === 0),
      ratio: stage.width / stage.height,
      centred: Math.abs((stage.left + stage.width / 2) - innerWidth / 2) < 1,
    };
  })()`);
  ok(/pm-border-blue\.png$/.test(visualContract.blue) &&
     /pm-border-orange\.png$/.test(visualContract.orange) &&
     /pm-border-green\.png$/.test(visualContract.green),
    "party tiles use the exact blue/orange/recognized Figma borders");
  ok(/pm-got-it\.png$/.test(visualContract.got) &&
     /pm-divider\.png$/.test(visualContract.divider),
    "GOT IT paper and split divider use their exact Figma exports");
  ok(visualContract.tapes.every(t =>
      /pm-tape-[a-z-]+\.png$/.test(t.src) && (t.rotate === "none" || t.rotate === "0deg")),
    "all Party tapes use exact pre-rotated Figma node exports");
  /* A party match used to be a one-way door — the header is hidden here, so a
     player who wanted out had to reload. It now carries Solo's ghosted LEAVE
     paper: reachable, but faint enough never to compete with the round. */
  ok(!!visualContract.exit && visualContract.exit.clickable,
    "Party has a reachable in-match exit control");
  ok(!!visualContract.exit?.label,
    `the party exit is labelled (${visualContract.exit?.label})`);
  ok(visualContract.exit?.opacity < .35,
    `the party exit stays ghosted until sought out (${visualContract.exit?.opacity})`);
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
    partyCheck(currentWord,.45);
    await new Promise(resolve=>setTimeout(resolve,260));
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

  const recognize = p => p.evaluate(`(async () => {
    const { partyCheck } = await import('${APP}/js/partyMatch.js');
    const { state } = await import('${APP}/js/state.js');
    const w = state.game.word;
    clearInterval(window.__rec);
    window.__rec = setInterval(() => {
      state.smooth[w] = .95;
      partyCheck(w, .95);
    }, 70);
  })()`);

  // A is recognized first
  await recognize(A);
  await A.waitForFunction(() => document.querySelector('#pmStage [data-seat].mine.got'),
    { timeout: 8000, polling: 100 });
  ok(true, "the local player's seat turns green on recognition");
  await A.waitForFunction(() =>
    document.getElementById("pmAward").classList.contains("show") &&
    document.getElementById("pmWordCard").classList.contains("locked"),
    { timeout:1500,polling:25 });
  ok(/1ST/.test(await txt(A, '#pmStage [data-seat].mine .pm-gotit b')),
    `the sticker names the placement ("${await txt(A, '#pmStage [data-seat].mine .pm-gotit b')}")`);
  const hitFeedback = await ev(A, `(() => {
    const seat = document.querySelector('#pmStage [data-seat].mine');
    const sticker = seat.querySelector('.pm-gotit').getBoundingClientRect();
    const box = seat.getBoundingClientRect();
    return {
      award: document.getElementById('pmAward').classList.contains('show'),
      awardLabel: document.getElementById('pmAwardLabel').textContent,
      locked: document.getElementById('pmWordCard').classList.contains('locked'),
      fill: document.getElementById('pmWordFill').style.width,
      stickerOnHead: sticker.top + sticker.height / 2 < box.top + box.height * .45,
      stickerFits: (() => {
        const label=seat.querySelector(".pm-gotit b");
        return label.scrollWidth<=label.clientWidth+1;
      })(),
      teamBorder: getComputedStyle(seat.querySelector('.pm-border-team') || seat).opacity,
      greenBorder: getComputedStyle(seat.querySelector('.pm-border-got') || seat).opacity,
      confetti: !!document.querySelector(".burstwrap"),
    };
  })()`);
  ok(hitFeedback.award && hitFeedback.awardLabel === "PLACE!",
    "recognition replays the shared impact -> lock -> award-paper sequence");
  ok(hitFeedback.locked && hitFeedback.fill === "95%",
    `the successful word state locks at a full meter (${hitFeedback.fill})`);
  ok(hitFeedback.confetti, "Party recognition erupts from the shared word card");
  ok(hitFeedback.stickerOnHead && hitFeedback.stickerFits,
    "the local GOT IT paper lands in the head band without clipping its placement");
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
      { timeout: 18000, polling: 150 })));
  ok(true, "all four players reached results without leaving the party room");
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

  /* Let the short restarted match end naturally, then prove a results-phase
     leaver disappears from the survivor papers and reduces the tally. */
  await Promise.all([A, B, C, D].map(p =>
    p.waitForFunction(() => document.body.dataset.screen === "results",
      { timeout: 18000, polling: 150 })));
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
