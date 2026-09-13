/* ENABLE CAMERA — the boot gate.

   The whole game is a webcam pointed at your body, and until this existed the
   app asked for that with the browser's own permission chip and nothing else:
   Home built itself, played its full paper entrance, and then sat there fully
   assembled and completely dead while an unexplained grey bar hung off the
   address bar. Every card was clickable and every one of them failed.

   So the boot now has a front door. While it is open:

   · HOME IS HELD, NOT HIDDEN. `.home-held` parks every paper at the exact
     state its entrance starts from — the wallpaper and the waves are up, and
     nothing else is. A finished screen sitting behind a scrim reads as a
     screen that is being withheld from you; a screen that is visibly still
     arriving reads as one that is loading. When the gate closes, the papers
     fly in for real (homeAlive's existing entrance) instead of just having
     been there the whole time.
   · THE ENGINE LOADS BEHIND IT. MediaPipe's wasm + the two model files are
     several megabytes and take longer than anyone reads three lines of copy,
     so they download while the card is up and the card says so — `progress()`
     drives a paper loading strip. Nothing here gates the download; the gate
     only holds `getUserMedia`, which is the one call that needs a human.
   · THE ROBOT IS THE SAME RIG. Not a still: `robot.js` is fed a flat charge
     on a slow interval, which is all its idle loop needs to run, so he cycles
     through the same pointing / thinking / peeking beats he plays between
     words in a match. He is muted (`data-mute`) — the panel copy is the
     voice here, and a speech paper would collide with the button.

   IT IS SHOWN ON EVERY BOOT, not only the first one. This is not a permission
   notification, it is the game's front door: it says what Pose Party does with
   your camera, where your video goes, and how much room you need to stand in.
   All three of those are worth reading again on the tenth run, and none of
   them stop being true once the browser has granted the permission. Skipping
   the card for a returning player dropped them straight into a Home screen
   with a live camera already running and no statement anywhere about it.

   What the grant DOES change is the one line that would be a lie: the card
   asks `navigator.permissions.query({name:"camera"})` and, when the answer is
   `granted`, sets `data-granted` — row 1 becomes YOUR CAMERA IS READY and the
   button becomes LET'S GO instead of ENABLE CAMERA. Asking someone to enable
   something they enabled months ago reads as a screen that is not listening.
   Where the query is unsupported (Firefox, Safari) the asking copy is used:
   over-explaining is cheap, claiming a permission you do not have is not. */

import { $ } from "./dom.js";
import { blip } from "./audio.js";
import { scheduleGameplayTextFit } from "./gameplayFeedback.js";

const ART = "assets/ui/figma/";

/* HOME is `point` — Figma 322:713 `body_point_bottom_left`, a sprite that
   exists only on this screen and is aimed down-left at the ENABLE CAMERA
   paper. That is his entire job here, so every beat returns to it rather
   than wandering off into a general idle. The alternates are the RObot
   Sprites section's raw square fills, which share his 1254x1254 framing;
   the faces are the shared union-box set the whole app uses. */
const HOME_POSE = ["point", "joyful"];
const BEATS = Object.freeze([
  ["point",     "happy"],
  ["thumbsup",  "joyful"],
  ["point",     "speaking"],
  ["idle",      "happy"],
  ["point",     "surprised"],
  ["present",   "speaking"],
  ["point",     "joyful"],
  ["thinking",  "thinking"],
  ["point",     "happy"],
  ["surprised", "surprised"],
]);
const BEAT_GAP_MS  = [1500, 2700];   // back on `point`, waiting
const BEAT_HOLD_MS = [800, 1400];    // how long one alternate is held

let resolveConsent = null;
/* Whether the browser already holds a camera grant for this origin. It is the
   only thing on the card that the grant changes, so it is the only thing kept
   here; every place that restores the default button label reads it. */
let cameraGranted = false;
let rigTimer = 0;
let beatIx = -1;
let restoreFocus = null;
let spritesWarmed = false;

const card = () => $("camGate");
/* The single action on this card is "start the game". When the permission is
   still outstanding that action happens to include asking for it, which is
   what the button should say; when it is already held, saying ENABLE CAMERA
   asks for something the player has already given. */
const startLabel = () => cameraGranted ? "LET\u2019S GO!" : "ENABLE CAMERA";
export const isCameraGateOpen = () => {
  const gate = card();
  return !!gate && !gate.classList.contains("hidden");
};
/* Callers need to know whether the card exists before they hand it an error
   to display — without it, retryCameraConsent returns a promise nobody can
   ever resolve. */
export const hasCameraGate = () => !!card();

/* ---------------- the rig ---------------- */

const rand = (lo, hi) => lo + Math.random() * (hi - lo);

