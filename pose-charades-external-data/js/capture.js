/* Recording clips for training. The render loop feeds frames in via
   state.recording; this module owns the start/stop edges. */

import { $ } from "./dom.js";
import { state } from "./state.js";
import { flash, toast, renderClasses, setCountdown } from "./ui.js";
import { blip } from "./audio.js";
import { gameState, onTransition } from "./fsm.js";
import { JOINTS } from "./constants.js";

let countIn = null;
let ticker = null;

const RECORD_LABEL = "Record clip (3·2·1)";

/* The button is the only control on screen while a clip arms and runs, so it
   doubles as the way out. Without this, pressing record committed you to the
   full clip with no feedback and no escape. */
function setArmed(armed){
  const btn = $("btnRecord"), label = $("recordLabel");
  if(btn) btn.classList.toggle("recording", armed);
  if(label) label.textContent = armed ? "Cancel" : RECORD_LABEL;
}

/* Leaving Training mid-3·2·1 used to arm the recorder anyway: the interval
   was never cancelled, so state.recording was set on whatever screen the
   player had walked to, #recdot appeared over a live match, and the clip was
   saved under the wrong label. Cancelling on the way out is the whole fix. */
export function cancelRecording(){
  if(countIn){ clearInterval(countIn); countIn = null; }
  if(ticker){ clearInterval(ticker); ticker = null; }
  $("countdown").classList.add("hidden");
  $("recdot").style.display = "none";
  const left = $("recLeft"); if(left) left.textContent = "";
  const btn = $("btnRecord"); if(btn) btn.disabled = false;
  setArmed(false);
  state.recording = null;
}

onTransition((to, from) => {
  if(from === "training" && to !== "training") cancelRecording();
});

export function startRecording(){
  /* already running? the button is CANCEL now */
  if(countIn || state.recording){ cancelRecording(); blip([392,294],.05); return; }

  const label=$("classInput").value.trim().toLowerCase();
  if(!label){
    /* .focus() alone read as the button being broken */
    toast("Type or pick a word first. That's the label this clip trains.");
    const input=$("classInput");
    input.focus();
    input.classList.remove("nudge"); void input.offsetWidth; input.classList.add("nudge");
    blip([330,262],.05);
    return;
  }
  const person=$("personInput").value.trim().toLowerCase()||"unknown";
  const secs=+$("clipLen").value;
  let n=3; const cd=$("countdown"); cd.classList.remove("hidden"); setCountdown(n);
  setArmed(true);
  clearInterval(countIn);
  countIn=setInterval(()=>{
    if(gameState()!=="training"){ cancelRecording(); return; }
    n--; if(n>0){ setCountdown(n); return; }
    clearInterval(countIn); countIn=null; cd.classList.add("hidden");
    $("recdot").style.display="flex";
    state.recording={ label, person, frames:[], endAt: performance.now()+secs*1000 };
    /* count the clip down so the pose has a visible finish line */
    clearInterval(ticker);
    ticker=setInterval(()=>{
      const r=state.recording;
      if(!r){ clearInterval(ticker); ticker=null; return; }
      const left=Math.max(0,Math.ceil((r.endAt-performance.now())/1000));
      const el=$("recLeft"); if(el) el.textContent=left+"s";
    },100);
  },800);
}

/* ── FRAMING ───────────────────────────────────────────────────────────────
   Frames are hip-centred and scaled by the torso (shoulder-mid to hip-mid), so
   an ankle's y IS its depth below the hips measured in torso lengths. On a
   standing adult that is about 1.5. Anything much under it means the ankles
   are not in the picture and MediaPipe is extrapolating them: the numbers keep
   arriving, they just describe legs it cannot see.

   This was worth checking because it had already happened to the whole shipped
   deck. Thirty of its thirty-four clips sit between 0.99 and 1.39, so the
   classifier was being taught, over and over, from invented legs — and `squat`,
   whose entire signal is where the knees are relative to the hips, could never
   be learned from any of them.

   It WARNS and still saves. The clip is the player's, a short recording is
   cheap to redo, and refusing to keep work someone just performed is worse
   than telling them what is wrong with it. */
const ANKLES = [JOINTS.indexOf(27), JOINTS.indexOf(28)].filter(i => i >= 0);
const FULL_BODY_ANKLE_DEPTH = 1.30;

function ankleDepth(frames){
  if(!ANKLES.length) return null;
  const depths = [];
  for(const f of frames){
    let sum = 0, n = 0;
    for(const i of ANKLES){
      const p = f[i];
      if(!p) continue;
      sum += p[1]; n++;
    }
    if(n) depths.push(sum / n);
  }
  if(!depths.length) return null;
  /* median, not mean: one frame where the tracker lost the feet entirely
     should not decide whether a whole clip gets flagged */
  depths.sort((a, b) => a - b);
  const mid = depths.length >> 1;
  return depths.length % 2 ? depths[mid] : (depths[mid - 1] + depths[mid]) / 2;
}

export function finishRecording(){
  const r=state.recording; state.recording=null;
  if(ticker){ clearInterval(ticker); ticker=null; }
  $("recdot").style.display="none";
  const left=$("recLeft"); if(left) left.textContent="";
  $("btnRecord").disabled=false;
  setArmed(false);
  if(r.frames.length<15){ flash("bad"); toast("Too short. Couldn’t see you: more light, step back!"); return; }
  state.dataset.clips.push({label:r.label, person:r.person, ts:Date.now(), frames:r.frames});
  flash("good"); blip([660]); renderClasses();
  const depth = ankleDepth(r.frames);
  const cropped = depth !== null && depth < FULL_BODY_ANKLE_DEPTH;
  /* A recorded word is in the LIST but not yet in the MODEL. Deleting a clip
     retrains immediately, so leaving a record un-marked made the two paths
     disagree about whether the AI had caught up. */
  markModelStale(cropped
    /* One toast, not two: the framing is the more useful sentence, and a
       second toast would only replace the first before it could be read. */
    ? "Clip saved, but your legs were out of shot. Step back so your feet are in the picture, then record it again."
    : "Clip saved. Press TRAIN THE AI to teach it.");
  if(cropped) flash("bad");
}

/* the TRAIN button is the thing that closes the gap, so it is what pulses */
function markModelStale(message){
  const btn=$("btnTrain");
  if(!btn) return;
  btn.classList.add("stale");
  toast(message, 4200);
}
export function clearModelStale(){ $("btnTrain")?.classList.remove("stale"); }
