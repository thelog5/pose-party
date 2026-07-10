/* Fits the kNN model and reports a holdout estimate of its accuracy. */

import { $, esc } from "./dom.js";
import { state } from "./state.js";
import { buildModel, classify, windowsOf } from "./classifier.js";
import { blip } from "./audio.js";

function shuffle(a){
  for(let i=a.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; }
  return a;
}

/* Per-label 20% holdout, but only for labels with 4+ clips — below that a test
   split would leave too little to train on. */
function splitTrainTest(clips, labels){
  const trainClips=[], testClips=[];
  for(const lab of labels){
    const forLabel=shuffle(clips.filter(c=>c.label===lab).slice());
    const nTest = forLabel.length>=4 ? Math.max(1,Math.floor(forLabel.length*0.2)) : 0;
    testClips.push(...forLabel.slice(0,nTest)); trainClips.push(...forLabel.slice(nTest));
  }
  return { trainClips, testClips };
}

/* Each clip votes with its windows; the majority window label is the prediction. */
function evaluate(testClips, evalModel){
  let ok=0, tot=0; const missBy={};
  for(const c of testClips){
    const wins=windowsOf(c); if(!wins.length) continue;
    const votes={};
    for(const v of wins){
      const s=classify(v,evalModel);
      const top=Object.entries(s).sort((a,b)=>b[1]-a[1])[0];
      if(top) votes[top[0]]=(votes[top[0]]||0)+1;
    }
    const pred=Object.entries(votes).sort((a,b)=>b[1]-a[1])[0][0];
    tot++; if(pred===c.label) ok++; else missBy[c.label]=(missBy[c.label]||0)+1;
  }
  return { acc: tot ? Math.round(ok/tot*100) : null, missBy };
}

export function train(opts={}){
  const silent = !!opts.silent;
  const counts={};
  for(const c of state.dataset.clips) counts[c.label]=(counts[c.label]||0)+1;
  const labels=Object.keys(counts);
  const rep=$("trainReport"); rep.style.display="block";
  if(labels.length<2){ rep.innerHTML='<span class="warn">Need at least 2 words (record “idle” plus one action).</span>'; return; }

  const { trainClips, testClips } = splitTrainTest(state.dataset.clips, labels);
  const { acc, missBy } = evaluate(testClips, buildModel(trainClips));

  state.model=buildModel(state.dataset.clips);
  state.smooth={}; for(const l of state.model.labels) state.smooth[l]=0;
  if(!silent) blip([523,784]);

  const worst=Object.entries(missBy).sort((a,b)=>b[1]-a[1]).slice(0,3).map(e=>e[0]);
  rep.innerHTML =
    'AI trained on <b>'+labels.length+'</b> words, <b>'+state.dataset.clips.length+'</b> clips, <b>'+state.model.samples.length+'</b> body-motion windows.<br><b>Hands are visual + exported only</b> so noisy finger tracking does not hurt the guesser.'+
    (acc!==null ? '<br>Quick holdout check: <b>'+acc+'%</b> of test clips guessed right.' : '<br>Record 4+ clips per word to unlock the accuracy check.')+
    (worst.length ? '<br><span class="warn">Most confused: '+worst.map(esc).join(", ")+' — record more of these or swap them out.</span>' : '')+
    '<br>Watch it guess live below, then go play.';
}
