/* Exercise the real camera callback, recorder and sampler with deterministic
   landmarks. UI suites separately seed predictions for scoring tests. */
import puppeteer from 'puppeteer-core';
import assert from 'node:assert/strict';

const browser=await puppeteer.launch({
  executablePath:process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless:'new',args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream','--no-first-run'],
});
const page=await browser.newPage();
const errors=[];page.on('pageerror',e=>errors.push(e.message));
try{
  await page.goto(process.env.APP_URL || 'http://localhost:8123',{waitUntil:'networkidle2'});
  await page.click('#cgEnable');
  await page.waitForFunction(()=>document.getElementById('status').style.display==='none',{timeout:60000});
  await page.evaluate(async()=>{
    const {state}=await import('/js/state.js');
    const {resetPoseInput}=await import('/js/poseInput.js');
    window.__poseState=state;
    window.__testLandmarks=Array.from({length:33},()=>({x:.5,y:.3,z:0,visibility:.99}));
    const p=window.__testLandmarks;
    const set=(i,x,y)=>Object.assign(p[i],{x,y});
    set(11,.4,.3);set(12,.6,.3);set(23,.45,.55);set(24,.55,.55);
    set(13,.35,.4);set(14,.65,.4);set(15,.3,.5);set(16,.7,.5);
    set(25,.45,.72);set(26,.55,.72);set(27,.45,.9);set(28,.55,.9);
    state.landmarker={detectForVideo:()=>({landmarks:window.__testLandmarks?[window.__testLandmarks]:[]})};
    state.handmarker=null;
    resetPoseInput(state.poseInput);
  });
  await page.waitForFunction(()=>window.__poseState.poseInput.frames.length>=15);
  const initial=await page.evaluate(()=>({n:window.__poseState.poseInput.frames.length,
    at:window.__poseState.poseInput.sampleAt,generation:window.__poseState.poseInput.generation}));
  assert.ok(initial.n>=15);console.log('ok camera frames fill a uniform pose window');
  await page.evaluate(()=>{window.__savedLandmarks=window.__testLandmarks;window.__testLandmarks=null;});
  await page.waitForFunction(()=>!window.__poseState.poseInput.tracking);
  assert.equal(await page.evaluate(()=>window.__poseState.poseInput.accepted),false);
  await page.waitForFunction(()=>window.__poseState.poseInput.frames.length===0);
  assert.equal(await page.evaluate(()=>window.__poseState.poseInput.predictionAt),-Infinity);
  console.log('ok tracking loss clears prediction and old motion history');
  await page.evaluate(()=>{window.__testLandmarks=window.__savedLandmarks;});
  await page.waitForFunction(()=>window.__poseState.poseInput.frames.length>0);
  assert.ok(await page.evaluate(()=>window.__poseState.poseInput.frames.length<15));
  console.log('ok reacquisition starts with fresh samples');
  await page.evaluate(async()=>{
    const {transition}=await import('/js/fsm.js');
    transition('training');
    document.getElementById('classInput').value='test saluting';
    document.getElementById('clipLen').value='3';
    const {startRecording}=await import('/js/capture.js');
    window.__beforeClips=window.__poseState.dataset.clips.length;
    startRecording();
  });
  await page.waitForFunction(()=>window.__poseState.recording!==null,{timeout:5000});
  await page.waitForFunction(()=>window.__poseState.recording===null,{timeout:5000});
  const saved=await page.evaluate(()=>{
    const state=window.__poseState,c=state.dataset.clips.at(-1);
    return {added:state.dataset.clips.length-window.__beforeClips,version:state.dataset.version,
      frames:c.frames.length,times:c.timestamps?.length,visibility:c.visibility?.length,bounds:c.inFrame?.length,
      camera:c.camera,space:c.coordinateSpace};
  });
  assert.equal(saved.added,1);assert.equal(saved.version,3);
  assert.equal(saved.frames,saved.times);assert.equal(saved.frames,saved.visibility);assert.equal(saved.frames,saved.bounds);
  assert.ok(saved.camera.width>0 && saved.camera.height>0);
  assert.equal(saved.space,'torso-reference-16:9-v1');
  console.log('ok recorder stores camera geometry, timestamps and landmark quality',saved);
  await page.evaluate(()=>{window.__testLandmarks[27].y=1.2;});
  await page.waitForFunction(()=>!document.getElementById('poseHint').hidden);
  assert.match(await page.$eval('#poseHint',el=>el.textContent),/knees and feet/);
  await page.screenshot({path:'/tmp/pose-reliability-training.png'});
  console.log('ok live guidance identifies missing legs');
  assert.deepEqual(errors,[]);
}finally{await browser.close();}