/* A pose swap is a `src` change, so the first use of each sprite would pop a
   frame late without this — most visibly on the very first beat, which is the
   one that has to convince you he is alive. */
function warmSprites(){
  if(spritesWarmed || typeof Image !== "function") return;
  spritesWarmed = true;
  for(const [body, face] of [HOME_POSE, ...BEATS]){
    new Image().src = ART + "cam-robot-" + body + ".webp";
    new Image().src = ART + "rb-face-" + face + ".webp";
  }
}

function setPose(body, face){
  const rig = $("cgRobot");
  if(!rig) return;
  rig.dataset.pose = body;          // the CSS keys each face offset off this
  const b = $("cgRobotBody");
  const f = $("cgRobotFace");
  if(b) b.src = ART + "cam-robot-" + body + ".webp";
  if(f) f.src = ART + "rb-face-" + face + ".webp";
}

/* Deliberately its own loop rather than robot.js's. That module drives the
   TALL 520x610 gameplay rig off a charge meter, through .grobot CSS with its
   own face offsets — none of which exists here. This rig is the square
   tutorial-style one (the same shape .htp-rig uses) and has no meter to
   read, so borrowing the machinery would mean feeding it a fake number to
   get a sprite swap. */
function scheduleBeat(){
  clearTimeout(rigTimer);
  rigTimer = setTimeout(() => {
    beatIx = (beatIx + 1) % BEATS.length;
    setPose(...BEATS[beatIx]);
    rigTimer = setTimeout(() => {
      setPose(...HOME_POSE);
      scheduleBeat();
    }, rand(BEAT_HOLD_MS[0], BEAT_HOLD_MS[1]));
  }, rand(BEAT_GAP_MS[0], BEAT_GAP_MS[1]));
}

function startRig(){
  if(rigTimer) return;
  warmSprites();
  setPose(...HOME_POSE);
  scheduleBeat();
}

function stopRig(){
  clearTimeout(rigTimer);
  rigTimer = 0;
}

/* ---------------- boot progress ---------------- */

/* THE DOWNLOAD IS NOT A WAIT, so it no longer reports itself. There used to
   be a READY WHEN YOU ARE label over a paper loading bar under the card. But
   nothing here gates on the download: the button is live from the first
   frame, an early click reaches getUserMedia immediately, and the models
   finish behind the permission prompt. So the bar was a progress meter for
   something the player never has to wait for — and it dragged the centred
   column down and put a strip of chrome under a finished Figma composition.
   The stage is still tracked for `data-ready`, which is the only part
   anything else reads. */
export function setBootProgress(label, at){
  const g = card();
  if(g) g.dataset.bootStage = label || "";
}

export function setBootReady(){
  card()?.setAttribute("data-ready", "");
}

/* The engine failed before the camera was ever asked for. Say so on the card
   the player is looking at — showStatus() paints the camera dock, which on
   Home is parked out of sight. */
export function setBootFailed(message){
  const g = card();
  if(g){
    g.dataset.state = "broken";
    setBootProgress(message);
    /* There is no useful action left on this permission card: engine.boot()
       cancels camera acquisition before calling us. Hide the modal instead of
       releasing Home behind an inert scrim, and wake the canceled consent
       waiter so it can observe that cancellation without calling getUserMedia. */
    g.classList.add("hidden");
    g.removeAttribute("data-pending");
    const button = $("cgEnable");
    if(button){
      button.disabled = false;
      button.removeAttribute("aria-busy");
    }
    const label = $("cgEnableLabel");
    if(label) label.textContent = startLabel();
  }
  stopRig();
  const finishConsent = resolveConsent;
  resolveConsent = null;
  finishConsent?.(false);
  /* The camera will never be asked for now, so nothing downstream will ever
     release Home. Let it arrive anyway: a broken engine is a game you cannot
     play, but a permanently invisible menu is a page that looks dead. */
  releaseHold();
}

/* ---------------- consent ---------------- */

/* Resolves immediately when the browser already holds a camera grant for this
   origin, so a returning player boots straight into Home. */
async function alreadyGranted(){
  try{
    const status = await navigator.permissions?.query({ name:"camera" });
    return status?.state === "granted";
  }catch(e){ return false; }   // unsupported query name -> show the card
}

export async function requestCameraConsent(){
  /* The grant no longer short-circuits the card, it only re-words it. The
     three things this screen says are true on every run, and a returning
     player who is dropped straight into Home has a camera switched on with
     nothing on screen that ever said so. */
  cameraGranted = await alreadyGranted();
  open();
  return new Promise(resolve => { resolveConsent = resolve; });
}

/* Re-arm after a refused or failed getUserMedia. The card stays up, swaps to
   its blocked copy, and the button becomes TRY AGAIN — a dead end here means
   a dead app, so there is always a way back to the prompt. */
