/* Entry point: wire the DOM to the modules, then start. */

import { $ } from "./dom.js";
import { state } from "./state.js";
import { STARTERS } from "./constants.js";
import { toast, renderClasses, setDatasetEditedHandler, setRecordWordHandler } from "./ui.js";
import { blip } from "./audio.js";
import { startRecording, recordWord } from "./capture.js";
import { train } from "./training.js";
import { exportData, importData, preloadBundledDataset } from "./data.js";
import { render } from "./screens.js";
import { gameState, transition, onTransition } from "./fsm.js";
import { startGame, missWord, endGame, bindGameLifecycle } from "./game.js";
import { wireResults, devResults } from "./results.js";
import { enterLobby, leaveRoom, setPendingJoin } from "./online.js";
import { enterParty, wireParty, leaveParty } from "./party.js";
import { wireHomeAlive, pickMode } from "./homeAlive.js";
import { wireHowToPlay, isHowToPlayOpen } from "./howToPlay.js";
import { requireOnlineAge, isAgeGateOpen } from "./ageGate.js";
import { wireCameraGate } from "./cameraGate.js";
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
  $("btnFriends").onclick=()=>toast("Friends lists are coming soon. Share a room link to play together!");
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
    if(e.key!=="Escape" || e.repeat || isHowToPlayOpen() || isAgeGateOpen()) return;
    if(state.screen==="match"){ leaveRoom(); transition("menu"); }
    else if(state.screen==="pmatch"){ leaveParty(); transition("menu"); }
    else return;
    toast("Left the match.");
  });

  /* home (Figma v2): SOLO card -> solo, 1V1 -> lobby, PARTY -> party room.
     pickMode() pops the pressed card off the board first and calls through
     when it is gone — the press has to be answered before the next screen
     exists, and for 1v1/Party the lobby then re-lands the same component. */
  $("modeAI").onclick=playSolo;
  /* Online play asks the player's age first (ageGate.js); under 13 is kept
     to Solo, which the card's PLAY SOLO button starts. */
  $("modeVS").onclick=()=>requireOnlineAge(()=>pickMode("vs",()=>enterLobby()), { solo:playSolo });
  $("modeParty").onclick=()=>requireOnlineAge(()=>pickMode("party",()=>enterParty()), { solo:playSolo });
  $("btnHomeGear").onclick=()=>transition("training");
  wireHomeAlive();
  wireLobbyAlive();
  wireHowToPlay();
  /* Must be wired before boot() so the ENABLE CAMERA card's one button is
     live the instant the card goes up. */
  wireCameraGate();

  /* in-game. Solo keeps its LEAVE paper: there is no room to tell, and no
     Esc-only affordance is warranted when the run is entirely local. */
  $("btnExitSolo").onclick=()=>state.game&&endGame();
  $("btnSkipSolo").onclick=()=>missWord(true);

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

  /* dev: jump straight to the training panel from wherever you are. Every
     FSM state already allows `training`, and this is the same call Home's
     gear makes — it just saves walking back to Home to reach it. */
  $("btnDevTrain").onclick=()=>{ if(gameState()!=="training") transition("training"); };

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
  setRecordWordHandler(recordWord);
  $("btnTrain").onclick=()=>train();
  /* deleting clips has to refit the model the live panel is using */
  setDatasetEditedHandler(()=>{ train({silent:true, defer:true}); });
  $("btnExport").onclick=exportData;
  $("btnImport").onclick=()=>$("fileImport").click();
  $("fileImport").onchange=e=>{ if(e.target.files[0]) importData(e.target.files[0]); e.target.value=""; };

  wireParty();
}

/* The SOLO card, and the age card's PLAY SOLO button. */
function playSolo(){ pickMode("ai",()=>startGame("ai")); }

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
    if(state.model){ requireOnlineAge(()=>enterLobby(), { solo:playSolo }); return; }
    setTimeout(tryEnter, 400);
  };
  tryEnter();
}

/* THE OWNER'S TOOLS ARE THE OWNER'S. The Home gear (the only way into
   Training), every sound button and the DEV bar show only with
   body[data-dev] (screens.css).
   - On a real site, only the server can switch it on: the owner visits /dev,
     types the stats password, and gets a signed HttpOnly cookie; this asks
     /dev/check and shows the tools on a 204. ?dev does nothing there.
   - On localhost (your own machine, and every E2E suite) ?dev / ?dev=0 and
     the localStorage flag still work, with no server needed. */
const IS_LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
function applyDevMode(){
  delete document.body.dataset.dev;
  if(!IS_LOCAL){
    fetch("/dev/check", { cache:"no-store", credentials:"same-origin" })
      .then(r => { if(r.status===204) document.body.dataset.dev="1"; })
      .catch(() => {});
    return;
  }
  const KEY="posePartyDev";
  try{
    const q=new URLSearchParams(location.search).get("dev");
    if(q!==null){
      if(q==="0") localStorage.removeItem(KEY); else localStorage.setItem(KEY,"1");
      const url=new URL(location.href); url.searchParams.delete("dev");
      history.replaceState(null,"",url.pathname+url.search+url.hash);
    }
    if(localStorage.getItem(KEY)==="1") document.body.dataset.dev="1";
  }catch(e){ /* no storage: players' view */ }
}

applyDevMode();
wireControls();
buildStarterWords();
renderClasses();
render(gameState());
preloadBundledDataset().then(handleJoinLink);
/* pasting a room link into an already-open tab fires hashchange, not load */
window.addEventListener("hashchange", handleJoinLink);
boot();
