/* Skeleton overlay. Dims itself during play so it doesn't upstage the word card. */

import { JOINTS, BONES, HAND_BONES } from "./constants.js";
import { splitHands } from "./pose.js";
import { state } from "./state.js";

function drawHand(hand, color, c, canvas, subtle){
  if(!hand) return;
  const W=canvas.width, H=canvas.height;
  c.save();
  c.strokeStyle=color; c.fillStyle=color; c.lineWidth=subtle ? 1.7 : 3; c.lineCap="round";
  c.shadowColor=color; c.shadowBlur=subtle ? 0 : 6;
  for(const [a,b] of HAND_BONES){
    const p=hand[a], q=hand[b]; if(!p||!q) continue;
    c.beginPath(); c.moveTo(p.x*W,p.y*H); c.lineTo(q.x*W,q.y*H); c.stroke();
  }
  for(const p of hand){
    c.beginPath(); c.arc(p.x*W,p.y*H,subtle?2.2:3.6,0,7); c.fill();
  }
  c.restore();
}

export function drawSkeleton(lm, handRes, c, canvas){
  const W=canvas.width, H=canvas.height;
  const subtle = (state.screen==="solo" || state.screen==="match" || state.screen==="pmatch");
  c.save();
  c.strokeStyle=subtle ? "rgba(250,243,227,.42)" : "rgba(250,243,227,.95)";
  c.lineWidth=subtle ? 2.4 : 4;
  c.lineCap="round";
  c.shadowColor="rgba(250,243,227,.35)";
  c.shadowBlur=subtle ? 0 : 6;
  for(const [a,b] of BONES){
    const p=lm[JOINTS[a]], q=lm[JOINTS[b]];
    if(p.visibility<0.4||q.visibility<0.4) continue;
    c.beginPath(); c.moveTo(p.x*W,p.y*H); c.lineTo(q.x*W,q.y*H); c.stroke();
  }
  c.fillStyle=subtle ? "rgba(255,207,93,.58)" : "rgba(255,185,55,.95)";
  for(let i=1;i<JOINTS.length;i++){ const p=lm[JOINTS[i]]; if(p.visibility<0.4)continue;
    c.beginPath(); c.arc(p.x*W,p.y*H,subtle?3.0:4.5,0,7); c.fill(); }
  const nose=lm[0];
  if(nose.visibility>=0.4){ c.strokeStyle=subtle ? "rgba(255,207,93,.55)" : "rgba(255,185,55,.95)"; c.beginPath(); c.arc(nose.x*W,nose.y*H,subtle?10:15,0,7); c.stroke(); }

  const hands=splitHands(handRes);
  drawHand(hands.left, subtle ? "rgba(180,245,218,.48)" : "rgba(62,213,152,.96)", c, canvas, subtle);
  drawHand(hands.right, subtle ? "rgba(255,184,202,.48)" : "rgba(248,72,94,.96)", c, canvas, subtle);
  c.restore();
}
