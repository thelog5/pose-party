/* MediaPipe setup, camera, and the per-frame render/sample loop. */

/* Version here must match MEDIAPIPE_VERSION in constants.js (which builds the
   matching wasm URL). Import specifiers can't be interpolated. */
import { PoseLandmarker, HandLandmarker, FaceLandmarker, FilesetResolver } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";

import { $ } from "./dom.js";
import { state } from "./state.js";
import { JOINTS, WASM_URL, POSE_MODEL_URL, HAND_MODEL_URL,
         FACE_MODEL_URL, SAMPLE_MS } from "./constants.js";
import { isSlowComputer, setSlowComputer } from "./speed.js";
import { normalize } from "./pose.js";
import { createLandmarkFilter, filterLandmarks } from "./smooth.js";
import { drawSkeleton } from "./draw.js";
import { features, classifyDetailed } from "./classifier.js";
import { assessPose, observePose, resetPoseInput, windowJointMask,
         MIN_POSE_SAMPLES, POSE_GAP_MS, poseQualityMessage } from "./poseInput.js";
import { showStatus, renderGuesses, updateMoveBack } from "./ui.js";
import { finishRecording } from "./capture.js";
import { gameCheck } from "./game.js";
import { setModelOutput } from "./soloRound.js";
import { notePresence, presence } from "./presence.js";
import { setRobotFeetHidden } from "./robot.js";
import { statsTick } from "./wordStats.js";
import { requestCameraConsent, retryCameraConsent, closeCameraGate,
         hasCameraGate, setBootProgress, setBootReady,
         setBootFailed } from "./cameraGate.js";

const CLASSIFY_EVERY_MS = 250;
/* The classifier samples at ~15 Hz. Party caps landmark inference at 30 Hz,
   leaving a full extra pose frame between samples while freeing headroom for
   its WebRTC mesh and remote-video decoding. */
const PARTY_VISION_MIN_MS = 30;
const CAMERA_PLAY_TIMEOUT_MS = 1400;

/* SPEED: WHICH DELEGATE, AND IS THIS A SLOW COMPUTER.
   Every pose model call blocks the page until it returns, so a slow call
   slows the WHOLE game, not only the dots. Measured with e2e/_perf.mjs and
   e2e/_perfmodels.mjs:
   - On an M2 a call takes 14-23ms whatever the model, frame size or delegate.
     That is a wait on the graphics chip, not work.
   - With no usable graphics chip (blocked driver, hardware acceleration off,
     a virtual machine), Chrome runs WebGL in software. The GPU delegate then
     takes ~190ms a call and the CPU delegate ~14ms. The game ran at 5 frames
     a second and the dots trailed the body. So the GPU delegate is not used
     on a software renderer, and on any machine where it is slow the CPU
     delegate is timed once and kept if it is faster.
   - `lite` was not faster than `full` on either delegate. That was measured
     on the fake camera, with no person in shot (the detector path), so it is
     not proof for the landmark path. The model stays `full` until a slow
     computer is measured with a person in front of it. */
const TRY_CPU_MS = 30;       // median GPU call over this: time the CPU delegate
const SLOW_ENTER_MS = 32;    // median call over this: slow computer
const SLOW_LEAVE_MS = 22;    // back under this: not slow any more
const SPEED_CALLS = 40;      // calls in the median
/* A slow computer runs the model at the classifier's own sample rate. Faster
   than that only spends time the rest of the page needs. The 6ms is timing
   slack, so a 30 fps camera gives every other frame. */
const SLOW_VISION_MIN_MS = SAMPLE_MS - 6;
/* A body lost for this many camera frames resets the motion window, never
   fewer than POSE_GAP_MS. At 7 frames a second one missed frame is 150ms. */
const LOST_FRAMES = 2.5;
const speed = { delegate:"GPU", recent:[], calls:0, tried:false, trial:null, frameMs:33 };
let engineLandmarker = null;
const median = list => { const s = [...list].sort((a, b) => a - b); return s[s.length >> 1]; };

function softwareGraphics(){
  try{
    const gl = document.createElement("canvas").getContext("webgl2");
    if(!gl) return true;   // no WebGL2: the GPU delegate cannot run
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    const name = String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return /swiftshader|llvmpipe|softpipe|software|basic render/i.test(name);
  }catch(e){ return false; }
}

