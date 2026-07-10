/* Entry point: wire the DOM to the modules, then start. */

import { $ } from "./dom.js";
import { state } from "./state.js";
import { STARTERS } from "./constants.js";
import { toast, renderClasses } from "./ui.js";
import { startRecording } from "./capture.js";
import { train } from "./training.js";
import { exportData, importData, preloadBundledDataset } from "./data.js";
import { setScreen } from "./screens.js";
import { startGame, missWord, endGame } from "./game.js";
import { boot } from "./engine.js";

function wireControls(){
  $("logoHome").onclick=()=>setScreen("home");
  $("btnGear").onclick=()=>setScreen(state.screen==="train"?"home":"train");
  $("btnDoneTrain").onclick=()=>setScreen("home");
  $("btnSound").onclick=()=>{
    state.muted=!state.muted;
    $("sndOn").classList.toggle("hidden",state.muted);
    $("sndOff").classList.toggle("hidden",!state.muted);
  };

  $("btnStart").onclick=()=>startGame("ai");
  $("btnAgain").onclick=()=>startGame(state.lastMode);
  $("btnHome").onclick=()=>setScreen("home");
  $("btnSkip").onclick=()=>state.game&&missWord(true);
  $("btnQuit").onclick=()=>state.game&&endGame();
  $("btnQuitVs").onclick=()=>state.game&&endGame();

  if($("modeAI")) $("modeAI").onclick=()=>startGame("ai");
  $("modeVS").onclick=()=>startGame("vs");
  $("modeParty").onclick=()=>toast("Party Mode is coming soon.");

  $("btnRecord").onclick=startRecording;
  $("btnTrain").onclick=()=>train();
  $("btnExport").onclick=exportData;
  $("btnImport").onclick=()=>$("fileImport").click();
  $("fileImport").onchange=e=>{ if(e.target.files[0]) importData(e.target.files[0]); e.target.value=""; };
}

function buildStarterWords(){
  const dl=$("classSuggestions"), chips=$("starterChips");
  for(const w of STARTERS){
    const o=document.createElement("option"); o.value=w; dl.appendChild(o);
    const c=document.createElement("button"); c.className="chip"; c.textContent=w;
    c.onclick=()=>{ $("classInput").value=w; }; chips.appendChild(c);
  }
}

wireControls();
buildStarterWords();
renderClasses();
setScreen("home");
preloadBundledDataset();
boot();
