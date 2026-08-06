/* Solo-round mechanic for the Figma "Singe player" HUD.

   The Word card's yellow pill is a PROGRESS BAR driven by the smoothed
   confidence for the round's TARGET word. It completes exactly at the lock
   point; the card shakes harder as it closes in. Separately, the bottom-
   right guess stack is a rolling history of the AI's live top guess —
   newest pops into the green top slot, older ones fade down through blue
   then purple.

   All model output funnels through setModelOutput(label, confidence) (the
   current top guess, for the stack). The target-word fill reads the app's
   smoothed scores (state.smooth[target]) each animation frame — same
   funnelled model output, just the target's channel.

   Round state machine (elements render off #scrSolo[data-rstate] only):
     IDLE → GUESSING → HITSTOP → LOCKED → ROUND_END
   plus the failure edge GUESSING → ROUND_END (timeout/skip: no payoff).

   Lock-on payoff, in order: hitstop → word turns green/pops → green screen
   flash → confetti from the word → the POINTS AWARD paper lands centre-stage,
   holds, and is then DRAGGED into the Score card, where the number goes up as
   it arrives → ROUND_END. */

import { $ } from "./dom.js";
import { state } from "./state.js";
import { blip } from "./audio.js";
import { showTimesUp } from "./ui.js";
import { SOLO } from "./constants.js";
import { calculateFirstPoints } from "./scoring.js";
import {
  RECOGNITION_IMPACT_MS,
  RECOGNITION_FILL_MIN,
  RECOGNITION_FILL_MAX,
  GUESS_LABEL_DEBOUNCE_MS,
  WARM_AT, HOT_AT, CRITICAL_AT,
  createGuessHistory, resetGuessHistory, updateGuessHistory,
  restartFeedbackAnimation, markGuessRecognized,
  setWordRecognitionMotion, prepareWordFeedback,
  playWordLockFeedback, playWordMissFeedback,
  fitGameplayText, prefersReducedMotion,
} from "./gameplayFeedback.js";

import { createChargeMeter, resetChargeMeter, advanceCharge,
         chargePercent } from "./recognition.js";
import { clearSeatAwards } from "./seatAward.js";
import { robotCharge, robotMiss, robotNewWord,
         resetRobot, resetRobots } from "./robot.js";

export { setWordRecognitionMotion } from "./gameplayFeedback.js";

/* ---------------- tuning (against real model logs) ---------------- */
/* The lock is no longer "confidence crossed a line": it is a charge earned by
   HOLDING the pose above a gate that relaxes across the word clock (see
   recognition.js). This constant is now purely the scale the word card's
   shake curve is read against — full charge is full urgency. */
export const LOCK_THRESHOLD    = 1;
export const LABEL_DEBOUNCE_MS = GUESS_LABEL_DEBOUNCE_MS;
export { WARM_AT, HOT_AT, CRITICAL_AT };
export const HITSTOP_MS        = RECOGNITION_IMPACT_MS;
/* The payoff used to be two disconnected events: a paper that popped centre
   screen and faded out over 1.85s, and — under it, unrelated — a small yellow
   chip that flew to the score card. Nobody read the chip; the paper read as a
   flash. Now there is ONE object. The award paper is the points: it lands, it
   is held long enough to read, then it is dragged into the score card and the
   total goes up exactly as it arrives. */
export const AWARD_HOLD_MS     = 640;   // paper readable, centre stage
export const AWARD_FLIGHT_MS   = 560;   // ...then dragged into the score card
export const AWARD_MS          = AWARD_HOLD_MS + AWARD_FLIGHT_MS;
export const ROUND_END_PAUSE_MS = 1250; // linger before the next word

/* ---------------- state ---------------- */
let rstate = "idle";
let target = null;
const meter = createChargeMeter("solo");
export const soloCharge = () => meter;
let resolveCb = null;
let onLockCb = null;        // fires the instant the pose is recognised

/* The shared history owns admission timing; Solo renders three entries. */
const guessHistory = createGuessHistory(3);

let rafId = null;
const el = id => $(id);

function setState(s){
  rstate = s;
  const scr = el("scrSolo");
  if(scr) scr.dataset.rstate = s;
}
export const roundState = () => rstate;
export const timerFrozen = () => rstate !== "guessing" && rstate !== "idle";

const disp = l => (l === "idle" ? "just standing" : l).toUpperCase();

