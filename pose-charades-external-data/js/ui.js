/* DOM writers: guess panels, camera pill, toasts, flashes, class list. */

import { $, esc } from "./dom.js";
import { state } from "./state.js";
import { blip } from "./audio.js";
import { fakeRivalGuesses } from "./rival.js";
import { THRESH } from "./constants.js";
import {
  advanceRecognitionFill,
  createGuessHistory, resetGuessHistory, updateGuessHistory,
  restartFeedbackAnimation, markGuessRecognized,
  setWordRecognitionMotion,
  fitGameplayText,
} from "./gameplayFeedback.js";

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
  const f=$("flash"); f.className="flash "+kind;
  setTimeout(()=>f.className="flash",700);
}

export function toast(msg){
  const t=$("toast"); t.textContent=msg; t.style.display="block";
  clearTimeout(toast._t); toast._t=setTimeout(()=>t.style.display="none",2600);
}

export function pointBurst(headline, detail, kind="good"){
  const b=$("pointBurst"); if(!b) return;
  $("pointHeadline").textContent=headline;
  $("pointDetail").textContent=detail;
  b.className="pointBurst "+kind;
  void b.offsetWidth; // restart the animation
  b.classList.add("show");
  clearTimeout(pointBurst._t);
  pointBurst._t=setTimeout(()=>b.classList.remove("show"),1300);
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
  my:{ key:null,history:createGuessHistory(2),shownFill:0,fillAt:0 },
  rival:{ key:null,history:createGuessHistory(2),shownFill:0,fillAt:0 },
};

function resetMatchSide(prefix, key){
  const slot=matchGuess[prefix];
  if(slot.key===key) return slot;
  slot.key=key;
  slot.shownFill=0;
  slot.fillAt=0;
  resetGuessHistory(slot.history);
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
  if(!cd) return;
  const next=String(value);
  if(cd.textContent===next) return false;
  cd.textContent=next;
  cd.classList.remove("tick"); void cd.offsetWidth; cd.classList.add("tick");
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
    if(pct) pct.textContent=Math.round(current.pct*100)+"%";
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
    const fill=$("v1WordFill");
    if(fill && g?.word){
      const current=mySlot?.history.items[0];
      const targetIsDisplayed=current?.label===g.word;
      const displayedConfidence=targetIsDisplayed
        ? Math.max(0,Math.min(1,current?.pct||0))
        : 0;
      const targetProgress=localLocked
        ? 1
        : Math.max(0,Math.min(1,displayedConfidence/THRESH));
      if(localLocked){
        mySlot.shownFill=1;
        mySlot.fillAt=performance.now();
      }else{
        const next=advanceRecognitionFill(
          mySlot.shownFill,targetProgress,mySlot.fillAt);
        mySlot.shownFill=next.value;
        mySlot.fillAt=next.at;
      }
      fill.style.width=(mySlot.shownFill*95)+"%";
      const card=$("vsWordCard");
      const activePhase=g.mode==="vs" ||
        ["word","chase","sudden"].includes(g.roundPhase);
      const canShake=activePhase && !localLocked;
      setWordRecognitionMotion(card,mySlot.shownFill*THRESH,THRESH,canShake);
    }
    fitMatchPaperText();
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
    if(b.classList.contains("delall")){
      if(confirm('Delete ALL clips of “'+lab+'”?')) state.dataset.clips=state.dataset.clips.filter(c=>c.label!==lab);
    }else{
      const i=state.dataset.clips.map(c=>c.label).lastIndexOf(lab);
      if(i>=0) state.dataset.clips.splice(i,1);
    }
    renderClasses();
  });
}
