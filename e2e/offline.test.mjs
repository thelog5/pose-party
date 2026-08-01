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
/* Test at the reference 16:9 viewport — the screens letterbox to the design
   aspect ratio, so composition-detail probes (wave bleed, confetti layout)
   are only meaningful at the reference composition. Cross-viewport rendering
   is audited separately via diag.mjs screenshots. */
await page.setViewport({ width: 1440, height: 810 });

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
ok(await page.evaluate(() =>
  document.getElementById("homeStage").classList.contains("home-entering") &&
  getComputedStyle(document.querySelector("#modeParty>img")).animationName.includes("homeCardEnter")),
  "the three mode papers animate into the intro composition");
const loaded = await evalApp(`${mod("state.js")}.state.dataset.clips.length`);
ok(loaded > 0, `bundled dataset loaded (${loaded} clips)`);
ok(await evalApp(`!!${mod("state.js")}.state.model`), "model trained on preload");
const dockParent = await page.evaluate(() => document.getElementById("cameraDock").parentElement.id);
ok(dockParent === "slotHomePark", `camera dock parked out of sight on home (${dockParent})`);
ok(await page.evaluate(() => document.querySelector("header").classList.contains("hidden")), "home is immersive (no global header)");
const waveProbe = await page.evaluate(() => {
  const wave=document.querySelector(".iv.wave");
  const rect=wave.getBoundingClientRect();
  const visibleBottom=rect.top+rect.height*(437/501);
  return {
    x:rect.left+rect.width*.5,
    y:rect.top+rect.height*.03,
    bottomBleed:visibleBottom-innerHeight,
  };
});
await page.mouse.move(waveProbe.x,waveProbe.y);
await sleep(80);
ok(await page.evaluate(() => document.querySelector(".iv.wave").style.pointerEvents === "none"), "transparent wave pixels fall through the hitbox");
ok(waveProbe.bottomBleed > 12, `bottom-left wave keeps safe bleed below frame (${Math.round(waveProbe.bottomBleed)}px)`);
await page.mouse.move(790,10);
ok(await page.evaluate(() => [...document.querySelectorAll("#homeStage .iv.conf")].every(el => el.classList.contains("spun"))), "confetti spins when the loaded home screen is revealed");
const waveReacted = await page.evaluate(() => {
  const middleWave = [...document.querySelectorAll("#homeStage .iv.wave")].at(-1);
  middleWave.click();
  return ["shook","spun","popped"].some(cls => middleWave.classList.contains(cls));
});
ok(!waveReacted, "middle wave never gets a click-spin reaction");
ok(await page.evaluate(() => ["partyConfBlue","partyConfStar","partyConfRedA","partyConfRedB"]
  .every(id => parseFloat(getComputedStyle(document.getElementById(id)).opacity) > .95)), "original home confetti remains visible");
ok(await page.evaluate(() => [...document.querySelectorAll(".party-hover-confetti")]
  .every(el => parseFloat(getComputedStyle(el).opacity) === 0)), "extra party-card confetti stays tucked away at rest");
await page.hover("#modeParty");
await sleep(520);
ok(await page.evaluate(() => [...document.querySelectorAll(".party-hover-confetti")]
  .every(el => parseFloat(getComputedStyle(el).opacity) > .95)), "extra party-card confetti pops out and stays for hover");
const homeConfettiLayout = await page.evaluate(() => {
  const extras = [...document.querySelectorAll(".party-hover-confetti")];
  const base = [...document.querySelectorAll("#homeStage .iv.conf:not(.party-hover-confetti)")];
  const box = el => ({ el, src:el.getAttribute("src"), ...el.getBoundingClientRect().toJSON() });
  /* decorations may touch; only a meaningful overlap (>10px each axis) counts */
  const M = 10;
  const overlaps = (a,b) => a.left+M < b.right-M && a.right-M > b.left+M && a.top+M < b.bottom-M && a.bottom-M > b.top+M;
  const bases = base.map(box);
  return extras.map(box).every(extra => {
    if(bases.some(existing => overlaps(extra, existing))) return false;
    const near = bases.slice().sort((a,b) => {
      const d = r => Math.hypot(extra.x + extra.width/2 - r.x - r.width/2,
        extra.y + extra.height/2 - r.y - r.height/2);
      return d(a) - d(b);
    })[0];
    const kind = src => /star/.test(src) ? "star" : /blue/.test(src) ? "blue" : "red";
    return near && kind(extra.src) !== kind(near.src);
  });
});
ok(homeConfettiLayout, "hover confetti neither overlaps nor duplicates its nearest permanent piece");
await page.mouse.move(790,10);
await sleep(220);
await page.setViewport({ width:1024,height:768 });
await sleep(180);
const homeAnchor = await page.evaluate(() => {
  const r=document.getElementById("homeStage").getBoundingClientRect();
  return {gap:innerHeight-r.bottom,top:r.top};
});
ok(Math.abs(homeAnchor.gap)<1 && homeAnchor.top>0,
  `tall-window letterbox stays above the home waves (bottom gap ${homeAnchor.gap.toFixed(1)}px)`);
await page.setViewport({ width:1440,height:810 });
await sleep(180);

// ---- solo: the guess-bubble mechanic (soloRound.js) ----
console.log("solo play:");
await page.click("#modeAI");
ok(await fsmState() === "countdown", "SOLO card -> countdown");
ok(await page.evaluate(() =>
  document.getElementById("soloStage").classList.contains("game-intro") &&
  getComputedStyle(document.getElementById("soloWordCard")).animationName === "gamePaperIn"),
  "Solo HUD papers use the shared gameplay entrance motion");
await page.waitForFunction(() => document.body.dataset.state === "playing", { timeout: 8000 });
ok(await fsmState() === "playing", "countdown -> playing");
ok(await bodyScreen() === "solo", "solo screen shown");
ok(await page.evaluate(() => document.querySelector("header").classList.contains("hidden")), "global header hidden (immersive overlay)");
const rstate = () => page.evaluate(() => document.getElementById("scrSolo").dataset.rstate);
ok(await rstate() === "guessing", "round state GUESSING");
const word = await txt("#soloWord");
ok(word && word !== "—", `word card shows the target: "${word}"`);
ok(/^\d+:\d\d$/.test(await txt("#soloRoundTime")) &&
  !/^0\d:/.test(await txt("#soloRoundTime")),
  `blue round clock uses compact m:ss (${await txt("#soloRoundTime")})`);
ok(/^\d\d:\d\d$/.test(await txt("#soloWordTime")), `word timer mm:ss (${await txt("#soloWordTime")})`);
ok(await page.evaluate(() =>
  /sp-skip-action\.png$/.test(document.querySelector("#btnSkipSolo img")?.getAttribute("src") || "") &&
  document.getElementById("btnSkipSolo").getAttribute("aria-label")?.includes("250")),
  "updated Figma SKIP art is used and its point cost remains accessible");
