/* Keeps the 1v1 lobby breathing: the waiting robot runs his puppet loop
   (js/paperRig.js — he watches the player's cursor and reaches for it), and
   every "waiting" line walks its dots. Runs only while the FSM is in the
   lobby. */

import { $ } from "./dom.js";
import { onTransition } from "./fsm.js";
import { blip } from "./audio.js";
import { wireAlphaHitAreas } from "./alphaHit.js";
import { wirePaperRigs, startRig, stopRig } from "./paperRig.js";

const DOTS_MS = 450;

let dotsTimer = null, dots = 3;
let active = false;
const motionPreference = matchMedia("(prefers-reduced-motion: reduce)");

function settle(){
  dots = 3;
  for(const id of ["dotsBig", "dotsSmall"]){
    const el = $(id);
    if(el) el.textContent = "···";
  }
}

function start(){
  stop();
  startRig("lobby");
  if(motionPreference.matches){ settle(); return; }
  dotsTimer = setInterval(() => {
    dots = (dots % 3) + 1;
    /* one glyph per step so the label width never jumps */
    const s = "·".repeat(dots);
    for(const id of ["dotsBig", "dotsSmall"]){
      const el = $(id);
      if(el) el.textContent = s;
    }
  }, DOTS_MS);
}

function stop(){
  clearInterval(dotsTimer);
  dotsTimer = null;
  stopRig("lobby");
}

/* ---------- arriving ----------
   The lobby is dealt onto the desk the way Home is (css/screens.css, LOBBY
   ENTRANCE): its mode title paper lands with the mirror of the pop that took
   the matching card off Home, and every other paper is thrown in from the
   edge it lives against. Must outlast the last beat — the party VS badge at
   .86s + .56s — or the class comes off mid-flight. */
const LOBBY_INTRO_MS = 1600;
let introTimer = null;

function playLobbyEntrance(){
  const stage = $("lobbyStage");
  if(!stage) return;
  /* An exit still on the stage holds every paper at opacity 0 (`both` fill),
     so arriving always cancels leaving — even under reduced motion, where
     nothing else here runs. */
  stage.classList.remove("lobby-leaving");
  clearTimeout(exitTimer);
  if(motionPreference.matches) return;
  stage.classList.remove("lobby-entering");
  void stage.offsetWidth;
  stage.classList.add("lobby-entering");
  clearTimeout(introTimer);
  introTimer = setTimeout(() => stage.classList.remove("lobby-entering"),
                          LOBBY_INTRO_MS);
}

function endLobbyEntrance(){
  clearTimeout(introTimer);
  clearTimeout(exitTimer);
  $("lobbyStage")?.classList.remove("lobby-entering", "lobby-leaving");
}

/* ---------- leaving ----------
   Walking out of the lobby is the mirror of pressing the mode card that
   opened it, so it is the same beat: the mode paper pops off the board and
   the room drops away under it, and only then is the move made. Home is
   already dealing itself back in behind this (`.home-entering`), so the two
   read as one hand-off in the other direction.

   Kept the same length as homeAlive.js's MODE_EXIT_MS: this is the same
   gesture and it must not feel like a different, slower door. */
const LOBBY_EXIT_MS = 420;
let exitTimer = null;
let leaving = false;

export function leaveLobby(go){
  const stage = $("lobbyStage");
  /* One press only: `go` tells the room we are gone. */
  if(leaving) return;
  if(!stage || motionPreference.matches){ go(); return; }
  leaving = true;
  clearTimeout(introTimer);
  stage.classList.remove("lobby-entering");
  void stage.offsetWidth;
  stage.classList.add("lobby-leaving");
  clearTimeout(exitTimer);
  exitTimer = setTimeout(() => {
    leaving = false;
    go();
    /* A refused move leaves the player on a lobby parked at the end of its
       own exit, i.e. a dead screen. Deal it back in rather than snapping. */
    if(document.body.dataset.screen === "lobby") playLobbyEntrance();
    else stage.classList.remove("lobby-leaving");
  }, LOBBY_EXIT_MS);
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
  wirePaperRigs();
  const refreshMotion = () => { if(active) start(); };
  if(motionPreference.addEventListener)
    motionPreference.addEventListener("change", refreshMotion);
  else motionPreference.addListener?.(refreshMotion);
  /* One key per (state, lobby variant): entering the stage plays the
     entrance, and so does the 1v1 -> party hop a shared room code triggers,
     because that swaps the very component the entrance is built around. A
     re-entry that changes neither (enterLobby called from inside the lobby)
     does not re-deal a board the player is already looking at. */
  let lastKey = null;
  onTransition(to => {
    active = to === "lobby" || to === "party";
    if(active) start(); else stop();
    const key = active ? to + "|" + $("lobbyStage").dataset.mode : null;
    if(active && key !== lastKey) playLobbyEntrance();
    /* Leaving mid-entrance would strand `both` fill on every paper, which is
       also what kills their hovers when you come back. */
    if(!active) endLobbyEntrance();
    lastKey = key;
  });
}
