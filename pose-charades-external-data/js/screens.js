/* Maps FSM states to visible chrome. Pure presentation — game lifecycle
   (killing timers etc.) lives in game.js so this stays side-effect-light.

   Screens: home | play | train | results | versus */

import { $ } from "./dom.js";
import { state } from "./state.js";
import { ROUNDS } from "./constants.js";

const RAILS = { home:"railHome", play:"railPlay", train:"railTrain", results:"railResults" };

/* countdown/playing/word-won all show the in-game screen; which one depends
   on the mode of the running game. */
function screenFor(fsmState){
  switch(fsmState){
    case "menu": return "home";
    case "training": return "train";
    case "results": return "results";
    case "lobby": return "versus";
    case "countdown": case "playing": case "word-won":
      return (state.game && state.game.mode!=="ai") ? "versus" : "play";
    default: return "home";
  }
}

export function render(fsmState){
  const s = screenFor(fsmState);
  state.screen = s;
  document.body.dataset.screen = s;
  document.body.dataset.state = fsmState;

  for(const k in RAILS) $(RAILS[k]).classList.toggle("hidden", k!==s);
  $("mainGrid").classList.toggle("hidden", s==="versus");
  $("vsShell").classList.toggle("hidden", s!=="versus");
  $("wordcard").classList.toggle("hidden", s!=="play");
  $("gotthis").classList.toggle("hidden", s!=="play");
  $("homeBottom").classList.toggle("hidden", !(s==="home"||s==="train"||s==="results"));
  $("playBottom").classList.toggle("hidden", s!=="play");
  $("modePill").classList.toggle("hidden", !(s==="play"||s==="versus"));
  $("statRival").classList.toggle("hidden", s!=="versus");
  $("statScore").classList.toggle("youScore", s==="versus");
  $("scoreLabel").textContent = s==="versus" ? "Your score" : "Score";
  $("modeLabel").textContent = s==="versus" ? "1v1" : "PLAY WITH AI";

  const inGame = fsmState==="countdown"||fsmState==="playing"||fsmState==="word-won";
  if(!inGame){
    $("pillTime").textContent="0:20";
    $("pillRound").textContent="1/"+ROUNDS;
    $("pillRivalScore").textContent="0";
  }
  if(fsmState==="menu") $("pillScore").textContent="0";
}
