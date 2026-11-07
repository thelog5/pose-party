/* Dataset import/export. Training data lives only in the external JSON file —
   replace assets/data/pose-charades-data.json whenever you export newer data.
   Must be served over http(s), not file://, or the fetch is blocked. */

import { BUNDLED_DATA_URL } from "./constants.js";
import { decodePoseDataset } from "./poseData.js";
import { state } from "./state.js";
import { toast, renderClasses } from "./ui.js";
import { train } from "./training.js";
import { setWordStatsEnabled } from "./wordStats.js";

export function exportData(){
  const blob=new Blob([JSON.stringify(state.dataset)],{type:"application/json"});
  const a=document.createElement("a"); a.href=URL.createObjectURL(blob);
  a.download="pose-charades-data-"+new Date().toISOString().slice(0,10)+".json"; a.click();
  URL.revokeObjectURL(a.href);
}

function mergeClips(d){
  const clips=decodePoseDataset(d);
  state.dataset.clips.push(...clips);
  renderClasses();
  return clips;
}

export function importData(file){
  const r=new FileReader();
  r.onload=()=>{
    try{
      const clips=mergeClips(JSON.parse(r.result));
      toast("Merged "+clips.length+" clips.");
    }catch(e){ toast("That file doesn’t look like a Pose Party dataset."); }
  };
  r.readAsText(file);
}

/* `no-cache`, not `no-store`: the deck is megabytes and rarely changes. The
   browser keeps its copy and asks the server each visit; an unchanged file
   comes back as a 304 with no body. A new deck is still picked up at once. */
export async function preloadBundledDataset(){
  try{
    const res=await fetch(BUNDLED_DATA_URL,{cache:"no-cache"});
    if(!res.ok) throw new Error("Missing training data file: "+BUNDLED_DATA_URL);
    /* the game server says whether it collects word stats (wordStats.js) */
    setWordStatsEnabled(res.headers.get("x-word-stats")==="on");
    mergeClips(await res.json());
    if(state.dataset.clips.length) train({silent:true});
    /* the preload is expected and uneventful — no toast for it */
  }catch(e){
    console.warn("Training data could not be loaded.", e);
    toast("No training data loaded. Run with localhost and keep data at assets/data/pose-charades-data.json");
  }
}
