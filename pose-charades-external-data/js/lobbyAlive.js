/* Keeps the 1v1 lobby breathing: the sign-holding robot cycles between the
   user's high-wave and low-wave art, and every "waiting" line walks its
   dots. Runs only while the FSM is in the lobby. */

import { $ } from "./dom.js";
import { onTransition } from "./fsm.js";
import { blip } from "./audio.js";
import { wireAlphaHitAreas } from "./alphaHit.js";

const WAVE_MS = 1300;
const DOTS_MS = 450;

let waveTimer = null, dotsTimer = null, dots = 3;

function start(){
  if(matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  stop();
  waveTimer = setInterval(() => {
    $("robotWaveHigh").classList.toggle("ghosted");
    $("robotWaveLow").classList.toggle("ghosted");
  }, WAVE_MS);
  dotsTimer = setInterval(() => {
    dots = (dots % 3) + 1;
    const s = ".".repeat(dots);
    for(const id of ["dotsBig", "dotsSmall"]){
      const el = $(id);
      if(el) el.textContent = s;
    }
  }, DOTS_MS);
}

function stop(){
  clearInterval(waveTimer); clearInterval(dotsTimer);
  waveTimer = dotsTimer = null;
}

export function wireLobbyAlive(){
  const stage=$("lobbyStage");
  stage.querySelectorAll(".lobby-react").forEach(el=>{
    el.addEventListener("click",()=>{
      el.classList.remove("lobby-bop"); void el.offsetWidth;
      el.classList.add("lobby-bop");
      blip([523,659],.055);
    });
  });
  wireAlphaHitAreas(stage,".lobby-alpha");
  onTransition(to => { if(to === "lobby" || to === "party") start(); else stop(); });
}