/* ---------------- model funnel (guess stack) ---------------- */
export function setModelOutput(label, confidence){
  if(rstate !== "guessing") return;
  if(typeof label !== "string" || !label) return;
  const update = updateGuessHistory(guessHistory, label, confidence);
  if(update.committed) renderStack(update.changed);
}

function renderStack(popped){
  const slots = [
    { box: "spGuessTop", lab: "spGuessTopLabel", pct: "spGuessTopPct" },
    { box: "spGuessMid", lab: "spGuessMidLabel", pct: "spGuessMidPct" },
    { box: "spGuessBot", lab: "spGuessBotLabel", pct: "spGuessBotPct" },
  ];
  slots.forEach((s, i) => {
    const box = el(s.box), lab = el(s.lab), pct = el(s.pct);
    const entry = guessHistory.items[i];
    if(!box || !lab || !pct) return;
    if(entry){
      box.classList.remove("empty");
      lab.textContent = disp(entry.label) + (entry.locked ? "" : "?");
      /* the top slot showing the TARGET reports charge, not raw confidence */
      const live = i === 0 && !entry.locked && entry.label === target &&
        rstate === "guessing";
      pct.textContent = (live ? chargePercent(meter)
        : Math.round(entry.pct * 100)) + "%";
      fitGameplayText(lab);
    }else{
      box.classList.add("empty");
      box.classList.remove("recognized");
      lab.textContent = "";
      pct.textContent = "";
    }
  });
  if(popped){
    const top = el("spGuessTop");
    restartFeedbackAnimation(top, "pop");
    for(const id of ["spGuessMid", "spGuessBot"]){
      restartFeedbackAnimation(el(id), "shift");
    }
    blip([494, 622], 0.045);
  }
}

/* ---------------- per-frame: the word progress bar ---------------- */
function frame(){
  rafId = requestAnimationFrame(frame);
  if(rstate !== "guessing") return;

  /* Do not let the target channel get ahead of the visible robot. A target
     can already have confidence while another debounced label is still on
     the paper; its bar and lock begin only once that target paper pops in. */
  const targetIsDisplayed = !!target && guessHistory.items[0]?.label === target;
  const raw = targetIsDisplayed ? (state.smooth?.[target] || 0) : 0;
  advanceCharge(meter, raw, wordElapsedFrac());

  const fillEl = el("soloWordFill");
  if(fillEl) fillEl.style.width = (RECOGNITION_FILL_MIN +
    meter.display * (RECOGNITION_FILL_MAX - RECOGNITION_FILL_MIN)) + "%";

  const card = el("soloWordCard");
  setWordRecognitionMotion(card, meter.display, LOCK_THRESHOLD, true);
  /* The robot reads the same number the bar does, so his pose, his glow and
     the fill can never tell you different things about the same pose. */
  robotCharge("spRobot", meter.display, meter.locked);
  /* The percentage on the robot's paper reports PROGRESS, not the classifier's
     raw opinion — otherwise the number and the bar disagree about how close
     you are, and the number is the one the player believes. */
  if(targetIsDisplayed){
    const pct = el("spGuessTopPct");
    if(pct) pct.textContent = chargePercent(meter) + "%";
  }

  if(meter.locked) beginLock();
}

/* How far through the word clock we are — the meter uses it to relax. */
function wordElapsedFrac(){
  const g = state.game;
  if(!g || !g.wordEnd) return 0;
  const left = Math.max(0, g.wordEnd - performance.now());
  return Math.max(0, Math.min(1, 1 - left / SOLO.wordMs));
}

/* ---------------- lock payoff ---------------- */
function beginLock(){
  if(state.game?.mode==="ai")
    state.game.pendingPts=calculateFirstPoints(
      state.game.wordEnd-performance.now(),SOLO.wordMs);
  setState("hitstop");                 // freezes the game timers (timerFrozen)
  meter.locked = true;
  const card = el("soloWordCard");
  const fillEl = el("soloWordFill");
  updateGuessHistory(guessHistory, target || "", 1, { force:true,locked:true });
  renderStack(false);
  /* This is also what slams the robot: markGuessRecognized() is the shared
     recognition signal (see GUESS_ROBOT in gameplayFeedback.js), so the
     celebration arrives with the hitstop rather than when the paper lands —
     and there must not be a second robotGot() call next to it, or his
     "three in a row" run counts every catch twice. */
  markGuessRecognized(el("spGuessTop"));
  blip([523]);

  playWordLockFeedback({
    card,
    fill: fillEl,
    threshold: LOCK_THRESHOLD,
    impactMs: HITSTOP_MS,
    onImpact: () => {
      if(rstate !== "hitstop") return;
      setState("locked");
      /* The held pose, grabbed HERE. game.js used to capture from the chip's
         land callback — 830ms after recognition, by which time the player has
         already dropped the pose and the "funny frame" is gone. */
      onLockCb?.();
      greenFlash(card);
      confettiFrom(card, AWARD_ANCHOR);
      blip([523, 659, 784, 1047], 0.08);
      payOutSoloWord();
    },
  });
}