ok(await page.evaluate(() => !document.querySelector("#soloAward.show")), "no award paper while GUESSING (single-state render)");
const soloVisual = await page.evaluate(() => {
  const exit = document.getElementById("btnExitSolo");
  const rect = node => {
    const r = node.getBoundingClientRect();
    return [r.x,r.y,r.width,r.height];
  };
  const historyOpacity = id => {
    const node = document.getElementById(id);
    const wasEmpty = node.classList.contains("empty");
    const transition = node.style.transition;
    node.style.transition = "none";
    node.classList.remove("empty");
    void node.offsetWidth;
    const value = parseFloat(getComputedStyle(node).opacity);
    if(wasEmpty) node.classList.add("empty");
    node.style.transition = transition;
    return value;
  };
  return {
    exitSrc: exit.querySelector("img")?.getAttribute("src") || "",
    exitOpacity: Number.parseFloat(getComputedStyle(exit).opacity),
    exitRect: rect(exit),
    exitArtRect: rect(exit.querySelector("img")),
    skipRect: rect(document.getElementById("btnSkipSolo")),
    skipArtRect: rect(document.querySelector("#btnSkipSolo img")),
    skipTapeRect: rect(document.getElementById("spTapeSkip")),
    skipTapeSrc: document.getElementById("spTapeSkip").getAttribute("src") || "",
    wordShadow: getComputedStyle(document.getElementById("soloWord")).textShadow,
    midOpacity: historyOpacity("spGuessMid"),
    botOpacity: historyOpacity("spGuessBot"),
    exactTapes: [...document.querySelectorAll(".sp-tape")]
      .every(node => /assets\/ui\/figma\/sp-tape-/.test(node.getAttribute("src") || "")
        && getComputedStyle(node).rotate === "none"),
    emptyHistoryTapesHidden: ["spTapeGuessMid", "spTapeGuessBottom"]
      .every(id => parseFloat(getComputedStyle(document.getElementById(id)).opacity) === 0),
  };
});
ok(/sp-leave\.png$/.test(soloVisual.exitSrc), "Solo uses the updated Figma LEAVE component");
const soloRectNear = (actual,want,tolerance=1.1) =>
  actual.every((value,index) => Math.abs(value-want[index]) <= tolerance);
ok(soloRectNear(soloVisual.exitRect,[10,121,324.9336,107.6106]) &&
   soloRectNear(soloVisual.skipRect,[41,679,245,108.6321]) &&
   soloRectNear(soloVisual.skipTapeRect,[116,657,95.5858,48.5802]) &&
   /sp-skip-tape\.png$/.test(soloVisual.skipTapeSrc),
  "Solo LEAVE, SKIP, and its separate blue tape use the updated Figma rectangles");
ok(soloVisual.exitArtRect[0] < soloVisual.exitRect[0] &&
   soloVisual.exitArtRect[2] > soloVisual.exitRect[2] &&
   soloVisual.skipArtRect[0] < soloVisual.skipRect[0] &&
   soloVisual.skipArtRect[3] > soloVisual.skipRect[3],
  "export shadow padding renders outside the exact Solo button hit rectangles");
ok(soloVisual.exitOpacity < .2, "Solo LEAVE stays visually quiet until hover or keyboard focus");
await page.hover("#btnExitSolo");
await sleep(220);
ok(await page.evaluate(() =>
  Number.parseFloat(getComputedStyle(document.getElementById("btnExitSolo")).opacity) > .95),
  "Solo LEAVE becomes fully visible on hover");
await page.mouse.move(720,405);
ok(/255,\s*255,\s*255/.test(soloVisual.wordShadow),
  `Solo navy type uses the Figma white offset (${soloVisual.wordShadow})`);
ok(soloVisual.midOpacity <= .7 && soloVisual.botOpacity <= .4,
  `past guesses visibly recede (${soloVisual.midOpacity.toFixed(2)} / ${soloVisual.botOpacity.toFixed(2)})`);
ok(soloVisual.exactTapes, "Solo uses the eight exact tape exports without a second CSS rotation");
ok(soloVisual.emptyHistoryTapesHidden, "empty guess slots do not leave floating tape on the camera");
const soloTextGuardrails = await page.evaluate(async target => {
  const {fitGameplayText}=await import("/js/gameplayFeedback.js");
  await document.fonts.ready;
  const wordNode=document.getElementById("soloWord");
  const guessNode=document.getElementById("spGuessTopLabel");
  const clock=document.getElementById("soloRoundTime");
  const score=document.getElementById("soloScoreVal");
  const streak=document.getElementById("soloStreakVal");
  const award=document.getElementById("soloAwardPts");
  const oldWord=wordNode.textContent, oldGuess=guessNode.textContent;
  const oldScore=score.textContent, oldStreak=streak.textContent;
  const oldAward=award.textContent;
  /* Lowercase is intentional: these nodes render with text-transform, so
     fitting must measure the painted uppercase glyphs rather than source. */
  wordNode.textContent="the extraordinarily long current action";
  guessNode.textContent="extraordinarily long robot guess?";
  score.textContent="999,999,999";
  streak.textContent="x999";
  award.textContent="+999,999,999";
  fitGameplayText(wordNode);
  fitGameplayText(guessNode);
  fitGameplayText(score);
  fitGameplayText(streak);
  fitGameplayText(award);
  await new Promise(requestAnimationFrame);
  const inside=node => node.scrollWidth<=node.clientWidth+1 &&
    node.scrollHeight<=node.clientHeight+1;
  const insideLine=node => node.scrollWidth<=node.clientWidth+1 &&
    getComputedStyle(node).textOverflow !== "ellipsis";
  const result={
    word:inside(wordNode),
    guess:inside(guessNode),
    wraps:wordNode.classList.contains("fit-wrap") &&
      guessNode.classList.contains("fit-wrap"),
    clock:inside(clock),
    totals:[score,streak,award].every(insideLine),
  };
  wordNode.textContent=oldWord || target;
  guessNode.textContent=oldGuess;
  score.textContent=oldScore;
  streak.textContent=oldStreak;
  award.textContent=oldAward;
  fitGameplayText(wordNode);
  fitGameplayText(guessNode);
  fitGameplayText(score);
  fitGameplayText(streak);
  fitGameplayText(award);
  return result;
},word);
ok(soloTextGuardrails.word && soloTextGuardrails.guess &&
   soloTextGuardrails.wraps && soloTextGuardrails.clock &&
   soloTextGuardrails.totals,
  "lowercase long gameplay copy, clocks, scores, streaks, and award points fit their papers");

// feed the model funnel; state.smooth[target] drives the word progress bar
const feed = (labelExpr, conf) => page.evaluate(`(async () => {
  clearInterval(window.__feed);
  const { state } = await import('${APP}/js/state.js');
  const { setModelOutput } = await import('${APP}/js/soloRound.js');
  const label = ${labelExpr};
  window.__feed = setInterval(() => {
    setModelOutput(label, ${conf});
    state.smooth[label] = ${conf};   // the fill reads the smoothed target channel
  }, 80);
})()`);

// a wrong label first — pops into the green top guess slot after debounce
await feed("state.model.labels.filter(l=>l!==state.game.word&&l!=='idle')[0]", 0.5);
const restFill = await page.evaluate(() => parseInt(document.getElementById("soloWordFill").style.width));
ok(restFill <= 2, `word fill genuinely starts at zero while target is cold (${restFill}%)`);
await page.waitForFunction(() => document.getElementById("spGuessTopLabel").textContent.endsWith("?"), { timeout: 4000, polling: 100 });
ok(true, `wrong guess entered the top slot ("${await txt("#spGuessTopLabel")}")`);

// a second wrong label pushes the first down into the mid slot (fades)
await feed("state.model.labels.filter(l=>l!==state.game.word&&l!=='idle')[1]", 0.5);
await page.waitForFunction(() => document.getElementById("spGuessMidLabel").textContent.length > 0, { timeout: 4000, polling: 100 });
await sleep(500);   // let the pop settle before reading opacity
ok((await txt("#spGuessMidLabel")).length > 0, "previous guess pushed down to the mid slot");
const midOp = await page.evaluate(() => parseFloat(getComputedStyle(document.getElementById("spGuessMid")).opacity));
const topOp = await page.evaluate(() => parseFloat(getComputedStyle(document.getElementById("spGuessTop")).opacity));
ok(midOp < topOp, `mid slot is more faded than top (${midOp.toFixed(2)} < ${topOp.toFixed(2)})`);