/* Spelled out rather than left on the .5 defaults. Detection is loosened
   because a player mid-word is often a shape the
   detector has never been shown; presence and tracking are tightened because
   the failure this addresses is the opposite one — the tracker holding on to
   a body that has left, or half-left, the frame and drawing its guess at full
   confidence. Losing the skeleton for a frame is honest; painting an invented
   one is not. */
const poseOptions = delegate => ({
  baseOptions:{ modelAssetPath:POSE_MODEL_URL, delegate },
  runningMode:"VIDEO", numPoses:1,
  minPoseDetectionConfidence:.4,
  minPosePresenceConfidence:.6,
  minTrackingConfidence:.6,
  outputSegmentationMasks:false,
});

/* Time the CPU delegate on the live camera for a few calls, then keep the
   faster of the two. Runs at most once. */
function tryCpuDelegate(gpuMs){
  speed.tried = true;
  speed.trial = { pending:true };
  PoseLandmarker.createFromOptions(visionRuntime, poseOptions("CPU")).then(cpu => {
    if(state.landmarker !== engineLandmarker){ cpu.close(); speed.trial = null; return; }
    speed.trial = { gpu:engineLandmarker, cpu, gpuMs, times:[], warm:3 };
    state.landmarker = cpu;
  }).catch(e => {
    speed.trial = null;
    console.warn("CPU pose delegate could not load; keeping the GPU one.", e);
  });
}

function endCpuTrial(){
  const { gpu, cpu, gpuMs, times } = speed.trial;
  const cpuMs = median(times);
  const keep = cpuMs < gpuMs * .8;
  engineLandmarker = state.landmarker = keep ? cpu : gpu;
  (keep ? gpu : cpu).close();
  if(keep) speed.delegate = "CPU";
  console.info(`Pose model: GPU ${gpuMs.toFixed(0)}ms a frame, CPU ${cpuMs.toFixed(0)}ms. Using ${speed.delegate}.`);
  speed.trial = null;
  speed.recent.length = 0;
}

/* Called after every model call with how long it blocked the page. */
function noteModelCall(ms){
  const trial = speed.trial;
  if(trial?.times){
    if(state.landmarker !== trial.cpu){ trial.cpu.close(); speed.trial = null; return; }
    if(trial.warm-- > 0) return;   // its first calls build its tracking
    trial.times.push(ms);
    if(trial.times.length >= 15) endCpuTrial();
    return;
  }
  const recent = speed.recent;
  recent.push(ms);
  if(recent.length > SPEED_CALLS) recent.shift();
  if(recent.length < SPEED_CALLS || ++speed.calls % 10) return;
  const typical = median(recent);
  /* Only the engine's own model is ever swapped; the suites stub it. */
  if(!speed.tried && speed.delegate === "GPU" && typical > TRY_CPU_MS &&
     state.landmarker === engineLandmarker) tryCpuDelegate(typical);
  if(speed.trial) return;   // judge the computer on the model it keeps
  if(!isSlowComputer() && typical > SLOW_ENTER_MS){
    setSlowComputer(true);
    console.info(`Slow computer: pose model ${typical.toFixed(0)}ms a frame. Lighter video, no face model.`);
  }else if(isSlowComputer() && typical < SLOW_LEAVE_MS) setSlowComputer(false);
}
let video, overlay, ctx;
let lastClassifyT = 0;
let lastVisionT = -Infinity;
let lastVideoTime = -1;
let loopArmed = false;
let cameraWatchT = null;
let detectFails = 0;
let rebuilding = false;
let rebuildAfter = 0;
let rebuildWait = 2000;
let lastFaceTrackT = 0;
let lastFaceSeenT = -Infinity;
let visionRuntime = null;
const poseFilter = createLandmarkFilter();
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

/* Party reuses this whole tracking path for the same paper crown 1v1 wears —
   it sits ON the head of whoever the AI recognized FIRST this word, which is
   the one thing worth marking. (It used to be the GOT IT sticker pasted onto
   the forehead of everyone who got the word, so it said nothing about who
   actually won it, and it covered the face while they were still posing.) */
