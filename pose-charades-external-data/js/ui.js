/* DOM writers: guess panels, camera pill, toasts, flashes, class list. */

import { $, esc } from "./dom.js";
import { state } from "./state.js";
import { blip } from "./audio.js";
import { fakeRivalGuesses } from "./rival.js";
import {
  createGuessHistory, resetGuessHistory, updateGuessHistory,
  restartFeedbackAnimation, markGuessRecognized,
  setWordRecognitionMotion,
  fitGameplayText,
} from "./gameplayFeedback.js";
import { createChargeMeter, resetChargeMeter, advanceCharge,
         chargePercent } from "./recognition.js";
import { robotCharge, robotNewWord } from "./robot.js";

/* Which rig belongs to which side of the split. `my` is yours and talks;
   `rival` is muted in the markup and reacts in body only. */
export const MATCH_ROBOT = Object.freeze({ my:"v1RobotYou", rival:"v1RobotRival" });

/* ---------------- transient feedback ---------------- */
export function showStatus(msg){
  const s=$("status");
  if(!msg){ s.style.display="none"; return; }
  s.style.display="flex"; s.textContent=msg;
  /* the home screen has no camera preview, so boot problems must not hide
     inside the invisible dock */
  if(state.screen==="home" && msg!==showStatus._last && !/Loading/.test(msg)) toast(msg);
  showStatus._last=msg;
}

export function flash(kind){
  const f=$("flash");
  /* Re-assigning the same className is a no-op, so a second flash of the same
     kind inside 700ms never replayed — and the shared timer cut it short. */
  f.className="flash";
  void f.offsetWidth;
  f.className="flash "+kind;
  clearTimeout(flash._t);
  flash._t=setTimeout(()=>f.className="flash",700);
}

/* `ms` exists for the handful of messages that are INSTRUCTIONS rather than
   notifications. 2.6s is right for "Room code copied!"; it is not enough to
   read a sentence that ends in a URL you are meant to type, and the one time
   a player most needs to read carefully is when they are stuck. */
const TOAST_MS = 2600;
export function toast(msg, ms = TOAST_MS){
  const t=$("toast");
  /* The paper is a sibling <img> inside the toast, so the copy goes on the
     text span — writing it to the container would blow the backing away. */
  const line=$("toastText")||t;
  line.textContent=msg;
  /* restart the entrance even when a second message lands inside the window */
  t.classList.remove("show");
  void t.offsetWidth;
  t.classList.add("show");
  clearTimeout(toast._t);
  toast._t=setTimeout(()=>t.classList.remove("show"), ms);
}

export const fmtTime = (ms, { compact=false }={}) => {
  const s=Math.max(0,Math.ceil(ms/1000));
  const minutes=String(Math.floor(s/60));
  return (compact ? minutes : minutes.padStart(2,"0"))+
    ":"+String(s%60).padStart(2,"0");
};

export const fmtScore = n => (n|0).toLocaleString("en-US");

/* ---------------- guess rendering ---------------- */
export const topGuesses = (n=5) => Object.entries(state.smooth).sort((a,b)=>b[1]-a[1]).slice(0,n);

const displayName = lab => lab==="idle" ? "just standing" : lab;

/* fill one "AI'S TOP GUESS" panel: big word + robot % + 12-seg meter + rows */
export function fillGuessPanel(prefix, top, rows=4){
  const best=top[0];
  const pct=best?Math.round(best[1]*100):0;
  const topWord=$(prefix+"TopWord"), topPct=$(prefix+"TopPct"), meter=$(prefix+"Meter");
  if(topWord) topWord.textContent = best ? displayName(best[0]).toUpperCase() : "…";
  if(topPct) topPct.textContent = pct+"%";
  const segs=meter ? meter.children : [];
  const on=Math.round(pct/100*Math.max(1,segs.length));
  [...segs].forEach((seg,i)=>seg.classList.toggle("on", i<on));
  const html=[];
  for(let i=1;i<Math.min(1+rows,top.length);i++){
    const p=Math.round(top[i][1]*100);
    html.push('<div class="grow"><span class="rank">'+(i+1)+'</span>'+
      '<span class="gname">'+esc(displayName(top[i][0]))+'</span>'+
      '<span class="gbar"><i style="width:'+p+'%"></i></span>'+
      '<span class="gpct">'+p+'%</span></div>');
  }
  const list=$(prefix+"GuessList");
  if(list) list.innerHTML=html.join("");
}

/* Figma 1v1 carries one current paper and one faded previous paper per side.
   Keep the existing classifier output funnel, but render it through that
   smaller rolling stack rather than the old dashboard panels. */
const matchGuess = {
  my:{ key:null,history:createGuessHistory(2) },
  rival:{ key:null,history:createGuessHistory(2) },
};

