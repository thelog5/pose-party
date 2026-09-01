/* Makes the v2 home screen feel alive. The robot is a jointed puppet that
   watches the player's cursor (js/paperRig.js); this module owns the stateful
   behaviors around him — the speech-bubble phrase bank, click "shakes", and
   alpha-aware pointer routing so transparent paper art never blocks the
   pieces beneath it. */

import { $ } from "./dom.js";
import { blip } from "./audio.js";
import { wireAlphaHitAreas } from "./alphaHit.js";
import { onTransition } from "./fsm.js";
import { fitWrappedTextToBox } from "./textFit.js";
import { wirePaperRigs, startRig, stopRig, cheerRig } from "./paperRig.js";

/* Keep the project's authored dialogue bank. Figma's visible Home overlay
   (302:635) supplies the first line; the remaining entries are the existing
   bank that shipped in this file before the paper refresh. Tap the bubble or
   robot to advance deterministically, so every tap differs from the last. */
export const HOME_ROBOT_PHRASES = Object.freeze([
  "STRIKE A POSE!",
  "I'm watching… in a friendly way!",
  "Bet I can guess your next move.",
  "I'll be back",
  "Sometimes I don't understand human behavior",
  "A thing isn't beautiful because it lasts.",
  "Help me, Obi-Wan Kenobi. You're my only hope",
  "Fate rarely calls upon us at a moment of our choosing.",
  "Autobots, roll out!",
  "EVE?",
  "Fist bump? Ba-la-la-la-la-la-la",
  "Here? Or in a Jaeger?",
  "'Laptop'! You do realize that nickname is demeaning?",
  "Both of You, Dance Like You Want to Win!",
  "Can a robot write a symphony?",
]);
let phraseIx = 0;

function fitHomePhrase(){
  /* EVERY phrase is measured, Figma's canonical STRIKE A POSE! included.
     That line used to be exempted to preserve its authored 51.88px, but at
     that size Fredoka One draws it ~394px wide — wider than the 360px paper
     itself — so the browser wrapped it and the box clipped "A POSE!" clean
     off. The fitter only ever shrinks from the authored `14.411cqw`, so a
     phrase that genuinely fits still renders at Figma's size. */
  return fitWrappedTextToBox($("bubbleText"), { minSize:8 });
}

function cyclePhrase(){
  phraseIx = (phraseIx + 1) % HOME_ROBOT_PHRASES.length;
  const t = $("bubbleText");
  t.textContent = HOME_ROBOT_PHRASES[phraseIx];
  /* Fit before the paper pops so no tap can expose an overflowing frame. */
  fitHomePhrase();
  const b = $("speechBubble");
  b.setAttribute("aria-label",
    "Robot says: " + HOME_ROBOT_PHRASES[phraseIx] + " Tap for another phrase.");
  b.classList.remove("pop"); void b.offsetWidth; b.classList.add("pop");
  blip([392, 523], 0.07);
}

/* A TAP IS ANSWERED WITH HIS BODY, not with a different picture of his face.
   He used to swap `robot-head-happy` for `robot-head-surprised` and hold it —
   the rig pack Figma authors (353:752) ships exactly one face, and a mood was
   always better read as a pose anyway. `cheerRig` plays a rise-and-fall that
   cannot be caught half-played, so there is nothing to revert. */
function hypeWave(){
  cheerRig("home");
  blip([659, 880], 0.08);
}

/* Tap reactions vary: sometimes a shake, sometimes a spin, sometimes a pop. */
const REACTIONS = [["shook",[440]], ["spun",[392,494]], ["popped",[523,392]]];
function react(el){
  el.classList.remove("shook","spun","popped"); void el.offsetWidth;
  const [cls, notes] = REACTIONS[Math.floor(Math.random()*REACTIONS.length)];
  el.classList.add(cls);
  blip(notes, 0.06);
}

function spinConfetti(){
  document.querySelectorAll("#homeStage .iv.conf").forEach(el=>{
    el.classList.remove("shook","spun","popped"); void el.offsetWidth;
    el.classList.add("spun");
  });
}

let entranceTimer = null;
let arrivalTimer = null;
let lastEntranceAt = -Infinity;
function playHomeEntrance(){
  const stage = $("homeStage");
  if(!stage) return;
  stage.classList.remove("home-entering");
  /* An exit that is still on the stage would out-rank everything below it —
     `both` fill holds each piece at opacity 0 — so arriving always cancels
     leaving. This is the only place Home is un-left. */
  clearHomeExit();
  void stage.offsetWidth;
  stage.classList.add("home-entering");
  clearTimeout(entranceTimer);
  lastEntranceAt = performance.now();
  /* must outlast the last tape (1.26s delay + .66s slap) or it snaps */
  entranceTimer = setTimeout(() => stage.classList.remove("home-entering"), 2100);
}

/* The pieces with no entrance of their own — logo, robot, bubble, boat. */
function playHomeArrival(){
  const stage = $("homeStage");
  if(!stage) return;
  stage.classList.add("home-arriving");
  clearTimeout(arrivalTimer);
  arrivalTimer = setTimeout(() => stage.classList.remove("home-arriving"), 1800);
}

/* ---------- picking a mode ----------
   The card is pulled off the board before the next screen is asked for, so
   the press has an answer during the gap where nothing has been built yet.
   Long enough to read the pop, short enough that it is never a wait: the
   chosen card's own beat runs .07s–.51s and this cuts it at .42s, by which
   point it is at ~10% opacity and 1.4x — the tail nobody sees. */
const MODE_EXIT_MS = 420;
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
let leaving = false;

function clearHomeExit(){
  const stage = $("homeStage");
  if(!stage) return;
  stage.classList.remove("home-leaving");
  delete stage.dataset.pick;
}