function placePartyCrown(topX, topY, faceWidth, faceHeight){
  const el=document.querySelector('#pmStage [data-seat].mine .pp-crown');
  const seat=el && el.closest('[data-seat]');
  if(!el || !seat || !seat.classList.contains("first")) return false;
  const mapped=mapVideoPoint(seat, topX, topY);
  if(!mapped) return false;

  const faceWidthPx=Math.max(1,faceWidth*mapped.renderedW);
  const faceHeightPx=Math.max(1,faceHeight*mapped.renderedH);
  /* Same distance-aware sizing as the 1v1 crown, in the seat's own box. */
  const crownW=Math.max(mapped.w*.16,
    Math.min(mapped.w*.62,faceWidthPx*1.18));
  const crownH=crownW*(420/640);
  const gapPx=Math.max(2,faceHeightPx*.04);

  el.classList.add("tracked");
  el.style.width=(crownW/mapped.w*100)+"%";
  el.style.left=Math.max(2,Math.min(98,mapped.x/mapped.w*100))+"%";
  /* top-left anchored (the CSS keeps translate:-50% 0), so subtract the paper
     height to hang it above the crown of the head rather than over the eyes */
  el.style.top=Math.max(-14,Math.min(72,
    (mapped.y-crownH-gapPx)/mapped.h*100))+"%";
  return true;
}

function placeLocalCrown(topX, topY, faceWidth, faceHeight){
  if(state.screen==="pmatch") return placePartyCrown(topX,topY,faceWidth,faceHeight);
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
  /* the Figma paper crown (176:373) is 640×420 */
  const crownHeightPx=crownWidthPx*(420/640);
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
    /* only while YOU are wearing the crown — one player per word, so this is
       strictly less face inference than the old every-seat sticker */
    return mine?.classList.contains("first") ? 65 : 0;
  }
  if(state.screen==="match"){
    return $("matchStage")?.classList.contains("you-leading") ? 75 : 0;
  }
  return 0;
}

