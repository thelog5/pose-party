/* Maps FSM states to visible screens and moves the two camera docks into
   the active screen's slot. There is exactly ONE local camera (and one
   remote video); reparenting the dock keeps MediaPipe reading a single
   <video> no matter which screen shows it.

   Screens: home | solo | lobby | match | party | train | results */

import { $ } from "./dom.js";
import { state } from "./state.js";
import { ROUNDS } from "./constants.js";

const SCREENS = { home:"scrHome", solo:"scrSolo", lobby:"scrLobby", match:"scrMatch",
                  pmatch:"scrPartyMatch", train:"scrTrain", results:"scrResults" };

/* where the local camera dock lives per screen (party manages its own slot) */
const CAM_SLOT = { home:"slotHomePark", solo:"slotSolo", lobby:"slotLobbyYou",
                   match:"slotMatchYou", train:"slotTrain" };
const RIVAL_SLOT = { lobby:"slotLobbyRival", match:"slotMatchRival" };

function screenFor(fsmState){
  switch(fsmState){
    case "menu": return "home";
    case "training": return "train";
    case "results": return "results";
    case "lobby": return "lobby";
    case "party": return "lobby"; // party shares the lobby stage (data-mode)
    case "countdown": case "playing": case "word-won":
      if(state.game && state.game.mode==="party") return "pmatch";
      return (state.game && state.game.mode!=="ai") ? "match" : "solo";
    default: return "home";
  }
}

export function mountCamera(slotEl){
  const dock=$("cameraDock");
  if(dock && slotEl && dock.parentElement!==slotEl) slotEl.appendChild(dock);
}
export function mountRival(slotEl){
  const dock=$("rivalDock");
  if(dock && slotEl && dock.parentElement!==slotEl) slotEl.appendChild(dock);
}

const MODE_LABELS = {
  home:"AI is watching. Strike a pose.",
  solo:"PLAY WITH AI (SOLO)",
  lobby:"LIVE 1V1: STRIKE A POSE",
  match:"LIVE 1V1: STRIKE A POSE",
  pmatch:"PARTY: EVERYONE POSE AT ONCE",
  party:"AI is watching. Strike a pose.",
  train:"TRAIN THE AI",
  results:"GAME OVER!",
};

let gameEntranceTimer = null;
function playGameplayEntrance(screen){
  const id = screen==="solo" ? "soloStage" : screen==="match" ? "matchStage" :
    screen==="pmatch" ? "pmStage" : "";
  const stage = id && $(id);
  if(!stage) return;
  stage.classList.remove("game-intro");
  void stage.offsetWidth;
  stage.classList.add("game-intro");
  clearTimeout(gameEntranceTimer);
  gameEntranceTimer = setTimeout(() => stage.classList.remove("game-intro"), 1250);
}

export function render(fsmState){
  const s = screenFor(fsmState);
  state.screen = s;
  document.body.dataset.screen = s;
  document.body.dataset.state = fsmState;

  for(const k in SCREENS) $(SCREENS[k]).classList.toggle("hidden", k!==s);

  /* Home, Solo, Lobby and the Figma split-screen match own their full HUD. */
  document.querySelector("header").classList.toggle("hidden",
    s==="solo"||s==="home"||s==="lobby"||s==="match"||s==="pmatch");
  const pills = false;
  $("hdrPills").classList.toggle("hidden", !pills);
  $("hdrIcons").classList.toggle("hidden", pills);
  $("modeLabel").textContent = MODE_LABELS[s];
  $("roundDots").classList.add("hidden");

  /* camera docks follow the screen (party places its own slot) */
  /* in party mode the camera lives in the player's team tile (party.js) */
  const partyMode = s==="lobby" && $("lobbyStage").dataset.mode==="party";
  if(CAM_SLOT[s] && !partyMode) mountCamera($(CAM_SLOT[s]));
  /* the rival dock covers its host card edge-to-edge, so it must be hidden
     outright on screens that don't slot it — otherwise it blankets the page */
  $("rivalDock").classList.toggle("hidden", !RIVAL_SLOT[s]);
  if(RIVAL_SLOT[s]) mountRival($(RIVAL_SLOT[s]));

  const inGame = fsmState==="countdown"||fsmState==="playing"||fsmState==="word-won";
  if(!inGame && fsmState!=="lobby"){
    $("pillTime").textContent="00:30";
    $("pillRound").textContent="1 / "+ROUNDS;
    $("pillStreak").textContent="x1";
  }
  if(fsmState==="menu") $("pillScore").textContent="0";

  /* Every mode receives the same paper-on-table entrance beat. The stage is
     already visible here, so one animation system works for Solo, 1v1 and
     Party without changing any mode's game/network state. */
  if(fsmState==="countdown" && (s==="solo" || s==="match" || s==="pmatch"))
    requestAnimationFrame(() => {
      if(document.body.dataset.state==="countdown") playGameplayEntrance(s);
    });
}

/* round-progress dots under the logo on the match screen */
export function renderDots(round, total){
  const el=$("roundDots");
  if(el.children.length!==total){
    el.innerHTML="";
    for(let i=0;i<total;i++) el.appendChild(document.createElement("i"));
  }
  [...el.children].forEach((d,i)=>{
    d.className = i<round-1 ? "done" : (i===round-1 ? "on" : "");
  });
}
