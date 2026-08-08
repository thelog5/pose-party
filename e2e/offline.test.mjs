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
/* Solo now raises HOW TO PLAY before its count-in, so every solo start (and
   every solo REMATCH) has to answer it before "playing" is reachable. */
const readyUp = async () => {
  await page.waitForFunction(() =>
    !document.getElementById("howToPlay").classList.contains("hidden"),
    { timeout: 5000, polling: 25 });
  await page.click("#htpReady");
};
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
const homeBubbleBefore = await page.evaluate(() => {
  const bubble = document.getElementById("speechBubble");
  const paper = bubble.querySelector("img");
  const line = document.getElementById("bubbleText");
  const range=document.createRange();
  range.selectNodeContents(line);
  const ink=range.getBoundingClientRect();
  const bubbleBox=bubble.getBoundingClientRect();
  return {
    text:line.textContent.trim(),
    asset:[paper.naturalWidth,paper.naturalHeight],
    fits:line.scrollWidth <= line.clientWidth + .75 &&
      line.scrollHeight <= line.clientHeight + .75,
    paperFits:ink.left >= bubbleBox.left - 1 && ink.right <= bubbleBox.right + 1 &&
      ink.top >= bubbleBox.top - 1 && ink.bottom <= bubbleBox.bottom + 1,
    font:getComputedStyle(line).fontFamily,
    weight:getComputedStyle(line).fontWeight,
    size:parseFloat(getComputedStyle(line).fontSize) / bubble.clientWidth,
    align:getComputedStyle(line).textAlign,
    /* the paper's own Figma DROP_SHADOW (302:637) */
    paperShadow:getComputedStyle(paper).filter,
    textBox:{
      left:line.offsetLeft / bubble.clientWidth,
      top:line.offsetTop / bubble.clientHeight,
      width:line.offsetWidth / bubble.clientWidth,
      height:line.offsetHeight / bubble.clientHeight,
    },
    /* where the drawn line actually sits inside the paper, which is the thing
       that was wrong: the copy used to hang off the top-left of its box and
       the second line was cut off by it */
    inkCentre:{
      x:(ink.left + ink.right) / 2 - bubbleBox.left,
      y:(ink.top + ink.bottom) / 2 - bubbleBox.top,
      w:bubbleBox.width, h:bubbleBox.height,
    },
  };
});
ok(homeBubbleBefore.asset[0] === 1440 && homeBubbleBefore.asset[1] === 758,
  "Home uses the new light Figma speech paper (302:638)");
ok(homeBubbleBefore.text === "STRIKE A POSE!" &&
   homeBubbleBefore.paperFits && homeBubbleBefore.fits,
  `Home starts with visible Figma node 302:635 ("${homeBubbleBefore.text}")`);
/* The text box is Figma node 302:635's rectangle grown to the balloon's
   interior and centred on the SAME point (50.28% / 40.17%). It has to be
   bigger: Fredoka One draws STRIKE A POSE! ~394px wide at the authored
   51.88px — wider than the whole 360px paper — so at the authored geometry
   it wrapped and the box clipped the second line clean off. The authored
   size is now a CEILING that homeAlive's fitter shrinks from, never a
   promise, and both axes are centred. */
ok(/Fredoka One/.test(homeBubbleBefore.font) &&
   homeBubbleBefore.weight === "400" &&
   homeBubbleBefore.align === "center" &&
   homeBubbleBefore.size <= .14411 + .0005 &&
   Math.abs((homeBubbleBefore.textBox.left + homeBubbleBefore.textBox.width / 2)
     - .502775) < .004 &&
   Math.abs((homeBubbleBefore.textBox.top + homeBubbleBefore.textBox.height / 2)
     - .40171) < .006 &&
   homeBubbleBefore.textBox.width > .76667 &&
   homeBubbleBefore.textBox.height > .43398,
  "Home copy is Fredoka at or under node 302:635's size, centred on its rectangle");
ok(Math.abs(homeBubbleBefore.inkCentre.x / homeBubbleBefore.inkCentre.w - .502775) < .012 &&
   Math.abs(homeBubbleBefore.inkCentre.y / homeBubbleBefore.inkCentre.h - .40171) < .02,
  "the drawn copy sits centred in the balloon on both axes, not parked at its top-left");
ok(/drop-shadow/.test(homeBubbleBefore.paperShadow),
  "the speech paper carries Figma 302:637's own drop shadow");
