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

import { $, esc } from "./dom.js";
import { state } from "./state.js";
import { blip } from "./audio.js";

/* ---------------- tuning (against real model logs) ---------------- */
export const LOCK_THRESHOLD    = 0.80;  // smoothed target confidence that completes the bar & locks
export const LOCK_HOLD_MS      = 160;   // must stay at/over threshold this long to lock
export const FILL_LERP         = 0.16;  // displayed fill -> target each frame (never snaps)
export const LABEL_DEBOUNCE_MS = 550;   // a new top label must persist this long to enter the stack
export const WARM_AT           = 0.55;  // fill fraction where the word starts shaking
export const HOT_AT            = 0.82;  // fill fraction where it shakes hard
export const HITSTOP_MS        = 180;   // freeze on lock
export const CHIP_FLIGHT_MS    = 650;   // points chip travel; score applies on arrival
export const AWARD_MS          = 1500;  // POINTS AWARD paper on screen
export const ROUND_END_PAUSE_MS = 1100; // linger before the next word

/* Figma resting pill = 35.4% of the word card; the bar grows to just short of
   the card's torn right edge so the paper still reads as paper. */
const FILL_MIN = 35.4, FILL_MAX = 95;

/* ---------------- state ---------------- */
let rstate = "idle";
let target = null;
let shownFill = 0;          // 0..1 displayed progress toward the lock
let overSince = 0;          // when the smoothed conf first crossed threshold
let resolveCb = null;

/* debounced guess stack: [top, mid, bot] of {label, pct}; top is live */
let stack = [];
let candLabel = null, candSince = 0, topLabel = null;

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
  const now = performance.now();
  if(label !== candLabel){ candLabel = label; candSince = now; }

  /* live-update the current top card's percentage every frame */
  if(label === topLabel && stack[0]){
    stack[0].pct = Math.round((confidence || 0) * 100);
    if(el("spGuessTopPct")) el("spGuessTopPct").textContent = stack[0].pct + "%";
  }

  /* a new label that has been top for long enough enters the stack on top */
  if(label !== topLabel && now - candSince >= LABEL_DEBOUNCE_MS){
    topLabel = label;
    stack.unshift({ label, pct: Math.round((confidence || 0) * 100) });
    stack = stack.slice(0, 3);
    renderStack(true);
  }
}

/* Figma sizes its type against one sample word ("JUMPING", "JUMPING?"), but
   real decks carry longer labels ("basketball shot"). Card geometry is the
   design and must not move, so the type bends to fit instead of clipping.
   Sizes stay in cqw, so a fitted size survives any resize. */
const WORD_FS_CQW = 14.69, GUESS_FS_CQW = 17.21;
function fitText(node, baseCqw){
  if(!node) return;
  node.style.fontSize = baseCqw + "cqw";
  const avail = node.clientWidth;
  if(!avail) return;                       // screen not laid out yet
  const want = node.scrollWidth;
  if(want > avail) node.style.fontSize = (baseCqw * (avail / want) * .97) + "cqw";
}
const fitWord = () => fitText(el("soloWord"), WORD_FS_CQW);

function renderStack(popped){
  const slots = [
    { box: "spGuessTop", lab: "spGuessTopLabel", pct: "spGuessTopPct" },
    { box: "spGuessMid", lab: "spGuessMidLabel", pct: "spGuessMidPct" },
    { box: "spGuessBot", lab: "spGuessBotLabel", pct: "spGuessBotPct" },
  ];
  slots.forEach((s, i) => {
    const box = el(s.box), lab = el(s.lab), pct = el(s.pct);
    const entry = stack[i];
    if(!box || !lab || !pct) return;
    if(entry){
      box.classList.remove("empty");
      lab.textContent = disp(entry.label) + "?";
      pct.textContent = entry.pct + "%";
      fitText(lab, GUESS_FS_CQW);
    }else{
      box.classList.add("empty");
      lab.textContent = "";
      pct.textContent = "";
    }
  });
  if(popped){
    const top = el("spGuessTop");
    top.classList.remove("pop"); void top.offsetWidth; top.classList.add("pop");
    for(const id of ["spGuessMid", "spGuessBot"]){
      const b = el(id);
      b.classList.remove("shift"); void b.offsetWidth; b.classList.add("shift");
    }
    blip([494, 622], 0.045);
  }
}

/* ---------------- per-frame: the word progress bar ---------------- */
function frame(){
  rafId = requestAnimationFrame(frame);
  if(rstate !== "guessing") return;

  const raw = target ? (state.smooth?.[target] || 0) : 0;
  const wantFill = Math.max(0, Math.min(1, raw / LOCK_THRESHOLD));
  shownFill += (wantFill - shownFill) * FILL_LERP;

  const fillEl = el("soloWordFill");
  if(fillEl) fillEl.style.width = (FILL_MIN + shownFill * (FILL_MAX - FILL_MIN)) + "%";

  const card = el("soloWordCard");
  if(card){
    card.classList.toggle("warm", shownFill >= WARM_AT && shownFill < HOT_AT);
    card.classList.toggle("hot", shownFill >= HOT_AT);
  }

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
  setState("hitstop");                 // freezes the game timers (timerFrozen)
  const card = el("soloWordCard");
  if(card){ card.classList.remove("warm", "hot"); card.classList.add("locked"); }
  const fillEl = el("soloWordFill");
  if(fillEl) fillEl.style.width = FILL_MAX + "%";
  blip([523]);

  setTimeout(() => {
    if(rstate !== "hitstop") return;
    setState("locked");
    greenFlash();
    confettiFrom(card);
    showAward();
    blip([523, 659, 784, 1047], 0.08);
    flyPointsChip();
  }, HITSTOP_MS);
}