/* `go` is the navigation itself (startGame / enterLobby / enterParty). */
export function pickMode(pick, go){
  const stage = $("homeStage");
  /* A second press cannot re-deal a board that is already leaving, and it
     must not fire `go` twice — enterLobby() creates a room on the way in. */
  if(leaving) return;
  if(!stage || reducedMotion.matches){ go(); return; }
  leaving = true;
  stage.dataset.pick = pick;
  stage.classList.remove("home-entering", "home-arriving");
  void stage.offsetWidth;
  stage.classList.add("home-leaving");
  blip([523, 698], 0.07);
  setTimeout(() => {
    leaving = false;
    go();
    /* Every normal path has left Home by now. The ones that have not are the
       refusals — an untrained model routes to Training (a different screen,
       so nothing to undo), but a rejected transition leaves the player right
       here, and a Home parked at the end of its own exit is a dead page.
       Deal it back in rather than snapping it back. */
    if(document.body.dataset.screen === "home"){
      playHomeEntrance();
      playHomeArrival();
    }else{
      clearHomeExit();
    }
  }, MODE_EXIT_MS);
}

function revealHome(){
  /* Boot now has two things that both want to reveal Home — the gate letting
     go and the status overlay hiding — and they fire within a frame of each
     other. Whichever gets there first owns the entrance; a replay would send
     three cards that are already mid-flight back to the start. */
  if(performance.now() - lastEntranceAt < 400) return;
  playHomeEntrance();
  spinConfetti();
}

/* The boot gate held every paper at the state its entrance starts from (see
   .home-held in screens.css). Take the handover: start the entrance and drop
   the hold in ONE frame, so the papers fly in from where they were parked
   instead of appearing and then animating. `preventDefault` is how the gate
   knows Home claimed it and must not clear the attribute itself. */
function claimBootRelease(e){
  const stage = $("homeStage");
  if(!stage || !document.body.dataset.boot) return;
  e.preventDefault();
  playHomeEntrance();
  /* .home-arriving carries the logo/robot/bubble/boat in; the cards and
     tapes already have their own beats inside .home-entering. */
  playHomeArrival();
  delete document.body.dataset.boot;
  spinConfetti();
}

function spinConfettiWhenHomeIsReady(){
  document.addEventListener("pose-party:boot-released", claimBootRelease);
  /* Belt and braces: if boot dies somewhere that never reaches the gate at
     all, Home must not stay parked at opacity 0 forever. */
  setTimeout(() => {
    if(document.body.dataset.boot) claimBootRelease(new Event("x", { cancelable:true }));
  }, 45000);

  const status = $("status");
  if(!status || status.style.display === "none"){
    revealHome();
    return;
  }

  const observer = new MutationObserver(()=>{
    if(status.style.display !== "none") return;
    stop();
    if(document.body.dataset.screen === "home") revealHome();
  });
  /* If boot never finishes — no camera, no model — the status never hides and
     this used to observe for the life of the session. Give it a deadline. */
  const give_up = setTimeout(stop, 60000);
  function stop(){ clearTimeout(give_up); observer.disconnect(); }
  observer.observe(status, { attributes:true, attributeFilter:["style"] });
}

export function wireHomeAlive(){
  fitHomePhrase();
  document.fonts?.ready?.then(fitHomePhrase);
  if("ResizeObserver" in globalThis)
    new ResizeObserver(fitHomePhrase).observe($("speechBubble"));
  $("speechBubble").onclick = cyclePhrase;
  /* One listener on the rig root: eleven layers are one character, and the
     click bubbles up from whichever of them the pointer actually hit. */
  $("homeRobot").onclick = () => { hypeWave(); cyclePhrase(); };
  wirePaperRigs();
  /* Tape is visual hardware, not a separate control. During the entrance it
     travels on a different path from its card and can temporarily sit over
     the card's centre; letting it take pointer events makes a deliberate
     card click disappear into decoration. It is therefore excluded from the
     click wiring too — it used to be listed here and then given
     pointer-events:none two lines later, so the listener could never fire. */
  document.querySelectorAll("#homeStage .iv:not(.wave):not(.tape)").forEach(el => {
    el.addEventListener("click", () => react(el));
  });
  document.querySelectorAll("#homeStage .tape").forEach(el => {
    el.style.pointerEvents = "none";
  });
  wireAlphaHitAreas(
    $("homeStage"),
    /* Mode choices are primary controls: keep their entire native button
       hitboxes stable while the card and its separate tape animate. Alpha
       routing could otherwise leave an inline pointer-events:none behind
       after returning from another screen, making PARTY/1V1 look clickable
       while swallowing the click. */
    ".iv:not(.tape), .home-alpha, .fh.bubble",
  );
  /* menu -> menu is a legal transition, so clicking the brand re-fired the
     whole 2.1s entrance and the three mode cards vanished mid-click. Only
     replay it when Home is actually being ARRIVED at. */
  onTransition((to, from)=>{
    if(to==="menu" && from!=="menu") requestAnimationFrame(revealHome);
    /* The rig is only ever fed while Home is the screen — a puppet swapping
       transforms into a stage nobody is looking at is the waste the gameplay
       rig's IDLE_STALE_MS exists to stop. */
    if(to==="menu") startRig("home"); else stopRig("home");
  });
  /* AND START HIM HERE, unconditionally. Home is the boot screen, but main.js
     wires every module (line ~79) long before its first `render(gameState())`
     (line ~150) — and that first render is a direct call, not a `transition()`,
     so no listener ever hears about it. Reading `data-screen` here is no better:
     nothing has written it yet. Both of those looked right and left the robot
     standing perfectly still on the one screen he is guaranteed to be on. */
  startRig("home");
  spinConfettiWhenHomeIsReady();
}