/* The green win wash, on whichever stage the word card belongs to. It used
   to be Solo-only: 1v1 fired ui.js's flash(), which lives INSIDE #cameraDock
   and so tinted just the local half of the split, and Party fired nothing at
   all. Same lookup confettiFrom uses, so the two always land together. */
export function greenFlash(node){
  const stage = node?.closest(".solostage,.matchstage,.pmstage");
  const f = stage?.querySelector(".sp-flash");
  if(!f) return;
  f.classList.remove("fire"); void f.offsetWidth; f.classList.add("fire");
}

/* Winning the LAST word of a run starts a ~1200ms award delivery and a 2500ms
   confetti burst, but the screen leaves for Results 1250ms later — both used
   to keep playing on top of the results papers. Every celebration registers
   here so the FSM can sweep them the moment gameplay ends. */
const liveAwards = new Set();
const liveBursts = new Set();

/* Land an award that is still in the air, exactly once. The paper is
   position:fixed at z-index 95, so one left mid-flight would otherwise sail
   across the Results screen — and any score paint it is holding would never
   be released. */
function settleAward(a){
  clearTimeout(a._awardTimer);
  a._awardTimer = null;
  a.classList.remove("show", "deliver");
  a.style.removeProperty("--fly-x");
  a.style.removeProperty("--fly-y");
  a.style.removeProperty("--fly-s");
  a.style.removeProperty("--fly-r");
  a.style.removeProperty("--fly-ms");
  const land = a._land;
  a._land = null;
  land?.();
}

export function clearCelebrations(){
  /* 1v1 and Party stamp their award on the player who earned it instead of
     centre stage (seatAward.js); those papers are fixed to the viewport for
     the same reason this one is, so they need the same sweep. */
  clearSeatAwards();
  /* A robot mid-slam, or holding a bubble, is a celebration too — leaving one
     running means the next board opens with the last word's reaction on it. */
  resetRobots();
  for(const a of [...liveAwards]) settleAward(a);
  liveAwards.clear();
  for(const wrap of liveBursts){
    clearTimeout(wrap._burstTimer);
    wrap.remove();
  }
  liveBursts.clear();
}

/* THE payoff. Solo, 1v1 and Party all call this with their own instance of
   the same Figma paper, so the asset, the timing and the motion are shared.
   `toEl` is the card that holds the score being paid into — the paper is
   physically dragged there — and `onLand` fires once, on arrival, which is
   the only moment any mode is allowed to repaint that score.
   Under reduced motion the paper is shown plainly and lands immediately:
   holding a score back for an animation nobody is playing just reads broken. */
/* Where on the STAGE the paper lands, as a fraction of the stage box.
   `position:fixed` is a viewport coordinate and every play stage letterboxes,
   so this cannot be a flat CSS percentage: at 5:4 a viewport `left:24%` is out
   in the black bar beside the board. Measured per show, which also means it
   is correct after a resize between words. */
export const AWARD_ANCHOR = Object.freeze({ x: .26, y: .5 });

function anchorAward(a, stage){
  const box = stage?.getBoundingClientRect();
  if(!box?.width){
    a.style.removeProperty("left");
    a.style.removeProperty("top");
    return;
  }
  a.style.left = (box.left + box.width * AWARD_ANCHOR.x) + "px";
  a.style.top = (box.top + box.height * AWARD_ANCHOR.y) + "px";
}

