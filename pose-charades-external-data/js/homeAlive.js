/* Makes the v2 home screen feel alive. The robot idles in a constant wave
   (CSS); this module owns the stateful behaviors — the robot's mood, the
   speech-bubble phrase bank, click "shakes", and alpha-aware pointer
   routing so big transparent PNGs (the robot) never block the paper
   scraps behind them. */

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

/* Robot tap: head pops to surprised and the wave gets bigger for a beat. */
let moodTimer = null;
function surpriseRobot(){
  const head = $("robotHead");
  head.src = "assets/ui/figma/robot-head-surprised.png";
  head.dataset.mood = "surprised";
  $("homeStage").classList.add("excited");
  blip([659, 880], 0.08);
  clearTimeout(moodTimer);
  moodTimer = setTimeout(() => {
    head.src = "assets/ui/figma/robot-head-happy.png";
    head.dataset.mood = "happy";
    $("homeStage").classList.remove("excited");
  }, 1400);
}

function shake(el){
  el.classList.remove("shook"); void el.offsetWidth; el.classList.add("shook");
}

/* ---------- alpha-aware pointer routing ----------
   The robot's body/head are large PNGs whose transparent corners cover the
   torn paper scraps beneath (bottom-left wave). Sample the pixel under the
   cursor; when it's transparent, the element goes pointer-transparent so
   hover/clicks fall through to whatever is really underneath. */
const alphaMaps = new Map();

function buildAlphaMap(img){
  const draw = () => {
    const cv = document.createElement("canvas");
    cv.width = img.naturalWidth; cv.height = img.naturalHeight;
    const cx = cv.getContext("2d", { willReadFrequently: true });
    cx.drawImage(img, 0, 0);
    alphaMaps.set(img, cx);
  };
  if(img.complete && img.naturalWidth) draw();
  else img.addEventListener("load", draw, { once: true });
}

function routePointer(e){
  for(const img of alphaMaps.keys()){
    const cx = alphaMaps.get(img);
    const r = img.getBoundingClientRect();
    if(e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom){
      img.style.pointerEvents = "";
      continue;
    }
    const px = Math.floor((e.clientX - r.left) / r.width * img.naturalWidth);
    const py = Math.floor((e.clientY - r.top) / r.height * img.naturalHeight);
    let alpha = 255;
    try{ alpha = cx.getImageData(px, py, 1, 1).data[3]; }catch(_){}
    img.style.pointerEvents = alpha > 16 ? "" : "none";
  }
}

export function wireHomeAlive(){
  $("speechBubble").onclick = cyclePhrase;
  for(const id of ["robotHead", "robotBody"]){
    $(id).onclick = () => { surpriseRobot(); cyclePhrase(); };
  }
  document.querySelectorAll("#homeStage .iv").forEach(el => {
    el.addEventListener("click", () => { shake(el); blip([440], 0.05); });
  });
  for(const id of ["robotBody", "robotHead"]) buildAlphaMap($(id));
  $("homeStage").addEventListener("pointermove", routePointer);
}
