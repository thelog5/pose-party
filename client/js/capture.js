/* Recording clips for training. The render loop feeds frames in via
   state.recording; this module owns the start/stop edges. */

import { $ } from "./dom.js";
import { state } from "./state.js";
import { flash, toast, renderClasses, setCountdown } from "./ui.js";
import { blip } from "./audio.js";
import { gameState, onTransition } from "./fsm.js";
import { clipSegments, POSE_SPACE } from "./poseInput.js";

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
  /* the per-word Record buttons stand down: the big button is CANCEL now */
  $("classList")?.classList.toggle("armed", armed);
}

/* A word's own Record button in the clip list: the same 3·2·1 and clip as the
   big button, with the word filled in, so the next big-button press repeats it. */
export function recordWord(label){
  if(countIn || state.recording) return;
  const input = $("classInput");
  if(input) input.value = label;
  startRecording();
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
    const startedAt=performance.now(), video=$("video");
    state.recording={ label, person, frames:[], timestamps:[], visibility:[], inFrame:[],
      coordinateSpace:POSE_SPACE, camera:{width:video.videoWidth,height:video.videoHeight},
      observed:0, rejected:0, startedAt, endAt:startedAt+secs*1000 };
    /* count the clip down so the pose has a visible finish line */
    clearInterval(ticker);
    ticker=setInterval(()=>{
      const r=state.recording;
      if(!r){ clearInterval(ticker); ticker=null; return; }
      if(performance.now()>=r.endAt){ finishRecording(); return; }
      const left=Math.max(0,Math.ceil((r.endAt-performance.now())/1000));
      const el=$("recLeft"); if(el) el.textContent=left+"s";
    },100);
  },800);
}

export function finishRecording(){
  const r=state.recording; state.recording=null;
  if(!r) return;
  if(ticker){ clearInterval(ticker); ticker=null; }
  $("recdot").style.display="none";
  const left=$("recLeft"); if(left) left.textContent="";
  $("btnRecord").disabled=false;
  setArmed(false);
  if(!clipSegments(r).some(frames=>frames.length>=15)){
    flash("bad"); toast("Couldn’t capture a clear second. Show your whole body, improve the lighting, and try again.", 5000); return;
  }
  state.dataset.clips.push({captureVersion:3,label:r.label, person:r.person, ts:Date.now(), frames:r.frames,
    timestamps:r.timestamps, visibility:r.visibility, inFrame:r.inFrame,
    coordinateSpace:r.coordinateSpace, camera:r.camera});
  flash("good"); blip([660]); renderClasses();
  const cropped = r.rejected > r.observed * .2;
  /* A recorded word is in the LIST but not yet in the MODEL. Deleting a clip
     retrains immediately, so leaving a record un-marked made the two paths
     disagree about whether the AI had caught up. */
  markModelStale(cropped
    /* One toast, not two: the framing is the more useful sentence, and a
       second toast would only replace the first before it could be read. */
    ? "Clip saved using its clear sections. Keep your whole body visible for a stronger take."
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