export function deliverPointsAward({
  awardId, pointsId, points = 0, toEl, onLand, stage,
} = {}){
  const a = el(awardId);
  if(!a){ onLand?.(); return; }
  anchorAward(a, stage);
  const value = el(pointsId);
  if(value){
    value.textContent = "+" + (points || 0).toLocaleString("en-US");
    fitGameplayText(value);
  }

  /* Re-entrancy: a chase can pay two players inside one word. Land whatever
     is already in the air before this paper claims the element. */
  if(liveAwards.has(a)) settleAward(a);

  const land = () => {
    liveAwards.delete(a);
    toEl?.classList.remove("awaiting");
    bumpTarget(toEl);
    onLand?.();
  };

  a.classList.remove("show", "deliver");
  void a.offsetWidth;
  a.classList.add("show");
  liveAwards.add(a);
  toEl?.classList.add("awaiting");     // braces until the paper actually lands

  if(prefersReducedMotion()){
    /* There is no flight to wait on, so pay immediately and let the paper sit
       for a readable beat. */
    land();
    a._land = null;
    a._awardTimer = setTimeout(() => {
      a._awardTimer = null;
      a.classList.remove("show");
      liveAwards.delete(a);
    }, AWARD_MS);
    liveAwards.add(a);
    return;
  }

  a._land = land;
  a._awardTimer = setTimeout(() => {
    if(!liveAwards.has(a)) return;
    aimAward(a, toEl);
    a.classList.add("deliver");
    a._awardTimer = setTimeout(() => settleAward(a), AWARD_FLIGHT_MS);
  }, AWARD_HOLD_MS);
}

/* Point the paper at the card that is about to receive the points. The paper
   is centred with translate(-50%,-50%), so the flight is a centre-to-centre
   delta plus the scale that shrinks it into the card. */
function aimAward(a, toEl){
  const from = a.getBoundingClientRect();
  const to = toEl?.getBoundingClientRect();
  if(!from.width || !to?.width) return;
  a.style.setProperty("--fly-x",
    (to.left + to.width / 2 - (from.left + from.width / 2)) + "px");
  a.style.setProperty("--fly-y",
    (to.top + to.height / 2 - (from.top + from.height / 2)) + "px");
  a.style.setProperty("--fly-s",
    Math.max(.12, Math.min(.55, (to.width * .82) / from.width)).toFixed(3));
  a.style.setProperty("--fly-r",
    (to.left + to.width / 2 < from.left + from.width / 2 ? -14 : 14) + "deg");
  a.style.setProperty("--fly-ms", AWARD_FLIGHT_MS + "ms");
}

/* Every score surface in the game reacts with the same .bump keyframe —
   .sp-card for Solo, .v1-scorecard for 1v1 and both Party team cards. */
function bumpTarget(node){
  if(!node) return;
  node.classList.remove("bump");
  void node.offsetWidth;
  node.classList.add("bump");
}

/* The win burst is real paper: the same torn confetti the home screen uses,
   thrown outward and then pulled down, rather than CSS shapes. (The previous
   particles had no styling at all and rendered invisible.) */
const CONFETTI_ART = [
  "conf-star-a.png", "conf-star-b.png", "conf-star-c.png",
  "conf-blue-a.png", "conf-blue-b.png", "conf-red-a.png", "conf-red-b.png",
];