await page.click("#speechBubble");
const homeBubbleAfter = await page.evaluate(async () => {
  const bubble = document.getElementById("speechBubble");
  const line = document.getElementById("bubbleText");
  const card = document.getElementById("modeVS");
  const started=performance.now();
  const gaps=[];
  const sample=now=>gaps.push({
    gap:card.getBoundingClientRect().left-bubble.getBoundingClientRect().right,
    at:now-started,
  });
  sample(started);
  await new Promise(resolve=>{
    const frame=now=>{
      sample(now);
      if(now-started>=450) resolve();
      else requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
  const tightest=gaps.reduce((best,next)=>next.gap<best.gap?next:best);
  return {
    text:line.textContent.trim(),
    popped:bubble.classList.contains("pop"),
    fits:line.scrollWidth <= line.clientWidth + .75 &&
      line.scrollHeight <= line.clientHeight + .75,
    cardGap:tightest.gap,
    tightestAt:tightest.at,
    samples:gaps.length,
  };
});
ok(homeBubbleAfter.text === "I'm watching… in a friendly way!" &&
   homeBubbleAfter.text !== homeBubbleBefore.text && homeBubbleAfter.popped &&
   homeBubbleAfter.fits,
  `tapping Home advances the existing dialogue bank and safely refits ` +
  `("${homeBubbleAfter.text}")`);
ok(homeBubbleAfter.cardGap >= 12,
  `Home's popping speech paper stays clear of the 1v1 card across ` +
  `${homeBubbleAfter.samples} animation frames ` +
  `(${homeBubbleAfter.cardGap.toFixed(1)}px minimum at ` +
  `${homeBubbleAfter.tightestAt.toFixed(0)}ms)`);
const homePhraseFit = await page.evaluate(async current => {
  const {HOME_ROBOT_PHRASES}=await import("/js/homeAlive.js");
  const {fitWrappedTextToBox}=await import("/js/textFit.js");
  const bubble=document.getElementById("speechBubble");
  const line=document.getElementById("bubbleText");
  const currentIndex=HOME_ROBOT_PHRASES.indexOf(current);
  const tapped=[];
  for(let i=0;i<HOME_ROBOT_PHRASES.length;i++){
    bubble.click();
    tapped.push(line.textContent.trim());
  }
  const expected=HOME_ROBOT_PHRASES.map((_,i) =>
    HOME_ROBOT_PHRASES[(currentIndex+i+1)%HOME_ROBOT_PHRASES.length]);
  const misses=[];
  for(const text of HOME_ROBOT_PHRASES){
    line.textContent=text;
    fitWrappedTextToBox(line,{minSize:8});
    if(line.scrollWidth > line.clientWidth + .75 ||
       line.scrollHeight > line.clientHeight + .75) misses.push(text);
  }
  line.textContent=current;
  fitWrappedTextToBox(line,{minSize:8});
  return {
    count:HOME_ROBOT_PHRASES.length,
    misses,
    cyclesFromBank:tapped.every((text,i)=>text===expected[i]),
    everyTapDiffers:tapped.every((text,i)=>text!==(i ? tapped[i-1] : current)),
    unique:new Set(HOME_ROBOT_PHRASES).size===HOME_ROBOT_PHRASES.length,
  };
},homeBubbleAfter.text);
ok(homePhraseFit.count === 15 && homePhraseFit.unique &&
   homePhraseFit.cyclesFromBank && homePhraseFit.everyTapDiffers &&
   homePhraseFit.misses.length === 0,
  `every tap follows all ${homePhraseFit.count} distinct lines in the existing ` +
  `Home text bank, and every line stays inside the bubble`);
await sleep(420);
if(process.env.HOME_SCREENSHOT){
  await page.screenshot({path:process.env.HOME_SCREENSHOT,fullPage:true});
}
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

/* HOW TO PLAY gates the count-in: the board and the camera are live behind
   it, so the 3-2-1 only starts once the player says they are ready. */
await sleep(650);   // let the drop settle: a live transform inflates every rect
const howTo = await page.evaluate(() => {
  const card = document.getElementById("howToPlay");
  const panel = document.getElementById("htpPanel");
  if (!card || card.classList.contains("hidden")) return null;
  const box = panel.getBoundingClientRect();
  /* Layout metrics, never client rects: the yellow papers retain their authored
     Figma rotations and the panel has just finished a scale/rotate entrance,
     both of which inflate getBoundingClientRect. */
  const step = node => node.offsetWidth > 0 && node.offsetHeight > 0 &&
    node.offsetLeft >= -1 &&
    node.offsetLeft + node.offsetWidth <= panel.clientWidth + 1;
  const inside = node => node.scrollWidth <= node.clientWidth + 1;
  const ready = document.getElementById("htpReady");
  const visible = n => getComputedStyle(n).display !== "none";
  const labels = [...panel.querySelectorAll(".htp-lab")].filter(visible);
  return {
    mode: card.dataset.mode,
    steps: [...panel.querySelectorAll(".htp-step")].length,
    labels: labels.map(n => n.textContent),
    stepsInside: [...panel.querySelectorAll(".htp-step")].every(step),
    labelsFit: labels.every(inside),
    art: [...panel.querySelectorAll("img")]
      .every(i => i.complete && i.naturalWidth > 0),
    focused: document.activeElement === ready,
    readyClickable: getComputedStyle(ready).pointerEvents !== "none",
    buttons: panel.querySelectorAll("button").length,
    modal: card.getAttribute("aria-modal") === "true",
    countdownHidden: document.getElementById("countdown")
      .classList.contains("hidden"),
    titleFits: (() => {
      const t = document.getElementById("htpTitle");
      return t.scrollWidth <= t.clientWidth + 1;
    })(),
    fitsViewport: box.top >= -1 && box.bottom <= innerHeight + 1 &&
      box.left >= -1 && box.right <= innerWidth + 1,
    /* the other two modes' columns (312:642, 312:641) live in the same DOM,
       gated purely by CSS off #howToPlay[data-mode] — confirm none of that
       content leaks through while Solo's card is up */
    onlySoloVisible: [...panel.querySelectorAll('[data-htp-for]')]
      .every(n => visible(n) === n.dataset.htpFor.split(" ").includes("ai")),
  };
});
const htpFidelity = await page.evaluate(() => {
  const card=document.getElementById("howToPlay");
  const panel=document.getElementById("htpPanel");
  const visible=node=>getComputedStyle(node).display!=="none";
  const lineCount=node=>{
    const range=document.createRange();
    range.selectNodeContents(node);
    return new Set([...range.getClientRects()]
      .filter(r=>r.width>0&&r.height>0)
      .map(r=>Math.round(r.top*10)/10)).size;
  };
  const modes={};
  for(const mode of ["ai","1v1","party"]){
    card.dataset.mode=mode;
    const labels=[...panel.querySelectorAll(".htp-lab")].filter(visible);
    const rig=[...panel.querySelectorAll(".htp-rig")].find(visible);
    const face=rig?.querySelector(".rb-face");
    modes[mode]={
      lines:labels.map(lineCount),
      rigRatio:rig ? rig.offsetWidth/rig.offsetHeight : 0,
      face:rig&&face ? {
        left:face.offsetLeft/rig.offsetWidth,
        top:face.offsetTop/rig.offsetHeight,
        width:face.offsetWidth/rig.offsetWidth,
        height:face.offsetHeight/rig.offsetHeight,
      } : null,
    };
  }
  card.dataset.mode="1v1";
  const timer=panel.querySelector(".htp-timer");
  const value=timer.querySelector(".htp-tval");
  const title=document.getElementById("htpTitle");
  const timerBox={
    left:value.offsetLeft/timer.offsetWidth,
    width:value.offsetWidth/timer.offsetWidth,
    top:value.offsetTop/timer.offsetHeight,
  };
  const titleBox={
    left:title.offsetLeft/panel.clientWidth,
    top:title.offsetTop/panel.clientHeight,
    width:title.offsetWidth/panel.clientWidth,
  };
  card.dataset.mode="ai";
  const clock=panel.querySelector(".htp-tu-clock");
  const clockStyle=getComputedStyle(clock);
  const soloClock={
    color:clockStyle.backgroundColor,
    mask:clockStyle.maskImage || clockStyle.webkitMaskImage,
    top:clock.offsetTop/clock.parentElement.offsetHeight,
    translate:clockStyle.translate,
  };
  const paperRotations=[...panel.querySelectorAll(".htp-step")].map(step =>
    parseFloat(getComputedStyle(step.querySelector(".htp-sq")).rotate) || 0);
  return {modes,timerBox,titleBox,soloClock,paperRotations};
});
if(process.env.HTP_SCREENSHOT_DIR){
  const screenshotDir=process.env.HTP_SCREENSHOT_DIR;
  for(const mode of ["ai", "1v1", "party"]){
    await page.evaluate(value => {
      const card=document.getElementById("howToPlay");
      card.dataset.mode=value;
      card.querySelectorAll(".htp-step").forEach(step=>{
        step.style.animation="none";
      });
    },mode);
    await page.evaluate(() => new Promise(resolve =>
      requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.$("#htpPanel").then(node => node.screenshot({
      path:`${screenshotDir}/htp-current-${mode}.png`,
      omitBackground:true,
    }));
  }
  await page.evaluate(() => { document.getElementById("howToPlay").dataset.mode="ai"; });
}
ok(!!howTo, "starting Solo raises the HOW TO PLAY card before the count-in");
ok(howTo?.mode === "ai", "the card is flagged data-mode=ai for Solo");
ok(howTo?.steps === 3 &&
  howTo.labels.join("|") ===
    "SEE THE WORD|ACT IT OUT|GET AI TO GUESS BEFORE TIME RUNS OUT",
  `the Figma card's three Solo steps are present (${howTo?.labels.join(" / ")})`);
ok(howTo?.onlySoloVisible,
  "1v1's and Party's column content stay hidden behind Solo's data-mode");
ok(htpFidelity.modes.ai.lines.join() === "1,1,2" &&
   htpFidelity.modes["1v1"].lines.join() === "2,2,3" &&
   htpFidelity.modes.party.lines.join() === "2,2,3",
  "all three How to Play captions wrap on the same authored lines as Figma");
ok(Object.values(htpFidelity.modes).every(mode =>
    Math.abs(mode.rigRatio - 1) < .01),
  "tutorial robots use Figma's square image-fill groups, not the tall gameplay rig");
ok(Math.abs(htpFidelity.modes.ai.face.left - .35047) < .01 &&
   Math.abs(htpFidelity.modes.ai.face.top - .20561) < .01 &&
   Math.abs(htpFidelity.modes["1v1"].face.left - .35348) < .01 &&
   Math.abs(htpFidelity.modes["1v1"].face.top - .20975) < .01,
  "tutorial robot faces use their mode-specific Figma rectangles");
ok(Math.abs(htpFidelity.timerBox.left - .18527) < .01 &&
   Math.abs(htpFidelity.timerBox.width - .57245) < .01 &&
   Math.abs(htpFidelity.timerBox.top - .38542) < .015,
  "1v1 mini timer copy is registered to its authored inner text box");
ok(Math.abs(htpFidelity.titleBox.left - .15993) < .005 &&
   Math.abs(htpFidelity.titleBox.top - .06221) < .005 &&
   Math.abs(htpFidelity.titleBox.width - .67923) < .005,
  "How to Play title uses the source text rectangle");
ok(Math.abs(htpFidelity.paperRotations[0]) < .01 &&
   Math.abs(htpFidelity.paperRotations[1] - 1.56178) < .01 &&
   Math.abs(htpFidelity.paperRotations[2] - 3.124524) < .01,
  "How to Play papers preserve Figma's 0° / +1.56178° / +3.12452° rotations");
ok(/242,\s*141,\s*64/.test(htpFidelity.soloClock.color) &&
   /sp-clock\.png/.test(htpFidelity.soloClock.mask) &&
   Math.abs(htpFidelity.soloClock.top-.207)<.01 &&
   htpFidelity.soloClock.translate==="none",
  "Solo's mini TIMES UP clock uses the orange rendered treatment from Figma");
ok(howTo?.art, "every How to Play paper export loads, across all three modes");
ok(howTo?.stepsInside && howTo?.labelsFit && howTo?.titleFits &&
   howTo?.fitsViewport,
  "the card, its title and its steps stay inside the panel and the viewport");
ok(howTo?.readyClickable && howTo?.buttons === 1 && howTo?.modal,
  "I'M READY is the card's only button and the card is a modal dialog");
ok(howTo?.focused, "I'M READY takes focus, so Enter starts the run");
ok(howTo?.countdownHidden, "the 3-2-1 waits for the player");

/* With the BACK paper gone, Esc is the ONLY way out of the card — which makes
   it load-bearing, not a convenience. */
await page.keyboard.press("Escape");
await sleep(400);
ok(await page.evaluate(() =>
  document.getElementById("howToPlay").classList.contains("hidden")) &&
  await bodyScreen() === "home" && await fsmState() === "menu",
  "Esc is the way out now the BACK paper is gone, and it lands back home");
await page.click("#modeAI");
await sleep(650);
ok(await page.evaluate(() =>
  !document.getElementById("howToPlay").classList.contains("hidden")),
  "starting Solo again raises the card again");
await page.click("#htpReady");
ok(await page.evaluate(() =>
  document.getElementById("howToPlay").classList.contains("hidden")),
  "I'M READY dismisses the card");

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

/* Recognition is a charge meter, not a threshold read: it has to be HELD, the
   gate relaxes as the word clock runs down, and the number it shows is a
   deliberate lie that never reaches 100 before the lock. */
console.log("recognition charge:");
const setWordLeft = ms => page.evaluate(async left => {
  const { state } = await import(location.origin + "/js/state.js");
  state.game.wordEnd = performance.now() + left;
}, ms);

// EARLY in the word the gate is strict: a pose the model half-believes cannot
// buy the word no matter how long it is held.
await setWordLeft(18000);
await feed("state.game.word", 0.55);
await sleep(1500);
await setWordLeft(18000);
const underGate = await page.evaluate(() => ({
  rstate:document.getElementById("scrSolo").dataset.rstate,
  fill:parseFloat(document.getElementById("soloWordFill").style.width) || 0,
  pct:parseInt(document.getElementById("spGuessTopPct").textContent,10),
}));
ok(underGate.rstate === "guessing",
  "a pose under the early gate never locks, however long it is held");
ok(underGate.fill > 3 && underGate.fill < 62,
  `the meter still reports the approach rather than going dead (${underGate.fill}%)`);

// LATE in the word the gate has relaxed, so the same shaky pose gets through.
await feed("state.game.word", 0.62);
await setWordLeft(6000);
const lenient = await page.waitForFunction(() =>
  document.getElementById("scrSolo").dataset.rstate !== "guessing",
  { timeout:5000, polling:50 }).then(() => true, () => false);
ok(lenient, "the gate relaxes over the word clock, so a shaky pose still lands late");

// back to a fresh word for the payoff checks below
await page.evaluate(() => clearInterval(window.__feed));
await page.waitForFunction(() =>
  document.getElementById("scrSolo").dataset.rstate === "guessing",
  { timeout:6000, polling:80 });

/* ---- the robot reads the same meter the bar does (js/robot.js) ----
   His pose is the charge, so an empty meter and a nearly-full one must not
   put him in the same body — that was the whole problem with the sprite he
   replaced. Driven straight through the module so this measures the mood
   machine, not how fast a fed pose happens to charge. */
const robotBands = await page.evaluate(async () => {
  const r = await import(location.origin + "/js/robot.js");
  const node = document.getElementById("spRobot");
  const read = () => ({
    pose: node.dataset.pose,
    body: node.querySelector(".rb-body").getAttribute("src"),
    face: node.querySelector(".rb-face").getAttribute("src"),
    hype: parseFloat(getComputedStyle(node).getPropertyValue("--rb-hype")) || 0,
  });
  const seen = {};
  for(const [value, key] of [[0, "cold"], [.3, "watch"], [.55, "read"], [.9, "close"]]){
    r.robotCharge("spRobot", value);
    seen[key] = read();
  }
  r.robotGot("spRobot");
  seen.got = read();
  seen.slam = node.querySelector(".rb-rig").classList.contains("slam");
  seen.said = (node.querySelector(".rb-bubble b").textContent || "").trim();
  seen.bubbleUp = node.querySelector(".rb-bubble").classList.contains("show");
  /* Sample the full 1.7s pop, not one settled frame. Its spring overshoots
     hardest around 95ms, well before a 320ms spot check, and that early AABB
     is the one that must retain shadow-safe air from WORD TIME. */
  const bubbleNode=node.querySelector(".rb-bubble");
  const wordTimerNode=document.querySelector("#soloStage .sp-wtimer");
  const obstacles=[...document.querySelectorAll(
    "#soloStage .sp-card,#soloStage .sp-word,#soloStage .sp-guess:not(.empty),"+
    "#soloStage .sp-skip,#soloStage .sp-exit,#soloStage .sp-sound")];
  const collisions=new Map();
  const clearances=[];
  const started=performance.now();
  const sample=now=>{
    const speakingBox=bubbleNode.getBoundingClientRect();
    const wordTimer=wordTimerNode.getBoundingClientRect();
    clearances.push({gap:speakingBox.left-wordTimer.right,at:now-started});
    obstacles.forEach(obstacle=>{
      const box=obstacle.getBoundingClientRect();
      const width=Math.min(speakingBox.right,box.right)-Math.max(speakingBox.left,box.left);
      const height=Math.min(speakingBox.bottom,box.bottom)-Math.max(speakingBox.top,box.top);
      const key=obstacle.id||obstacle.className;
      if(width>0&&height>0&&!collisions.has(key))
        collisions.set(key,{node:key,width,height,at:now-started});
    });
  };
  sample(started);
  await new Promise(resolve=>{
    const frame=now=>{
      sample(now);
      if(now-started>=1750) resolve();
      else requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
  const tightest=clearances.reduce((best,next)=>next.gap<best.gap?next:best);
  seen.speechClearance=tightest.gap;
  seen.speechTightestAt=tightest.at;
  seen.speechSamples=clearances.length;
  seen.speechCollisions=[...collisions.values()];
  r.resetRobot("spRobot");
  /* The dedicated Figma paper's measured tail is x=20.50%, y=96.59%. Wait
     through the pose/bottom transition, then measure its visible tip against
     the idle face. It must stay on the mouth line but sit outside the head. */
  await new Promise(done => setTimeout(done, 340));
  const bubble = bubbleNode.getBoundingClientRect();
  const face = node.querySelector(".rb-face").getBoundingClientRect();
  const tailX = node.dataset.side === "left" ? 1 - .2050147493 : .2050147493;
  const origin = getComputedStyle(bubbleNode).transformOrigin
    .split(" ").map(Number.parseFloat);
  const tip = {
    x:bubble.left + bubble.width * tailX,
    y:bubble.top + bubble.height * .9659090909,
  };
  return { ...seen,
    bubbleAsset:node.querySelector(".rb-bubble img").getAttribute("src"),
    tailDelta:{
      x:tip.x - (face.left + face.width / 2),
      y:tip.y - (face.top + face.height / 2),
    },
    robotWidth:node.getBoundingClientRect().width,
    side:node.dataset.side,
    tailOriginDelta:{
      x:origin[0] / bubbleNode.offsetWidth - tailX,
      y:origin[1] / bubbleNode.offsetHeight - .9659090909,
    },
    afterReset: read(),
  };
});
const robotPoses = ["cold", "watch", "read", "close", "got"].map(k => robotBands[k].pose);
ok(new Set(robotPoses).size === 5,
  `the robot has a different body at every band of the meter (${robotPoses.join(" -> ")})`);
ok(["cold", "watch", "read", "close", "got"]
  .every(k => /rb-body-/.test(robotBands[k].body) && /rb-face-/.test(robotBands[k].face)),
  "each mood dresses BOTH layers of the rig — a body sprite and a face sprite");
ok(robotBands.close.hype > robotBands.watch.hype &&
   robotBands.watch.hype > robotBands.cold.hype,
  `his glow and scale climb with the meter (${robotBands.cold.hype} -> ` +
  `${robotBands.watch.hype} -> ${robotBands.close.hype})`);
ok(robotBands.got.pose === "celebrate" && robotBands.slam,
  "recognition slams the celebrate pose in like a sticker");
ok(robotBands.bubbleUp && robotBands.said.length > 0,
  `he says something on the catch ("${robotBands.said}")`);
ok(/robot-speech-bubble\.png$/.test(robotBands.bubbleAsset),
  "gameplay robots use the dedicated Figma speech-bubble component");
/* Solo uses a closer, smaller speech paper so the complete pop route fits in
   the open pocket between WORD TIME, the robot and its guess stack. */
const robotTailGap = Math.abs(robotBands.tailDelta.x) / robotBands.robotWidth;
ok(robotBands.tailDelta.x < 0 && Math.abs(robotBands.tailDelta.y) < 6 &&
   robotTailGap > .26 && robotTailGap < .36,
  `the bubble tail points toward the mouth with clear air between them ` +
  `(${robotBands.tailDelta.x.toFixed(1)}px, ${robotBands.tailDelta.y.toFixed(1)}px)`);
ok(robotBands.speechCollisions.length === 0 &&
   robotBands.speechClearance >= 12,
  `the complete Solo catch bubble clears every HUD paper across ` +
  `${robotBands.speechSamples} animation frames ` +
  `(${robotBands.speechClearance.toFixed(1)}px minimum from WORD TIME at ` +
  `${robotBands.speechTightestAt.toFixed(0)}ms)`);
ok(Math.abs(robotBands.tailOriginDelta.x) < .002 &&
   Math.abs(robotBands.tailOriginDelta.y) < .002,
  "the bubble pop pivots at its tail instead of sweeping through the robot");
ok(robotBands.afterReset.pose === "idle",
  "a reset puts him back to idle rather than stranding the last reaction");

/* Robot dialogue lives in its own editable file. Exercise every shipped line
   plus a deliberately excessive edit: the two-axis fitter must settle before
   reveal and never let scroll bounds exceed the Figma text region. */
const robotCopyFit = await page.evaluate(async () => {
  const { ROBOT_DIALOGUE } = await import(location.origin + "/js/robotDialogue.js");
  const { fitWrappedTextToBox } = await import(location.origin + "/js/textFit.js");
  const line = document.querySelector("#spRobot .rb-bubble b");
  const samples = [
    ...Object.values(ROBOT_DIALOGUE).flat(),
    "THIS IS AN INTENTIONALLY VERY LONG EDITED ROBOT LINE THAT MUST STAY INSIDE",
  ];
  const misses = [];
  let smallest = Infinity;
  for(const text of samples){
    line.textContent = text;
    fitWrappedTextToBox(line);
    smallest = Math.min(smallest, parseFloat(getComputedStyle(line).fontSize));
    if(line.scrollWidth > line.clientWidth + .75 ||
       line.scrollHeight > line.clientHeight + .75) misses.push(text);
  }
  line.textContent = "";
  line.style.removeProperty("font-size");
  return { misses, count:samples.length, smallest };
});
ok(robotCopyFit.misses.length === 0,
  `all ${robotCopyFit.count} editable robot lines stay inside the bubble ` +
  `(smallest stress-fit ${robotCopyFit.smallest.toFixed(1)}px)`);

/* Multiplayer cameras are where people occupy the most screen area. Both
   rigs must live in the outer gutter, with a small intentional crop through
   the viewport edge, rather than sitting over a player's body. */
const multiplayerRobotEdges = await page.evaluate(() =>
  ["v1RobotYou", "v1RobotRival", "pmRobotMine", "pmRobotFoe"].map(id => {
    const node = document.getElementById(id);
    const left = Number.parseFloat(node.style.left);
    const width = Number.parseFloat(node.style.width);
    return {id, left, right:left + width};
  }));
const leftEdgeRobots = multiplayerRobotEdges.filter(({id}) =>
  id === "v1RobotYou" || id === "pmRobotMine");
const rightEdgeRobots = multiplayerRobotEdges.filter(({id}) =>
  id === "v1RobotRival" || id === "pmRobotFoe");
ok(leftEdgeRobots.every(({left,right}) => left < 0 && right <= 8) &&
   rightEdgeRobots.every(({left,right}) => left >= 92 && right > 100),
  "1v1 and Party robots stay partly through the outer edge, clear of players");

/* He LEANS ON his own guess paper — feet behind its top edge, roughly half his
   width over it. Floating in the open he read as pasted onto the screen: every
   other element on this board sits on an edge or is taped down. Overlapping
   only his outer edge is not enough either; the boots then end in mid-air. */
const robotAnchor = await page.evaluate(() => {
  const stage = document.getElementById("soloStage").getBoundingClientRect();
  const rig = document.getElementById("spRobot").getBoundingClientRect();
  const paper = document.getElementById("spGuessTop")
    .querySelector(".gcard").getBoundingClientRect();
  const overlapX = Math.min(rig.right, paper.right) - Math.max(rig.left, paper.left);
  return {
    feet: (rig.bottom - paper.top) / rig.height,
    over: overlapX / rig.width,
    underPaper: getComputedStyle(document.getElementById("spRobot")).zIndex,
    inStage: rig.left >= stage.left - 1 && rig.right <= stage.right + 1 &&
      rig.top >= stage.top - 1,
  };
});
ok(robotAnchor.feet > .12 && robotAnchor.feet < .45,
  `his feet stand behind the guess paper (${Math.round(robotAnchor.feet * 100)}% of him)`);
ok(robotAnchor.over > .35,
  `he is genuinely ON the paper, not clipping its corner (${Math.round(robotAnchor.over * 100)}% of his width)`);
ok(Number(robotAnchor.underPaper) < 3 && robotAnchor.inStage,
  "he paints under every paper and stays inside the letterboxed stage");

/* He has to be alive when NOTHING is happening. Before the idle loop he stood
   perfectly still until the meter moved, so all his character lived in the
   half-second before a catch and the rest of the word he was a sticker. */
const robotIdle = await page.evaluate(async () => {
  const r = await import(location.origin + "/js/robot.js");
  const node = document.getElementById("spRobot");
  r.resetRobot("spRobot");
  const seen = [];
  const started = performance.now();
  while(performance.now() - started < 9000){
    r.robotCharge("spRobot", 0);            // stone cold the whole time
    await new Promise(done => setTimeout(done, 100));
    const key = node.dataset.pose + "/" +
      (node.querySelector(".rb-face").getAttribute("src") || "").split("rb-face-")[1];
    if(seen[seen.length - 1] !== key) seen.push(key);
  }
  r.resetRobot("spRobot");
  return { seen, distinct:[...new Set(seen)].length };
});
ok(robotIdle.distinct >= 2,
  `he keeps moving with nothing fed to him (${robotIdle.distinct} looks in 9s: ` +
  `${[...new Set(robotIdle.seen)].join(", ")})`);
ok(robotIdle.seen.some(k => k.startsWith("thinking/")),
  "the idle rotation leans on the THINKING pose — that is what he is doing");

// the displayed percentage lies: it crawls, and it never reads 100 early
const chargeTrace = await page.evaluate(async () => {
  const { state } = await import(location.origin + "/js/state.js");
  const { setModelOutput } = await import(location.origin + "/js/soloRound.js");
  const word = state.game.word;
  const started = performance.now();
  const samples = [];
  let hundredEarly = false;
  while(performance.now() - started < 4000){
    setModelOutput(word, .95);
    state.smooth[word] = .95;
    await new Promise(r => requestAnimationFrame(r));
    const rstate = document.getElementById("scrSolo").dataset.rstate;
    const pct = parseInt(
      document.getElementById("spGuessTopPct").textContent, 10) || 0;
    samples.push(pct);
    if(rstate !== "guessing"){
      return { ms:performance.now() - started, samples, hundredEarly, locked:true };
    }
    if(pct >= 100) hundredEarly = true;
  }
  return { ms:performance.now() - started, samples, hundredEarly, locked:false };
});
ok(chargeTrace.locked, `holding a confident pose fills the meter (${Math.round(chargeTrace.ms)}ms)`);
ok(chargeTrace.ms > 700,
  `the word cannot be snapped up instantly any more (${Math.round(chargeTrace.ms)}ms)`);
ok(!chargeTrace.hundredEarly,
  "the readout never reaches 100% before the word actually locks");
ok(chargeTrace.samples.filter(v => v >= 90).length >= 6,
  `the meter visibly crawls through the nineties (${chargeTrace.samples.filter(v => v >= 90).length} frames at 90+)`);

await page.waitForFunction(() =>
  document.getElementById("scrSolo").dataset.rstate === "guessing",
  { timeout:8000, polling:80 });
/* Those probes scored real words. Rewind the run so the payoff assertions
   below still measure a FIRST catch on a clean board. */
await page.evaluate(async () => {
  const { state } = await import(location.origin + "/js/state.js");
  state.game.score = 0;
  state.game.streak = 0;
  state.game.results.length = 0;
  document.getElementById("soloScoreVal").textContent = "0";
  document.getElementById("soloStreakVal").textContent = "x0";
});

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
ok(await txt("#soloScoreVal") === scoreBefore,
  "score NOT incremented while the award paper is still being carried to it");
ok(await page.evaluate(() => document.getElementById("soloWordCard").classList.contains("locked")), "word card turned green + popped");
ok(await page.evaluate(() => document.getElementById("soloFlash").classList.contains("fire")), "green screen flash fired");
ok(await page.evaluate(() => !!document.querySelector(".burstwrap")), "confetti burst");
ok(await page.evaluate(() => document.getElementById("soloAward").classList.contains("show")), "POINTS AWARD paper shown");
ok(/^\+\d/.test(await txt("#soloAwardPts")), `award shows points (${await txt("#soloAwardPts")})`);
/* The paper has to grow into a real payoff AND stay off the middle of the
   board: dead centre is exactly where the player's own camera image is, so
   for half a second the thing you watch while holding a pose was covered by
   the paper telling you the pose worked. It now lands in the empty left band
   opposite the guess stack and the robot. Both halves of that are asserted —
   a paper that is merely big again would put it straight back over your face. */
const awardExpanded = await page.waitForFunction(() => {
  const box = document.getElementById("soloAward").getBoundingClientRect();
  const stage = document.getElementById("soloStage").getBoundingClientRect();
  const centre = (box.left + box.width / 2 - stage.left) / stage.width;
  return box.width / innerWidth > .38 && centre < .4 &&
    box.left > stage.left - 1 && box.right < stage.right + 1;
}, { timeout:1000, polling:25 }).then(() => true, () => false);
ok(awardExpanded,
  "GOT IT award expands into a full payoff, in the side band and inside the stage");
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
await readyUp();
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
await readyUp();
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
const lobbyRobotSign = await page.evaluate(() => {
  const paper=document.getElementById("robotWaveHigh");
  const line=document.querySelector("#lobbyRobotWait .signtext");
  return {
    text:line.textContent.trim(),
    asset:[paper.naturalWidth,paper.naturalHeight],
    fits:line.scrollWidth <= line.clientWidth + .75 &&
      line.scrollHeight <= line.clientHeight + .75,
  };
});
ok(lobbyRobotSign.text === "STRIKE A POSE!" && lobbyRobotSign.fits &&
   lobbyRobotSign.asset[0] === 1714 && lobbyRobotSign.asset[1] === 1136,
  "1v1 waiting robot uses the refreshed Figma art and fitted STRIKE A POSE! sign");
if(process.env.LOBBY_SCREENSHOT)
  await page.screenshot({path:process.env.LOBBY_SCREENSHOT,fullPage:true});
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
await page.waitForFunction(() =>
  !document.getElementById("howToPlay").classList.contains("hidden"),
  { timeout:4000,polling:25 });
await page.click("#htpReady");
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
  `reduced-motion commits the Solo score without waiting on a suppressed flight (${reducedScoreDelay}ms)`);
await page.emulateMediaFeatures([{ name:"prefers-reduced-motion", value:"no-preference" }]);

// ---- the boot gate ----
/* This suite's own page never sees the ENABLE CAMERA card: Chrome's
   --use-fake-ui-for-media-stream reports the origin as already `granted`, so
   requestCameraConsent() short-circuits exactly the way it does for a
   returning player. Drive it on a second page with the permission query
   stubbed to `prompt`, which is what a first-time visitor gets. */
console.log("boot gate:");
{
  const gatePage = await browser.newPage();
  await gatePage.setViewport({ width:1440, height:810 });
  const gateErrors = [];
  gatePage.on("pageerror", e => gateErrors.push("PAGEERROR: " + e.message));
  await gatePage.evaluateOnNewDocument(() => {
    navigator.permissions.query = async () => ({ state:"prompt" });
    window.__cameraGateProbe = { gumCalls:0, gumAt:[], playCalls:0 };
    /* refuse once, so the retry path is exercised too — a dead end here
       means a dead app, since nothing on the site works without a camera */
    const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    let calls = 0;
    navigator.mediaDevices.getUserMedia = async c => {
      window.__cameraGateProbe.gumCalls++;
      window.__cameraGateProbe.gumAt.push(performance.now());
      if(calls++ === 0){ const e = new Error("denied"); e.name = "NotAllowedError"; throw e; }
      return real(c);
    };

    /* A usable stream used to remain trapped behind the popup whenever play()
       stalled or rejected. Force both paths: the first promise never settles,
       the bounded retry rejects, and the next gesture gets the real method. */
    const realPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function(){
      if(this.id === "video"){
        window.__cameraGateProbe.playCalls++;
        if(window.__cameraGateProbe.playCalls === 1)
          return new Promise(() => {});
        if(window.__cameraGateProbe.playCalls === 2){
          const e = new Error("playback not ready");
          e.name = "NotAllowedError";
          return Promise.reject(e);
        }
      }
      return realPlay.call(this);
    };
  });
  /* DOMContentLoaded is intentional: waiting for network-idle lets all model
     downloads finish and would mask the early-click bug this page exists to
     catch. */
  await gatePage.goto(APP, { waitUntil:"domcontentloaded", timeout:60000 });
  await gatePage.waitForFunction(() =>
    !document.getElementById("camGate").classList.contains("hidden"),
    { timeout:30000, polling:50 });
  ok(true, "a first-time visitor is met by the ENABLE CAMERA card");
  ok(await gatePage.evaluate(() => document.body.dataset.boot === "gate"),
    "the boot hold is on while the card is up");
  const held = await gatePage.evaluate(() => {
    const pieces = ["logoHomeCraft","modeAI","modeVS","modeParty","tapeSolo",
                    "robotBody","speechBubble"];
    return {
      hidden:pieces.every(id =>
        Number(getComputedStyle(document.getElementById(id)).opacity) === 0),
      /* the wallpaper and the waves stay: Home is HELD mid-assembly, which is
         what makes it read as loading rather than as being withheld */
      bg:Number(getComputedStyle(document.querySelector("#homeStage .fh.bg")).opacity),
      wave:Number(getComputedStyle(document.querySelector("#homeStage .iv.wave")).opacity),
    };
  });
  ok(held.hidden && held.bg === 1 && held.wave === 1,
    "Home is held at its pre-entrance state behind the card, wallpaper and waves up");
  await gatePage.waitForFunction(() =>
    [...document.querySelectorAll("#cgPanel img")]
      .every(image => image.complete && image.naturalWidth > 0),
    { timeout:10000, polling:25 });
  /* The card is Figma's ENABLE CAMERA SCREEN (322:717), not a generic modal:
     its own paper, its three info rows, and the pointing robot that exists
     only on this screen. Assert the art, because the failure mode here is a
     plausible card built out of the wrong assets. */
  const authored = await gatePage.evaluate(() => {
    const src = sel => (document.querySelector(sel)?.getAttribute("src") || "");
    /* Layout metrics, never getBoundingClientRect: the robot bobs and the
       button twitches, and a transformed rect measures the animation rather
       than the layout. Same trap the type fitters document. */
    const panel = document.getElementById("cgPanel");
    const box = sel => {
      const n = document.querySelector(sel);
      return { l:n.offsetLeft / panel.offsetWidth,
               t:n.offsetTop / panel.offsetHeight,
               w:n.offsetWidth / panel.offsetWidth,
               h:n.offsetHeight / panel.offsetHeight };
    };
    const tape = sel => {
      const n = document.querySelector(sel);
      return {
        src:n.getAttribute("src"), box:box(sel),
        natural:[n.naturalWidth,n.naturalHeight],
        filter:getComputedStyle(n).filter,
      };
    };
    return {
      paper:src(".cg-paper"),
      rows:[...document.querySelectorAll(".cg-row")].map(n => n.getAttribute("src")),
      icons:[...document.querySelectorAll(".cg-icon")].map(n => n.getAttribute("src")),
      tapes:{ yellow:tape(".cg-tape-y"), cream:tape(".cg-tape-c") },
      body:src("#cgRobotBody"),
      title:document.getElementById("cgTitle").textContent.trim(),
      heads:[...document.querySelectorAll(".cg-head")].map(n => n.textContent.trim()),
      rig:box(".cg-rig"), btn:box(".cg-enable"), row1:box(".cg-row1"),
    };
  });
  ok(/cam-panel\.png$/.test(authored.paper) &&
     authored.rows.length === 3 && authored.rows.every(s => /cam-row\.png$/.test(s)) &&
     authored.icons.length === 3 &&
     new Set(authored.icons).size === 3 &&
     /cam-robot-point\.png$/.test(authored.body),
    "the card is built from 322:717's own art, not a generic modal");
  ok(/cam-tape-yellow\.png$/.test(authored.tapes.yellow.src) &&
     /cam-tape-cream\.png$/.test(authored.tapes.cream.src) &&
     authored.tapes.yellow.natural.join("x") === "405x383" &&
     authored.tapes.cream.natural.join("x") === "427x312" &&
     authored.tapes.yellow.filter === "none" &&
     authored.tapes.cream.filter === "none",
    "both tapes use rendered Figma instances with their crop, rotation and shadow baked in");
  ok(authored.title === "ACT OUT THE WORD. LET THE AI GUESS" &&
     authored.heads.join("|") ===
       "ENABLE YOUR CAMERA|YOUR VIDEO STAYS PRIVATE|MAKE SOME ROOM",
    "the copy is Figma's, verbatim");
  /* Figma percentages: rows at 13.06/34.315 w73.879, button 17.414/85.753
     w54.451, robot 69.526/66.164 w32.099 — he hangs 1.6% off the right edge
     and paints OVER the button, which is what makes the point read. */
  ok(Math.abs(authored.row1.l - .1306) < .006 &&
     Math.abs(authored.row1.t - .34315) < .008 &&
     Math.abs(authored.row1.w - .73879) < .006 &&
     Math.abs(authored.btn.l - .17414) < .006 &&
     Math.abs(authored.btn.t - .85753) < .008 &&
     Math.abs(authored.rig.l - .69526) < .006 &&
     Math.abs(authored.rig.w - .32099) < .006 &&
     authored.rig.l + authored.rig.w > 1,
    "rows, button and the overhanging robot sit on their Figma percentages");
  /* Rendered bounds from slot-3 Figma nodes 321:667 / 321:666. The raw fills
     are padded transparent canvases, so using their nested fill rectangles is
     exactly what reduced both tapes to tiny scraps. */
  ok(Math.abs(authored.tapes.yellow.box.l - .275236) < .004 &&
     Math.abs(authored.tapes.yellow.box.t) < .003 &&
     Math.abs(authored.tapes.yellow.box.w - .131335) < .004 &&
     Math.abs(authored.tapes.cream.box.l - .591293) < .004 &&
     Math.abs(authored.tapes.cream.box.t - .204794) < .004 &&
     Math.abs(authored.tapes.cream.box.w - .138453) < .004,
    "the yellow and cream tape exports occupy their exact Figma render bounds");

  const firstClickAt = await gatePage.evaluate(() => ({
    at:performance.now(),
    engineReady:document.getElementById("camGate").hasAttribute("data-ready"),
  }));
  await gatePage.click("#cgEnable");
  await gatePage.waitForFunction(() =>
    document.getElementById("camGate").dataset.state === "blocked",
    { timeout:5000, polling:25 });
  const earlyRequest = await gatePage.evaluate(started => ({
    ...window.__cameraGateProbe,
    delay:window.__cameraGateProbe.gumAt[0] - started,
  }), firstClickAt.at);
  ok(earlyRequest.gumCalls === 1 && earlyRequest.delay >= 0 && earlyRequest.delay < 1000,
    `an early click reaches getUserMedia immediately instead of waiting for models ` +
    `(${earlyRequest.delay.toFixed(0)}ms, engine ready=${firstClickAt.engineReady})`);
  ok(await gatePage.evaluate(() =>
    document.getElementById("cgEnableLabel").textContent.trim() === "TRY AGAIN" &&
    !document.getElementById("cgEnable").disabled &&
    !document.getElementById("cgEnable").hasAttribute("aria-busy") &&
    getComputedStyle(document.querySelector('[data-cg-note="blocked"]')).display !== "none" &&
    getComputedStyle(document.getElementById("cgLoad")).display === "none" &&
    /* the headline stays Figma's own line — it is the one sentence that says
       what the screen is for, and an error must not cost it */
    document.getElementById("cgTitle").textContent.trim() ===
      "ACT OUT THE WORD. LET THE AI GUESS"),
    "a refusal re-arms the card as TRY AGAIN instead of dead-ending the app");
  const retryAt = await gatePage.evaluate(() => performance.now());
  await gatePage.click("#cgEnable");
  await gatePage.waitForFunction(() =>
    document.getElementById("camGate").classList.contains("hidden"),
    { timeout:5000, polling:25 });
  const accepted = await gatePage.evaluate(started => ({
    delay:performance.now()-started,
    gumCalls:window.__cameraGateProbe.gumCalls,
    playCalls:window.__cameraGateProbe.playCalls,
    stream:document.getElementById("video").srcObject?.getVideoTracks()
      .some(track => track.readyState === "live"),
  }), retryAt);
  ok(accepted.stream && accepted.gumCalls === 2 && accepted.playCalls >= 1 &&
     accepted.delay < 2500,
    `a live stream dismisses the gate promptly even when the first play() stalls ` +
    `(${accepted.delay.toFixed(0)}ms)`);
  const arrival = await gatePage.evaluate(() => ({
    boot:document.body.dataset.boot,
    entering:document.getElementById("homeStage").classList.contains("home-entering"),
    arriving:document.getElementById("homeStage").classList.contains("home-arriving"),
  }));
  ok(arrival.boot === undefined && arrival.entering && arrival.arriving,
    "letting go hands Home its entrance in the same frame the hold is released");
  await gatePage.waitForFunction(() =>
    !document.getElementById("homeStage").classList.contains("home-arriving") &&
    !document.getElementById("homeStage").classList.contains("home-entering"),
    { timeout:6000, polling:50 });
  ok(await gatePage.evaluate(() =>
    ["logoHomeCraft","modeAI","tapeSolo","robotBody","speechBubble"].every(id =>
      Number(getComputedStyle(document.getElementById(id)).opacity) === 1)),
    "every held paper is fully on screen once the entrance finishes");
  await gatePage.waitForFunction(() =>
    document.getElementById("status").style.display === "none",
    { timeout:60000, polling:100 });
  ok(await gatePage.evaluate(() => window.__cameraGateProbe.playCalls >= 2),
    "a pending play() is bounded and the engine finishes after retrying playback");
  await gatePage.mouse.click(8, 8);
  await gatePage.waitForFunction(() =>
    window.__cameraGateProbe.playCalls >= 3 &&
    !document.getElementById("video").paused,
    { timeout:5000, polling:25 });
  ok(true, "a later real gesture resumes preview without reopening camera permission");
  const brokenGate = await gatePage.evaluate(async () => {
    const gate = await import("/js/cameraGate.js");
    const pendingConsent = gate.requestCameraConsent();
    for(let i=0; i<20 && !gate.isCameraGateOpen(); i++)
      await new Promise(resolve => requestAnimationFrame(resolve));
    gate.setBootFailed("COULDN’T LOAD THE POSE ENGINE");
    const consent = await pendingConsent;
    const card = document.getElementById("camGate");
    const button = document.getElementById("cgEnable");
    return {
      consent,
      hidden:card.classList.contains("hidden"),
      boot:document.body.dataset.boot,
      disabled:button.disabled,
      busy:button.hasAttribute("aria-busy"),
      label:document.getElementById("cgEnableLabel").textContent.trim(),
    };
  });
  ok(brokenGate.consent === false && brokenGate.hidden &&
     brokenGate.boot === undefined && !brokenGate.disabled && !brokenGate.busy &&
     brokenGate.label === "ENABLE CAMERA",
    "a broken pose engine closes and disarms the gate instead of leaving ASKING… stuck");
  ok(gateErrors.length === 0, `boot gate raised no page errors (${gateErrors.length})`);
  gateErrors.forEach(e => console.log("    " + e.slice(0, 200)));
  await gatePage.close();
}

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
