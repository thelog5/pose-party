/* Recording clips for training. The render loop feeds frames in via
   state.recording; this module owns the start/stop edges. */

import { $ } from "./dom.js";
import { state } from "./state.js";
import { flash, toast, renderClasses, setCountdown } from "./ui.js";
import { blip } from "./audio.js";

export function startRecording(){
  const label=$("classInput").value.trim().toLowerCase();
  if(!label){ $("classInput").focus(); return; }
  const person=$("personInput").value.trim().toLowerCase()||"unknown";
  const secs=+$("clipLen").value;
  let n=3; const cd=$("countdown"); cd.classList.remove("hidden"); setCountdown(n);
  $("btnRecord").disabled=true;
  const t=setInterval(()=>{
    n--; if(n>0){ setCountdown(n); return; }
    clearInterval(t); cd.classList.add("hidden");
    $("recdot").style.display="flex";
    state.recording={ label, person, frames:[], endAt: performance.now()+secs*1000 };
  },800);
}

export function finishRecording(){
  const r=state.recording; state.recording=null;
  $("recdot").style.display="none";
  $("btnRecord").disabled=false;
  if(r.frames.length<15){ flash("bad"); toast("Too short — couldn’t see you. More light, step back!"); return; }
  state.dataset.clips.push({label:r.label, person:r.person, ts:Date.now(), frames:r.frames});
  flash("good"); blip([660]); renderClasses();
}
