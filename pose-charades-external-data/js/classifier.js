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
   · **Dimensions are WEIGHTED by how well they separate words** (see
     featureWeights). One weight vector for the whole deck, learned from the
     spread between takes. +3.0 points clean and +5 under hip jitter on the
     2026-09-11 deck (65.7% -> 68.7%), +5.8 on the deck before it.

   Augmentation happens on FRAMES, before windowing, so a time-scaled clip
   produces genuinely different windows rather than a re-labelled copy. */

import { MODEL_POINTS, JOINTS, LEFT_HAND_OFFSET, RIGHT_HAND_OFFSET,
         HAND_LANDMARKS, WIN, STRIDE, K, TIME_SCALES, FEATURE_SD_FLOOR,
         FEATURE_WEIGHT_MIN, FEATURE_WEIGHT_MAX, FEATURE_WEIGHT_FLOOR,
         FEATURE_WEIGHTING, WORD_JOINT_WEIGHTS, LEG_SHARE_MIN } from "./constants.js";
import { clipSegments, canonicalClip, LEGS } from "./poseInput.js";

function pt(frame, j){
  const p=frame[j];
  return p ? p : [0,0];
}

/* DISTANCES BETWEEN JOINTS, the fourth block. Every position above is
   measured from the hip centre, so when the tracker moves a hip, every joint
   moves with it. The distance from a wrist to the nose does not change. On the
   2026-09-11 deck this block leaves clean accuracy where it was (76.0% ->
   76.1%) and takes accuracy under .02 hip-and-leg jitter from 56.7% to 67.4%.
   It also makes the model less sensitive to body shape: test clips with legs
   20% shorter score 71.4% against 65.6% without it. Raw MediaPipe ids; the
   list is closed under mirroring, so a mirrored clip uses the same pairs. */
const PAIRS = [[15,0],[16,0],[15,16],[15,23],[16,24],[15,12],[16,11],
               [13,14],[27,28],[25,26],[15,25],[16,26]]
  .map(pair => pair.map(j => JOINTS.indexOf(j)));

/* Block layout: [mean, std, vel] are x,y per joint; then the mean and the std
   of each pair distance. DIM_JOINTS says which joints each dimension reads,
   so a masked joint drops every dimension that depends on it. */
const POS_DIMS = MODEL_POINTS*2;
export const FEATURE_DIMS = POS_DIMS*3 + PAIRS.length*2;
const BLOCKS = [[0,POS_DIMS],[POS_DIMS,POS_DIMS*2],[POS_DIMS*2,POS_DIMS*3],[POS_DIMS*3,FEATURE_DIMS]];
const DIM_JOINTS = Array.from({length:FEATURE_DIMS}, (_, d) => d < POS_DIMS*3
  ? [Math.floor((d % POS_DIMS)/2)] : PAIRS[(d - POS_DIMS*3) % PAIRS.length]);

/* Feature vector per window: per-joint mean, std, and mean absolute velocity,
   then the mean and std of each joint-pair distance. */
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
  const P=PAIRS.length, dist=new Float64Array(P*n), dMean=new Float64Array(P), dStd=new Float64Array(P);
  frames.forEach((f, i) => PAIRS.forEach(([a, b], k) => {
    const p=pt(f,a), q=pt(f,b), x=Math.hypot(p[0]-q[0], p[1]-q[1]);
    dist[i*P+k]=x; dMean[k]+=x/n;
  }));
  for(let i=0;i<n;i++) for(let k=0;k<P;k++) dStd[k]+=(dist[i*P+k]-dMean[k])**2/n;
  const v=new Float32Array(FEATURE_DIMS); v.set(mean,0); v.set(std,D); v.set(vel,D*2);
  v.set(dMean,D*3); v.set(dStd.map(Math.sqrt),D*3+P);
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

/* Linear resample to `factor` of the original length. A source that holds a
   full window keeps one, so speeding it up cannot drop it below WIN. A shorter
   source is scaled as asked and gives null under 15 frames. It used to be
   floored at WIN too, which stretched every section under 24 frames to 30:
   the "fast" copy and the "slow" copy both came out SLOWER. */
export function timeScaleFrames(frames, factor){
  const n=frames.length;
  let m=Math.round(n*factor);
  if(n>=WIN) m=Math.max(WIN, m);
  else if(m<15) return null;
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
  const out=[];
  for(const F of clipSegments(canonicalClip(clip))){
    if(F.length<15) continue;
    if(F.length<=WIN){ out.push(features(F)); continue; }
    for(let i=0;i+WIN<=F.length;i+=STRIDE) out.push(features(F.slice(i,i+WIN)));
  }
  return out;
}