/* 1v1's word bar is the shared charge meter (recognition.js): the pose has to
   be HELD over a gate that relaxes as the word clock runs down, and the claim
   goes out when the meter fills. The bar is driven at display rate rather than
   at CLASSIFY_EVERY_MS so it walks smoothly between inference ticks. */
const matchMeter = createChargeMeter("match");
let matchFillTarget = 0;        // last DISPLAYED confidence for the target, 0..1
let matchFillRaf = 0;
let matchLockHandler = null;

/* game.js owns what a completed meter MEANS (claim the server round, or win
   the practice word), and registers it here. ui.js must not import game.js —
   game.js already imports ui.js. */
export function setMatchLockHandler(fn){ matchLockHandler = fn; }
export function matchChargePercent(){ return chargePercent(matchMeter); }
export function resetMatchCharge(){
  resetChargeMeter(matchMeter);
  matchFillTarget = 0;
}

function matchWordElapsedFrac(g){
  const now = performance.now();
  if(!g?.wordEnd) return 0;
  /* The chase and sudden-death windows are their own short clocks; either way
     the meter wants how far through the CURRENT window we are. */
  const limit = g.roundPhase === "chase" ? 5000
    : (g.wordLimitMs || 20000);
  return Math.max(0, Math.min(1, 1 - Math.max(0, g.wordEnd - now) / limit));
}

function matchFillFrame(){
  matchFillRaf = 0;
  const g = state.game;
  const fill = $("v1WordFill");
  if(state.screen !== "match" || !g?.word || !fill) return;

  const stage = $("matchStage");
  const locked = stage?.classList.contains("you-locked");
  if(locked){
    matchMeter.charge = 1;
    matchMeter.display = 1;
    matchMeter.locked = true;
    matchMeter.at = performance.now();
  }else{
    advanceCharge(matchMeter, matchFillTarget, matchWordElapsedFrac(g));
    if(matchMeter.locked) matchLockHandler?.();
  }
  fill.style.width = (matchMeter.display * 95) + "%";
  robotCharge(MATCH_ROBOT.my, matchMeter.display, matchMeter.locked || locked);
  const activePhase = g.mode === "vs" ||
    ["word", "chase", "sudden"].includes(g.roundPhase);
  setWordRecognitionMotion($("vsWordCard"),
    matchMeter.display, 1, activePhase && !locked);
  matchFillRaf = requestAnimationFrame(matchFillFrame);
}

function startMatchFill(){
  if(!matchFillRaf) matchFillRaf = requestAnimationFrame(matchFillFrame);
}

export function stopMatchFill(){
  if(matchFillRaf) cancelAnimationFrame(matchFillRaf);
  matchFillRaf = 0;
  resetMatchCharge();
}

function resetMatchSide(prefix, key){
  const slot=matchGuess[prefix];
  if(slot.key===key) return slot;
  slot.key=key;
  if(prefix==="my") resetMatchCharge();
  resetGuessHistory(slot.history);
  robotNewWord(MATCH_ROBOT[prefix]);
  const topWord=$(prefix+"TopWord"), topPct=$(prefix+"TopPct");
  const topBox=$(prefix+"GuessTop");
  const pastWord=$(prefix+"PastWord"), pastPct=$(prefix+"PastPct"),
    pastBox=$(prefix+"GuessPast");
  if(topWord) topWord.textContent="GUESSING…";
  if(topPct) topPct.textContent="0%";
  if(pastWord) pastWord.textContent="";
  if(pastPct) pastPct.textContent="";
  if(pastBox) pastBox.classList.add("empty");
  markGuessRecognized(topBox,false);
  fitGameplayText(topWord);
  return slot;
}

/* One place owns the countdown so every mode gets the same beat: writing a
   new value re-triggers the punch animation. */
export function setCountdown(value){
  const cd=$("countdown");
  const num=$("countdownNum");
  if(!cd || !num) return false;
  const next=String(value);
  if(num.textContent===next) return false;
  num.textContent=next;
  /* The punch rides the inner span. On the wrapper it also transformed the
     full-bleed ::before dim layer, sweeping a skewed grey rectangle across
     the header and camera instead of dimming the page evenly. */
  num.classList.remove("tick"); void num.offsetWidth; num.classList.add("tick");
  return true;
}

/* Running out of time is the one beat that has to be unmistakable, so every
   mode shows the same Figma paper (245:907) rather than a text burst. The
   stage takes a red pulse too — the card alone is easy to miss mid-pose. */
let timesUpTimer = 0;
export function showTimesUp(){
  const card = $("timesUp");
  if(!card) return;
  clearTimeout(timesUpTimer);
  card.classList.remove("fire");
  void card.offsetWidth;
  card.classList.add("fire");

  const flash = $("timesUpFlash");
  if(flash){
    flash.classList.remove("fire");
    void flash.offsetWidth;
    flash.classList.add("fire");
    setTimeout(() => flash.classList.remove("fire"), 1200);
  }
  blip([392, 294, 196], .12);
  timesUpTimer = setTimeout(() => card.classList.remove("fire"), 1600);
}