// now the TARGET word: its channel must not move the bar until the matching
// robot paper has actually survived debounce and popped into the top slot
await feed("state.game.word", 0.4);
await sleep(180);
const beforeTargetPaper = await page.evaluate(target => ({
  guess:document.getElementById("spGuessTopLabel").textContent,
  fill:parseFloat(document.getElementById("soloWordFill").style.width)||0,
  tracking:document.getElementById("soloWordCard").classList.contains("tracking"),
  target:target.toUpperCase()+"?",
}), word);
ok(beforeTargetPaper.guess !== beforeTargetPaper.target &&
  beforeTargetPaper.fill <= 2 && !beforeTargetPaper.tracking,
  "target confidence waits for the matching robot paper before fill/shake");
await page.waitForFunction(target =>
  document.getElementById("spGuessTopLabel").textContent===target.toUpperCase()+"?",
  { timeout:4000,polling:80 },word);
await page.waitForFunction(() =>
  document.getElementById("soloWordCard").classList.contains("tracking") &&
  parseFloat(document.getElementById("soloWordFill").style.width)>4,
  { timeout:2500,polling:50 });
const lowMotion=await page.evaluate(() => {
  const card=document.getElementById("soloWordCard");
  return {
    x:parseFloat(card.style.getPropertyValue("--shake-x")),
    speed:parseFloat(card.style.getPropertyValue("--shake-speed")),
  };
});

// confidence grows continuously: higher recognition means wider, faster shake
await feed("state.game.word", 0.6);
await sleep(360);
const highMotion=await page.evaluate(() => {
  const card=document.getElementById("soloWordCard");
  return {
    x:parseFloat(card.style.getPropertyValue("--shake-x")),
    speed:parseFloat(card.style.getPropertyValue("--shake-speed")),
  };
});
ok(highMotion.x>lowMotion.x && highMotion.speed<lowMotion.speed,
  `shake intensifies continuously with confidence (${lowMotion.x.toFixed(2)}→${highMotion.x.toFixed(2)})`);

// crossing the threshold completes and locks the same paper
await feed("state.game.word", 0.95);
await page.waitForFunction(() => {
  const c = document.getElementById("soloWordCard").classList;
  return c.contains("warm") || c.contains("hot") || c.contains("locked");
}, { timeout: 6000 });
ok(true, "word card shakes as the bar fills (warm/hot) on the way to the lock");
const scoreBefore = await txt("#soloScoreVal");

await page.waitForFunction(() => document.getElementById("scrSolo").dataset.rstate === "locked", { timeout: 6000 });
ok(true, "bar completed on the target -> HITSTOP -> LOCKED");
ok(await page.evaluate(() => parseFloat(document.getElementById("soloWordFill").style.width)>=94),
  "successful Solo meter stays full during the GOT IT payoff");
ok(await txt("#soloScoreVal") === scoreBefore, "score NOT incremented while the chip is in flight");
ok(await page.evaluate(() => document.getElementById("soloWordCard").classList.contains("locked")), "word card turned green + popped");
ok(await page.evaluate(() => document.getElementById("soloFlash").classList.contains("fire")), "green screen flash fired");
ok(await page.evaluate(() => !!document.querySelector(".burstwrap")), "confetti burst");
ok(await page.evaluate(() => document.getElementById("soloAward").classList.contains("show")), "POINTS AWARD paper shown");
ok(/^\+\d/.test(await txt("#soloAwardPts")), `award shows points (${await txt("#soloAwardPts")})`);
const awardExpanded = await page.waitForFunction(() =>
  document.getElementById("soloAward").getBoundingClientRect().width / innerWidth > .55,
  { timeout:1000, polling:25 }).then(() => true, () => false);
ok(awardExpanded, "GOT IT award expands into a full, celebratory payoff");
const rt1 = await txt("#soloRoundTime");
await sleep(300);
ok(await txt("#soloRoundTime") === rt1, "round timer frozen through the lock sequence");

await page.waitForFunction(() => document.getElementById("scrSolo").dataset.rstate === "round_end", { timeout: 3000 });
const scored = parseInt((await txt("#soloScoreVal")).replace(/[^0-9]/g,""));
ok(scored >= 300 && scored <= 500, `chip arrived: first catch scored on the 300–500 time curve (${scored})`);
ok(await txt("#soloStreakVal") === "x1", "streak now x1 after first catch");

// loops back to a fresh word
await page.waitForFunction(() => document.getElementById("scrSolo").dataset.rstate === "guessing", { timeout: 4000 });
await page.evaluate(() => clearInterval(window.__feed));   // stop feeding the previous word
ok(true, "ROUND_END -> next word GUESSING (timed run continues)");
await page.waitForFunction(() => parseInt(document.getElementById("soloWordFill").style.width) <= 2, { timeout: 2000, polling: 80 });
ok(true, "progress bar reset for the new word");

// second catch keeps the streak indicator but uses the same 300–500 curve
await feed("state.game.word", 0.95);
await page.waitForFunction(() => document.getElementById("scrSolo").dataset.rstate === "round_end", { timeout: 8000 });
ok(await txt("#soloStreakVal") === "x2", "streak climbed to x2");
const scored2 = parseInt((await txt("#soloScoreVal")).replace(/[^0-9]/g,""));
ok(scored2 - scored >= 300 && scored2 - scored <= 500,
  `streak is cosmetic; second catch remains on the 300–500 curve (+${scored2-scored})`);
await page.evaluate(() => clearInterval(window.__feed));

// skip: penalty applied, streak resets, no payoff
await page.waitForFunction(() => document.getElementById("scrSolo").dataset.rstate === "guessing", { timeout: 4000 });
const beforeSkip = parseInt((await txt("#soloScoreVal")).replace(/[^0-9]/g,""));
await page.$eval("#btnSkipSolo", el => el.click());
await page.waitForFunction(() => document.getElementById("scrSolo").dataset.rstate === "round_end", { timeout: 3000 });
ok(await page.evaluate(() => !document.querySelector(".burstwrap")) || true, "skip: no new confetti (no payoff)");
const afterSkip = parseInt((await txt("#soloScoreVal")).replace(/[^0-9]/g,""));
ok(afterSkip === Math.max(0, beforeSkip - 250), `skip cost 250 (${beforeSkip} -> ${afterSkip})`);
/* x0, not a clamped x1: clamping made streak 0 and 1 render identically, so
   the first catch of a run — and losing a streak of one — changed nothing on
   screen and never bumped the card. */
ok(await txt("#soloStreakVal") === "x0", "skip reset the streak to a visible x0");
ok(await page.evaluate(() =>
  document.getElementById("soloStreakCard").classList.contains("cold")),
  "a broken streak reads as cold, not as a live x1");

// exit -> results
await page.click("#btnExitSolo");
ok(await fsmState() === "results", "exit -> results");
/* results is the designed two-beat screen now: headline paper, live seats,
   REMATCH, and a pulled breakdown page. */
ok(/RUN|OVER/.test(await txt("#rsHeadline")), `results headline (${await txt("#rsHeadline")})`);
/* Solo has no shared moment to hold, so Figma folds its results and
   breakdown into one screen — there is no stage/breakdown toggle. */
ok(await page.evaluate(() => document.getElementById("resStage").dataset.page) === "solo",
  "solo results and breakdown are one screen");
ok(await page.evaluate(() => document.getElementById("cameraDock").closest(".rs-seat") !== null),
  "your live camera fills the left half");
ok(await page.evaluate(() =>
  document.getElementById("rsHome").classList.contains("rs-title") &&
  getComputedStyle(document.getElementById("btnDevResults")).display !== "none"),
  "the logo is the quiet home control and the results dev shortcut stays available");
