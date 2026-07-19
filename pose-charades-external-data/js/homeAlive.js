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
  $("robotHead").onclick = () => { cycleFace(); hypeWave(); cyclePhrase(); };
  $("robotBody").onclick = () => { hypeWave(); cyclePhrase(); };
  document.querySelectorAll("#homeStage .iv").forEach(el => {
    el.addEventListener("click", () => react(el));
  });
  for(const id of ["robotBody", "robotHead"]) buildAlphaMap($(id));
  $("homeStage").addEventListener("pointermove", routePointer);
}
