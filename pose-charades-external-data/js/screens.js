/* Single place that decides which chrome is visible for a given screen.
   Screens: home | play | train | results | versus */

import { $ } from "./dom.js";
import { state } from "./state.js";
import { ROUNDS } from "./constants.js";

const RAILS = { home:"railHome", play:"railPlay", train:"railTrain", results:"railResults" };

export function setScreen(s){
  state.screen=s;
  document.body.dataset.screen=s;
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

  if(s!=="play" && s!=="versus" && state.game){ clearInterval(state.game.timer); state.game=null; }
  if(s!=="play" && s!=="versus"){
    $("pillTime").textContent="0:20";
    $("pillRound").textContent="1/"+ROUNDS;
    $("pillRivalScore").textContent="0";
  }
  if(s==="home") $("pillScore").textContent="0";
}