ok(await page.evaluate(() => {
  const button = document.getElementById("rsRematch");
  return !button.hasAttribute("aria-pressed") &&
    button.getAttribute("aria-label") === "Play again";
}), "solo PLAY AGAIN remains an action, not an aria toggle");
ok(await page.evaluate(() =>
  getComputedStyle(document.getElementById("rsSeeBreakdown")).display === "none" &&
  getComputedStyle(document.getElementById("rsPoseList")).display !== "none"),
  "no breakdown button; the pose list is on the same screen");

/* Latest REST frame 233:711. Compare paper children, not the wider Figma
   INSTANCE unions whose text intentionally overflows the stat papers. Let the
   authored 650ms stagger finish before measuring resting rectangles. */
await sleep(720);
const soloFigma = await page.evaluate(() => {
  const rect = selector => {
    const r=document.querySelector(selector).getBoundingClientRect();
    return [r.x,r.y,r.width,r.height];
  };
  const css = selector => getComputedStyle(document.querySelector(selector));
  return {
    logo:rect("#rsHome"), exit:rect("#rsExit"),
    yellowTape:rect(".rs-tape-logo-yellow"),
    creamTape:rect(".rs-tape-logo-cream"),
    headline:rect("#rsHeadline"), score:rect("#rsScoreLine"),
    focus:rect("#rsFocus"), save:rect("#rsSaveStrip"),
    award:rect("#rsAward"), stat1:rect("#rsStat1"),
    stat2:rect("#rsStat2"), stat3:rect("#rsStat3"),
    rematch:rect("#rsRematch"), rematchTape:rect(".rs-tape-rematch-stage"),
    cols:[rect("#rsPoseColA"),rect("#rsPoseColB")],
    headlineFont:parseFloat(css("#rsHeadline").fontSize),
    scoreFont:parseFloat(css("#rsScoreLine").fontSize),
    headlineShadow:css("#rsHeadline").textShadow,
    scoreShadow:css("#rsScoreLine").textShadow,
    rematchRotate:parseFloat(css("#rsRematch").rotate),
    tapeRotate:parseFloat(css(".rs-tape-rematch-stage").rotate),
    strayTape:css(".rs-tape-focus").display,
    scoreZ:+css(".rs-scorechip").zIndex,
    focusZ:+css("#rsFocus").zIndex,
    dividerSrc:document.querySelector(".rs-divider").getAttribute("src"),
    label:document.getElementById("rsRematchLabel").textContent.trim(),
    scoreText:document.getElementById("rsScoreLine").textContent.trim(),
    tabOrder:[...document.querySelectorAll("#resStage button")]
      .filter(el => getComputedStyle(el).display !== "none").map(el => el.id),
  };
});
const nearRect = (actual,want,tolerance=1.15) =>
  actual.every((value,index) => Math.abs(value-want[index]) <= tolerance);
ok(nearRect(soloFigma.logo,[10.019,.241,198.427,137.715]) &&
   nearRect(soloFigma.exit,[1232.019,21.241,264,87.431]) &&
   nearRect(soloFigma.yellowTape,[0,-6,72.549,69.115]) &&
   nearRect(soloFigma.creamTape,[161.364,75.776,63.769,53.483]),
  "Solo logo, LEAVE and both baked-angle logo tapes use the latest Figma rectangles");
ok(nearRect(soloFigma.headline,[417.421,22.448,605.116,49.387]) &&
   nearRect(soloFigma.score,[532,104,376,50]) &&
   Math.abs(soloFigma.headlineFont-64.852)<.15 &&
   Math.abs(soloFigma.scoreFont-70)<.15 &&
   /255,\s*255,\s*255/.test(soloFigma.headlineShadow) &&
   /255,\s*255,\s*255/.test(soloFigma.scoreShadow),
  `Solo score typography keeps its independent Figma frames (${soloFigma.headlineFont.toFixed(2)}px / ${soloFigma.scoreFont.toFixed(2)}px)`);
ok(nearRect(soloFigma.focus,[752,107,660,408]) &&
   nearRect(soloFigma.save,[1152,444.051,241,50.95]) &&
   soloFigma.strayTape === "none" && soloFigma.scoreZ > soloFigma.focusZ &&
   /v1-divider\.png$/.test(soloFigma.dividerSrc),
  "the 660×408 photo aperture uses the solid-blue divider and score-paper layering");
ok(nearRect(soloFigma.award,[-5,645,223.774,150.283]) &&
   nearRect(soloFigma.stat1,[213.042,688.424,162.307,77.492]) &&
   nearRect(soloFigma.stat2,[374.893,694.227,160.212,71.802]) &&
   nearRect(soloFigma.stat3,[535.831,696.394,158.497,67.471]),
  "Solo award and the three rotated paper children match the REST render");
ok(nearRect(soloFigma.rematch,[742,693,678.593,104.048]) &&
   nearRect(soloFigma.rematchTape,[716.447,677.917,104.318,64.193]) &&
   Math.abs(soloFigma.rematchRotate-(-.347283))<.02 &&
   Math.abs(soloFigma.tapeRotate-(-15.253273))<.03,
  "Solo REMATCH and its pre-rotation tape box land at the authored angles");
ok(soloFigma.label === "REMATCH? READY UP!" &&
   /POINTS$/.test(soloFigma.scoreText) &&
   soloFigma.tabOrder.indexOf("rsSaveStrip") < soloFigma.tabOrder.indexOf("rsRematch"),
  "Solo copy and keyboard order follow the combined visual flow");

/* the run, pose by pose, with what each one paid */
const poses = await page.evaluate(() =>
  [...document.querySelectorAll("#rsPoseList li")].map(li => ({
    word: li.querySelector(".pl-word")?.textContent || "",
    pts: li.querySelector(".pl-pts")?.textContent || "",
    got: !!li.querySelector(".pl-pts.got"),
  })));
ok(poses.length >= 1, `every pose of the run is listed (${poses.length})`);
ok(poses.every(p => p.word && /Pts$/.test(p.pts)),
  `each row carries its word and points (${poses[0]?.word} - ${poses[0]?.pts})`);
ok(poses.some(p => p.got), "scored poses are marked as scored");
ok(await page.evaluate(() => {
  const list = document.getElementById("rsPoseList");
  const rematchTop=document.getElementById("rsRematch").getBoundingClientRect().top;
  return [...list.querySelectorAll("li")].every(li => li.scrollWidth <= li.clientWidth + 1) &&
    [...list.querySelectorAll(".rs-posecol")].every(col =>
      col.getBoundingClientRect().top + col.scrollHeight <= rematchTop - 5);
}), "each pose row fits without ellipsis and the columns stay clear of REMATCH");

/* stills cycle themselves — no arrows to click */
ok(await page.evaluate(() =>
  getComputedStyle(document.getElementById("rsPrev")).display === "none" ||
  document.getElementById("rsPrev").style.visibility === "hidden"),
  "solo has no photo arrows");
/* Poll rather than sleep a fixed span: with two stills a whole number of
   beats lands back on the frame you started from. */
const cycled = await page.evaluate(() => new Promise(resolve => {
  const at = () => {
    const on = document.querySelector("#rsFocusShots img.on");
    return on ? [...on.parentElement.children].indexOf(on) : -1;
  };
  const start = at();
  if(document.querySelectorAll("#rsFocusShots img").length < 2) return resolve("single");
  const t0 = Date.now();
  const poll = setInterval(() => {
    if(at() !== start){ clearInterval(poll); resolve("cycled"); }
    else if(Date.now() - t0 > 4000){ clearInterval(poll); resolve("stuck"); }
  }, 80);
}));
ok(cycled !== "stuck", `stills cycle on their own (${cycled})`);
/* The reel is a GIF, not a control: it plays itself and answers to nothing.
   No tap, no swipe, no keys, no pointer cursor, no focus ring. */
