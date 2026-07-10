/* Everything that writes to the DOM outside of screen routing. */

import { $, esc } from "./dom.js";
import { state } from "./state.js";
import { fakeRivalGuesses } from "./rival.js";

/* ---------------- transient feedback ---------------- */
export function showStatus(msg){
  const s=$("status");
  if(!msg){ s.style.display="none"; return; }
  s.style.display="flex"; s.textContent=msg;
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
  pointBurst._t=setTimeout(()=>b.classList.remove("show"),1350);
}

/* ---------------- guess list ---------------- */
const CROWN = '<img class="crown" src="assets/crown.png" alt="">';
const ARROW_UP = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V6M6 12l6-6 6 6"/></svg>';

export const topGuesses = (n=5) => Object.entries(state.smooth).sort((a,b)=>b[1]-a[1]).slice(0,n);

function guessRows(top, limit=5){
  const html=[];
  for(let i=0;i<Math.min(limit, top.length);i++){
    const lab=top[i][0], p=top[i][1];
    const name = lab==="idle" ? "just standing" : esc(lab);
    const rose = (state.prevRank[lab]!==undefined && state.prevRank[lab]>i);
    const pctHtml = Math.round(p*100)+"%"+(i===0&&rose?ARROW_UP:"");
    html.push('<div class="grow'+(i===0?' first':'')+'">'+(i===0?CROWN:'')+
      '<span class="rank">'+(i+1)+'</span><span class="gname">'+name+'</span>'+
      '<span class="gpct">'+pctHtml+'</span></div>');
  }
  return html.join("");
}

function setSegbar(id, pct){
  const el=$(id); if(!el) return;
  const on=Math.round(pct/100*6);
  [...el.children].forEach((seg,i)=>seg.classList.toggle("on", i<on));
}

export function renderGuesses(){
  const top=topGuesses(5);
  if(!top.length) return;
  if(state.screen==="play"){
    const pct=Math.round((top[0][1]||0)*100);
    $("confBig").textContent=pct+"%";
    setSegbar("segbar", pct);
    $("guessList").innerHTML=guessRows(top,5);
  } else if(state.screen==="train") {
    $("trainGuessList").innerHTML=guessRows(top,5);
  } else if(state.screen==="versus") {
    const pct=Math.round((top[0][1]||0)*100);
    setSegbar("segbarVsYou", pct);
    $("guessListVsYou").innerHTML=guessRows(top,4);
    if(state.game?.mode!=="online"){
      // online: the rival's AI runs on their device; online.js sets a static note
      const rtop=fakeRivalGuesses();
      const rpct=rtop.length?Math.round(rtop[0][1]*100):0;
      setSegbar("segbarVsRival", rpct);
      $("guessListVsRival").innerHTML=guessRows(rtop,4);
    }
  }
  state.prevRank={}; top.forEach((g,i)=>state.prevRank[g[0]]=i);
}

/* ---------------- recorded class list ---------------- */
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
