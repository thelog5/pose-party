/* Solo-round guess mechanic: the mascot's speech bubble IS the confidence
   meter. One bubble at a time; its fill width lerps toward the model's
   confidence; superseded guesses fade into a small history stack above it.

   All model output funnels through setModelOutput(label, confidence) — the
   UI never binds to raw model output directly.

   Round state machine (explicit; elements render off this state ONLY):
     IDLE → GUESSING → HITSTOP → LOCKED → ROUND_END
   plus the failure edge GUESSING → ROUND_END (timeout/skip: no hitstop,
   no celebration).

   Lock-on sequence, in order:
     1. HITSTOP: everything (fill, timer, mascot bounce) freezes ~180ms.
     2. LOCKED: the SAME bubble element transforms in place — "WORD?"
        becomes "WORD!", the fill stops updating.
     3. The bottom prompt bar flips to its matched state in the same frame.
     4. Celebration particles fire from the bubble (event-triggered only).
     5. A points chip flies bubble → score card; score and streak increment
        only when it arrives.
     6. ROUND_END, then game.js advances to the next word. */

import { $, esc } from "./dom.js";
import { state } from "./state.js";
import { blip } from "./audio.js";

/* ---------------- tuning constants (match against real model logs) ---------------- */
export const LOCK_THRESHOLD    = 0.85;  // displayed fill needed to lock (configurable)
export const LABEL_DEBOUNCE_MS = 600;   // new top label must persist this long to swap the bubble
export const FILL_LERP         = 0.09;  // displayed fill -> raw confidence, per animation frame
export const NEARMISS_PEAK_MIN = 0.65;  // near-miss only armed above this displayed peak
export const NEARMISS_DROP     = 0.22;  // ...and fires after dropping this many points
export const HITSTOP_MS        = 180;   // freeze duration on lock
export const CHIP_FLIGHT_MS    = 700;   // points chip travel time; score increments on arrival
export const CONFUSED_MS       = 900;   // how long the mascot stays confused after a near-miss
export const HISTORY_MAX       = 3;     // faded previous-guess bubbles kept above the live one
export const ROUND_END_PAUSE_MS = 900;  // linger on the resolved bubble before the next word

/* ---------------- state ---------------- */
let rstate = "idle";            // idle | guessing | hitstop | locked | round_end
let target = null;              // this round's word
let rawLabel = null,  rawConf = 0;      // latest model output (via setModelOutput)
let candLabel = null, candSince = 0;    // debounce candidate
let shownLabel = null;          // label currently in the bubble
let shownConf = 0;              // displayed (lerped) fill 0..1
let peakConf = 0;               // peak displayed confidence for the current label
let history = [];               // [{label, pct}] oldest first
let rafId = null;
let confusedTimer = null;
let resolveCb = null;           // game.js callback: ({won, skip})

const el = id => $(id);

function setState(s){
  rstate = s;
  const scr = el("scrSolo");
  if(scr) scr.dataset.rstate = s;   // CSS gates every stateful element off this
}
export const roundState = () => rstate;

/* ---------------- mascot ---------------- */
/* Exactly one mascot instance (#mascotImg); the bubble is anchored to it.
   Poses: thinking (default), confused (near-miss), excited (locked).
   NOTE: no confused art was uploaded — the thinking pose gets a CSS
   "dizzy" treatment until a real asset lands (see ASSETS-NEEDED.md). */
const POSES = {
  thinking: "assets/ui/robot-wave.png",
  confused: "assets/ui/robot-wave.png",
  excited:  "assets/ui/mascot-thumbs.png",
};
function setMascot(pose){
  const img = el("mascotImg");
  if(!img) return;
  img.src = POSES[pose];
  img.dataset.pose = pose;
}

/* ---------------- model funnel ---------------- */
/* Called every inference frame by the engine. The only entry point for
   model output; everything the player sees derives from here. */