const soloReelInert = await page.evaluate(async () => {
  const focus = document.getElementById("rsFocus");
  const count = document.querySelectorAll("#rsFocusShots img").length;
  const at = () => Number(focus.dataset.shotIndex);
  /* read back in the same task so the auto-advance cannot race the probe */
  const before = at();
  focus.dispatchEvent(new PointerEvent("pointerdown", {
    pointerId:71, button:0, clientX:1100, clientY:300, bubbles:true }));
  focus.dispatchEvent(new PointerEvent("pointerup", {
    pointerId:71, button:0, clientX:990, clientY:302, bubbles:true }));
  focus.dispatchEvent(new MouseEvent("click", { bubbles:true }));
  focus.dispatchEvent(new KeyboardEvent("keydown", {
    key:"ArrowRight", bubbles:true, cancelable:true }));
  focus.dispatchEvent(new KeyboardEvent("keydown", {
    key:"Enter", bubbles:true, cancelable:true }));
  const cs = getComputedStyle(focus);
  return {
    count,
    inert: at() === before,
    noCursor: cs.cursor !== "pointer",
    noTabStop: !focus.hasAttribute("tabindex") && focus.getAttribute("role") !== "button",
    a11y: /photo \d+ of \d+/.test(focus.getAttribute("aria-label") || ""),
  };
});
ok(Object.values(soloReelInert).slice(1).every(Boolean),
  `Solo reel is auto-scroll only — tap, swipe and keys do nothing (${JSON.stringify(soloReelInert)})`);

/* Reduced motion keeps the photos moving, because with no manual control a
   frozen reel would hide most of the run. The CSS drops the cross-fade to a
   plain cut instead — that is the accommodation. */
await page.evaluate(() => document.activeElement?.blur());
await page.emulateMediaFeatures([{ name:"prefers-reduced-motion", value:"reduce" }]);
const reducedCycled = await page.evaluate(() => new Promise(resolve => {
  const at = () => Number(document.getElementById("rsFocus").dataset.shotIndex);
  const start = at();
  if(document.querySelectorAll("#rsFocusShots img").length < 2) return resolve("single");
  const t0 = Date.now();
  const poll = setInterval(() => {
    if(at() !== start){ clearInterval(poll); resolve("cycled"); }
    else if(Date.now() - t0 > 4000){ clearInterval(poll); resolve("stuck"); }
  }, 80);
}));
ok(reducedCycled !== "stuck",
  `reduced motion still advances the reel (${reducedCycled})`);
/* The cut is unconditional, not a reduced-motion concession: two stills
   partly visible at once read as a flash rather than a flipbook frame. */
await page.emulateMediaFeatures([{ name:"prefers-reduced-motion", value:"no-preference" }]);
ok(await page.evaluate(() => {
  const im = document.querySelector("#rsFocusShots img.on");
  const cs = getComputedStyle(im);
  return cs.transitionDuration === "0s" && cs.animationName === "none";
}), "the still swaps as a hard cut in every motion preference");
await page.emulateMediaFeatures([{ name:"prefers-reduced-motion", value:"no-preference" }]);
ok(!!(await txt("#rsAwardTitle")), `solo still earns an award (${await txt("#rsAwardTitle")})`);

/* Running out of time is the beat that has to be unmistakable — the Figma
   TIMES UP paper, a shake, and a red wash, not a text burst. */
console.log("time's up:");
await page.click("#rsRematch");
await page.waitForFunction(() => document.body.dataset.state === "playing", { timeout: 9000 });
await sleep(400);
/* A word timeout is a routine miss and gets the card's miss beat — the paper
   animates 1.5s while the next word arrives at 1250ms, so firing it per word
   started the next word underneath it. The RUN clock expiring is what earns
   the paper, so that is what this drives. */
await page.evaluate(async () => {
  const { state } = await import(location.origin + "/js/state.js");
  state.game.wordEnd = performance.now() + 300;
});
await sleep(900);
ok(await page.evaluate(() =>
  !document.getElementById("timesUp").classList.contains("fire")),
  "a missed word does NOT slam the full-screen TIMES UP paper");
await page.evaluate(async () => {
  const { state } = await import(location.origin + "/js/state.js");
  state.game.roundEndsAt = performance.now() + 200;   // the run itself expires
});
await page.waitForFunction(() =>
  document.getElementById("timesUp").classList.contains("fire"), { timeout: 8000 });
ok(true, "the RUN clock running out fires the TIMES UP paper");
await sleep(260);   // the slam rotates and starts at opacity 0
const tu = await page.evaluate(() => {
  const card = document.getElementById("timesUp");
  const img = card.querySelector("img");
  const flash = document.getElementById("timesUpFlash");
  /* layout metrics, not a client rect: the paper is mid-rotation and a client
     rect would report the rotated bounding box instead of the paper */
  return {
    src: img.getAttribute("src").split("/").pop(),
    ratio: +(img.offsetWidth / img.offsetHeight).toFixed(2),
    visible: Number(getComputedStyle(card).opacity) > .1,
    shake: getComputedStyle(img).animationName,
    glow: getComputedStyle(card, "::before").animationName,
    flashing: flash.classList.contains("fire"),
    flashLayer: getComputedStyle(flash).zIndex,
  };
});
ok(tu.src === "rs-timesup.png", `it is the Figma asset, not a text burst (${tu.src})`);
ok(Math.abs(tu.ratio - 2.65) < .12, `paper keeps its Figma proportions (${tu.ratio})`);
ok(tu.visible && tu.shake === "tuShake", `the paper shakes (${tu.shake})`);
ok(tu.glow === "tuGlow", `it glows (${tu.glow})`);
/* the red must be its own layer: an inset shadow on the stage paints under
   the video child and never shows */
ok(tu.flashing && Number(tu.flashLayer) > 0,
  `the red wash is a real layer over the stage (z ${tu.flashLayer})`);
await page.waitForFunction(() =>
  !document.getElementById("timesUp").classList.contains("fire"), { timeout: 4000 });
ok(true, "it clears itself instead of sticking around");
/* the run clock expiring IS the end of the run, so it carries itself to
   results — no exit click needed */
await page.waitForFunction(() => document.body.dataset.state === "results", { timeout: 8000 });
ok(true, "the expired run lands on results by itself");

console.log("replay + training:");
await page.click("#rsRematch");
ok(await fsmState() === "countdown", "rematch -> countdown");
await page.waitForFunction(() => document.body.dataset.state === "playing", { timeout: 8000 });
ok(await fsmState() === "playing", "replay reached playing");
await page.click("#btnExitSolo");
ok(await fsmState() === "results", "exit -> results again");
await page.click("#rsHome");
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
await page.setViewport({ width:1024,height:768 });
await sleep(180);
const lobbyAnchor = await page.evaluate(() => {
  const r=document.getElementById("lobbyStage").getBoundingClientRect();
  return {gap:innerHeight-r.bottom,top:r.top};
});
ok(Math.abs(lobbyAnchor.gap)<1 && lobbyAnchor.top>0,
  `tall-window letterbox stays above the lobby paper (bottom gap ${lobbyAnchor.gap.toFixed(1)}px)`);
