/* Turns raw MediaPipe landmarks into a hip-centered, shoulder-scaled frame:
   [ ...body, ...leftHand, ...rightHand ] of FRAME_POINTS [x,y] pairs. */

import { JOINTS, HAND_LANDMARKS } from "./constants.js";
import { REFERENCE_ASPECT } from "./poseInput.js";

export function emptyHand(){ return Array.from({length:HAND_LANDMARKS},()=>[0,0]); }

function handednessLabel(handRes, idx){
  const all = handRes?.handednesses || handRes?.handedness || [];
  const item = all[idx];
  const cat = Array.isArray(item) ? item[0] : item;
  return (cat?.categoryName || cat?.displayName || cat?.label || "").toLowerCase();
}

export function splitHands(handRes){
  const out={left:null,right:null};
  const hands = handRes?.landmarks || [];
  for(let i=0;i<hands.length;i++){
    const label=handednessLabel(handRes,i);
    if(label.includes("left") && !out.left) out.left=hands[i];
    else if(label.includes("right") && !out.right) out.right=hands[i];
  }
  // Fallback when handedness is unavailable: keep a stable left/right order by x position.
  const leftovers = hands.filter(h=>h!==out.left && h!==out.right).sort((a,b)=>(a[0]?.x||0)-(b[0]?.x||0));
  for(const h of leftovers){
    if(!out.left) out.left=h;
    else if(!out.right) out.right=h;
  }
  return out;
}

function normalizeHands(handRes, hx, hy, s, xScale){
  const hands=splitHands(handRes);
  const norm = hand => hand ? hand.map(p=>[
    +(((p.x-hx)*xScale/s).toFixed(3)),
    +(((p.y-hy)/s).toFixed(3))
  ]) : emptyHand();
  return { left:norm(hands.left), right:norm(hands.right) };
}

/* Returns null when the torso is too small to give a stable scale. */
export function normalize(lm, handRes, camera){
  if(!lm || JOINTS.some(j => !Number.isFinite(lm[j]?.x) || !Number.isFinite(lm[j]?.y))) return null;
  const aspect = camera?.width / camera?.height;
  const xScale = Number.isFinite(aspect) && aspect > 0 ? aspect / REFERENCE_ASPECT : 1;
  const hx=(lm[23].x+lm[24].x)/2, hy=(lm[23].y+lm[24].y)/2;
  const sx=(lm[11].x+lm[12].x)/2, sy=(lm[11].y+lm[12].y)/2;
  const s=Math.hypot((sx-hx)*xScale, sy-hy);
  if(!s || s<1e-4) return null;
  const body = JOINTS.map(j=>[ +(((lm[j].x-hx)*xScale/s).toFixed(3)), +(((lm[j].y-hy)/s).toFixed(3)) ]);
  const hands = normalizeHands(handRes, hx, hy, s, xScale);
  return body.concat(hands.left, hands.right);
}