/* Every training view of one clip: both handednesses at every tempo. */
function* augmentedFrames(clip){
  for(const segment of clipSegments(canonicalClip(clip))){
    if(segment.length < 15) continue;
    for(const frames of [segment, mirrorFrames(segment)])
      for(const factor of TIME_SCALES){
        const out = factor===1 ? frames : timeScaleFrames(frames, factor);
        if(out) yield out;
      }
  }
}

/* Joint groups WORD_JOINT_WEIGHTS can name. Arms: elbows, wrists, index
   fingers. Legs: knees and ankles. */
const JOINT_GROUPS = {
  arms: [13,14,15,16,19,20].map(j => JOINTS.indexOf(j)),
  legs: [25,26,27,28].map(j => JOINTS.indexOf(j)),
};

/* Squared per-dimension weights for each word in `table`, or null for none.
   A pair distance takes the mean of its two joints' weights. */
function wordDimWeights(table, labels){
  const out = {};
  for(const label of labels){
    const spec = table[label];
    if(!spec) continue;
    const joint = new Float32Array(JOINTS.length).fill(1);
    for(const [group, x] of Object.entries(spec)) for(const j of JOINT_GROUPS[group]) joint[j] = x;
    out[label] = Float32Array.from({length:FEATURE_DIMS}, (_, d) => {
      const js = DIM_JOINTS[d], w = js.reduce((s, j) => s + joint[j], 0) / js.length;
      return w * w;
    });
  }
  return Object.keys(out).length ? out : null;
}

/* `weigh` switches the learned global weighting (FEATURE_WEIGHTING);
   `wordWeights` is the per-word joint emphasis (WORD_JOINT_WEIGHTS, `{}` for
   none). scripts/pose-deck-eval.mjs builds every combination as a baseline.
   The weight* options override the FEATURE_WEIGHT_* table. */
export function buildModel(clips, { weigh=FEATURE_WEIGHTING, wordWeights=WORD_JOINT_WEIGHTS,
                                    weightMin=FEATURE_WEIGHT_MIN, weightMax=FEATURE_WEIGHT_MAX,
                                    weightFloor=FEATURE_WEIGHT_FLOOR }={}){
  const raw=[], labels=new Set();
  clips.forEach((c, take)=>{
    for(const frames of augmentedFrames(c))
      for(const v of windowsOf({frames})){ labels.add(c.label); raw.push({v, label:c.label, take}); }
  });
  const D = raw.length ? raw[0].v.length : FEATURE_DIMS;
  const mean=new Float32Array(D), sd=new Float32Array(D);
  if(raw.length){
    for(const s of raw) for(let d=0;d<D;d++) mean[d]+=s.v[d];
    for(let d=0;d<D;d++) mean[d]/=raw.length;
    for(const s of raw) for(let d=0;d<D;d++) sd[d]+=(s.v[d]-mean[d])**2;
    for(let d=0;d<D;d++) sd[d]=Math.sqrt(sd[d]/raw.length);
    applySdFloor(sd);
  }else sd.fill(1);

  const z=raw.map(s=>standardize(s.v, mean, sd));
  /* Learned even when `weigh` is off: legLabels is calibrated in this space. */
  const learned = raw.length
    ? featureWeights(z, raw, { min:weightMin, max:weightMax, floor:weightFloor }) : null;
  const weights = weigh ? learned : null;
  /* Fold the weights into sd, so classify() stays one cosine and costs the
     same: (v-mean)/(sd/w) is exactly w*(v-mean)/sd. */
  if(weights) for(let d=0;d<D;d++){ sd[d]/=weights[d]; for(const v of z) v[d]*=weights[d]; }

  /* A word with joint emphasis keeps its squared weights on each of its
     samples, and the sample's norm is taken in that weighted metric. */
  const wordW = raw.length ? wordDimWeights(wordWeights, labels) : null;
  const samples=raw.map((s,i)=>{
    const w2 = wordW?.[s.label];
    const norm = w2 ? Math.sqrt(z[i].reduce((sum, x, d) => sum + w2[d]*x*x, 0)) || 1e-9 : l2(z[i]);
    return w2 ? { v:z[i], norm, w2, label:s.label, take:s.take } : { v:z[i], norm, label:s.label, take:s.take };
  });
  return { samples, labels:[...labels], mean, sd, weights, wordWeights:wordW, legLabels:legLabels(samples, D, weights ? null : learned) };
}

/* Words that need their legs SEEN before they can be recognized. Each word's
   centroid in the weighted space is its difference from the average pose; the
   share of that difference on knee and ankle dimensions says how much of the
   word lives in its legs. Past LEG_SHARE_MIN its upper body is generic, so a
   comparison with the legs masked would accept it on any standing player.
   Cheap (one pass over the samples), so every retrain re-derives it.
   ALWAYS IN THE LEARNED-WEIGHT SPACE, even with FEATURE_WEIGHTING off: pass
   `learned` when the samples are unweighted. LEG_SHARE_MIN was set there, and
   there the deck has a clear gap (star jump .30, then saluting .23). In the
   unweighted space there is none, and .26 also gates 67, saluting, dribbling
   a basketball and climbing a ladder, which a player with the feet out of shot
   could then never get. */
