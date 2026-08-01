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
   flash → confetti from the word → POINTS AWARD paper → points chip flies
   to the Score card (score/streak apply on arrival) → ROUND_END. */

import { $ } from "./dom.js";
import { state } from "./state.js";
import { blip } from "./audio.js";
import { showTimesUp } from "./ui.js";
import { SOLO } from "./constants.js";
import { calculateFirstPoints } from "./scoring.js";
import {
  RECOGNITION_FILL_LERP_60FPS,
  RECOGNITION_IMPACT_MS,
  RECOGNITION_FILL_MIN,
  RECOGNITION_FILL_MAX,
  GUESS_LABEL_DEBOUNCE_MS,
  WARM_AT, HOT_AT, CRITICAL_AT,
  advanceRecognitionFill,
  createGuessHistory, resetGuessHistory, updateGuessHistory,
  restartFeedbackAnimation, markGuessRecognized,
  setWordRecognitionMotion, prepareWordFeedback,
  playWordLockFeedback, playWordMissFeedback,
  fitGameplayText, prefersReducedMotion,
} from "./gameplayFeedback.js";

export { setWordRecognitionMotion } from "./gameplayFeedback.js";

/* ---------------- tuning (against real model logs) ---------------- */
export const LOCK_THRESHOLD    = 0.80;  // smoothed target confidence that completes the bar & locks
/* Must exceed one classifier tick (CLASSIFY_EVERY_MS = 250) or a single
   sample satisfies it — state.smooth cannot change inside a shorter window.
   1v1 (HOLD_MS) and Party (CLAIM_HOLD_MS) both require 250. */
export const LOCK_HOLD_MS      = 260;
export const FILL_LERP         = RECOGNITION_FILL_LERP_60FPS;
export const LABEL_DEBOUNCE_MS = GUESS_LABEL_DEBOUNCE_MS;
export { WARM_AT, HOT_AT, CRITICAL_AT };
export const HITSTOP_MS        = RECOGNITION_IMPACT_MS;
export const CHIP_FLIGHT_MS    = 650;   // points chip travel; score applies on arrival
export const AWARD_MS          = 1850;  // POINTS AWARD paper on screen
export const ROUND_END_PAUSE_MS = 1250; // linger before the next word

/* ---------------- state ---------------- */
let rstate = "idle";
let target = null;
let shownFill = 0;          // 0..1 displayed progress toward the lock
let fillAt = 0;
let overSince = 0;          // when the smoothed conf first crossed threshold
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
      pct.textContent = Math.round(entry.pct * 100) + "%";
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
  const wantFill = Math.max(0, Math.min(1, raw / LOCK_THRESHOLD));
  const nextFill = advanceRecognitionFill(shownFill, wantFill, fillAt);
  shownFill = nextFill.value;
  fillAt = nextFill.at;

  const fillEl = el("soloWordFill");
  if(fillEl) fillEl.style.width = (RECOGNITION_FILL_MIN +
    shownFill * (RECOGNITION_FILL_MAX - RECOGNITION_FILL_MIN)) + "%";

  const card = el("soloWordCard");
  setWordRecognitionMotion(card,shownFill*LOCK_THRESHOLD,LOCK_THRESHOLD,true);

  /* lock when the smoothed confidence holds at/over threshold */
  if(raw >= LOCK_THRESHOLD){
    if(!overSince) overSince = performance.now();
    if(performance.now() - overSince >= LOCK_HOLD_MS) beginLock();
  }else{
    overSince = 0;
  }
}