function ensureFaceLandmarker(){
  if(state.faceLandmarker || faceLoad || faceLoadFailed || !visionRuntime) return;
  faceLoad = FaceLandmarker.createFromOptions(visionRuntime,{
    baseOptions:{ modelAssetPath:FACE_MODEL_URL, delegate:speed.delegate },
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

/* Camera consent and model loading deliberately run in parallel. The old boot
   started the consent promise here, but did not call getUserMedia until after
   every MediaPipe download had finished. An early click therefore changed the
   button to ASKING… and then appeared to do nothing for the whole model load.

   A live video track is the browser's successful camera hand-off. Once we have
   one, attach it and release the ENABLE CAMERA gate immediately. Playback is
   started at the same time, but its promise is diagnostic rather than a lock:
   Safari/Chrome can transiently reject play() while metadata settles, and a
   usable stream must never leave the permission card stuck on screen. */
function liveVideoTrack(stream){
  return stream?.getVideoTracks?.().find(track => track.readyState !== "ended");
}

function stopStream(stream){
  for(const track of stream?.getTracks?.() || []){
    try{ track.stop(); }catch(e){}
  }
}

function playCamera(){
  video.autoplay = true;
  video.muted = true;
  video.playsInline = true;
  video.setAttribute("autoplay", "");
  try{
    const attempt = video.play();
    /* Some WebKit/Chromium media states return a promise that neither resolves
       nor rejects until another gesture. Bound it so camera boot and the
       inference loop cannot remain suspended behind an already-closed gate. */
    return new Promise(resolve => {
      let settled = false;
      const finish = error => {
        if(settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(error || null);
      };
      const timer = setTimeout(() => {
        const error = new Error("Camera preview did not start in time.");
        error.name = "TimeoutError";
        finish(error);
      }, CAMERA_PLAY_TIMEOUT_MS);
      Promise.resolve(attempt).then(() => finish(null), finish);
    });
  }catch(error){
    return Promise.resolve(error);
  }
}

async function acquireCamera(consent, control){
  while(!control.cancelled){
    await consent;
    if(control.cancelled) return null;
    let candidate = null;
    try{
      candidate = await navigator.mediaDevices.getUserMedia({
        /* `ideal`, not a fixed size: 480p across a whole standing body is a
           few hundred pixels of person, and the pose model crops its region of
           interest out of the frame we hand it — so a coarse frame is a coarse
           elbow. Every one of these degrades rather than failing if the camera
           cannot meet it. */
        video:{
          width:{ ideal:1280, min:640 },
          height:{ ideal:720, min:480 },
          frameRate:{ ideal:30, min:15 },
        }, audio:false,
      });
      if(control.cancelled){
        stopStream(candidate);
        return null;
      }
      if(!liveVideoTrack(candidate)){
        const error = new Error("The camera returned no live video track.");
        error.name = "NotFoundError";
        throw error;
      }

      state.mediaStream = candidate;
      video.srcObject = candidate;
      const playback = playCamera();

      /* Do not await playback here. A rejected or slow play() used to strand
         a successfully-authorized player behind this popup indefinitely. */
      closeCameraGate();
      return { stream:candidate, playback };
    }catch(e){
      stopStream(candidate);
      if(video.srcObject === candidate) video.srcObject = null;
      if(state.mediaStream === candidate) state.mediaStream = null;
      if(control.cancelled) return null;

      /* A refusal is recoverable on the same card. The no-card branch is only
         for incomplete/embedded markup where there is nowhere to offer retry. */
      if(!hasCameraGate()){
        showStatus("Camera blocked. Allow camera access for this page and refresh. (Opened as file://? Serve it locally: see README.)");
        return null;
      }
      consent = retryCameraConsent(e);
    }
  }
  return null;
}

function sizeCameraOverlay(){
  overlay.width = video.videoWidth || 640;
  overlay.height = video.videoHeight || 480;
}

/* Muted inline video normally starts immediately. If a browser still rejects
   that first attempt, retry after models/metadata settle and finally on the
   next real gesture. The gate is already gone because the stream is live; a
   later click can recover playback without asking for camera permission twice. */
async function settleCameraPlayback(firstAttempt){
  let error = await firstAttempt;
  if(error) error = await playCamera();
  if(!error) return true;

  console.warn("Camera stream connected; preview will resume on the next interaction.", error);
  const resume = () => {
    playCamera().then(nextError => {
      if(nextError) return;
      removeEventListener("pointerdown", resume, true);
      removeEventListener("keydown", resume, true);
      sizeCameraOverlay();
    });
  };
  addEventListener("pointerdown", resume, true);
  addEventListener("keydown", resume, true);
  return false;
}

export async function boot(){
  video=$("video"); overlay=$("overlay"); ctx=overlay.getContext("2d");

  /* Ask for consent FIRST, but don't wait on it yet. The card goes up now,
     Home is held behind it (see .home-held), and the several megabytes of
     wasm and model below download while the player reads it. Nothing here
     gates the download — the gate only holds `getUserMedia`, which is the
     single call that needs a human. A returning player whose grant is still
     on file never sees the card and this resolves immediately. */
  const consent = requestCameraConsent();
  /* Start this worker now, not below the model downloads. It waits on the
     card's button promise, so getUserMedia remains a direct consequence of
     the player's click even when the pose engine is still downloading. */
  const cameraControl = { cancelled:false };
  const cameraReady = acquireCamera(consent, cameraControl);

  let vision;
  try{
    setBootProgress("STARTING THE POSE ENGINE");
    vision = await FilesetResolver.forVisionTasks(WASM_URL);
    visionRuntime = vision;
    setBootProgress("LOADING THE BODY MODEL");
    speed.delegate = softwareGraphics() ? "CPU" : "GPU";
    try{
      state.landmarker = await PoseLandmarker.createFromOptions(vision, poseOptions(speed.delegate));
    }catch(e){
      /* A GPU delegate that cannot start used to end the boot here. The CPU
         delegate runs everywhere wasm does. */
      if(speed.delegate !== "GPU") throw e;
      console.warn("GPU pose delegate failed; using the CPU one.", e);
      speed.delegate = "CPU";
      state.landmarker = await PoseLandmarker.createFromOptions(vision, poseOptions("CPU"));
    }
    if(speed.delegate === "CPU") speed.tried = true;
    engineLandmarker = state.landmarker;
  }catch(e){
    cameraControl.cancelled = true;
    /* getUserMedia itself cannot be aborted. If it is already in flight, stop
       the returned tracks as soon as it settles so a failed pose engine never
       leaves the camera light on behind an unusable app. */
    cameraReady.then(camera => {
      if(!camera) return;
      stopStream(camera.stream);
      if(state.mediaStream === camera.stream) state.mediaStream = null;
      if(video.srcObject === camera.stream) video.srcObject = null;
    });
    /* showStatus paints the camera dock, which on Home is parked out of
       sight — so the card the player is actually looking at has to say it. */
    setBootFailed("COULDN’T LOAD THE POSE ENGINE");
    return showStatus("Couldn’t load the pose engine. Check your internet connection and refresh.");
  }

  /* Hands are a nice-to-have: the body model alone still plays the game. */
  try{
    setBootProgress("LOADING HAND TRACKING");
    state.handmarker = await HandLandmarker.createFromOptions(vision,{
      baseOptions:{ modelAssetPath:HAND_MODEL_URL, delegate:speed.delegate },
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
  setBootReady();

  const camera = await cameraReady;
  if(!camera) return;
  await settleCameraPlayback(camera.playback);
  sizeCameraOverlay();
  showStatus(null);
  scheduleLoop();
  watchCamera();
}

/* Learned from the deck by buildModel, so a new word needs no code change. */
const needsLegs = label => !!label && !!state.model?.legLabels?.includes(label);

function classifyLive(now){
  const input=state.poseInput;
  /* No body, or not enough of one: there is nothing to guess, so the papers
     keep their last guess. They never say UNSURE. */
  if(!input.tracking || input.frames.length<MIN_POSE_SAMPLES){
    renderGuesses();
    return;
  }
  if(input.sampleAt<=input.predictedSampleAt) return;
  input.predictedSampleAt=input.sampleAt;
  const jointMask=windowJointMask(input);
  input.predictionMask=jointMask;
  /* THE AI ALWAYS COMMITS TO ITS BEST GUESS (reject:false). It used to drop
     any window that was not close enough to a training example and show
     UNSURE, which in a guessing game means the guesser is not playing. The
     charge rule still decides what scores: the raw guess AND the smoothed top
     guess must both be the word, held over time. */
  const result=jointMask.filter(Boolean).length>=9
    ? classifyDetailed(features(input.frames), state.model, {jointMask, reject:false})
    : {scores:{},accepted:false,label:null,confidence:0};
  const scores=result.scores;
  input.predictionAt=now;
  input.accepted=!!result.label;
  input.predictionLabel=result.label;
  input.predictionNeedsLegs=needsLegs(result.label);
  for(const lab of state.model.labels) state.smooth[lab]=0.65*(state.smooth[lab]||0)+0.35*(scores[lab]||0);
  if(state.game?.word) statsTick(result.label, state.smooth[state.game.word]);
  /* solo: RAW top guess funnels through setModelOutput every inference
     frame — soloRound.js owns all smoothing/debounce from there */
  if(state.game?.mode==="ai" && result.label){
    setModelOutput(result.label, result.confidence);
  }
  renderGuesses();
  if(state.game) gameCheck();
}

/* A camera is normally 30 fps while requestAnimationFrame is 60+ fps.
   requestVideoFrameCallback prevents re-running MediaPipe on duplicate camera
   frames; older browsers keep the existing RAF fallback. */
/* THE VISION LOOP HAD TWO WAYS TO DIE SILENTLY, AND A PHONE FINDS BOTH.
   Reported as "it says 100% but the bar won't move and it just stops
   registering". Neither fault touches the meter or the papers, which is
   exactly why it looks like the detection code is broken: the guess cards
   keep the last text `renderGuesses()` wrote (so a card can sit at 100%
   forever) while the charge bar, still advanced by each mode's own rAF,
   sees `canRecognize()` go false on stale input and bleeds to its ratchet.

     1. THE CALLBACK CHAIN STOPS. `requestVideoFrameCallback` fires only when
        the video presents a new frame, so a video that PAUSES never re-arms
        the loop. iOS pauses the camera preview on an app switch, a lock, a
        call or Low Power Mode, and does not always resume it; an
        interruption can also leave the track muted with the element stalled.
        The RAF fallback survives this, which is why desktop never saw it.
     2. THE MODEL CALL THROWS. `detectForVideo` is unguarded, and a
        backgrounded phone loses its WebGL context routinely. `scheduleLoop()`
        runs first so the chain lives, and then every single frame throws:
        the loop is running perfectly and nothing is ever detected again.

   Recovery for both is cheap and idempotent, so the watchdog can be blunt.
   It runs on a timer rather than on frames, because the thing it is watching
   for is the absence of frames. */
const CAMERA_STALL_MS = 1500;
/* A lost GPU context throws on every call, so a handful in a row is the
   signal. Rebuilding is a model load; never more than one at a time. */
const DETECT_FAIL_LIMIT = 5;
const REBUILD_WAIT_MS = 2000;
const REBUILD_WAIT_MAX_MS = 30000;

function detectPose(now){
  try{
    const res = state.landmarker.detectForVideo(video, now);
    detectFails = 0;
    return res;
  }catch(e){
    if(++detectFails === 1) console.warn("Pose model call failed; retrying.", e);
    if(detectFails >= DETECT_FAIL_LIMIT) rebuildLandmarker(e);
    return null;
  }
}

/* The delegate is kept: a context loss says nothing about which one is
   faster, and `speed` has already paid for that measurement.

   A FAILED REBUILD MUST NOT BE RETRIED ON THE NEXT FRAME. `detectFails` only
   climbs while the calls keep throwing, so without a wait the failure path is
   a model download every 30ms on a device that is already in trouble. */
function rebuildLandmarker(cause){
  if(rebuilding || performance.now() < rebuildAfter) return;
  if(!visionRuntime || state.landmarker !== engineLandmarker) return;
  rebuilding = true;
  console.warn("Pose model stopped responding; rebuilding it.", cause);
  PoseLandmarker.createFromOptions(visionRuntime, poseOptions(speed.delegate)).then(fresh => {
    const old = engineLandmarker;
    engineLandmarker = state.landmarker = fresh;
    detectFails = 0;
    rebuildWait = REBUILD_WAIT_MS;
    try{ old?.close(); }catch(e){}
  }).catch(e => {
    /* Back off rather than give up: a context lost with the phone in a pocket
       comes back when the page does, and the player never asked for a reload. */
    rebuildWait = Math.min(rebuildWait * 2, REBUILD_WAIT_MAX_MS);
    console.warn("Pose model could not be rebuilt; waiting " + rebuildWait + "ms.", e);
  }).finally(() => {
    rebuilding = false;
    rebuildAfter = performance.now() + rebuildWait;
  });
}

/* Put playback back and re-arm the loop. Safe to call on any suspicion: a
   playing video ignores `play()` and an armed chain ignores `scheduleLoop()`. */
function nudgeCamera(){
  if(document.hidden || !video) return;
  const stream = state.mediaStream;
  if(stream && video.srcObject !== stream) video.srcObject = stream;
  if(video.paused || video.ended) playCamera();
  /* The equality guard would otherwise swallow the first frame back when the
     video resumes on the same `currentTime` it stopped at. */
  lastVideoTime = -1;
  scheduleLoop();
}

function watchCamera(){
  if(cameraWatchT) return;
  cameraWatchT = setInterval(() => {
    if(document.hidden || !state.landmarker) return;
    /* No live track is a camera that was stopped or revoked, not one that
       stalled, and re-playing a dead element would only spin. */
    if(!liveVideoTrack(state.mediaStream)) return;
    if(performance.now() - lastVisionT < CAMERA_STALL_MS) return;
    nudgeCamera();
  }, 1000);
  /* The events are not a second mechanism, only a faster one: coming back
     from a locked phone should not cost the player another second. */
  for(const type of ["pause", "stalled", "suspend", "ended", "emptied"])
    video.addEventListener(type, nudgeCamera);
  document.addEventListener("visibilitychange", () => {
    if(!document.hidden) nudgeCamera();
  });
}

/* ARMED ONCE. `requestVideoFrameCallback` only ever fires again if the VIDEO
   produces another frame, so the chain is not self-healing and it must not be
   doubled either: two chains mean two full model calls per frame on the one
   device that can least afford them. The watchdog below re-arms it, and this
   flag is what makes that call free when the chain is already alive. */
function scheduleLoop(){
  if(loopArmed) return;
  loopArmed = true;
  if(typeof video?.requestVideoFrameCallback === "function"){
    video.requestVideoFrameCallback(loop);
  }else{
    requestAnimationFrame(loop);
  }
}

function loop(){
  loopArmed = false;
  scheduleLoop();
  if(!state.landmarker || video.readyState<2) return;
  if(document.hidden){ resetPoseInput(state.poseInput); return; }
  if(video.currentTime===lastVideoTime) return;

  const now=performance.now();
  const minGap=Math.max(state.screen==="pmatch" ? PARTY_VISION_MIN_MS : 0,
    isSlowComputer() ? SLOW_VISION_MIN_MS : 0);
  if(now-lastVisionT<minGap) return;
  /* How often frames really arrive here. A long pause (a hidden tab) says
     nothing about the computer. */
  if(now-lastVisionT<1000) speed.frameMs+=.1*(now-lastVisionT-speed.frameMs);
  state.poseInput.lostMs=Math.max(POSE_GAP_MS, speed.frameMs*LOST_FRAMES);
  lastVisionT=now;
  lastVideoTime=video.currentTime;
  const callAt=performance.now();
  const res=detectPose(now);
  if(!res) return;
  noteModelCall(performance.now()-callAt);
  /* Live classification consumes only the 15 body landmarks. The hand model
     is reserved for Training/recording, where its points are actually drawn
     and exported, instead of doubling inference work during every match. */
  const needsHands = state.screen==="train" || !!state.recording;
  const handRes=needsHands && state.handmarker
    ? state.handmarker.detectForVideo(video, now)
    : null;
  /* A slow computer places the crown from the pose points it already has.
     The face model is a second full model call on top of the pose one. */
  const crownEvery=faceTrackingInterval();
  const faceEvery=isSlowComputer() ? 0 : crownEvery;
  if(faceEvery) ensureFaceLandmarker();

  ctx.clearRect(0,0,overlay.width,overlay.height);

  /* Filtered ONCE, here, so the overlay the player watches and the frames the
     classifier reads are the same numbers. Filtering only one of them would
     make the dots agree with the body while the AI still saw the jitter, or
     the reverse. Recording goes through the same path, so clips captured from
     now on match what live inference sees. */
  const rawLandmarks=res.landmarks?.[0];
  const quality=assessPose(rawLandmarks);
  const lm = filterLandmarks(poseFilter, rawLandmarks, now);
  const camera={width:video.videoWidth,height:video.videoHeight};
  const f=lm && quality.usable ? normalize(lm, handRes, camera) : null;
  const generation=state.poseInput.generation;
  observePose(state.poseInput, f, quality, now);
  if(generation!==state.poseInput.generation){
    for(const label of Object.keys(state.smooth)) state.smooth[label]=0;
  }
  const guidance=poseQualityMessage(quality, needsLegs(state.recording?.label || state.game?.word),
    !!state.recording || state.screen==="train");
  /* THE CAPTION BOX IS TRAINING ONLY. In a match it was a dark rounded box
     under the paper HUD, behind the WORD card. Framing in play is MOVE BACK's
     job (head or hips out of shot), and the one thing it cannot say, that a
     leg word needs the legs, the robot says in his own paper bubble. */
  const hint=$("poseHint");
  if(hint){
    const text=state.screen==="train" ? guidance : "";
    if(hint.textContent!==text) hint.textContent=text;
    hint.hidden=!text;
  }
  setRobotFeetHidden(["solo","match","pmatch"].includes(state.screen) &&
    needsLegs(state.game?.word) && !!quality?.torso && !quality.legs);
  if(state.recording){
    const r=state.recording;
    r.observed++;
    if(f){
      r.frames.push(f);
      r.timestamps.push(now-r.startedAt);
      r.visibility.push(JOINTS.map(j=>rawLandmarks[j]?.visibility ?? 0));
      r.inFrame.push(JOINTS.map(j=>{
        const p=rawLandmarks[j]; return !!p && p.x>=0 && p.x<=1 && p.y>=0 && p.y<=1;
      }));
      if(!quality.fullBody) r.rejected++;
    }else r.rejected++;
  }
  /* Unconditional, and ahead of the crown/skeleton/sample block so it reads
     the landmarks before anything else can consume them: presence.js needs the
     empty frames too, or its "how long since we saw you" clock never runs. */
  notePresence(lm, now);
  /* Straight after, on the same reading, and unconditionally — a frame with no
     body has to reach it too, or a warning stays on screen after the player
     walks out of shot. */
  updateMoveBack(presence(), now);
  if(lm){
    if(crownEvery && (!faceEvery || now-lastFaceSeenT>350)) positionLocalCrownFromPose(lm);
    drawSkeleton(lm, handRes, ctx, overlay);
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
  if(state.model && now-lastClassifyT>CLASSIFY_EVERY_MS){ lastClassifyT=now; classifyLive(now); }
}
