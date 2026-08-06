/* Entry point: wire the DOM to the modules, then start. */

import { $ } from "./dom.js";
import { state } from "./state.js";
import { STARTERS } from "./constants.js";
import { toast, renderClasses, setDatasetEditedHandler } from "./ui.js";
import { blip } from "./audio.js";
import { startRecording } from "./capture.js";
import { train } from "./training.js";
import { exportData, importData, preloadBundledDataset } from "./data.js";
import { render } from "./screens.js";
import { gameState, transition, onTransition } from "./fsm.js";
import { startGame, missWord, endGame, bindGameLifecycle } from "./game.js";
import { wireResults, devResults } from "./results.js";
import { enterLobby, leaveRoom, setPendingJoin } from "./online.js";
import { enterParty, wireParty, leaveParty } from "./party.js";
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
  /* the lobby brand is the same quiet way home as its Home twin — it already
     had the cursor, the hover lift and the alt text, just no handler */
  $("logoLobby").onclick=()=>transition("menu");
  $("btnGear").onclick=()=>transition(gameState()==="training"?"menu":"training");
  $("btnDoneTrain").onclick=()=>transition("menu");
  $("btnFriends").onclick=()=>toast("Friends lists are coming soon — share a room link to play together!");
  /* Class-driven so every screen's volume control stays in sync — the header,
     Home, and one per play stage (the header is hidden during a round). */
  const toggleMute=()=>{
    state.muted=!state.muted;
    for(const el of document.querySelectorAll(".snd-on"))
      el.classList.toggle("hidden",state.muted);
    for(const el of document.querySelectorAll(".snd-off"))
      el.classList.toggle("hidden",!state.muted);
    for(const el of document.querySelectorAll(".sp-sound")){
      el.classList.toggle("muted",state.muted);
      el.setAttribute("aria-label",state.muted?"Unmute sound":"Mute sound");
      el.title=state.muted?"Unmute":"Mute";
    }
    /* blip() is silent while muted, so this only ever sounds on UNmute —
       which is exactly the confirmation you want: proof audio works. */
    blip([523,784],.05);
  };
  for(const id of ["btnSound","btnHomeSound",
                   "btnSoloSound","btnMatchSound","btnPartySound"])
    $(id).onclick=toggleMute;

  /* 1v1 and Party no longer show a LEAVE paper during a match. Esc is the
     replacement, and it still does the thing that actually matters: tell the
     room you are going, so five other people are not waiting out a player who
     is not there. Without it, entering an online match would be a one-way
     door — the header is hidden on every play stage. */
  addEventListener("keydown", e => {
    if(e.key!=="Escape" || e.repeat || isHowToPlayOpen()) return;
    if(state.screen==="match"){ leaveRoom(); transition("menu"); }
    else if(state.screen==="pmatch"){ leaveParty(); transition("menu"); }
    else return;
    toast("Left the match.");
  });

  /* home (Figma v2): SOLO card -> solo, 1V1 -> lobby, PARTY -> party room */
  $("modeAI").onclick=()=>startGame("ai");
  $("modeVS").onclick=()=>enterLobby();
  $("modeParty").onclick=()=>enterParty();
  $("btnHomeGear").onclick=()=>transition("training");
  wireHomeAlive();
  wireLobbyAlive();

  /* in-game. Solo just ends the run; the online modes have to tell the room
     they are going, or everyone else waits out a player who is not there. */
  $("btnExitSolo").onclick=()=>state.game&&endGame();
  $("btnSkipSolo").onclick=()=>missWord(true);
  $("btnExitMatch").onclick=()=>{ leaveRoom(); transition("menu"); };
  $("btnExitParty").onclick=()=>{ leaveParty(); transition("menu"); };

  /* results — the screen owns its own buttons now (see results.js) */
  wireResults();
  const leaveResults=()=>{
    /* Party results still own a live shared room; its lifecycle listener
       performs the single room:leave. Solo/1v1 keep their existing cleanup. */
    if($("resStage").dataset.mode !== "party") leaveRoom();
    transition("menu");
  };
  $("rsHome").onclick=leaveResults;
  $("rsExit").onclick=leaveResults;

  /* dev: jump straight to either results layout without playing a match */
  const resultsDev=$("btnDevResults");
  resultsDev.onclick=()=>{
    const order=["3v3","2v2","breakdown","1v1","1v1-breakdown","solo"];
    const next=order[(order.indexOf(resultsDev.dataset.kind||"breakdown")+1)%order.length];
    resultsDev.dataset.kind=next;
    resultsDev.textContent="DEV: RESULTS "+next.toUpperCase();
    devResults(next);
  };

  /* training */
  $("btnRecord").onclick=startRecording;
  $("btnTrain").onclick=()=>train();
  /* deleting clips has to refit the model the live panel is using */
  setDatasetEditedHandler(()=>{ train({silent:true, defer:true}); });
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