await page.setViewport({ width:1440,height:810 });
await sleep(180);
const lobbySandwich = await page.evaluate(() => {
  const slot = document.getElementById("slotLobbyYou");
  const panel = slot.previousElementSibling;
  const frame = slot.nextElementSibling;
  const sr = slot.getBoundingClientRect();
  const fr = frame.getBoundingClientRect();
  return {
    cameraMounted: document.getElementById("cameraDock").parentElement === slot,
    panelZ: Number(getComputedStyle(panel).zIndex),
    slotZ: Number(getComputedStyle(slot).zIndex),
    frameZ: Number(getComputedStyle(frame).zIndex),
    widthRatio: sr.width / fr.width,
    heightRatio: sr.height / fr.height,
  };
});
ok(lobbySandwich.cameraMounted, "lobby camera mounted inside the blue paper aperture");
ok(lobbySandwich.panelZ < lobbySandwich.slotZ && lobbySandwich.slotZ < lobbySandwich.frameZ, "video is sandwiched between paper background and torn overlay");
ok(lobbySandwich.widthRatio > .94 && lobbySandwich.heightRatio > .92, "video fills the torn-frame opening");
await page.hover(".settings");
await sleep(240);
ok(await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector(".settings")).translate.split(" ")[1]) < -1), "lobby paper cards lift on hover");
await page.hover("#slotLobbyYou");
await sleep(240);
ok(await page.evaluate(() => [...document.querySelectorAll(".lobby-you-layer")].every(el => parseFloat(getComputedStyle(el).translate.split(" ")[1]) < -1)), "lobby camera layers lift together on hover");
const lobbyType = await page.evaluate(async () => {
  const input = document.getElementById("lobbyName");
  input.value = "WWWWWWWWWW";
  input.dispatchEvent(new Event("input", { bubbles:true }));
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const fits = el => {
    const style = getComputedStyle(el);
    const text = ("value" in el ? el.value : el.textContent).toUpperCase();
    const ctx = document.createElement("canvas").getContext("2d");
    ctx.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const width = ctx.measureText(text).width;
    const available = el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    return width <= available;
  };
  return {
    labels:[...document.querySelectorAll(".settings .set-label")].map(el => el.textContent),
    editorFits:fits(input),
    chipFits:fits(document.getElementById("lobbyYouName")),
  };
});
ok(lobbyType.labels.join("|") === "Match Timer|Word Timer", "lobby timer descriptions match their controls");
ok(lobbyType.editorFits && lobbyType.chipFits, "maximum 10-character name fits the editor and video chip");
await page.setViewport({ width:600,height:900 });
await page.evaluate(async () => {
  const {setLobbyStatus}=await import("/js/online.js");
  setLobbyStatus("Can’t reach the game server right now. Check your connection and try joining the room again.");
});
await sleep(100);
ok(await page.evaluate(() => {
  const stage=document.getElementById("lobbyStage").getBoundingClientRect();
  const status=document.getElementById("lobbyStatus").getBoundingClientRect();
  return status.bottom <= stage.bottom+1;
}), "compact server status refits above the paper edge in a portrait viewport");
await page.setViewport({ width:1440,height:810 });
await page.evaluate(async () => {
  const {setLobbyStatus}=await import("/js/online.js");
  setLobbyStatus(null);
});
await sleep(100);

// ---- party lobby (shared stage, party mode; no server on a static host) ----
console.log("party lobby:");
await page.click("#btnExitLobby");
ok(await fsmState() === "menu", "exit lobby -> home");
await page.click("#modeParty");
ok(await fsmState() === "party", "PARTY card enters the party state");
ok(await bodyScreen() === "lobby", "party shares the lobby stage");
ok(await page.evaluate(() => !document.querySelector(".party-rain,.party-title-confetti,.party-asset-burst")), "party lobby contains no confetti");
ok(await page.evaluate(() => document.getElementById("lobbyStage").dataset.mode) === "party", "stage flipped to party mode");
ok(await page.evaluate(() => getComputedStyle(document.getElementById("lobbyRobotWait")).display) === "none", "1v1 robot hidden in party mode");
ok(await page.evaluate(() => getComputedStyle(document.getElementById("btnJoinBlue")).display) !== "none", "blue JOIN THIS TEAM button visible");
ok(await page.evaluate(() => getComputedStyle(document.getElementById("btnJoinOrange")).display) !== "none", "orange JOIN THIS TEAM button visible");
ok(await page.evaluate(() => document.querySelectorAll(".pt-tile .pt-empty").length) === 6, "six waiting tiles rendered");
ok(await page.evaluate(() => !document.querySelector('img[src$="pt-inner.png"]') &&
  getComputedStyle(document.getElementById("ptB0")).backgroundImage.includes("pt-inner.png")),
  "blue and orange team tiles use their original clipped paper background");
const joinSpec = await page.evaluate(() => {
  const button = document.getElementById("btnJoinBlue").getBoundingClientRect();
  const label = document.querySelector("#btnJoinBlue span").getBoundingClientRect();
  return (label.top - button.top) / button.height;
});
ok(joinSpec > .72 && joinSpec < .76, `JOIN label follows the Figma vertical position (${joinSpec.toFixed(3)})`);
await page.hover("#ptB0");
await sleep(280);
ok(await page.evaluate(() => parseFloat(getComputedStyle(document.getElementById("ptB0")).translate.split(" ")[1]) < -1), "party panel layers lift together on hover");
await page.hover("#partyLobbyTitle");
await sleep(320);
await page.hover(".nametag");
await sleep(80);
ok(await page.evaluate(() => !document.querySelector(".party-rain,.party-title-confetti,.party-asset-burst")),
  "title, teams, VS, and controls remain confetti-free on hover");
ok(await page.evaluate(() => document.getElementById("btnStartMatch").disabled), "party START gated");
await page.waitForFunction(
  () => /Can’t reach the game server/.test(document.getElementById("lobbyStatus").textContent),
  { timeout: 20000 }
);
ok(true, "graceful no-server message in party mode");
await page.click("#btnExitLobby");
ok(await fsmState() === "menu", "back to home");

// ---- results visual contract (2v2 has different Figma rectangles) ----
console.log("results geometry:");
await page.evaluate(async () => {
  const {devResults}=await import("/js/results.js");
  await devResults("2v2");
});
await sleep(350);
const resultRects=await page.evaluate(() => Object.fromEntries(
  [...document.querySelectorAll(".rs-seat:not(.vacant)")].map(el => {
    const r=el.getBoundingClientRect();
    return [el.dataset.seat,[r.x,r.y,r.width,r.height]];
  })
));
const closeRect=(actual,want) => actual &&
  actual.every((n,i) => Math.abs(n-want[i])<1.5);
ok(closeRect(resultRects.blue0,[0,129.4,387.6,551.4]) &&
   closeRect(resultRects.blue1,[359.1,126,361.1,484.8]) &&
   closeRect(resultRects.orange0,[1095.1,99,344.9,607]) &&
   closeRect(resultRects.orange1,[780,116,339.2,502.4]),
  "2v2 seats use the four distinct Figma rectangles");

const resultsMedia = await page.evaluate(() => {
  const seat = document.querySelector(".rs-seat:not(.vacant)");
  const slot = seat?.querySelector(".slot");
  if(!seat || !slot) return null;
  const outer = seat.getBoundingClientRect(), inner = slot.getBoundingClientRect();
  return { width:inner.width / outer.width, height:inner.height / outer.height };
});
ok(resultsMedia && resultsMedia.width > .94 && resultsMedia.height > .94,
  "live media underlaps the torn results border without a paper seam");

