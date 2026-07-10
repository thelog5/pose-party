/* Cosine-similarity kNN over per-window motion features.
   Pure functions — no DOM, no shared state. */

import { MODEL_POINTS, WIN, STRIDE, K } from "./constants.js";

function pt(frame, j){
  const p=frame[j];
  return p ? p : [0,0];
}

/* Feature vector per window: per-joint mean, std, and mean absolute velocity. */
export function features(frames){
  const J=MODEL_POINTS, D=J*2, n=frames.length;
  const mean=new Float32Array(D), std=new Float32Array(D), vel=new Float32Array(D);
  for(const f of frames) for(let j=0;j<J;j++){ const p=pt(f,j); mean[j*2]+=p[0]; mean[j*2+1]+=p[1]; }
  for(let d=0;d<D;d++) mean[d]/=n;
  for(const f of frames) for(let j=0;j<J;j++){ const p=pt(f,j);
    std[j*2]+=(p[0]-mean[j*2])**2; std[j*2+1]+=(p[1]-mean[j*2+1])**2; }
  for(let d=0;d<D;d++) std[d]=Math.sqrt(std[d]/n);
  for(let i=1;i<n;i++) for(let j=0;j<J;j++){ const a=pt(frames[i],j), b=pt(frames[i-1],j);
    vel[j*2]+=Math.abs(a[0]-b[0]);
    vel[j*2+1]+=Math.abs(a[1]-b[1]); }
  for(let d=0;d<D;d++) vel[d]= n>1 ? vel[d]/(n-1)*8 : 0;
  const v=new Float32Array(D*3); v.set(mean,0); v.set(std,D); v.set(vel,D*2);
  return v;
}

export const l2 = v => Math.sqrt(v.reduce((s,x)=>s+x*x,0)) || 1e-9;

export function windowsOf(clip){
  const out=[], F=clip.frames;
  if(F.length<15) return out;
  if(F.length<=WIN){ out.push(features(F)); return out; }
  for(let i=0;i+WIN<=F.length;i+=STRIDE) out.push(features(F.slice(i,i+WIN)));
  return out;
}

export function buildModel(clips){
  const samples=[], labels=new Set();
  for(const c of clips){ labels.add(c.label);
    for(const v of windowsOf(c)) samples.push({v, norm:l2(v), label:c.label}); }
  return { samples, labels:[...labels] };
}

/* Cubed similarity weighting sharpens the vote toward the nearest neighbours. */
export function classify(v, m){
  const nv=l2(v), sims=[];
  for(const s of m.samples){
    let dot=0; for(let d=0;d<v.length;d++) dot+=v[d]*s.v[d];
    sims.push({sim:dot/(nv*s.norm), label:s.label});
  }
  sims.sort((a,b)=>b.sim-a.sim);
  const scores={}; let tot=0;
  for(let i=0;i<Math.min(K,sims.length);i++){
    const w=Math.max(sims[i].sim,0)**3;
    scores[sims[i].label]=(scores[sims[i].label]||0)+w; tot+=w;
  }
  if(tot>0) for(const k in scores) scores[k]/=tot;
  return scores;
}