function legLabels(samples, D, learned=null){
  /* Measured on the three POSITION blocks only. The distance block mixes arm
     and leg in one number (wrist to knee), so counting it pushed overhead
     bicep flex (.249) up level with squat (.255) and froggy jump (.254). On
     the position blocks the deck keeps a clear gap at LEG_SHARE_MIN. */
  const leg = JOINTS.map(j => LEGS.includes(j)), span = POS_DIMS*3;
  const words = new Map();
  for(const s of samples){
    let w = words.get(s.label);
    if(!w){ w = { n:0, sum:new Float64Array(D) }; words.set(s.label, w); }
    w.n++; for(let d=0;d<D;d++) w.sum[d]+=s.v[d];
  }
  const out = [];
  for(const [label, w] of words){
    let legs = 0, all = 0;
    for(let d=0;d<span;d++){
      const e = (w.sum[d]/w.n * (learned ? learned[d] : 1))**2;
      all += e;
      if(leg[DIM_JOINTS[d][0]]) legs += e;
    }
    if(all > 0 && legs/all >= LEG_SHARE_MIN) out.push(label);
  }
  return out;
}

function median(a){
  const s=Float64Array.from(a).sort(), m=s.length>>1;
  return s.length%2 ? s[m] : (s[m-1]+s[m])/2;
}

/* Root-mean-square distance of each row from `centre`, per dimension. */
function spread(rows, centre){
  const D=centre.length, out=new Float64Array(D);
  for(const r of rows) for(let d=0;d<D;d++) out[d]+=(r[d]-centre[d])**2;
  return out.map(x=>Math.sqrt(x/rows.length));
}

/* One weight per dimension, the same for every word. A dimension counts for
   more when the WORD means differ on it and the TAKES of one word agree on it.
   Takes, not windows: windows of one take all share that take's quirks (where
   the player stood, which arm was lazy), so window spread says nothing about
   what changes the next time somebody acts the word out.

   PER-WORD weights were tested against this and LOST (64.9% vs 68.7% on the
   2026-09-11 deck, and far worse under hip jitter): with two takes a word, a
   per-word spread is an estimate from two points. Pooling the take spread over
   every word is what makes it stable. Mixing weighted and unweighted words in
   one kNN is worse still (54%), because their cosines are not on one scale. */
function featureWeights(z, raw, { min, max, floor }){
  const D=z[0].length, words=new Map();
  z.forEach((v,i)=>{
    const {label, take}=raw[i];
    let w=words.get(label);
    if(!w){ w={ n:0, sum:new Float64Array(D), takes:new Map() }; words.set(label, w); }
    let t=w.takes.get(take);
    if(!t){ t={ n:0, sum:new Float64Array(D) }; w.takes.set(take, t); }
    w.n++; t.n++;
    for(let d=0;d<D;d++){ w.sum[d]+=v[d]; t.sum[d]+=v[d]; }
  });
  const list=[...words.values()];
  for(const w of list){
    w.mean=w.sum.map(x=>x/w.n);
    w.takeMeans=[...w.takes.values()].map(t=>t.sum.map(x=>x/t.n));
  }
  const grand=new Float64Array(D);
  for(const w of list) for(let d=0;d<D;d++) grand[d]+=w.mean[d]/list.length;
  const between=spread(list.map(w=>w.mean), grand);

  /* Only a word with two or more takes can say how takes differ. With none
     (a fresh Training deck), the window spread inside each word stands in. */
  const multi=list.filter(w=>w.takeMeans.length>=2), within=new Float64Array(D);
  if(multi.length){
    for(const w of multi){ const s=spread(w.takeMeans, w.mean); for(let d=0;d<D;d++) within[d]+=s[d]**2/multi.length; }
  }else{
    z.forEach((v,i)=>{ const m=words.get(raw[i].label).mean; for(let d=0;d<D;d++) within[d]+=(v[d]-m[d])**2/z.length; });
  }
  for(let d=0;d<D;d++) within[d]=Math.sqrt(within[d]);

  const pad=floor*median(within);
  const ratio=between.map((b,d)=>b/(within[d]+pad+1e-6));
  const mid=median(ratio) || 1;
  return Float32Array.from(ratio, r=>Math.min(max, Math.max(min, r/mid)));
}

/* Raise every dimension's standard deviation to at least FEATURE_SD_FLOOR of
   the median within its own block, so a dimension that barely moves cannot be
   amplified into the loudest thing in the vector. Per BLOCK rather than across
   the whole vector because position, spread and velocity live at genuinely
   different magnitudes and comparing them to one another means nothing. */