export function retryCameraConsent(err){
  const g = card();
  if(g){
    g.dataset.state = err?.name === "NotAllowedError" ? "blocked" : "failed";
    g.removeAttribute("data-pending");
    /* Whatever permissions.query said a moment ago, the camera did not come
       back — so the card must stop claiming it is ready and go back to the
       asking copy. */
    cameraGranted = false;
    g.removeAttribute("data-granted");
    /* The headline stays Figma's own line. The failure goes in the note strip
       under the button, which is the only copy on this card that is not
       authored — swapping the title would throw away the one sentence that
       explains what the screen is for. */
    const label = $("cgEnableLabel");
    if(label) label.textContent = "TRY AGAIN";
    const button = $("cgEnable");
    if(button){
      button.disabled = false;
      button.removeAttribute("aria-busy");
    }
    if(!isCameraGateOpen()) open();
    requestAnimationFrame(() => $("cgEnable")?.focus({ preventScroll:true }));
  }
  return new Promise(resolve => { resolveConsent = resolve; });
}

function open(){
  const g = card();
  if(!g || isCameraGateOpen()) return;
  restoreFocus = document.activeElement;
  document.body.dataset.boot = "gate";
  g.toggleAttribute("data-granted", cameraGranted);
  const startText = $("cgEnableLabel");
  if(startText) startText.textContent = startLabel();
  g.classList.remove("hidden");
  /* Replay the drop on every open — a state selector alone only animates the
     first one, which is the trap every other paper on this project has hit. */
  const p = $("cgPanel");
  if(p){ p.style.animation = "none"; void p.offsetWidth; p.style.animation = ""; }
  startRig();
  /* A display:none paper measures 0 and is skipped, so the headline can only
     be fitted once the card is actually up. */
  scheduleGameplayTextFit($("cgTitle"));
  const button = $("cgEnable");
  if(button){
    button.disabled = false;
    button.removeAttribute("aria-busy");
  }
  requestAnimationFrame(() => button?.focus({ preventScroll:true }));
}

export function closeCameraGate(){
  const g = card();
  stopRig();
  resolveConsent = null;
  if(g){
    g.classList.add("hidden");
    g.removeAttribute("data-state");
    g.removeAttribute("data-pending");
    g.removeAttribute("data-ready");
    g.removeAttribute("data-granted");
    const button = $("cgEnable");
    if(button){
      button.disabled = false;
      button.removeAttribute("aria-busy");
    }
    const label = $("cgEnableLabel");
    if(label) label.textContent = startLabel();
    if(restoreFocus?.isConnected) restoreFocus.focus?.({ preventScroll:true });
    restoreFocus = null;
  }
  releaseHold();
}

/* Home is still held at this instant. The hold and the entrance have to
   change in the SAME frame — release it first and every paper snaps into
   place before the entrance can claim it, which is the whole difference
   between "the screen arrived" and "the screen was always there". So the
   screen that owns the hold gets first refusal: homeAlive.js listens, plays
   its entrance and calls preventDefault() to say it took ownership. If
   nobody claims it (Home is not the screen up, or the listener is not wired
   yet) the attribute is cleared here so nothing is ever left invisible. */
function releaseHold(){
  const claimed = !document.dispatchEvent(
    new CustomEvent("pose-party:boot-released", { cancelable:true }));
  if(!claimed) delete document.body.dataset.boot;
}

function consent(){
  if(!resolveConsent) return;
  const g = card();
  const fn = resolveConsent;
  resolveConsent = null;
  /* The click and the browser's permission result are not the same instant.
     getUserMedia starts now, in parallel with any remaining model download;
     say what is happening and make the single action genuinely single-shot. */
  if(g){
    g.dataset.pending = "";
    g.removeAttribute("data-state");
  }
  const button = $("cgEnable");
  if(button){
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
  }
  /* "ASKING" is only true when there is something to ask for. With the grant
     already held the click starts the camera outright, so the busy copy has to
     say that instead of describing a prompt that will never appear. */
  const label = $("cgEnableLabel");
  if(label) label.textContent = cameraGranted ? "STARTING\u2026" : "ASKING\u2026";
  blip([523, 784], .06);
  fn(true);
}

export function wireCameraGate(){
  const button = $("cgEnable");
  if(!button) return;
  button.onclick = consent;
  /* Focus is trapped on the one control: everything behind is mid-load, and
     tabbing into a Home that has not arrived yet reaches dead cards. */
  card()?.addEventListener("keydown", e => {
    if(e.key === "Tab"){ e.preventDefault(); button.focus({ preventScroll:true }); }
    if(e.key === "Enter" || e.key === " "){
      /* Enter/Space on the focused button fires natively; this only catches
         the case where focus has drifted off it. */
      if(document.activeElement !== button){ e.preventDefault(); consent(); }
    }
  });
}
