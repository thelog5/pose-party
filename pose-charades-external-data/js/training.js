/* Fits the kNN model and reports a holdout estimate of its accuracy. */

import { $, esc } from "./dom.js";
import { state } from "./state.js";
import { buildModel, classify, windowsOf } from "./classifier.js";
import { blip } from "./audio.js";
import { clearModelStale } from "./capture.js";

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

/* buildModel + evaluate run fully synchronously, and on a real dataset that
   is a multi-second frozen tab off a single click. Paint "Training…" and
   disable the button, then let the browser render before we block it. */
export function train(opts={}){
  const silent = !!opts.silent;
  /* `defer` is separate from `silent` on purpose: the bundled-data preload
     wants the model to exist the moment it returns, while the retrain that
     follows a clip delete must not block the click thread — evaluate() is
     superlinear and a large deck freezes the tab for hundreds of ms. */
  const defer = opts.defer ?? !silent;
  const rep0=$("trainReport"), btn=$("btnTrain");
  if(defer && !train._busy){
    train._busy=true;
    if(!silent && rep0){
      rep0.style.display="block";
      rep0.innerHTML="Training the AI on your clips…";
    }
    if(btn) btn.disabled=true;
    requestAnimationFrame(()=>requestAnimationFrame(()=>{
      try{ runTraining(opts); }
      finally{ train._busy=false; if(btn) btn.disabled=false; }
    }));
    return;
  }
  runTraining(opts);
}

function runTraining(opts={}){
  const silent = !!opts.silent;
  const counts={};
  for(const c of state.dataset.clips) counts[c.label]=(counts[c.label]||0)+1;
  const labels=Object.keys(counts);
  const rep=$("trainReport");
  if(labels.length<2){
    /* Bailing here used to leave state.model holding the DELETED words, so
       the live panel and every game mode kept classifying against clips that
       no longer exist. There is no model below two words — say so. */
    state.model=null;
    state.smooth={};
    /* and don't shout a red warning at someone who only deleted a clip */
    if(!silent){
      rep.style.display="block";
      rep.innerHTML='<span class="warn">Need at least 2 words (record “idle” plus one action).</span>';
    }
    return;
  }
  rep.style.display="block";

  const { trainClips, testClips } = splitTrainTest(state.dataset.clips, labels);
  const { acc, missBy } = evaluate(testClips, buildModel(trainClips));

  state.model=buildModel(state.dataset.clips);
  state.smooth={}; for(const l of state.model.labels) state.smooth[l]=0;
  clearModelStale();               // the model has caught up with the list
  if(!silent) blip([523,784]);

  const worst=Object.entries(missBy).sort((a,b)=>b[1]-a[1]).slice(0,3).map(e=>e[0]);
  rep.innerHTML =
    'AI trained on <b>'+labels.length+'</b> words, <b>'+state.dataset.clips.length+'</b> clips, <b>'+state.model.samples.length+'</b> body-motion windows.<br><b>Hands are visual + exported only</b> so noisy finger tracking does not hurt the guesser.'+
    (acc!==null ? '<br>Quick holdout check: <b>'+acc+'%</b> of test clips guessed right.' : '<br>Record 4+ clips per word to unlock the accuracy check.')+
    (worst.length ? '<br><span class="warn">Most confused: '+worst.map(esc).join(", ")+' — record more of these or swap them out.</span>' : '')+
    '<br>Watch it guess live below, then go play.';
}