function applySdFloor(sd){
  for(const [from, to] of BLOCKS){
    const block=Array.from(sd.slice(from, to)).sort((x,y)=>x-y);
    const mid=block.length>>1;
    const median=block.length%2 ? block[mid] : (block[mid-1]+block[mid])/2;
    /* the +1e-6 is the only true divide-by-zero guard here; the floor above it
       is the thing that actually matters */
    const floor=Math.max(median*FEATURE_SD_FLOOR, 1e-6);
    for(let d=from;d<to;d++) sd[d]=Math.max(sd[d], floor);
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
  return classifyDetailed(v, m, { reject:false }).scores;
}

/* Closed-set voting is retained for deck comparisons. Live recognition also
   requires a nearby example and separation from the closest competing word.
   Scores are vote shares, never probabilities that an arbitrary action is known. */
/* minSimilarity was .55 before the distance block. The new space has more
   dimensions, so the same number rejected less: 49 wrong guesses and 151 of
   558 unseen actions, against 56 and 172 before. At .66 it rejects 57 and 183
   and costs 2 more correct windows (23 of 434). The margin does most of the
   work: up to .64 no correct window changes at all.
   .66 -> .62 WITH FEATURE_WEIGHTING OFF (2026-09-13 deck). Unweighted
   cosines sit on a different scale, and at .66 the new model threw away twice
   as many correct windows under .02 jitter (103 against 52). Swept over the
   whole deck, leave-one-clip-out plus leave-one-word-out:
     old model at .66: right 928 clean / 844 jitter, wrong 161 / 174, unseen rejected 322 of 1171
     new model at .62: right 951 clean / 855 jitter, wrong 156 / 160, unseen rejected 326 of 1171
   At .62 every count is at least as good as the old model's. */
export const REJECTION = Object.freeze({ minSimilarity:.62, minMargin:.005 });

export function classifyDetailed(v, m, { reject=true, jointMask=null,
    minSimilarity=REJECTION.minSimilarity, minMargin=REJECTION.minMargin }={}){
  const q=standardize(v, m.mean, m.sd);
  const dims = jointMask && !jointMask.every(Boolean) ? Array.from(q, (_, d) => d)
    .filter(d => DIM_JOINTS[d].every(j => jointMask[j])) : null;
  const plainNorm=dims ? Math.sqrt(dims.reduce((sum,d)=>sum+q[d]**2,0)) : l2(q), sims=[];
  const nearest={};
  /* The query's norm in each emphasised word's metric, over the same dims. */
  const wordNorm=new Map();
  for(const [label, w2] of Object.entries(m.wordWeights || {})){
    let sq=0;
    if(dims) for(const d of dims) sq+=w2[d]*q[d]**2;
    else for(let d=0;d<q.length;d++) sq+=w2[d]*q[d]**2;
    wordNorm.set(label, Math.sqrt(sq));
  }
  for(const s of m.samples){
    const w2=s.w2, nv=w2 ? wordNorm.get(s.label) : plainNorm;
    let dot=0, norm=s.norm;
    if(dims){
      let sq=0;
      if(w2) for(const d of dims){ dot+=w2[d]*q[d]*s.v[d]; sq+=w2[d]*s.v[d]**2; }
      else for(const d of dims){ dot+=q[d]*s.v[d]; sq+=s.v[d]**2; }
      norm=Math.sqrt(sq);
    }else if(w2) for(let d=0;d<q.length;d++) dot+=w2[d]*q[d]*s.v[d];
    else for(let d=0;d<q.length;d++) dot+=q[d]*s.v[d];
    const sim=nv>0 && norm>0 ? dot/(nv*norm) : 0;
    sims.push({sim:Number.isFinite(sim)?sim:0, label:s.label});
    nearest[s.label]=Math.max(nearest[s.label] ?? -1, Number.isFinite(sim)?sim:0);
  }
  sims.sort((a,b)=>b.sim-a.sim);
  const scores={}; let tot=0;
  for(let i=0;i<Math.min(K,sims.length);i++){
    const w=Math.max(sims[i].sim,0)**3;
    scores[sims[i].label]=(scores[sims[i].label]||0)+w; tot+=w;
  }
  if(tot>0) for(const k in scores) scores[k]/=tot;
  const best=Object.entries(scores).sort((a,b)=>b[1]-a[1])[0];
  const label=best?.[0] || null;
  const similarity=nearest[label] ?? 0;
  const runnerUp=Math.max(-1,...Object.entries(nearest).filter(([l])=>l!==label).map(([,s])=>s));
  const margin=similarity-runnerUp;
  const accepted=!!label && tot>0 && similarity>=minSimilarity && margin>=minMargin;
  return { scores:reject && !accepted ? {} : scores, label:accepted || !reject ? label : null,
    confidence:accepted || !reject ? best?.[1] || 0 : 0, accepted, similarity, margin };
}
