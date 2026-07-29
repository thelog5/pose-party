/* MediaPipe setup, camera, and the per-frame render/sample loop. */

/* Version here must match MEDIAPIPE_VERSION in constants.js (which builds the
   matching wasm URL). Import specifiers can't be interpolated. */
import { PoseLandmarker, HandLandmarker, FaceLandmarker, FilesetResolver } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";

import { $ } from "./dom.js";
import { state } from "./state.js";
import { SAMPLE_MS, WIN, WASM_URL, POSE_MODEL_URL, HAND_MODEL_URL,
         FACE_MODEL_URL } from "./constants.js";
import { normalize } from "./pose.js";
import { drawSkeleton } from "./draw.js";
import { features, classify } from "./classifier.js";
import { showStatus, renderGuesses } from "./ui.js";
import { finishRecording } from "./capture.js";
import { gameCheck } from "./game.js";
import { setModelOutput } from "./soloRound.js";

const CLASSIFY_EVERY_MS = 250;
/* The classifier samples at ~15 Hz. Party caps landmark inference at 30 Hz,
   leaving a full extra pose frame between samples while freeing headroom for
   its WebRTC mesh and remote-video decoding. */
const PARTY_VISION_MIN_MS = 30;
let video, overlay, ctx;
let lastClassifyT = 0;
let lastVisionT = -Infinity;
let lastFaceTrackT = 0;
let lastFaceSeenT = -Infinity;
let visionRuntime = null;
let faceLoad = null;
let faceLoadFailed = false;

/* Map a normalized camera landmark through the exact mirrored object-fit:cover
   crop used by the match video. */
function mapVideoPoint(side, x, y){
  const w=side.clientWidth, h=side.clientHeight;
  if(!w || !h || !video.videoWidth || !video.videoHeight) return null;
  const scale=Math.max(w/video.videoWidth,h/video.videoHeight);
  const renderedW=video.videoWidth*scale, renderedH=video.videoHeight*scale;
  const cropX=(renderedW-w)/2, cropY=(renderedH-h)/2;
  return {
    x:(1-x)*renderedW-cropX,
    y:y*renderedH-cropY,
    w,h,renderedW,renderedH,
  };
}

/* Party reuses this whole tracking path, but its GOT IT paper lands ON the
   forehead instead of floating above the head like the 1v1 crown. */
function placePartySticker(topX, topY, faceWidth, faceHeight){
  const el=document.querySelector('#pmStage [data-seat].mine .pm-gotit');
  const seat=el && el.closest('[data-seat]');
  if(!el || !seat || !seat.classList.contains("got")) return false;
  const mapped=mapVideoPoint(seat, topX, topY);
  if(!mapped) return false;

  const faceWidthPx=Math.max(1,faceWidth*mapped.renderedW);
  const faceHeightPx=Math.max(1,faceHeight*mapped.renderedH);
  const stickerW=Math.max(mapped.w*.22,
    Math.min(mapped.w*.94,faceWidthPx*1.5));
  const stickerH=stickerW/4.2;
  /* Span the hairline/forehead rather than drifting into the face. */
  const centerY=mapped.y+faceHeightPx*.10;

  el.classList.add("tracked");
  el.style.width=(stickerW/mapped.w*100)+"%";
  el.style.left=Math.max(2,Math.min(98,mapped.x/mapped.w*100))+"%";
  el.style.top=Math.max(-6,Math.min(90,(centerY-stickerH/2)/mapped.h*100))+"%";
  el.style.translate="-50% 0";
  return true;
}