/* ---------------- lock payoff ---------------- */
function beginLock(){
  if(state.game?.mode==="ai")
    state.game.pendingPts=calculateFirstPoints(
      state.game.wordEnd-performance.now(),SOLO.wordMs);
  setState("hitstop");                 // freezes the game timers (timerFrozen)
  const card = el("soloWordCard");
  const fillEl = el("soloWordFill");
  updateGuessHistory(guessHistory, target || "", 1, { force:true,locked:true });
  renderStack(false);
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
      confettiFrom(card);
      showAward();
      blip([523, 659, 784, 1047], 0.08);
      flyPointsChip();
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

/* Winning the LAST word of a run starts an 1850ms award paper and a 2500ms
   confetti burst, but the screen leaves for Results 1250ms later — both used
   to keep playing on top of the results papers. Every celebration registers
   here so the FSM can sweep them the moment gameplay ends. */
const liveAwards = new Set();
const liveBursts = new Set();
const liveChips = new Set();

export function clearCelebrations(){
  for(const a of liveAwards){
    clearTimeout(a._awardTimer);
    a.classList.remove("show");
  }
  liveAwards.clear();
  for(const wrap of liveBursts){
    clearTimeout(wrap._burstTimer);
    wrap.remove();
  }
  liveBursts.clear();
  /* A chip launched on the final word is position:fixed at z-index 96, so it
     kept flying across the Results screen — the exact failure this function
     exists to prevent. Land it (once) so no score hold is left dangling. */
  for(const chip of liveChips){
    clearTimeout(chip._flightTimer);
    chip.remove();
    const land = chip._land;
    chip._land = null;
    land?.();
  }
  liveChips.clear();
}

/* The 1v1 match and Party deliberately call this same helper with their own
   instance of the Solo paper. That keeps the asset, timing and motion
   completely shared. */
export function showPointsAward(awardId, pointsId, points, valueText){
  const a = el(awardId);
  if(!a) return;
  const value = el(pointsId);
  if(value){
    /* Party's provisional paper shows a PLACE, not a figure — the server has
       not resolved points yet — so it passes its own valueText and still gets
       the shared timing and the clearCelebrations registry. */
    value.textContent = valueText ?? ("+" + (points || 0).toLocaleString("en-US"));
    fitGameplayText(value);
  }
  clearTimeout(a._awardTimer);
  a.classList.remove("show"); void a.offsetWidth; a.classList.add("show");
  liveAwards.add(a);
  a._awardTimer=setTimeout(() => {
    a.classList.remove("show");
    liveAwards.delete(a);
  }, AWARD_MS);
}

function showAward(){
  showPointsAward("soloAward", "soloAwardPts",
    state.game ? state.game.pendingPts : 0);
}

/* The win burst is real paper: the same torn confetti the home screen uses,
   thrown outward and then pulled down, rather than CSS shapes. (The previous
   particles had no styling at all and rendered invisible.) */
const CONFETTI_ART = [
  "conf-star-a.png", "conf-star-b.png", "conf-star-c.png",
  "conf-blue-a.png", "conf-blue-b.png", "conf-red-a.png", "conf-red-b.png",
];

export function confettiFrom(node){
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

  /* Erupt from where the eye already is — the award lands centre-stage.
     Bursting from the word card put every piece in the bottom strip, where
     it fell straight out of frame. */
  const ox = box.width * .5, oy = box.height * .46;
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

/* Points physically travel from the word you just landed to the card that
   holds your score, and the score only moves when they ARRIVE. Solo has had
   this since the Figma build; 1v1 and Party now share the same flight, which
   is why it takes its elements as arguments rather than reading Solo's.

   `onLand` is always called exactly once — including under reduced motion,
   where there is no visible flight and holding the 650ms timer would just
   make the score feel broken. */
export function flyPoints(fromEl, toEl, points, onLand){
  let landed = false;
  const land = () => {
    if(landed) return;
    landed = true;
    toEl?.classList.remove("awaiting");
    onLand?.();
  };
  if(prefersReducedMotion()){ land(); return; }

  const chip = document.createElement("div");
  chip.className = "sp-chip";
  chip.textContent = "+" + (points || 0).toLocaleString("en-US");
  const fr = fromEl ? fromEl.getBoundingClientRect()
    : { left: innerWidth / 2, top: innerHeight / 2, width: 0, height: 0 };
  const tr = toEl ? toEl.getBoundingClientRect()
    : { left: innerWidth - 160, top: 40, width: 120, height: 60 };
  chip.style.left = (fr.left + fr.width / 2) + "px";
  chip.style.top = (fr.top + fr.height / 2) + "px";
  document.body.appendChild(chip);
  chip._land = land;
  liveChips.add(chip);
  toEl?.classList.add("awaiting");     // braces until the chip actually lands
  requestAnimationFrame(() => {
    chip.style.transition = "transform " + CHIP_FLIGHT_MS + "ms cubic-bezier(.3,-.15,.5,1), opacity 140ms " + (CHIP_FLIGHT_MS - 120) + "ms";
    chip.style.transform = "translate(" +
      (tr.left + tr.width / 2 - (fr.left + fr.width / 2)) + "px," +
      (tr.top + tr.height / 2 - (fr.top + fr.height / 2)) + "px) scale(.5)";
    chip.style.opacity = "0";
  });
  chip._flightTimer = setTimeout(() => {
    chip.remove();
    liveChips.delete(chip);
    const done = chip._land;
    chip._land = null;
    done?.();
  }, CHIP_FLIGHT_MS);
}

function flyPointsChip(){
  flyPoints(el("soloWordCard"), el("soloScoreCard"),
    state.game ? state.game.pendingPts : 0,
    () => {
      if(rstate !== "locked") return;
      setState("round_end");
      blip([880]);
      if(resolveCb) resolveCb({ won: true });
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
  if(resolveCb) resolveCb({ won: false, skip: !!skipped });
  return true;
}

/* ---------------- lifecycle (from game.js) ---------------- */

/* Wipe the board back to "nothing has happened yet". Called before the 3·2·1
   so a second run never counts in under the last word of the previous one. */
export function resetSoloBoard(){
  clearCelebrations();
  shownFill = 0; fillAt = 0; overSince = 0;
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
  shownFill = 0; fillAt = 0; overSince = 0;
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
  el("soloAward")?.classList.remove("show");
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
