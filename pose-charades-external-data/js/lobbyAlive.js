/* Keeps the 1v1 lobby breathing: the sign-holding robot cycles between the
   user's high-wave and low-wave art, and every "waiting" line walks its
   dots. Runs only while the FSM is in the lobby. */

import { $ } from "./dom.js";
import { onTransition } from "./fsm.js";

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
    for(const id of ["dotsSign", "dotsBig", "dotsSmall"]){
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
  onTransition(to => { if(to === "lobby") start(); else stop(); });
}
