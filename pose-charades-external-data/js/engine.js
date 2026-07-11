/* MediaPipe setup, camera, and the per-frame render/sample loop. */

/* Version here must match MEDIAPIPE_VERSION in constants.js (which builds the
   matching wasm URL). Import specifiers can't be interpolated. */
import { PoseLandmarker, HandLandmarker, FilesetResolver } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";

import { $ } from "./dom.js";
import { state } from "./state.js";
import { SAMPLE_MS, WIN, WASM_URL, POSE_MODEL_URL, HAND_MODEL_URL } from "./constants.js";
import { normalize } from "./pose.js";
import { drawSkeleton } from "./draw.js";
import { features, classify } from "./classifier.js";
import { showStatus, renderGuesses } from "./ui.js";
import { finishRecording } from "./capture.js";
import { gameCheck } from "./game.js";

const CLASSIFY_EVERY_MS = 250;

let video, overlay, ctx;
let lastClassifyT = 0;

export async function boot(){
  video=$("video"); overlay=$("overlay"); ctx=overlay.getContext("2d");

  let vision;
  try{
    vision = await FilesetResolver.forVisionTasks(WASM_URL);
    state.landmarker = await PoseLandmarker.createFromOptions(vision,{
      baseOptions:{ modelAssetPath:POSE_MODEL_URL, delegate:"GPU" },
      runningMode:"VIDEO", numPoses:1
    });
  }catch(e){ return showStatus("Couldn’t load the pose engine. Check your internet connection and refresh."); }

  /* Hands are a nice-to-have: the body model alone still plays the game. */
  try{
    state.handmarker = await HandLandmarker.createFromOptions(vision,{
      baseOptions:{ modelAssetPath:HAND_MODEL_URL, delegate:"GPU" },
      runningMode:"VIDEO", numHands:2
    });
  }catch(e){
    state.handmarker = null;
    console.warn("Hand tracking could not load; body pose will still work.", e);
  }

  try{
    const stream = await navigator.mediaDevices.getUserMedia({ video:{width:640,height:480}, audio:false });
    state.mediaStream=stream;
    video.srcObject=stream; await video.play();
  }catch(e){ return showStatus("Camera blocked. Allow camera access for this page and refresh. (Opened as file://? Serve it locally — see README.)"); }

  overlay.width=video.videoWidth; overlay.height=video.videoHeight;
  showStatus(null);
  requestAnimationFrame(loop);
}

function classifyLive(){
  if(state.liveBuf.length<15) return;
  const scores=classify(features(state.liveBuf.slice(-WIN)), state.model);
  for(const lab of state.model.labels) state.smooth[lab]=0.65*(state.smooth[lab]||0)+0.35*(scores[lab]||0);
  renderGuesses();
  if(state.game) gameCheck();
}

function loop(){
  requestAnimationFrame(loop);
  if(!state.landmarker || video.readyState<2) return;

  const now=performance.now();
  const res=state.landmarker.detectForVideo(video, now);
  const handRes=state.handmarker ? state.handmarker.detectForVideo(video, now) : null;

  ctx.clearRect(0,0,overlay.width,overlay.height);

  const lm = res.landmarks && res.landmarks[0];
  if(lm){
    drawSkeleton(lm, handRes, ctx, overlay);
    if(now-state.lastSampleT >= SAMPLE_MS){
      state.lastSampleT=now;
      const f=normalize(lm, handRes);
      if(f){
        state.liveBuf.push(f); if(state.liveBuf.length>WIN) state.liveBuf.shift();
        if(state.recording) state.recording.frames.push(f);
      }
    }
  }

  if(state.recording && now>=state.recording.endAt) finishRecording();
  if(state.model && now-lastClassifyT>CLASSIFY_EVERY_MS){ lastClassifyT=now; classifyLive(); }
}