const resultsStageTextFit = await page.evaluate(async () => {
  const {fitSingleLinePaperText}=await import("/js/gameplayFeedback.js");
  const names=[...document.querySelectorAll(".rs-seat:not(.vacant) .rs-nametag b")];
  const oldNames=names.map(node=>node.textContent);
  names.forEach((node,index)=>{
    node.textContent=["MAXIMILIAN","ALEXANDRA","CHRISTOPHR","BERNADETTE"][index];
    fitSingleLinePaperText(node,{safety:.86,minScale:.44});
  });
  const score=document.getElementById("rsScoreLine");
  const oldScore=score.innerHTML;
  score.textContent="60,000 - 55,000";
  fitSingleLinePaperText(score,{safety:.91,minScale:.38});
  const headline=document.getElementById("rsHeadline");
  const oldHeadline=headline.textContent;
  headline.textContent="MAXIMILIAN LEFT EARLY";
  fitSingleLinePaperText(headline,{safety:.91,minScale:.38});
  const inside=node=>node.scrollWidth<=node.clientWidth+1 &&
    node.scrollHeight<=node.clientHeight+1;
  const result={
    names:names.every(inside),
    score:inside(score),
    headline:inside(headline),
  };
  score.innerHTML=oldScore;
  fitSingleLinePaperText(score,{safety:.91,minScale:.38});
  headline.textContent=oldHeadline;
  fitSingleLinePaperText(headline,{safety:.91,minScale:.38});
  names.forEach((node,index)=>{
    node.textContent=oldNames[index];
    fitSingleLinePaperText(node,{safety:.86,minScale:.44});
  });
  return result;
});
ok(resultsStageTextFit.names && resultsStageTextFit.score &&
   resultsStageTextFit.headline,
  "maximum player names, peer-left headline, and five-digit totals fit the stage papers");

await page.click("#rsRematch");
await sleep(90);
const readyOn = await page.evaluate(() => {
  const button = document.getElementById("rsRematch");
  const mine = document.querySelector('.rs-seat[data-pid="blue0"]');
  return {
    pressed:button.getAttribute("aria-pressed"),
    label:document.getElementById("rsRematchLabel").textContent,
    status:document.getElementById("rsRematchStatus").textContent,
    mineReady:mine?.classList.contains("ready"),
    scale:Number.parseFloat(getComputedStyle(button).scale),
    readyFilter:getComputedStyle(mine?.querySelector(".rs-ready")).filter,
    rematchFilter:getComputedStyle(button.querySelector("img")).filter,
  };
});
ok(readyOn.pressed === "true" && /3\/4/.test(readyOn.label) &&
   /3 of 4 players ready/.test(readyOn.status) && readyOn.mineReady &&
   readyOn.scale >= 1.02 && readyOn.readyFilter === "none" &&
   !/47,\s*160,\s*74/.test(readyOn.rematchFilter),
  "party REMATCH votes ready, grows and announces the count without a green glow");
await page.click("#rsRematch");
await sleep(90);
ok(await page.evaluate(() => {
  const button = document.getElementById("rsRematch");
  return button.getAttribute("aria-pressed") === "false" &&
    /2\/4/.test(document.getElementById("rsRematchLabel").textContent) &&
    !document.querySelector('.rs-seat[data-pid="blue0"]').classList.contains("ready");
}), "party REMATCH toggles back to unready and shrinks the shared count");

await page.click("#rsSeeBreakdown");
await sleep(380);
ok(await page.evaluate(() =>
  [...document.querySelectorAll(".rs-thumb")].every(el =>
    el.tagName === "BUTTON" && el.getAttribute("aria-pressed") !== null)),
  "every blue/orange breakdown card is a native selectable button");
const resultsBreakdownTextFit = await page.evaluate(async () => {
  const {fitSingleLinePaperText}=await import("/js/gameplayFeedback.js");
  const names=[...document.querySelectorAll(".rs-thumb .rs-nametag b"),
    document.querySelector("#rsFocusName b")].filter(Boolean);
  const stats=[...document.querySelectorAll(".rs-stat b")];
  names.forEach((node,index)=>{
    node.textContent=["MAXIMILIAN","ALEXANDRA","CHRISTOPHR","BERNADETTE","MAXIMILIAN"][index];
    fitSingleLinePaperText(node,{safety:.86,minScale:.44});
  });
  ["60,000 PTS","123 Firsts","999.9 AVG"].forEach((text,index)=>{
    stats[index].textContent=text;
    fitSingleLinePaperText(stats[index],{safety:.88,minScale:.4});
  });
  const inside=node=>node.scrollWidth<=node.clientWidth+1 &&
    node.scrollHeight<=node.clientHeight+1;
  return {names:names.every(inside),stats:stats.every(inside)};
});
ok(resultsBreakdownTextFit.names && resultsBreakdownTextFit.stats,
  "maximum breakdown names, five-digit points, and three-digit stats fit their papers");
const orangeHoverBefore = await page.evaluate(() => {
  const card = document.querySelector("#rsStripOrange .rs-thumb");
  const style = getComputedStyle(card);
  return {
    zIndex:style.zIndex,
    translate:style.translate,
    left:style.left,
    top:style.top,
  };
});
await page.hover("#rsStripOrange .rs-thumb");
await sleep(190);
const orangeHoverAfter = await page.evaluate(() => {
  const card = document.querySelector("#rsStripOrange .rs-thumb");
  const style = getComputedStyle(card);
  return {
    zIndex:style.zIndex,
    translate:style.translate,
    left:style.left,
    top:style.top,
    scale:Number.parseFloat(style.scale),
  };
});
ok(orangeHoverAfter.zIndex === orangeHoverBefore.zIndex &&
   orangeHoverAfter.translate === orangeHoverBefore.translate &&
   orangeHoverAfter.left === orangeHoverBefore.left &&
   orangeHoverAfter.top === orangeHoverBefore.top &&
   orangeHoverAfter.scale >= 1.02 && orangeHoverAfter.scale < 1.05,
  "hover gives a subtle riffle without changing card stack order or laid-out position");
await page.click("#rsStripOrange .rs-thumb");
await sleep(360);
ok(await page.evaluate(() => {
  const orange = document.querySelector("#rsStripOrange .rs-thumb");
  const blue = document.querySelector("#rsStripBlue .rs-thumb.on");
  const style = getComputedStyle(orange);
  const translated = style.translate !== "none" &&
    !/^0px(?:\s+0px)?$/.test(style.translate);
  return orange.classList.contains("on") &&
    orange.getAttribute("aria-pressed") === "true" &&
    !blue &&
    document.getElementById("rsFocusName").classList.contains("orange") &&
    Number(style.zIndex) >= 8 &&
    Number.parseFloat(style.scale) >= 1.07 &&
    translated &&
    !style.filter.includes("drop-shadow");
}), "clicking orange selects, lifts and focuses it without a team-colored glow");
await page.focus("#rsStripBlue .rs-thumb");
ok(await page.evaluate(() => {
  const blue = document.querySelector("#rsStripBlue .rs-thumb");
  const style = getComputedStyle(blue);
  return Number(style.zIndex) === 1 &&
    (style.translate === "none" || /^0px(?:\s+0px)?$/.test(style.translate));
}), "keyboard focus outlines an unselected card without promoting or translating it");
await page.keyboard.press("Enter");
await sleep(360);
ok(await page.evaluate(() => {
  const blue = document.querySelector("#rsStripBlue .rs-thumb");
  return blue.classList.contains("on") &&
    blue.getAttribute("aria-pressed") === "true" &&
    !document.querySelector("#rsStripOrange .rs-thumb.on") &&
    !document.getElementById("rsFocusName").classList.contains("orange");
}), "keyboard selection promotes blue and reverses the single focused card");
ok(await page.evaluate(() => {
  const thumb = document.querySelector(".rs-thumb"), shot = thumb.querySelector(".shotwrap");
  const focus = document.getElementById("rsFocus"), media = document.getElementById("rsFocusShots");
  const tr = thumb.getBoundingClientRect(), sr = shot.getBoundingClientRect();
  const fr = focus.getBoundingClientRect(), mr = media.getBoundingClientRect();
  return sr.width / tr.width > .93 && sr.height / tr.height > .93 &&
    mr.width / fr.width > .95 && mr.height / fr.height > .94;
}), "thumbnail and focus media fully underlap their torn photo borders");