function placeLocalCrown(topX, topY, faceWidth, faceHeight){
  if(state.screen==="pmatch") return placePartySticker(topX,topY,faceWidth,faceHeight);
  if(state.screen!=="match") return false;
  const crown=$("v1YouCrown"), side=crown?.closest(".v1-video-side");
  if(!crown || !side) return false;
  const mapped=mapVideoPoint(side,topX,topY);
  if(!mapped) return false;

  /* Scale with the detected face, then place the crown's lower edge just
     above the mesh's top band. Moving closer therefore increases both crown
     size and clearance instead of letting a fixed nose offset cover a face. */
  const faceWidthPx=Math.max(1,faceWidth*mapped.renderedW);
  const faceHeightPx=Math.max(1,faceHeight*mapped.renderedH);
  const crownWidthPx=Math.max(mapped.w*.10,
    Math.min(mapped.w*.38,faceWidthPx*1.10));
  const crownHeightPx=crownWidthPx*(538/640);
  const gapPx=Math.max(3,faceHeightPx*.035);
  const crownCenterY=mapped.y-crownHeightPx*.54-gapPx;

  crown.style.width=(crownWidthPx/mapped.w*100)+"%";
  crown.style.left=Math.max(3,Math.min(97,mapped.x/mapped.w*100))+"%";
  crown.style.top=Math.max(-9,Math.min(54,crownCenterY/mapped.h*100))+"%";
  return true;
}

/* Face Landmarker supplies hundreds of local-only points. We never draw or
   transmit them; the top band and face bounds are used solely for the crown. */
function positionLocalCrownFromFace(face){
  const pts=(face||[]).filter(p=>Number.isFinite(p.x)&&Number.isFinite(p.y));
  if(pts.length<20) return false;
  const xs=pts.map(p=>p.x), ys=pts.map(p=>p.y);
  const minX=Math.min(...xs), maxX=Math.max(...xs);
  const minY=Math.min(...ys), maxY=Math.max(...ys);
  const faceWidth=maxX-minX, faceHeight=maxY-minY;
  if(faceWidth<.025 || faceHeight<.035) return false;
  const topBand=pts.filter(p=>p.y<=minY+faceHeight*.075);
  const topX=topBand.length
    ? topBand.reduce((sum,p)=>sum+p.x,0)/topBand.length
    : (minX+maxX)/2;
  return placeLocalCrown(topX,minY,faceWidth,faceHeight);
}

/* Pose landmarks remain a dynamic fallback while the optional face model is
   loading or if a face briefly leaves frame. Eye/ear width (or shoulder
   width) scales with camera distance, so this path also avoids fixed pixels. */
function positionLocalCrownFromPose(lm){
  if(!lm?.[0]) return false;
  const facePts=[1,2,3,4,5,6,7,8].map(i=>lm[i])
    .filter(p=>p&&Number.isFinite(p.x)&&Number.isFinite(p.y)&&(p.visibility??1)>.35);
  if(facePts.length>=4){
    const xs=facePts.map(p=>p.x), ys=facePts.map(p=>p.y);
    const minX=Math.min(...xs), maxX=Math.max(...xs);
    const minY=Math.min(...ys), maxY=Math.max(...ys);
    const width=Math.max(.025,maxX-minX);
    return placeLocalCrown((minX+maxX)/2,minY-width*.62,width,
      Math.max(maxY-minY,width*1.15));
  }
  const nose=lm[0], left=lm[11], right=lm[12];
  if((nose.visibility??1)<.4 || !left || !right) return false;
  const width=Math.max(.035,Math.abs(left.x-right.x)*.42);
  return placeLocalCrown(nose.x,nose.y-width*.72,width,width*1.2);
}

/* Face inference is significantly heavier than moving an already-rendered
   paper. Run it only while a crown/sticker is actually visible. This keeps
   facial points completely outside classification and restores the original
   pose sampling budget during recognition. */
function faceTrackingInterval(){
  if(state.screen==="pmatch"){
    const mine=document.querySelector('#pmStage [data-seat].mine');
    return mine?.classList.contains("got") ? 65 : 0;
  }
  if(state.screen==="match"){
    return $("matchStage")?.classList.contains("you-leading") ? 75 : 0;
  }
  return 0;
}

function ensureFaceLandmarker(){
  if(state.faceLandmarker || faceLoad || faceLoadFailed || !visionRuntime) return;
  faceLoad = FaceLandmarker.createFromOptions(visionRuntime,{
    baseOptions:{ modelAssetPath:FACE_MODEL_URL, delegate:"GPU" },
    runningMode:"VIDEO", numFaces:1,
    minFaceDetectionConfidence:.45,
    minFacePresenceConfidence:.45,
    minTrackingConfidence:.45,
    outputFaceBlendshapes:false,
    outputFacialTransformationMatrixes:false,
  }).then(model=>{
    state.faceLandmarker=model;
  }).catch(e=>{
    faceLoadFailed=true;
    state.faceLandmarker=null;
    console.warn("Face tracking could not load; scaled pose tracking will position the crown.",e);
  }).finally(()=>{
    faceLoad=null;
  });
}

