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

export function wireAlphaHitAreas(root, selector){
  if(!root || root.dataset.alphaHitWired==="true") return;
  root.dataset.alphaHitWired="true";

  const entries=[...root.querySelectorAll(selector)]
    .map(hit=>({hit,image:sourceImage(hit),map:null}))
    .filter(entry=>entry.image);
  entries.forEach(buildMap);

  root.addEventListener("pointermove",event=>{
    for(const entry of entries){
      if(!entry.map) continue;
      const { hit, map }=entry;
      const rect=hit.getBoundingClientRect();
      const inside=event.clientX>=rect.left && event.clientX<=rect.right &&
        event.clientY>=rect.top && event.clientY<=rect.bottom;
      if(!inside || !rect.width || !rect.height){
        hit.style.removeProperty("pointer-events");
        continue;
      }
      const x=Math.max(0,Math.min(map.width-1,
        Math.floor((event.clientX-rect.left)/rect.width*map.width)));
      const y=Math.max(0,Math.min(map.height-1,
        Math.floor((event.clientY-rect.top)/rect.height*map.height)));
      hit.style.pointerEvents=map.alpha[y*map.width+x]>ALPHA_THRESHOLD ? "" : "none";
    }
  },{passive:true});
  root.addEventListener("pointerleave",()=>reset(entries),{passive:true});
}