export function setModelOutput(label, confidence){
  if(rstate !== "guessing") return;      // frozen during hitstop/locked/round_end
  if(typeof label !== "string" || !label) return;
  rawLabel = label;
  rawConf = Math.max(0, Math.min(1, +confidence || 0));

  const now = performance.now();
  if(label !== candLabel){ candLabel = label; candSince = now; }

  /* debounce: only swap the bubble after 600ms of a stable new top label */
  if(label !== shownLabel && now - candSince >= LABEL_DEBOUNCE_MS){
    if(shownLabel !== null) pushHistory(shownLabel, shownConf);
    shownLabel = label;
    peakConf = shownConf;                // reset near-miss peak on swap
    renderBubbleLabel();
  }
}

function pushHistory(label, conf){
  history.push({ label, pct: Math.round(conf * 100) });
  while(history.length > HISTORY_MAX) history.shift();
  const stack = el("bubbleHistory");
  if(!stack) return;
  stack.innerHTML = history.map(h =>
    '<div class="gbubble mini"><img class="shell" src="assets/ui/bubble-white.png" alt="">' +
    '<span class="btext"><span class="blabel">' + esc(disp(h.label)) + '?</span>' +
    '<span class="bpct">' + h.pct + '%</span></span></div>'
  ).join("");
}

const disp = l => (l === "idle" ? "just standing" : l).toUpperCase();

function renderBubbleLabel(){
  const lab = el("bubbleLabel");
  if(lab) lab.textContent = shownLabel ? disp(shownLabel) + "?" : "…";
}

/* ---------------- per-frame animation ---------------- */
function frame(){
  rafId = requestAnimationFrame(frame);
  if(rstate !== "guessing") return;       // hitstop freezes everything

  /* smoothing: never snap the fill to raw values */
  const targetConf = (rawLabel === shownLabel) ? rawConf : 0;
  shownConf += (targetConf - shownConf) * FILL_LERP;

  const pct = Math.round(shownConf * 100);
  const fill = el("bubbleFill");
  const pctEl = el("bubblePct");
  if(fill) fill.style.width = pct + "%";
  if(pctEl) pctEl.textContent = pct + "%";

  /* near-miss: peaked high, then slid back down */
  if(shownConf > peakConf) peakConf = shownConf;
  if(peakConf >= NEARMISS_PEAK_MIN && peakConf - shownConf >= NEARMISS_DROP){
    peakConf = shownConf;                 // re-arm from the new floor
    nearMiss();
  }

  /* lock: DISPLAYED fill crosses the threshold on the matching label —
     raw spikes can't trigger it */
  if(shownConf >= LOCK_THRESHOLD && shownLabel === target){
    beginLockSequence(pct);
  }
}

function nearMiss(){
  const bubble = el("guessBubble");
  if(bubble){
    bubble.classList.remove("shake"); void bubble.offsetWidth;
    bubble.classList.add("shake");
  }
  setMascot("confused");
  blip([330, 262]);
  clearTimeout(confusedTimer);
  confusedTimer = setTimeout(() => {
    if(rstate === "guessing") setMascot("thinking");
  }, CONFUSED_MS);
}

/* ---------------- lock sequence ---------------- */
function beginLockSequence(pct){
  setState("hitstop");                    // freezes frame() and the game timer
  clearTimeout(confusedTimer);
  blip([523]);

  setTimeout(() => {
    if(rstate !== "hitstop") return;      // round was torn down mid-hitstop
    setState("locked");

    /* the SAME bubble transforms: "WORD?" -> "WORD!", fill stops updating */
    const lab = el("bubbleLabel");
    if(lab) lab.textContent = disp(target) + "!";
    if(el("bubblePct")) el("bubblePct").textContent = pct + "%";

    /* prompt bar flips to matched in the same beat (CSS via data-rstate) */
    setMascot("excited");
    fireParticles();
    blip([523, 659, 784]);
    flyPointsChip();
  }, HITSTOP_MS);
}

/* celebration particles — event-triggered only, self-removing */
function fireParticles(){
  const bubble = el("guessBubble");
  if(!bubble) return;
  const r = bubble.getBoundingClientRect();
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  const wrap = document.createElement("div");
  wrap.className = "burstwrap";
  for(let i = 0; i < 16; i++){
    const p = document.createElement("i");
    const ang = (i / 16) * Math.PI * 2 + Math.random() * 0.5;
    const dist = 70 + Math.random() * 110;
    p.style.left = cx + "px"; p.style.top = cy + "px";
    p.style.setProperty("--dx", Math.cos(ang) * dist + "px");
    p.style.setProperty("--dy", Math.sin(ang) * dist - 40 + "px");
    p.style.setProperty("--rot", (Math.random() * 540 - 270) + "deg");
    p.className = ["star", "dot", "spark"][i % 3];
    wrap.appendChild(p);
  }
  document.body.appendChild(wrap);
  setTimeout(() => wrap.remove(), 950);
}

