/* Makes the v2 home screen feel alive. Everything on the board reacts:
   hover lifts are pure CSS (screens.css); this module owns the behaviors
   that need state — the robot's mood, the speech-bubble phrase bank, and
   the click "shake" that any decorated element gets. */

import { $ } from "./dom.js";
import { blip } from "./audio.js";

/* The bubble keeps the designed voice but never repeats the file's exact
   line twice in a row — tap the bubble (or the robot) to cycle. */
const PHRASES = [
  "Strike a pose. Let the AI guess!",
  "I'm watching… in a friendly way!",
  "Bet I can guess your next move.",
  "Do a T-rex. I love T-rexes!",
  "My circuits say: DANCE.",
  "Pose like nobody's watching. (I am.)",
  "Beep boop — show me your best!",
  "I never blink. Ever.",
  "Warmed up? Prove it!",
  "Jazz hands. Trust me.",
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

/* Robot: tap anywhere on it — head pops to surprised, arms flail, then back. */
let moodTimer = null;
function surpriseRobot(){
  const head = $("robotHead");
  head.src = "assets/ui/figma/robot-head-surprised.png";
  head.dataset.mood = "surprised";
  $("homeStage").classList.add("waving");
  blip([659, 880], 0.08);
  clearTimeout(moodTimer);
  moodTimer = setTimeout(() => {
    head.src = "assets/ui/figma/robot-head-happy.png";
    head.dataset.mood = "happy";
    $("homeStage").classList.remove("waving");
  }, 1400);
}

/* Any decorated element shakes when tapped. */
function shake(el){
  el.classList.remove("shook"); void el.offsetWidth; el.classList.add("shook");
}

export function wireHomeAlive(){
  $("speechBubble").onclick = cyclePhrase;
  for(const id of ["robotHead", "robotBody", "robotArmL", "robotArmR"]){
    const el = $(id);
    el.onclick = () => { surpriseRobot(); cyclePhrase(); };
    el.onmouseenter = () => $("homeStage").classList.add("waving");
    el.onmouseleave = () => { if($("robotHead").dataset.mood === "happy") $("homeStage").classList.remove("waving"); };
  }
  document.querySelectorAll("#homeStage .iv").forEach(el => {
    el.addEventListener("click", () => { shake(el); blip([440], 0.05); });
  });
}