export async function boot(){
  video=$("video"); overlay=$("overlay"); ctx=overlay.getContext("2d");

  let vision;
  try{
    vision = await FilesetResolver.forVisionTasks(WASM_URL);
    visionRuntime = vision;
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

  /* The face model is loaded lazily only once a crown/sticker is visible.
     Until then the recognition loop has the exact same pose/hand workload it
     had before head tracking existed. Face points remain crown-only. */
  state.faceLandmarker = null;

  try{
    const stream = await navigator.mediaDevices.getUserMedia({ video:{width:640,height:480}, audio:false });
    state.mediaStream=stream;
    video.srcObject=stream; await video.play();
  }catch(e){ return showStatus("Camera blocked. Allow camera access for this page and refresh. (Opened as file://? Serve it locally — see README.)"); }

  overlay.width=video.videoWidth; overlay.height=video.videoHeight;
  showStatus(null);
  scheduleLoop();
}

function classifyLive(){
  if(state.liveBuf.length<15) return;
  const scores=classify(features(state.liveBuf.slice(-WIN)), state.model);
  for(const lab of state.model.labels) state.smooth[lab]=0.65*(state.smooth[lab]||0)+0.35*(scores[lab]||0);
  /* solo: RAW top guess funnels through setModelOutput every inference
     frame — soloRound.js owns all smoothing/debounce from there */
  if(state.game?.mode==="ai"){
    let top=null;
    for(const k in scores) if(!top || scores[k]>scores[top]) top=k;
    if(top) setModelOutput(top, scores[top]);
  }
  renderGuesses();
  if(state.game) gameCheck();
}

/* A camera is normally 30 fps while requestAnimationFrame is 60+ fps.
   requestVideoFrameCallback prevents re-running MediaPipe on duplicate camera
   frames; older browsers keep the existing RAF fallback. */
function scheduleLoop(){
  if(typeof video?.requestVideoFrameCallback === "function"){
    video.requestVideoFrameCallback(loop);
  }else{
    requestAnimationFrame(loop);
  }
}

function loop(){
  scheduleLoop();
  if(!state.landmarker || video.readyState<2) return;
  if(document.hidden) return;

  const now=performance.now();
  if(state.screen==="pmatch" && now-lastVisionT<PARTY_VISION_MIN_MS) return;
  lastVisionT=now;
  const res=state.landmarker.detectForVideo(video, now);
  /* Live classification consumes only the 15 body landmarks. The hand model
     is reserved for Training/recording, where its points are actually drawn
     and exported, instead of doubling inference work during every match. */
  const needsHands = state.screen==="train" || !!state.recording;
  const handRes=needsHands && state.handmarker
    ? state.handmarker.detectForVideo(video, now)
    : null;
  const faceEvery=faceTrackingInterval();
  if(faceEvery) ensureFaceLandmarker();

  ctx.clearRect(0,0,overlay.width,overlay.height);

  const lm = res.landmarks && res.landmarks[0];
  if(lm){
    if(faceEvery && now-lastFaceSeenT>350) positionLocalCrownFromPose(lm);
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

  if(faceEvery && state.faceLandmarker && now-lastFaceTrackT>=faceEvery){
    lastFaceTrackT=now;
    try{
      const faceRes=state.faceLandmarker.detectForVideo(video,now);
      const face=faceRes.faceLandmarks?.[0];
      if(face && positionLocalCrownFromFace(face)) lastFaceSeenT=now;
    }catch(e){
      if(!positionLocalCrownFromFace._warned){
        positionLocalCrownFromFace._warned=true;
        console.warn("Face crown tracking paused; using pose-scale fallback.",e);
      }
    }
  }

  if(state.recording && now>=state.recording.endAt) finishRecording();
  if(state.model && now-lastClassifyT>CLASSIFY_EVERY_MS){ lastClassifyT=now; classifyLive(); }
}