/* points chip: bubble -> score card; the score changes only on arrival */
function flyPointsChip(){
  const bubble = el("guessBubble"), scoreCard = el("soloScoreCard");
  const pts = state.game ? state.game.pendingPts : 0;
  const chip = document.createElement("div");
  chip.className = "ptschip";
  chip.textContent = "+" + (pts || 0).toLocaleString("en-US");
  const from = bubble ? bubble.getBoundingClientRect() : { left: innerWidth / 2, top: innerHeight / 2, width: 0, height: 0 };
  const to = scoreCard ? scoreCard.getBoundingClientRect() : { left: innerWidth - 160, top: 40, width: 120, height: 60 };
  chip.style.left = (from.left + from.width / 2) + "px";
  chip.style.top = (from.top + from.height / 2) + "px";
  document.body.appendChild(chip);
  requestAnimationFrame(() => {
    chip.style.transition = "transform " + CHIP_FLIGHT_MS + "ms cubic-bezier(.3,-.2,.6,1), opacity 120ms " + (CHIP_FLIGHT_MS - 100) + "ms";
    chip.style.transform = "translate(" +
      (to.left + to.width / 2 - (from.left + from.width / 2)) + "px," +
      (to.top + to.height / 2 - (from.top + from.height / 2)) + "px) scale(.55)";
    chip.style.opacity = "0";
  });
  setTimeout(() => {
    chip.remove();
    if(rstate !== "locked") return;
    const b = el("guessBubble"), scr = el("scrSolo");
    if(b) b.classList.add("won");
    if(scr) scr.classList.add("wonround");    // keeps the prompt bar matched through round_end
    setState("round_end");
    blip([880]);
    if(resolveCb) resolveCb({ won: true });   // game.js increments score+streak NOW
  }, CHIP_FLIGHT_MS);
}

/* ---------------- failure paths ---------------- */
/* Timer expired or player skipped: bubble transitions to its failed state.
   No celebration, no hitstop. */
export function failRound(skipped){
  if(rstate !== "guessing") return false;
  clearTimeout(confusedTimer);
  const b = el("guessBubble");
  if(b) b.classList.add("failed");
  setState("round_end");
  const lab = el("bubbleLabel");
  if(lab && !shownLabel) lab.textContent = "…";
  setMascot("thinking");
  blip(skipped ? [294, 220] : [220, 165]);
  if(resolveCb) resolveCb({ won: false, skip: !!skipped });
  return true;
}

/* ---------------- round lifecycle (driven by game.js) ---------------- */
export function beginRound(word, onResolve){
  target = word;
  resolveCb = onResolve;
  rawLabel = null; rawConf = 0;
  candLabel = null; candSince = 0;
  shownLabel = null; shownConf = 0; peakConf = 0;
  history = [];
  const stack = el("bubbleHistory");
  if(stack) stack.innerHTML = "";
  const b = el("guessBubble"), scr = el("scrSolo");
  if(b) b.classList.remove("won", "failed", "shake");
  if(scr) scr.classList.remove("wonround");
  renderBubbleLabel();
  if(el("bubbleFill")) el("bubbleFill").style.width = "0%";
  if(el("bubblePct")) el("bubblePct").textContent = "0%";
  if(el("promptWord")) el("promptWord").textContent = word; // word only — never a percentage
  setMascot("thinking");
  setState("guessing");
  if(!rafId) rafId = requestAnimationFrame(frame);
}

export function endRound(){
  setState("idle");
  clearTimeout(confusedTimer);
  resolveCb = null;
  if(rafId){ cancelAnimationFrame(rafId); rafId = null; }
}

/* The game timer freezes whenever the round isn't actively guessing
   (hitstop and everything after). game.js consults this. */
export const timerFrozen = () => rstate !== "guessing" && rstate !== "idle";