export function confettiFrom(node, origin){
  if(matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  /* Live inside the letterboxed stage: sizes and distances scale with it,
     the bars clip it, and the award (position:fixed) stays on top — so the
     paper reads as erupting from BEHIND the card rather than under it. */
  const stage = node?.closest(".solostage,.matchstage,.pmstage");
  const host = stage || document.body;
  const box = host === document.body
    ? { width: innerWidth, height: innerHeight }
    : host.getBoundingClientRect();

  const wrap = document.createElement("div");
  wrap.className = "burstwrap";
  if(!stage) wrap.classList.add("viewport");

  /* Erupt from where the eye already is. Bursting from the word card put
     every piece in the bottom strip, where it fell straight out of frame, so
     this follows the award paper — `origin` is where that paper lands for
     modes that moved it off centre (Solo). */
  const ox = box.width * (origin?.x ?? .5), oy = box.height * (origin?.y ?? .46);
  const reach = Math.min(box.width, box.height * 1.9);
  const N = 54;

  for(let i = 0; i < N; i++){
    const p = document.createElement("i");
    /* full fan, biased upward so the arc has somewhere to go */
    const ang = (i / N) * Math.PI * 2 + (Math.random() - .5) * .5;
    const spread = .42 + Math.random() * .58;
    const dx = Math.cos(ang) * reach * .58 * spread;
    const dy = Math.sin(ang) * reach * .40 * spread - box.height * .10;
    const size = box.height * (.030 + Math.random() * .038);

    p.style.left = ox + "px";
    p.style.top = oy + "px";
    p.style.setProperty("--sz", size + "px");
    p.style.setProperty("--dx", dx + "px");
    p.style.setProperty("--dy", dy + "px");
    p.style.setProperty("--fall", (box.height * (.55 + Math.random() * .45)) + "px");
    p.style.setProperty("--rot", (Math.random() * 900 - 450) + "deg");
    p.style.setProperty("--dur", (1500 + Math.random() * 700) + "ms");
    p.style.setProperty("--delay", (Math.random() * 90) + "ms");
    /* set on the element, not through a custom property: a url() inside a
       var() resolves against the stylesheet (/css/), not the document. */
    p.style.backgroundImage =
      'url("assets/ui/figma/' + CONFETTI_ART[(Math.random() * CONFETTI_ART.length) | 0] + '")';
    wrap.appendChild(p);
  }
  host.appendChild(wrap);
  liveBursts.add(wrap);
  wrap._burstTimer = setTimeout(() => {
    wrap.remove();
    liveBursts.delete(wrap);
  }, 2500);
}

function payOutSoloWord(){
  deliverPointsAward({
    awardId: "soloAward", pointsId: "soloAwardPts",
    points: state.game ? state.game.pendingPts : 0,
    toEl: el("soloScoreCard"),
    stage: el("soloStage"),
    onLand: () => {
      if(rstate !== "locked") return;
      setState("round_end");
      blip([880]);
      if(resolveCb) resolveCb({ won: true });
    },
  });
}

/* ---------------- failure (timeout / skip) ---------------- */
export function failRound(skipped){
  if(rstate !== "guessing") return false;
  setState("round_end");
  playWordMissFeedback(el("soloWordCard"), LOCK_THRESHOLD);
  /* TIME'S UP is a 1.5s full-screen paper but the next word arrives at
     ROUND_END_PAUSE_MS (1250ms), so firing it on every ordinary word timeout
     started the next word underneath it — and made a routine miss read like
     the run ending. The RUN ending is what earns the paper; game.js calls
     showTimesUp() there. Here a word timeout gets the miss beat and a
     descending blip, and a skip gets its own two-note. */
  blip(skipped ? [294, 220] : [330, 262, 196]);
  robotMiss("spRobot", skipped ? "skip" : "timeout");
  if(resolveCb) resolveCb({ won: false, skip: !!skipped });
  return true;
}

/* ---------------- lifecycle (from game.js) ---------------- */

/* Wipe the board back to "nothing has happened yet". Called before the 3·2·1
   so a second run never counts in under the last word of the previous one. */
export function resetSoloBoard(){
  clearCelebrations();
  resetRobot("spRobot");
  resetChargeMeter(meter);
  target = null;
  resetGuessHistory(guessHistory);
  renderStack(false);
  prepareWordFeedback(el("soloWordCard"), el("soloWordFill"), LOCK_THRESHOLD, true);
  markGuessRecognized(el("spGuessTop"), false);
  setTxt("soloWord", "—");
  fitGameplayText(el("soloWord"));
}

export function beginRound(word, onResolve, onLock){
  target = word;
  resolveCb = onResolve;
  onLockCb = onLock || null;
  resetChargeMeter(meter);
  /* Confidence has to be EARNED for this word. state.smooth carries over from
     the previous round, so if the new word is one the AI was already sure of,
     the bar would start full and lock instantly — a point for doing nothing.
     Zeroing the target's channel makes the classifier re-prove it; live
     inference refills it within a few frames. */
  if(state.smooth) state.smooth[word] = 0;
  resetGuessHistory(guessHistory);
  renderStack(false);
  const fillEl = el("soloWordFill");
  const card = el("soloWordCard");
  prepareWordFeedback(card, fillEl, LOCK_THRESHOLD, true);
  markGuessRecognized(el("spGuessTop"), false);
  robotNewWord("spRobot");
  el("soloAward")?.classList.remove("show", "deliver");
  setTxt("soloWord", word);
  fitGameplayText(el("soloWord"));
  setState("guessing");
  if(!rafId) rafId = requestAnimationFrame(frame);
}

export function endRound(){
  setState("idle");
  resolveCb = null;
  onLockCb = null;
  if(rafId){ cancelAnimationFrame(rafId); rafId = null; }
  const card = el("soloWordCard");
  if(card){
    clearTimeout(card._recognitionImpactTimer);
    setWordRecognitionMotion(card,0,LOCK_THRESHOLD,false);
    card.classList.remove("hit", "locked", "miss");
  }
  markGuessRecognized(el("spGuessTop"), false);
}

function setTxt(id, v){ const e = el(id); if(e) e.textContent = v; }
