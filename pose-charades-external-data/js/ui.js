/* DOM writers: guess panels, camera pill, toasts, flashes, class list. */

import { $, esc } from "./dom.js";
import { state } from "./state.js";
import { fakeRivalGuesses } from "./rival.js";

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

export const fmtTime = ms => {
  const s=Math.max(0,Math.ceil(ms/1000));
  return String(Math.floor(s/60)).padStart(2,"0")+":"+String(s%60).padStart(2,"0");
};

export const fmtScore = n => (n|0).toLocaleString("en-US");

/* ---------------- guess rendering ---------------- */
export const topGuesses = (n=5) => Object.entries(state.smooth).sort((a,b)=>b[1]-a[1]).slice(0,n);

const displayName = lab => lab==="idle" ? "just standing" : lab;

/* fill one "AI'S TOP GUESS" panel: big word + robot % + 12-seg meter + rows */
export function fillGuessPanel(prefix, top, rows=4){
  const best=top[0];
  const pct=best?Math.round(best[1]*100):0;
  $(prefix+"TopWord").textContent = best ? displayName(best[0]).toUpperCase() : "…";
  $(prefix+"TopPct").textContent = pct+"%";
  const segs=$(prefix+"Meter").children;
  const on=Math.round(pct/100*segs.length);
  [...segs].forEach((seg,i)=>seg.classList.toggle("on", i<on));
  const html=[];
  for(let i=1;i<Math.min(1+rows,top.length);i++){
    const p=Math.round(top[i][1]*100);
    html.push('<div class="grow"><span class="rank">'+(i+1)+'</span>'+
      '<span class="gname">'+esc(displayName(top[i][0]))+'</span>'+
      '<span class="gbar"><i style="width:'+p+'%"></i></span>'+
      '<span class="gpct">'+p+'%</span></div>');
  }
  $(prefix+"GuessList").innerHTML=html.join("");
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
    fillGuessPanel("my", top, 2);
    if(state.game?.mode==="vs"){
      // practice mode: the robot rival's "AI" runs right here
      fillGuessPanel("rival", fakeRivalGuesses(), 2);
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
    if(b.classList.contains("delall")){
      if(confirm('Delete ALL clips of “'+lab+'”?')) state.dataset.clips=state.dataset.clips.filter(c=>c.label!==lab);
    }else{
      const i=state.dataset.clips.map(c=>c.label).lastIndexOf(lab);
      if(i>=0) state.dataset.clips.splice(i,1);
    }
    renderClasses();
  });
}