/* Sudden death was a toast. In a mode where the whole screen is your own
   camera and you are mid-pose, a line of text at the bottom edge is not a
   rule change anybody notices — and this one inverts the entire match. It
   gets the same treatment TIMES UP gets: a full-screen Figma paper that slams
   in, plus the screen-edge pulse that keeps running underneath it for as long
   as the phase lasts (overlays.css). */
let suddenTimer = 0;
export function showSuddenDeath(){
  const card = $("suddenDeath");
  if(!card) return;
  clearTimeout(suddenTimer);
  card.classList.remove("hidden", "fire");
  void card.offsetWidth;
  card.classList.add("fire");
  blip([392, 330, 262, 196, 262, 330], .11);
  suddenTimer = setTimeout(() => {
    card.classList.remove("fire");
    card.classList.add("hidden");
  }, 1950);
}

export function hideSuddenDeath(){
  const card = $("suddenDeath");
  if(!card) return;
  clearTimeout(suddenTimer);
  card.classList.remove("fire");
  card.classList.add("hidden");
}

export function fitMatchPaperText(){
  for(const id of [
    "vsWord", "v1YouName", "v1RivalName",
    "v1MatchTime", "v1WordTime",
    "myTopWord", "myPastWord", "rivalTopWord", "rivalPastWord",
  ]) fitGameplayText($(id));
}

function paintMatchSide(prefix, slot, popped=false){
  const word=$(prefix+"TopWord"), pct=$(prefix+"TopPct"), topBox=$(prefix+"GuessTop");
  const pastWord=$(prefix+"PastWord"), pastPct=$(prefix+"PastPct"), pastBox=$(prefix+"GuessPast");
  const current=slot.history.items[0];
  const past=slot.history.items[1];
  if(current){
    const label=displayName(current.label).toUpperCase()+(current.locked?"":"?");
    if(word){ word.textContent=label; fitGameplayText(word); }
    /* your own paper reports CHARGE toward the claim while it is showing the
       target word — the number must agree with the bar underneath it */
    const live=prefix==="my" && !current.locked &&
      current.label===state.game?.word;
    if(pct) pct.textContent=(live?chargePercent(matchMeter)
      :Math.round(current.pct*100))+"%";
  }
  if(past){
    const label=displayName(past.label).toUpperCase()+"?";
    if(pastWord){ pastWord.textContent=label; fitGameplayText(pastWord); }
    if(pastPct) pastPct.textContent=Math.round(past.pct*100)+"%";
    pastBox?.classList.remove("empty");
  }else{
    pastBox?.classList.add("empty");
  }
  markGuessRecognized(topBox,!!current?.locked);
  /* Recognition itself fires his celebration from inside markGuessRecognized,
     which every mode routes through. What is left here is the rival rig's
     CONTINUOUS read: yours runs off the charge meter each frame, but the only
     confidence anyone has on the rival is the number his paper is showing —
     which is exactly what a robot watching him across the split would know. */
  if(prefix==="rival" && !current?.locked)
    robotCharge(MATCH_ROBOT.rival,current?.pct||0);
  if(popped && topBox){
    restartFeedbackAnimation(topBox,"pop");
    if(past) restartFeedbackAnimation(pastBox,"shift");
  }
}

function renderMatchSide(prefix, top, key, locked=false){
  const slot=resetMatchSide(prefix,key);
  if(locked && state.game?.word){
    const target=state.game.word;
    const update=updateGuessHistory(slot.history,target,1,
      { force:true,locked:true });
    paintMatchSide(prefix,slot,update.changed);
    return slot;
  }
  const best=top?.[0];
  if(!best) return slot;
  const [label,confidence]=best;
  const update=updateGuessHistory(slot.history,label,confidence);
  if(update.committed) paintMatchSide(prefix,slot,update.changed);
  return slot;
}

/* gameCheck uses this same displayed state, so neither a fill nor a win can
   race ahead while the robot paper is still showing the previous label. */
export function localMatchGuessIs(label){
  return !!label && matchGuess.my.history.items[0]?.label===label;
}

/* Online 1v1 relays only the opponent's already-computed label + confidence.
   Render it through the exact same rolling paper stack as the local side. */
export function renderRemoteMatchGuess(roundId,label,confidence){
  const game=state.game;
  if(!game || game.mode!=="online" || game.roundId!==roundId) return;
  if(typeof label!=="string" || !Number.isFinite(confidence)) return;
  const stage=$("matchStage");
  renderMatchSide("rival",[[label,Math.max(0,Math.min(1,confidence))]],
    roundId,stage?.classList.contains("rival-locked"));
}

