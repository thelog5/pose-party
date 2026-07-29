/* Dataset import/export. Training data lives only in the external JSON file —
   replace assets/data/pose-charades-data.json whenever you export newer data.
   Must be served over http(s), not file://, or the fetch is blocked. */

import { JOINTS, FRAME_POINTS, BUNDLED_DATA_URL } from "./constants.js";
import { state } from "./state.js";
import { toast, renderClasses } from "./ui.js";
import { train } from "./training.js";

export function exportData(){
  const blob=new Blob([JSON.stringify(state.dataset)],{type:"application/json"});
  const a=document.createElement("a"); a.href=URL.createObjectURL(blob);
  a.download="pose-charades-data-"+new Date().toISOString().slice(0,10)+".json"; a.click();
  URL.revokeObjectURL(a.href);
}

/* Older exports predate hand tracking; pad them out to the current frame width. */
function padFrame(frame){
  if(frame.length>=FRAME_POINTS) return frame.slice(0,FRAME_POINTS);
  return frame.concat(Array.from({length:FRAME_POINTS-frame.length},()=>[0,0]));
}

function mergeClips(d){
  if(!d || !d.clips || JSON.stringify(d.joints)!==JSON.stringify(JOINTS)) throw new Error("bad dataset");
  const clips=d.clips.map(c=>({...c, frames:c.frames.map(padFrame)}));
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
    }catch(e){ toast("That file doesn’t look like a Pose Charades dataset."); }
  };
  r.readAsText(file);
}

export async function preloadBundledDataset(){
  try{
    const res=await fetch(BUNDLED_DATA_URL,{cache:"no-store"});
    if(!res.ok) throw new Error("Missing training data file: "+BUNDLED_DATA_URL);
    mergeClips(await res.json());
    if(state.dataset.clips.length) train({silent:true});
    /* the preload is expected and uneventful — no toast for it */
  }catch(e){
    console.warn("Training data could not be loaded.", e);
    toast("No training data loaded. Run with localhost and keep data at assets/data/pose-charades-data.json");
  }
}
