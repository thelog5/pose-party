/* Cosine-similarity kNN over per-window motion features.
   Pure functions — no DOM, no shared state.

   Three things here are load-bearing and were each worth a measurable jump in
   leave-one-clip-out accuracy on the shipped deck (63% -> 88%):

   · **The feature space is STANDARDIZED, not raw.** Every human standing in
     front of a camera has nearly the same average posture, so the `mean` block
     dominates the vector and every clip in the deck sat at cosine .82-.99 to
     every other one — the whole dataset lived in one narrow cone and the gap
     between "same word" and "different word" was about .02. For five labels
     the within-label similarity was LOWER than the nearest wrong label, which
     is not a tuning problem, it is a geometry problem. `buildModel` now stores
     the per-dimension mean and standard deviation of the training set and both
     sides subtract/divide by them before the cosine. That alone is worth ~8
     points, and it is what took `boxing` and `flexing bicep` off the floor.
   · **Charades has no handedness.** Nobody mimes a tennis serve with a fixed
     hand, but every clip is recorded with one. Mirroring each clip doubles the
     deck for free and is worth ~15 points on its own — the single largest win
     available without recording anything.
   · **Nobody performs at the recording's tempo.** Each clip is also resampled
     slower and faster, so a word acted out at three-quarter speed still lands
     on a neighbour.

   Augmentation happens on FRAMES, before windowing, so a time-scaled clip
   produces genuinely different windows rather than a re-labelled copy. */

import { MODEL_POINTS, JOINTS, LEFT_HAND_OFFSET, RIGHT_HAND_OFFSET,
         HAND_LANDMARKS, WIN, STRIDE, K, TIME_SCALES,
         FEATURE_SD_FLOOR } from "./constants.js";

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

/* MediaPipe numbers its paired landmarks left-odd / right-even from 11 up, so
   a body joint's mirror is its neighbour and the centre line (nose, 0) is its
   own mirror. Derived from JOINTS rather than written out, so changing the
   joint list cannot leave a stale table behind. */
const BODY_MIRROR = JOINTS.map(j => {
  const partner = j < 11 ? j : (j % 2 ? j + 1 : j - 1);
  const at = JOINTS.indexOf(partner);
  return at === -1 ? JOINTS.indexOf(j) : at;
});

/* Flip a frame across the body's own centre line: negate x (the frame is
   already hip-centred, so 0 IS the centre line), swap the paired body joints,
   and swap the two hand blocks wholesale. */
function mirrorFrame(frame){
  const out=new Array(frame.length);
  for(let i=0;i<JOINTS.length;i++){
    const p=pt(frame, BODY_MIRROR[i]);
    out[i]=[-p[0], p[1]];
  }
  for(let i=0;i<HAND_LANDMARKS;i++){
    const l=pt(frame, LEFT_HAND_OFFSET+i), r=pt(frame, RIGHT_HAND_OFFSET+i);
    out[LEFT_HAND_OFFSET+i]=[-r[0], r[1]];
    out[RIGHT_HAND_OFFSET+i]=[-l[0], l[1]];
  }
  return out;
}

export const mirrorFrames = frames => frames.map(mirrorFrame);

/* Linear resample to `factor` of the original length. Never shorter than WIN,
   so speeding a clip up cannot drop it below one window. */
export function timeScaleFrames(frames, factor){
  const n=frames.length;
  const m=Math.max(WIN, Math.round(n*factor));
  if(n<2 || m===n) return frames;
  const width=frames[0].length, out=new Array(m);
  for(let i=0;i<m;i++){
    const t=i*(n-1)/(m-1), a=Math.min(n-2, Math.floor(t)), f=t-a;
    const A=frames[a], B=frames[a+1], row=new Array(width);
    for(let j=0;j<width;j++){
      const p=pt(A,j), q=pt(B,j);
      row[j]=[p[0]+(q[0]-p[0])*f, p[1]+(q[1]-p[1])*f];
    }
    out[i]=row;
  }
  return out;
}

export function windowsOf(clip){
  const out=[], F=clip.frames;
  if(F.length<15) return out;
  if(F.length<=WIN){ out.push(features(F)); return out; }
  for(let i=0;i+WIN<=F.length;i+=STRIDE) out.push(features(F.slice(i,i+WIN)));
  return out;
}

/* Every training view of one clip: both handednesses at every tempo. */
function* augmentedFrames(clip){
  for(const frames of [clip.frames, mirrorFrames(clip.frames)])
    for(const factor of TIME_SCALES)
      yield factor===1 ? frames : timeScaleFrames(frames, factor);
}

export function buildModel(clips){
  const raw=[], labels=new Set();
  for(const c of clips){
    labels.add(c.label);
    for(const frames of augmentedFrames(c))
      for(const v of windowsOf({frames})) raw.push({v, label:c.label});
  }
  const D = raw.length ? raw[0].v.length : MODEL_POINTS*6;
  const mean=new Float32Array(D), sd=new Float32Array(D);
  if(raw.length){
    for(const s of raw) for(let d=0;d<D;d++) mean[d]+=s.v[d];
    for(let d=0;d<D;d++) mean[d]/=raw.length;
    for(const s of raw) for(let d=0;d<D;d++) sd[d]+=(s.v[d]-mean[d])**2;
    for(let d=0;d<D;d++) sd[d]=Math.sqrt(sd[d]/raw.length);
    applySdFloor(sd);
  }else sd.fill(1);

  const samples=raw.map(s=>{
    const v=standardize(s.v, mean, sd);
    return { v, norm:l2(v), label:s.label };
  });
  return { samples, labels:[...labels], mean, sd };
}

/* Raise every dimension's standard deviation to at least FEATURE_SD_FLOOR of
   the median within its own block, so a dimension that barely moves cannot be
   amplified into the loudest thing in the vector. Per BLOCK rather than across
   the whole vector because position, spread and velocity live at genuinely
   different magnitudes and comparing them to one another means nothing. */
function applySdFloor(sd){
  const D=sd.length, blocks=3, span=D/blocks;
  for(let b=0;b<blocks;b++){
    const from=b*span, block=Array.from(sd.slice(from, from+span)).sort((x,y)=>x-y);
    const mid=block.length>>1;
    const median=block.length%2 ? block[mid] : (block[mid-1]+block[mid])/2;
    /* the +1e-6 is the only true divide-by-zero guard here; the floor above it
       is the thing that actually matters */
    const floor=Math.max(median*FEATURE_SD_FLOOR, 1e-6);
    for(let d=from;d<from+span;d++) sd[d]=Math.max(sd[d], floor);
  }
}

/* Move a raw feature vector into the model's standardized space. A model built
   before this existed carries no mean/sd; it is then the identity, so an old
   in-memory model still classifies rather than throwing. */
function standardize(v, mean, sd){
  if(!mean || !sd) return v;
  const out=new Float32Array(v.length);
  for(let d=0;d<v.length;d++) out[d]=(v[d]-mean[d])/sd[d];
  return out;
}

/* Cubed similarity weighting sharpens the vote toward the nearest neighbours. */
export function classify(v, m){
  const q=standardize(v, m.mean, m.sd);
  const nv=l2(q), sims=[];
  for(const s of m.samples){
    let dot=0; for(let d=0;d<q.length;d++) dot+=q[d]*s.v[d];
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
