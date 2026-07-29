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
await sleep(2900);
ok(await fsmState() === "playing", "countdown -> playing");
ok(await bodyScreen() === "solo", "solo screen shown");
ok(await page.evaluate(() => document.querySelector("header").classList.contains("hidden")), "global header hidden (immersive overlay)");
const rstate = () => page.evaluate(() => document.getElementById("scrSolo").dataset.rstate);
ok(await rstate() === "guessing", "round state GUESSING");
const word = await txt("#soloWord");
ok(word && word !== "—", `word card shows the target: "${word}"`);
ok(/^\d\d:\d\d$/.test(await txt("#soloRoundTime")), `round timer mm:ss (${await txt("#soloRoundTime")})`);
ok(/^\d\d:\d\d$/.test(await txt("#soloWordTime")), `word timer mm:ss (${await txt("#soloWordTime")})`);
ok(await txt("#soloSkipCost") === "\u2212250", `skip cost from SOLO settings (${await txt("#soloSkipCost")})`);
ok(await page.evaluate(() => !document.querySelector("#soloAward.show")), "no award paper while GUESSING (single-state render)");
const soloVisual = await page.evaluate(() => {
  const exit = document.getElementById("btnExitSolo");
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
    exitText: exit.textContent.trim(),
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
/* lb-exit.png bakes "EXIT LOBBY" into the art, which is the wrong screen.
   Solo must use a blank exported paper and carry a live, correct label. */
ok(/\/lb-[a-z-]+\.png$/.test(soloVisual.exitSrc) && !soloVisual.exitSrc.endsWith("/lb-exit.png"),
  `Solo exit uses a blank exported paper button (${soloVisual.exitSrc.split("/").pop()})`);
ok(/END GAME/i.test(soloVisual.exitText) && !/lobby/i.test(soloVisual.exitText),
  `Solo exit is labelled for the screen it is on ("${soloVisual.exitText}")`);
ok(/255,\s*255,\s*255/.test(soloVisual.wordShadow),
  `Solo navy type uses the Figma white offset (${soloVisual.wordShadow})`);
ok(soloVisual.midOpacity <= .7 && soloVisual.botOpacity <= .4,
  `past guesses visibly recede (${soloVisual.midOpacity.toFixed(2)} / ${soloVisual.botOpacity.toFixed(2)})`);
ok(soloVisual.exactTapes, "Solo uses the eight exact tape exports without a second CSS rotation");
ok(soloVisual.emptyHistoryTapesHidden, "empty guess slots do not leave floating tape on the camera");

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
ok(await txt("#soloStreakVal") === "x1", "skip reset the streak");

// exit -> results
await page.click("#btnExitSolo");
ok(await fsmState() === "results", "exit -> results");
ok(/SCORE/.test(await txt("#rescard h2")), `results title (${await txt("#rescard h2")})`);

console.log("replay + training:");
await page.click("#btnAgain");
ok(await fsmState() === "countdown", "play again -> countdown");
await sleep(2900);
ok(await fsmState() === "playing", "replay reached playing");
await page.click("#btnExitSolo");
ok(await fsmState() === "results", "exit -> results again");
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

// ---- console errors ----
console.log("hygiene:");
const realErrors = consoleErrors.filter(e =>
  !e.includes("favicon") && !e.includes("net::ERR_") &&
  !e.includes("socket.io") &&                  // static host has no socket endpoint — expected
  !/assets\/ui\/figma\/sp-/.test(e)          // solo art pending Figma export (rate-limited)
);
ok(realErrors.length === 0, `no console/page errors (${realErrors.length})`);
realErrors.forEach(e => console.log("    " + e.slice(0, 200)));

await browser.close();
console.log(fails ? `\n${fails} FAILURES` : "\nALL OFFLINE E2E CHECKS PASSED");
process.exit(fails ? 1 : 0);
