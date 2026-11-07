import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { normalize } from '../client/js/pose.js';
import { JOINTS, FRAME_POINTS } from '../client/js/constants.js';
import { createPoseInput, assessPose, observePose, canRecognize, clipSegments,
  canonicalClip, POSE_SPACE, windowJointMask } from '../client/js/poseInput.js';
import { createChargeMeter, advancePoseCharge } from '../client/js/recognition.js';
import { buildModel, classifyDetailed, features, timeScaleFrames, windowsOf } from '../client/js/classifier.js';
import { decodePoseDataset } from '../client/js/poseData.js';

function landmarks(width=1280,height=720){
  const p=Array.from({length:33},()=>({x:.5,y:.3,visibility:.99}));
  const set=(j,x,y)=>{p[j]={x:.5+x*height/width,y,visibility:.99};};
  set(11,-.1,.3); set(12,.1,.3); set(23,-.06,.55); set(24,.06,.55);
  set(13,-.2,.4); set(14,.2,.4); set(15,-.3,.5); set(16,.3,.5);
  set(25,-.07,.7); set(26,.07,.7); set(27,-.07,.9); set(28,.07,.9);
  return p;
}
const quality=assessPose(landmarks());
const base=normalize(landmarks(),null,{width:1280,height:720});
function close(a,b,epsilon=.002){
  assert.equal(a.length,b.length);
  for(let j=0;j<a.length;j++) for(let d=0;d<a[j].length;d++)
    assert.ok(Math.abs(a[j][d]-b[j][d])<epsilon,`joint ${j}/${d}: ${a[j][d]} vs ${b[j][d]}`);
}
function warm(input){
  for(let at=0;at<=1100;at+=1000/30) observePose(input,base,quality,at);
  input.accepted=true; input.predictionAt=1100;
  input.predictionMask=quality.mask;
  input.predictionLabel='saluting';
}

