/* Entry point: wire the DOM to the modules, then start. */

import { $ } from "./dom.js";
import { state } from "./state.js";
import { STARTERS } from "./constants.js";
import { toast, renderClasses } from "./ui.js";
import { startRecording } from "./capture.js";
import { train } from "./training.js";
import { exportData, importData, preloadBundledDataset } from "./data.js";
import { render } from "./screens.js";
import { gameState, transition, onTransition } from "./fsm.js";
import { startGame, missWord, endGame, bindGameLifecycle } from "./game.js";
import { enterLobby, quitOnline, leaveRoom, setPendingJoin } from "./online.js";
import { enterParty, wireParty } from "./party.js";
import { wireHomeAlive } from "./homeAlive.js";
import { wireLobbyAlive } from "./lobbyAlive.js";
import { boot } from "./engine.js";

/* Order matters: repaint the screen first, then let the game module tear
   down abandoned games. */
onTransition(to=>render(to));
bindGameLifecycle();

function wireControls(){
  $("logoHome").onclick=()=>transition("menu");
  $("logoHomeCraft").onclick=()=>transition("menu");
  $("btnGear").onclick=()=>transition(gameState()==="training"?"menu":"training");
  $("btnDoneTrain").onclick=()=>transition("menu");
  $("btnFriends").onclick=()=>toast("Friends lists are coming soon — share a room link to play together!");
  const toggleMute=()=>{
    state.muted=!state.muted;
    for(const [on,off] of [["sndOn","sndOff"],["homeSndOn","homeSndOff"]]){
      $(on).classList.toggle("hidden",state.muted);
      $(off).classList.toggle("hidden",!state.muted);
    }
  };
  $("btnSound").onclick=toggleMute;
  $("btnHomeSound").onclick=toggleMute;

  /* home (Figma v2): SOLO card -> solo, 1V1 -> lobby, PARTY -> party room */
  $("modeAI").onclick=()=>startGame("ai");
  $("modeVS").onclick=()=>enterLobby();
  $("modeParty").onclick=()=>enterParty();
  $("btnHomeGear").onclick=()=>transition("training");
  wireHomeAlive();
  wireLobbyAlive();

  /* in-game */
  $("btnExitSolo").onclick=()=>state.game&&endGame();
  $("btnSkipSolo").onclick=()=>missWord(true);
  $("btnExitMatch").onclick=()=>{
    if(state.game?.mode==="online") quitOnline();
    else if(state.game) endGame();
  };

  /* results */
  $("btnAgain").onclick=()=>{
    if(state.lastMode==="online") enterLobby();
    else startGame(state.lastMode);
  };
  $("btnHome").onclick=()=>{ leaveRoom(); transition("menu"); };

  /* training */
  $("btnRecord").onclick=startRecording;
  $("btnTrain").onclick=()=>train();
  $("btnExport").onclick=exportData;
  $("btnImport").onclick=()=>$("fileImport").click();
  $("fileImport").onchange=e=>{ if(e.target.files[0]) importData(e.target.files[0]); e.target.value=""; };

  wireParty();
}

function buildStarterWords(){
  const dl=$("classSuggestions"), chips=$("starterChips");
  for(const w of STARTERS){
    const o=document.createElement("option"); o.value=w; dl.appendChild(o);
    const c=document.createElement("button"); c.className="wordchip"; c.textContent=w;
    c.onclick=()=>{ $("classInput").value=w; }; chips.appendChild(c);
  }
}

/* Room links look like https://host/#join-ABC234 — capture the code and
   open the 1v1 lobby once the model has loaded. */
function handleJoinLink(){
  const m=location.hash.match(/^#join-([A-Za-z2-9]{6})$/);
  if(!m) return;
  history.replaceState(null,"",location.pathname); // don't re-join on refresh
  setPendingJoin(m[1].toUpperCase());
  const tryEnter=()=>{
    if(state.model){ enterLobby(); return; }
    setTimeout(tryEnter, 400);
  };
  tryEnter();
}

wireControls();
buildStarterWords();
renderClasses();
render(gameState());
preloadBundledDataset().then(handleJoinLink);
/* pasting a room link into an already-open tab fires hashchange, not load */
window.addEventListener("hashchange", handleJoinLink);
boot();