function greenFlash(){
  const f = el("soloFlash");
  if(!f) return;
  f.classList.remove("fire"); void f.offsetWidth; f.classList.add("fire");
}

function showAward(){
  const a = el("soloAward");
  if(!a) return;
  const pts = state.game ? state.game.pendingPts : 0;
  el("soloAwardPts").textContent = "+" + (pts || 0).toLocaleString("en-US");
  a.classList.remove("show"); void a.offsetWidth; a.classList.add("show");
  setTimeout(() => a.classList.remove("show"), AWARD_MS);
}

function confettiFrom(node){
  if(matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const r = node ? node.getBoundingClientRect()
                 : { left: innerWidth / 2, top: innerHeight / 2, width: 0, height: 0 };
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  const wrap = document.createElement("div");
  wrap.className = "burstwrap";
  for(let i = 0; i < 26; i++){
    const p = document.createElement("i");
    const ang = (i / 26) * Math.PI * 2 + Math.random() * 0.6;
    const dist = 90 + Math.random() * 160;
    p.style.left = cx + "px"; p.style.top = cy + "px";
    p.style.setProperty("--dx", Math.cos(ang) * dist + "px");
    p.style.setProperty("--dy", Math.sin(ang) * dist - 60 + "px");
    p.style.setProperty("--rot", (Math.random() * 540 - 270) + "deg");
    p.className = ["star", "dot", "spark"][i % 3];
    wrap.appendChild(p);
  }
  document.body.appendChild(wrap);
  setTimeout(() => wrap.remove(), 950);
}

function flyPointsChip(){
  const from = el("soloWordCard"), to = el("soloScoreCard");
  const pts = state.game ? state.game.pendingPts : 0;
  const chip = document.createElement("div");
  chip.className = "sp-chip";
  chip.textContent = "+" + (pts || 0).toLocaleString("en-US");
  const fr = from ? from.getBoundingClientRect() : { left: innerWidth / 2, top: innerHeight / 2, width: 0, height: 0 };
  const tr = to ? to.getBoundingClientRect() : { left: innerWidth - 160, top: 40, width: 120, height: 60 };
  chip.style.left = (fr.left + fr.width / 2) + "px";
  chip.style.top = (fr.top + fr.height / 2) + "px";
  document.body.appendChild(chip);
  requestAnimationFrame(() => {
    chip.style.transition = "transform " + CHIP_FLIGHT_MS + "ms cubic-bezier(.3,-.15,.5,1), opacity 140ms " + (CHIP_FLIGHT_MS - 120) + "ms";
    chip.style.transform = "translate(" +
      (tr.left + tr.width / 2 - (fr.left + fr.width / 2)) + "px," +
      (tr.top + tr.height / 2 - (fr.top + fr.height / 2)) + "px) scale(.5)";
    chip.style.opacity = "0";
  });
  setTimeout(() => {
    chip.remove();
    if(rstate !== "locked") return;
    setState("round_end");
    blip([880]);
    if(resolveCb) resolveCb({ won: true });    // score+streak apply NOW
  }, CHIP_FLIGHT_MS);
}

/* ---------------- failure (timeout / skip) ---------------- */
export function failRound(skipped){
  if(rstate !== "guessing") return false;
  setState("round_end");
  const card = el("soloWordCard");
  if(card){
    card.classList.remove("warm", "hot");
    card.classList.add("miss");
    setTimeout(() => card.classList.remove("miss"), 500);
  }
  blip(skipped ? [294, 220] : [220, 165]);
  if(resolveCb) resolveCb({ won: false, skip: !!skipped });
  return true;
}

/* ---------------- lifecycle (from game.js) ---------------- */
export function beginRound(word, onResolve){
  target = word;
  resolveCb = onResolve;
  shownFill = 0; overSince = 0;
  /* Confidence has to be EARNED for this word. state.smooth carries over from
     the previous round, so if the new word is one the AI was already sure of,
     the bar would start full and lock instantly — a point for doing nothing.
     Zeroing the target's channel makes the classifier re-prove it; live
     inference refills it within a few frames. */
  if(state.smooth) state.smooth[word] = 0;
  stack = []; candLabel = null; topLabel = null;
  renderStack(false);
  const fillEl = el("soloWordFill");
  if(fillEl) fillEl.style.width = FILL_MIN + "%";
  const card = el("soloWordCard");
  if(card) card.classList.remove("warm", "hot", "locked", "miss");
  setTxt("soloWord", word);
  fitWord();
  setState("guessing");
  if(!rafId) rafId = requestAnimationFrame(frame);
}

export function endRound(){
  setState("idle");
  resolveCb = null;
  if(rafId){ cancelAnimationFrame(rafId); rafId = null; }
  const card = el("soloWordCard");
  if(card) card.classList.remove("warm", "hot", "locked", "miss");
}

function setTxt(id, v){ const e = el(id); if(e) e.textContent = v; }