test('equivalent camera geometry normalizes identically, including a leaning torso',()=>{
  for(const [width,height] of [[640,480],[1280,720],[720,1280]]){
    close(normalize(landmarks(width,height),null,{width,height}),base);
    const a=landmarks(width,height), b=landmarks();
    for(const j of [11,12]){a[j].x+=.06*height/width;b[j].x+=.06*720/1280;}
    close(normalize(a,null,{width,height}),normalize(b,null,{width:1280,height:720}));
  }
});
test('legacy geometry is unchanged without metadata and migrated once when geometry is known',()=>{
  const original={frames:[base]}; assert.equal(canonicalClip(original),original);
  const raw=normalize(landmarks(640,480),null);
  const migrated=canonicalClip({frames:[raw],camera:{width:640,height:480}});
  close(migrated.frames[0],base,.004);
  assert.equal(canonicalClip(migrated),migrated);
});
test('bad torso anchors and non-finite coordinates cannot become observations',()=>{
  const p=landmarks(); p[23].visibility=.1;
  assert.equal(assessPose(p).usable,false);
  p[23].x=NaN; assert.equal(normalize(p),null);
  assert.equal(assessPose(null).usable,false);
});
test('bent visible legs are valid; out-of-frame or low-confidence legs are not',()=>{
  const p=landmarks(); for(const j of [25,26,27,28]) p[j].y=.59;
  assert.equal(assessPose(p).fullBody,true);
  p[27].y=1.1; assert.equal(assessPose(p).legs,false);
  const input=createPoseInput(); warm(input); input.quality=assessPose(p);
  input.predictionLabel='squat'; input.predictionNeedsLegs=true;
  assert.equal(canRecognize(input,'squat',1100),false);
  input.predictionLabel='saluting'; input.predictionNeedsLegs=false;
  assert.equal(canRecognize(input,'saluting',1100),true);
  input.quality=quality; input.predictionLabel='squat'; input.predictionNeedsLegs=true;
  input.predictionMask=quality.mask.slice();
  input.predictionMask[JOINTS.indexOf(27)]=false;
  assert.equal(canRecognize(input,'squat',1100),false);
});
test('30fps and irregular camera observations yield the same timed motion features',()=>{
  const regular=createPoseInput(), irregular=createPoseInput();
  const frame=at=>base.map(p=>[p[0]+at*.0001,p[1]]);
  for(let t=0;t<2200;t+=1000/30) observePose(regular,frame(t),quality,t);
  observePose(regular,frame(2200),quality,2200);
  for(let t=0;t<=2200;t+=100) observePose(irregular,frame(t),quality,t);
  const a=features(regular.frames),b=features(irregular.frames);
  assert.equal(a.length,b.length);
  assert.ok(Math.max(...a.map((v,i)=>Math.abs(v-b[i])))<1e-5);
});
test('a rejected observation pauses immediately; a long gap starts a new window',()=>{
  const input=createPoseInput(); warm(input);
  assert.equal(canRecognize(input,'saluting',1100),true);
  observePose(input,null,assessPose(null),1130);
  assert.equal(canRecognize(input,'saluting',1130),false);
  observePose(input,base,quality,1500);
  assert.equal(input.frames.length,1);
  assert.equal(input.generation,1);
  assert.equal(input.accepted,false);
});
test('frozen input and rejected predictions cannot finish a charge in any mode',()=>{
  for(const profile of ['solo','match','party']){
    const input=createPoseInput();warm(input);
    const meter=createChargeMeter(profile);
    for(let now=1100;now<5000;now+=16.7) advancePoseCharge(meter,.99,.1,input,'saluting',now);
    assert.equal(meter.locked,false,profile);
    input.tracking=false;
    assert.equal(canRecognize(input,'saluting',5000),false);
  }
});
test('sustained fresh accepted predictions still complete each mode',()=>{
  for(const profile of ['solo','match','party']){
    const input=createPoseInput();warm(input);const meter=createChargeMeter(profile);
    for(let now=1100;now<5000;now+=16.7){
      input.seenAt=input.predictionAt=now;
      advancePoseCharge(meter,.99,.1,input,'saluting',now);
    }
    assert.equal(meter.locked,true,profile);
  }
});
test('one bad sample keeps a joint; a quarter of the window drops it',()=>{
  const input=createPoseInput();warm(input);
  const q={...quality,mask:quality.mask.slice()};q.mask[5]=false;
  observePose(input,base,q,1133);
  assert.equal(windowJointMask(input)[5],true);
  for(let at=1166;at<1500;at+=1000/30) observePose(input,base,q,at);
  assert.equal(windowJointMask(input)[5],false);
});
test('a tracking gap pauses the charge but keeps the ratchet',()=>{
  const input=createPoseInput();warm(input);const meter=createChargeMeter('solo');
  let now=1100;
  for(;now<2100;now+=16.7){ input.seenAt=input.predictionAt=now; advancePoseCharge(meter,.99,.1,input,'saluting',now); }
  const peak=meter.peak;
  assert.ok(peak>.3 && !meter.locked);
  observePose(input,null,assessPose(null),now);
  for(const end=now+600;now<end;now+=16.7) advancePoseCharge(meter,.99,.1,input,'saluting',now);
  observePose(input,base,quality,now);
  advancePoseCharge(meter,.99,.1,input,'saluting',now);
  assert.equal(input.generation,1);
  assert.equal(meter.peak,peak);
  assert.ok(meter.charge>=peak*.25-1e-9,`charge ${meter.charge} fell under the ratchet of ${peak}`);
});
test('short sections are time-scaled the way they are asked to be',()=>{
  const frames=n=>Array.from({length:n},()=>base);
  assert.equal(timeScaleFrames(frames(20),1.25).length,25);
  assert.equal(timeScaleFrames(frames(20),.8).length,16);
  assert.equal(timeScaleFrames(frames(15),.8),null);
  assert.equal(timeScaleFrames(frames(35),.8).length,30);
  assert.equal(timeScaleFrames(frames(80),.8).length,64);
});
test('the distance block ignores a shift of the whole body; a hidden joint drops its distances',()=>{
  const still=Array.from({length:30},(_,i)=>base.map(p=>[p[0],p[1]+.01*Math.sin(i)]));
  const moved=still.map(f=>f.map(p=>[p[0]+.07,p[1]-.05]));
  const a=features(still), b=features(moved), from=JOINTS.length*6;
  assert.equal(a.length,from+24);
  for(let d=from;d<a.length;d++) assert.ok(Math.abs(a[d]-b[d])<1e-6,`dim ${d}`);
  const model={samples:[{label:'one',v:a,norm:Math.hypot(...a)}]};
  const jointMask=JOINTS.map(()=>true); jointMask[JOINTS.indexOf(27)]=false;
  const changed=a.slice(); changed[from+8]=99; changed[from+20]=-99;   // ankle-to-ankle mean and std
  assert.equal(classifyDetailed(changed,model,{jointMask}).similarity,classifyDetailed(a,model,{jointMask}).similarity);
});
test('words told apart by their legs need their legs seen; arm words do not',()=>{
  /* Most words in a deck are arm words, so the average pose has still legs.
     With two or three words every word differs from the average equally. */
  const clip=(label,joint,phase)=>{const a=JOINTS.indexOf(joint);
    return {label,frames:Array.from({length:45},(_,i)=>base.map((p,j)=>
      j===a||j===a+1 ? [p[0],p[1]+.4*Math.sin(i/3+phase)] : [p[0]+.01*Math.sin(i*7+j),p[1]]))};};
  const words={knees:25,wrists:15,elbows:13,fingers:19,shoulders:11};
  const model=buildModel(Object.entries(words).flatMap(([l,j])=>[clip(l,j,0),clip(l,j,1)]));
  assert.deepEqual(model.legLabels,['knees']);
});
test('a new accepted label cannot keep charging an old smoothed guess',()=>{
  const input=createPoseInput();warm(input);
  input.predictionLabel='punching';
  assert.equal(canRecognize(input,'saluting',1100),false);
});
test('unrelated weak matches and tied competing labels abstain',()=>{
  const sample=(label,x)=>({label,v:new Float32Array([x,Math.sqrt(1-x*x)]),norm:1});
  const weak={samples:Array.from({length:7},()=>sample('punching',.01))};
  assert.deepEqual(classifyDetailed(new Float32Array([1,0]),weak).scores,{});
  const tied={samples:[...Array.from({length:4},()=>sample('one',.8)),...Array.from({length:4},()=>sample('two',.8))]};
  assert.equal(classifyDetailed(new Float32Array([1,0]),tied).accepted,false);
});
test('untrusted joints cannot change the similarity to a training sample',()=>{
  const v=features(Array.from({length:30},()=>base));
  const model={samples:[{label:'one',v,norm:Math.hypot(...v)}]};
  const jointMask=JOINTS.map(()=>true); jointMask[13]=false;
  const changed=v.slice();
  for(let block=0;block<3;block++){
    changed[block*30+26]=1000;changed[block*30+27]=-1000;
  }
  const a=classifyDetailed(v,model,{jointMask}), b=classifyDetailed(changed,model,{jointMask});
  assert.equal(a.label,b.label);assert.equal(a.similarity,b.similarity);
});
test('timed clips split at camera loss and exclude bad landmark sections',()=>{
  const timestamps=Array.from({length:60},(_,i)=>i*33+(i>=30?500:0));
  const clip={frames:timestamps.map(()=>base),timestamps};
  assert.equal(clipSegments(clip).length,2);
  clip.visibility=timestamps.map(()=>JOINTS.map(()=>.99));
  clip.visibility[10][0]=.1;
  assert.equal(clipSegments(clip).length,3);
});
test('legacy deck round trips unchanged and malformed timing is rejected',()=>{
  const deck=JSON.parse(fs.readFileSync(new URL('../client/assets/data/pose-charades-data.json',import.meta.url)));
  const before=JSON.stringify(deck);
  const decoded=decodePoseDataset(deck);
  assert.equal(decoded.length,deck.clips.length);
  /* The shipped deck is slimmed to the body joints (scripts/slim-pose-deck.mjs);
     the loader pads the hand points back as zeros. */
  const legacy=deck.clips.findIndex(c=>c.coordinateSpace==='legacy-image');
  assert.ok(legacy>=0);
  assert.deepEqual(decoded[legacy].frames.map(f=>f.slice(0,JOINTS.length)),
    deck.clips[legacy].frames.map(f=>f.slice(0,JOINTS.length)));
  assert.ok(decoded[legacy].frames.every(f=>f.length===FRAME_POINTS && f.slice(JOINTS.length).every(p=>p[0]===0&&p[1]===0)));
  assert.equal(JSON.stringify(deck),before);
  const c={...decoded[0],timestamps:decoded[0].frames.map(()=>0)};
  assert.throws(()=>decodePoseDataset({...deck,clips:[c]}),/timestamps/);
});
test('version 3 timed recording survives export/import with metadata and features intact',()=>{
  const clip={captureVersion:3,label:'saluting',coordinateSpace:POSE_SPACE,camera:{width:1280,height:720},
    frames:Array.from({length:61},()=>base),timestamps:Array.from({length:61},(_,i)=>i*1000/30),
    visibility:Array.from({length:61},()=>JOINTS.map(()=>.99)),inFrame:Array.from({length:61},()=>JOINTS.map(()=>true))};
  const [restored]=decodePoseDataset(JSON.parse(JSON.stringify({version:3,joints:JOINTS,clips:[clip]})));
  assert.deepEqual(restored,clip);
  assert.deepEqual(windowsOf(restored),windowsOf(clip));
});
