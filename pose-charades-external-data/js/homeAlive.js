/* Makes the v2 home screen feel alive. The robot idles in a constant wave
   (CSS); this module owns the stateful behaviors — the robot's mood, the
   speech-bubble phrase bank, click "shakes", and alpha-aware pointer
   routing so transparent paper art never blocks the pieces beneath it. */

import { $ } from "./dom.js";
import { blip } from "./audio.js";
import { wireAlphaHitAreas } from "./alphaHit.js";
import { onTransition } from "./fsm.js";

/* The bubble keeps the designed voice but never repeats the file's exact
   line twice in a row — tap the bubble (or the robot) to cycle. */
const PHRASES = [
  "Strike a pose. Let the AI guess!",
  "I'm watching… in a friendly way!",
  "Bet I can guess your next move.",
  "I'll be back",
  "Sometimes I don't understand human behvavior",
  "A thing isn't beautiful because it lasts.",
  "Help me, Obi-Wan Kenobi. You're my only hope",
  "Fate rarely calls upon us at a moment of our choosing.",
  "Autobots, rollout!",
  "EVE?",
  "Fist bump? Ba-la-la-la-la-la-la",
  "Here? Or in a Jaegar?",
  "'Laptop'! You do realize that nickname is demeaning?",
  "Both of You, Dance Like You Want to Win!",
  "Can a robot write a symphony?"
];
let phraseIx = 0;

function cyclePhrase(){
  phraseIx = (phraseIx + 1) % PHRASES.length;
  const t = $("bubbleText");
  t.textContent = PHRASES[phraseIx];
  const b = $("speechBubble");
  b.classList.remove("pop"); void b.offsetWidth; b.classList.add("pop");
  blip([392, 523], 0.07);
}

/* Faces cycle on head taps and STAY — no auto-revert. Add more moods here
   as head components land in Figma. */
const FACES = ["happy", "surprised"];
let faceIx = 0;

function cycleFace(){
  faceIx = (faceIx + 1) % FACES.length;
  const head = $("robotHead");
  head.src = "assets/ui/figma/robot-head-" + FACES[faceIx] + ".png";
  head.dataset.mood = FACES[faceIx];
  head.classList.remove("boing"); void head.offsetWidth; head.classList.add("boing");
}

/* Any robot tap hypes the wave for a beat (face is left alone). */
let hypeTimer = null;
function hypeWave(){
  $("homeStage").classList.add("excited");
  blip([659, 880], 0.08);
  clearTimeout(hypeTimer);
  hypeTimer = setTimeout(() => $("homeStage").classList.remove("excited"), 1400);
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
function playHomeEntrance(){
  const stage = $("homeStage");
  if(!stage) return;
  stage.classList.remove("home-entering");
  void stage.offsetWidth;
  stage.classList.add("home-entering");
  clearTimeout(entranceTimer);
  /* must outlast the last tape (1.26s delay + .66s slap) or it snaps */
  entranceTimer = setTimeout(() => stage.classList.remove("home-entering"), 2100);
}

function revealHome(){
  playHomeEntrance();
  spinConfetti();
}

function spinConfettiWhenHomeIsReady(){
  const status = $("status");
  if(!status || status.style.display === "none"){
    revealHome();
    return;
  }

  const observer = new MutationObserver(()=>{
    if(status.style.display !== "none") return;
    observer.disconnect();
    if(document.body.dataset.screen === "home") revealHome();
  });
  observer.observe(status, { attributes:true, attributeFilter:["style"] });
}

export function wireHomeAlive(){
  $("speechBubble").onclick = cyclePhrase;
  $("robotHead").onclick = () => { cycleFace(); hypeWave(); cyclePhrase(); };
  $("robotBody").onclick = () => { hypeWave(); cyclePhrase(); };
  document.querySelectorAll("#homeStage .iv:not(.wave)").forEach(el => {
    el.addEventListener("click", () => react(el));
  });
  /* Tape is visual hardware, not a separate control. During the entrance it
     travels on a different path from its card and can temporarily sit over
     the card's centre; letting it take pointer events makes a deliberate
     card click disappear into decoration. */
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
    ".iv:not(.tape), #robotBody, #robotHead, .fh.bubble",
  );
  onTransition(to=>{ if(to==="menu") requestAnimationFrame(revealHome); });
  spinConfettiWhenHomeIsReady();
}