/* rows-only variant (training panel live list) */
function guessRowsInto(id, top, from=0, limit=5){
  const rows=[];
  for(let i=from;i<Math.min(from+limit,top.length);i++){
    const p=Math.round(top[i][1]*100);
    rows.push('<div class="grow"><span class="rank">'+(i+1)+'</span>'+
      '<span class="gname">'+esc(displayName(top[i][0]))+'</span>'+
      '<span class="gbar"><i style="width:'+p+'%"></i></span>'+
      '<span class="gpct">'+p+'%</span></div>');
  }
  $(id).innerHTML=rows.join("");
}

/* "AI THINKS YOU ARE... | WORD • 97%" pill on the camera */
function fillAiPill(top){
  const best=top[0];
  $("aiPillGuess").textContent = best
    ? displayName(best[0]).toUpperCase()+" • "+Math.round(best[1]*100)+"%"
    : "WARMING UP…";
}

export function renderGuesses(){
  const top=topGuesses(5);
  if(!top.length) return;
  const s=state.screen;
  if(s==="lobby"){
    fillAiPill(top);
  } else if(s==="match"){
    const g=state.game;
    const key=g?.roundId || "between-"+(g?.round||0);
    const stage=$("matchStage");
    const localLocked=stage?.classList.contains("you-locked");
    const rivalLocked=stage?.classList.contains("rival-locked");
    const mySlot=renderMatchSide("my",top,key,localLocked);
    if(state.game?.mode==="vs"){
      // practice mode: the robot rival's "AI" runs right here
      renderMatchSide("rival",fakeRivalGuesses(),key,rivalLocked);
    }else{
      /* Keep the rival stack initialized for this round; incoming
         round:guess events paint it through renderRemoteMatchGuess(). A
         successful rival remains painted through the between-word pause. */
      renderMatchSide("rival",[],key,rivalLocked);
      if(g?.mode==="online" && state.onlineGuess && top[0])
        state.onlineGuess(top[0][0],top[0][1]);
    }
    /* The bar and the shake are ANIMATION, not classifier output. Advancing
       them here tied them to CLASSIFY_EVERY_MS (250ms), so 1v1's bar stepped
       in four visible jumps while Solo and Party ran theirs off rAF. Record
       where the bar is headed; the rAF loop below walks it there. */
    if(g?.word){
      const current=mySlot?.history.items[0];
      const displayedConfidence=current?.label===g.word
        ? Math.max(0,Math.min(1,current?.pct||0))
        : 0;
      matchFillTarget=localLocked ? 1 : displayedConfidence;
      startMatchFill();
    }
  } else if(s==="train"){
    guessRowsInto("trainGuessList", top, 0, 5);
  }
}

/* ---------------- recorded class list (training) ---------------- */
export function renderClasses(){
  const counts={};
  for(const c of state.dataset.clips) counts[c.label]=(counts[c.label]||0)+1;
  const el=$("classList");
  el.innerHTML = Object.entries(counts).sort().map(([lab,n])=>
    '<div class="classrow"><span>'+esc(lab)+'</span>'+
    '<span style="display:flex;align-items:center;gap:8px">'+
    '<span class="count">'+n+' clip'+(n>1?'s':'')+'</span>'+
    '<button class="del" data-lab="'+esc(lab)+'" title="Delete last clip of '+esc(lab)+'">undo</button>'+
    '<button class="del delall" data-lab="'+esc(lab)+'" title="Delete ALL clips of '+esc(lab)+'">&times;</button>'+
    '</span></div>'
  ).join("") || '<div class="hint">No clips yet. Pick a word and hit record.</div>';
  el.querySelectorAll(".del").forEach(b=>b.onclick=()=>{
    const lab=b.dataset.lab;
    const before=state.dataset.clips.length;
    if(b.classList.contains("delall")){
      if(confirm('Delete ALL clips of “'+lab+'”?')) state.dataset.clips=state.dataset.clips.filter(c=>c.label!==lab);
    }else{
      const i=state.dataset.clips.map(c=>c.label).lastIndexOf(lab);
      if(i>=0) state.dataset.clips.splice(i,1);
    }
    const removed=before-state.dataset.clips.length;
    renderClasses();
    if(!removed) return;
    /* The live guesser keeps classifying against the deleted clips until the
       player happens to press TRAIN again — so the panel below silently
       disagrees with the list above. Refit now, and say that we did. */
    onDatasetEdited?.();
    toast(removed===1
      ? "Clip removed. AI retrained."
      : removed+" clips removed. AI retrained.");
  });
}

/* training.js registers the retrain here; ui.js must not import it directly
   (training.js already imports ui.js). */
let onDatasetEdited=null;
export function setDatasetEditedHandler(fn){ onDatasetEdited=fn; }
