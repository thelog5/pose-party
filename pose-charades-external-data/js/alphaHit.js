/* Alpha-aware hit testing for irregular paper PNGs.
   HTML images normally receive pointer events across their full rectangular
   box, including transparent corners. A small downsampled alpha map lets the
   transparent pixels fall through while keeping the visible paper clickable. */

const MAX_MAP_EDGE = 640;
const ALPHA_THRESHOLD = 20;

function sourceImage(hit){
  return hit instanceof HTMLImageElement
    ? hit
    : hit.querySelector(":scope > img") || hit.querySelector("img");
}

function buildMap(entry){
  const { image } = entry;
  const draw = () => {
    const ratio=Math.min(1, MAX_MAP_EDGE/Math.max(image.naturalWidth,image.naturalHeight));
    const width=Math.max(1,Math.round(image.naturalWidth*ratio));
    const height=Math.max(1,Math.round(image.naturalHeight*ratio));
    const canvas=document.createElement("canvas");
    canvas.width=width; canvas.height=height;
    const ctx=canvas.getContext("2d",{willReadFrequently:true});
    ctx.drawImage(image,0,0,width,height);
    const rgba=ctx.getImageData(0,0,width,height).data;
    const alpha=new Uint8Array(width*height);
    for(let i=0;i<alpha.length;i++) alpha[i]=rgba[i*4+3];
    entry.map={width,height,alpha};
  };
  if(image.complete && image.naturalWidth) draw();
  else image.addEventListener("load",draw,{once:true});
}

function reset(entries){
  for(const { hit } of entries) hit.style.removeProperty("pointer-events");
}

/* every wired root, so a screen change can hand back the papers it disabled */
const roots = new Set();

/* Papers are only disabled while the pointer is over their transparent part,
   and that inline style used to be cleared by `pointerleave` alone — so
   leaving a screen with the cursor resting on a transparent corner left that
   element permanently unclickable when the player came back. */
export function resetAlphaHitAreas(){
  for(const entries of roots) reset(entries);
}

export function wireAlphaHitAreas(root, selector){
  if(!root || root.dataset.alphaHitWired==="true") return;
  root.dataset.alphaHitWired="true";

  const entries=[...root.querySelectorAll(selector)]
    .map(hit=>({hit,image:sourceImage(hit),map:null}))
    .filter(entry=>entry.image);
  entries.forEach(buildMap);
  roots.add(entries);

  /* Coalesce into one frame: a high-rate pointer fires hundreds of moves a
     second, and each one measured every registered paper on the screen. */
  let pending=null, frame=0;
  const apply=()=>{
    frame=0;
    const at=pending;
    pending=null;
    if(!at) return;
    for(const entry of entries){
      if(!entry.map) continue;
      const { hit, map }=entry;
      const rect=hit.getBoundingClientRect();
      const inside=at.x>=rect.left && at.x<=rect.right &&
        at.y>=rect.top && at.y<=rect.bottom;
      if(!inside || !rect.width || !rect.height){
        hit.style.removeProperty("pointer-events");
        continue;
      }
      const x=Math.max(0,Math.min(map.width-1,
        Math.floor((at.x-rect.left)/rect.width*map.width)));
      const y=Math.max(0,Math.min(map.height-1,
        Math.floor((at.y-rect.top)/rect.height*map.height)));
      hit.style.pointerEvents=map.alpha[y*map.width+x]>ALPHA_THRESHOLD ? "" : "none";
    }
  };

  root.addEventListener("pointermove",event=>{
    pending={x:event.clientX,y:event.clientY};
    if(!frame) frame=requestAnimationFrame(apply);
  },{passive:true});
  root.addEventListener("pointerleave",()=>{
    pending=null;
    if(frame){ cancelAnimationFrame(frame); frame=0; }
    reset(entries);
  },{passive:true});
}