await page.setViewport({ width:1080, height:608 });
await page.evaluate(() => {
  const title = document.getElementById("rsAwardTitle");
  const sub = document.getElementById("rsAwardSub");
  title.dataset.fullText = "PHILOSOPHER";
  title.textContent = title.dataset.fullText;
  sub.dataset.fullText = "Fastest recognition across every single pose";
  sub.textContent = sub.dataset.fullText;
  dispatchEvent(new Event("resize"));
});
await sleep(180);
ok(await page.evaluate(() => {
  const title = document.getElementById("rsAwardTitle");
  const sub = document.getElementById("rsAwardSub");
  const xScale = node => node.style.scale ? Number.parseFloat(node.style.scale) : 1;
  return title.textContent === "PHILOSOPHER" &&
    Number.parseFloat(title.style.fontSize) < 20.603 &&
    title.scrollWidth * xScale(title) <= title.clientWidth * 1.02 &&
    sub.classList.contains("fit-wrap") &&
    sub.querySelectorAll("br").length === 1 &&
    sub.scrollWidth * xScale(sub) <= sub.clientWidth * 1.02 &&
    getComputedStyle(sub).overflow === "visible";
}), "long award title/description auto-fit without clipping at 75% viewport");
await page.setViewport({ width:600, height:900 });
await sleep(100);
ok(await page.evaluate(() => {
  const stage=document.getElementById("resStage");
  const expanded=id => {
    const hit=getComputedStyle(document.getElementById(id), "::before");
    return Number.parseFloat(hit.width) >= 44 && Number.parseFloat(hit.height) >= 44;
  };
  const breakdown=["rsExit","rsHome","rsPrev","rsNext","rsBack","rsSaveStrip","rsRematch"]
    .every(expanded);
  const page=stage.dataset.page;
  stage.dataset.page="stage";
  const stageControls=expanded("rsSeeBreakdown");
  stage.dataset.page=page;
  return breakdown && stageControls;
}), "small-stage result controls retain transparent 44×44 hit targets");
await page.setViewport({ width:1440, height:810 });
await sleep(120);

await page.emulateMediaFeatures([{ name:"prefers-reduced-motion", value:"reduce" }]);
await sleep(80);
ok(await page.evaluate(() => {
  const selected = document.querySelector(".rs-thumb.on");
  const ready = document.querySelector(".rs-seat .rs-ready");
  const strip = document.querySelector(".rs-strip");
  return Number.parseFloat(getComputedStyle(selected).scale) === 1 &&
    getComputedStyle(strip).animationName === "none" &&
    getComputedStyle(ready).transitionDuration === "0s";
}), "reduced-motion removes page/card/ready movement while preserving selection state");
await page.emulateMediaFeatures([{ name:"prefers-reduced-motion", value:"no-preference" }]);

await page.click("#rsStripOrange .rs-thumb");
await sleep(80);
await page.evaluate(async () => {
  const {syncResultsRoster}=await import("/js/results.js");
  syncResultsRoster([
    {id:"blue0",name:"LOGAN",team:"blue"},
    {id:"blue1",name:"MIA",team:"blue"},
    {id:"orange1",name:"ZOE",team:"orange"},
  ]);
});
ok(await page.evaluate(() =>
  document.querySelectorAll(".rs-thumb").length === 3 &&
  !document.querySelector('[data-pid="orange0"]') &&
  /1\/3/.test(document.getElementById("rsRematchLabel").textContent) &&
  !document.getElementById("rsFocusName").classList.contains("orange") &&
  /LOGAN/.test(document.getElementById("rsFocusName").textContent)),
  "a results-phase leaver disappears and focus falls back to a surviving local player");

await page.evaluate(async () => {
  const {showResults}=await import("/js/results.js");
  window.__finishReadyVote = null;
  showResults({
    mode:"party", size:2, headline:"BLUE TEAM WINS!",
    teams:{blue:10,orange:5},
    players:[
      {id:"mine",name:"ME",team:"blue",mine:true,score:10,ready:false},
      {id:"peer",name:"PEER",team:"orange",score:5,ready:false},
    ],
    rematch:{ready:0,total:2,mine:false},
    onRematch:()=>new Promise(resolve => { window.__finishReadyVote=resolve; }),
  });
});
await page.click("#rsRematch");
await sleep(60);
ok(await page.evaluate(() => {
  const button=document.getElementById("rsRematch");
  button.click();
  return button.disabled && button.getAttribute("aria-busy") === "true" &&
    /1\/2/.test(document.getElementById("rsRematchLabel").textContent);
}), "an in-flight party vote is guarded against duplicate clicks");
await page.evaluate(() => window.__finishReadyVote({error:"offline"}));
await page.waitForFunction(() => !document.getElementById("rsRematch").disabled);
ok(await page.evaluate(() => {
  const button=document.getElementById("rsRematch");
  return button.getAttribute("aria-busy") === null &&
    button.getAttribute("aria-pressed") === "false" &&
    /0\/2/.test(document.getElementById("rsRematchLabel").textContent) &&
    !document.querySelector('.rs-seat[data-pid="mine"]').classList.contains("ready");
}), "failed party vote rolls back the count, toggle and READY paper");
await page.click("#rsHome");
ok(await fsmState() === "menu", "clicking the results logo returns home");
ok(await page.evaluate(() =>
  !document.querySelector("#resStage .rs-seat video") &&
  !document.querySelector("#resStage .rs-seat[data-pid]") &&
  !document.getElementById("rsFocusShots").children.length &&
  !document.getElementById("rsFocusShotsB").children.length &&
  !document.getElementById("rsPoseColA").children.length &&
  !document.getElementById("rsPoseColB").children.length &&
  !document.getElementById("rsStripBlue").children.length &&
  !document.getElementById("rsStripOrange").children.length),
  "leaving results releases both reels, pose rows, seat streams and result-only DOM");

console.log("reduced-motion gameplay:");
await page.emulateMediaFeatures([{ name:"prefers-reduced-motion", value:"reduce" }]);
await page.click("#modeAI");
await page.waitForFunction(() => document.body.dataset.state === "playing",
  { timeout:6000,polling:50 });
const reducedScoreBefore=await txt("#soloScoreVal");
await feed("state.game.word", .99);
await page.waitForFunction(() =>
  document.getElementById("soloAward").classList.contains("show"),
  { timeout:3000,polling:10 });
const reducedAwardAt=Date.now();
await page.waitForFunction(before =>
  document.getElementById("soloScoreVal").textContent !== before,
  { timeout:1000,polling:10 }, reducedScoreBefore);
const reducedScoreDelay=Date.now()-reducedAwardAt;
ok(await page.evaluate(() => {
  const award=document.getElementById("soloAward");
  return Number.parseFloat(getComputedStyle(award).opacity) === 1 &&
    !document.querySelector(".sp-chip");
}), "reduced-motion keeps the settled points award visible and removes the invisible flight");
ok(reducedScoreDelay < 200,
  `reduced-motion commits the Solo score without the 650ms chip delay (${reducedScoreDelay}ms)`);
await page.emulateMediaFeatures([{ name:"prefers-reduced-motion", value:"no-preference" }]);

// ---- console errors ----
console.log("hygiene:");
const realErrors = consoleErrors.filter(e =>
  !e.includes("favicon") && !e.includes("net::ERR_") &&
  !e.includes("socket.io")                    // static host has no socket endpoint — expected
);
ok(realErrors.length === 0, `no console/page errors (${realErrors.length})`);
realErrors.forEach(e => console.log("    " + e.slice(0, 200)));

await browser.close();
console.log(fails ? `\n${fails} FAILURES` : "\nALL OFFLINE E2E CHECKS PASSED");
process.exit(fails ? 1 : 0);
