/* Maps FSM states to visible screens and moves the two camera docks into
   the active screen's slot. There is exactly ONE local camera (and one
   remote video); reparenting the dock keeps MediaPipe reading a single
   <video> no matter which screen shows it.

   Screens: home | solo | lobby | match | party | train | results */

import { $ } from "./dom.js";
import { resetAlphaHitAreas } from "./alphaHit.js";
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

/* The count-in choreography (css/screens.css, SHARED GAMEPLAY ENTRANCE) runs
   from .04s to ~2.12s: the last piece of tape starts at 1.616s and takes .5s
   to settle. This MUST outlast it or the final tapes are cut off mid-slap —
   `both` fill means pulling the class early snaps them to rest instead.
   Measured end on a warm headless Chrome is ~2.16s across all three stages,
   so this leaves ~240ms for a frame-starved start while still finishing well
   inside the 3s countdown, which for 1v1 and Party is server-driven and
   cannot be moved. */
const GAME_INTRO_MS = 2400;
const GAME_STAGE = { solo:"soloStage", match:"matchStage", pmatch:"pmStage" };

let gameEntranceTimer = null;
function playGameplayEntrance(screen){
  const stage = GAME_STAGE[screen] && $(GAME_STAGE[screen]);
  if(!stage) return;
  stage.classList.remove("game-intro");
  void stage.offsetWidth;
  stage.classList.add("game-intro");
  clearTimeout(gameEntranceTimer);
  gameEntranceTimer = setTimeout(() => {
    stage.classList.remove("game-intro");
    delete document.body.dataset.intro;
  }, GAME_INTRO_MS);
}

export function render(fsmState){
  const s = screenFor(fsmState);
  /* Alpha hit-testing disables a paper while the pointer sits on one of its
     transparent pixels. Leaving the screen right then would strand that
     inline pointer-events:none, so hand every paper back on each repaint. */
  resetAlphaHitAreas();
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
     Party without changing any mode's game/network state.

     Both the flag and the class go on SYNCHRONOUSLY. All three callers run
     transition("countdown") — i.e. this function — and then start their 3·2·1
     immediately, so anything deferred to a rAF is already racing a clock that
     is running: the flag has to be on the body the first time the scrim's own
     animation is resolved (or the dim flashes on at full strength before it
     yields), and the entrance loses a frame it does not have. */
  const introScreen = s==="solo" || s==="match" || s==="pmatch";
  if(fsmState==="countdown" && introScreen){
    document.body.dataset.intro = "game";
    playGameplayEntrance(s);
  }else{
    /* ANY transition out of the count-in ends it, not just backing out to a
       menu. GAME_INTRO_MS is measured from the client's own render, while the
       countdown it has to fit inside is measured from a server timestamp — so
       a client that reaches `countdown` late (camera + model still coming up)
       would otherwise still be flying paper around for a second of live play,
       with every hover dead because `both` fill outranks a plain declaration.
       In the normal case the timer has already fired here and this is a no-op;
       when it has not, snapping the board to rest exactly as the round starts
       is the right trade. It also covers backing out mid-count-in, which would
       strand `.game-intro` and pin every paper at its keyframed transform. */
    clearTimeout(gameEntranceTimer);
    for(const k in GAME_STAGE) $(GAME_STAGE[k])?.classList.remove("game-intro");
    delete document.body.dataset.intro;
  }
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
