/* Existing UI suites seed classifier output. Seed a fresh observation at each
   simulated inference too; otherwise the production freshness guard must reject
   it. Stop the real fake-camera detector so it cannot overwrite the fixture. */
export async function installVisionFixture(page){
  await page.evaluate(async()=>{
    const {state}=await import('/js/state.js');
    const {createPoseInput}=await import('/js/poseInput.js');
    state.landmarker=null;
    state.poseInput=createPoseInput();
    window.__visionTick=(label=state.game?.word)=>{
      const input=state.poseInput;
      input.tracking=input.accepted=true;
      input.seenAt=input.predictionAt=performance.now();
      input.quality={usable:true,torso:true,legs:true,fullBody:true,mask:Array(15).fill(true)};
      input.predictionMask=Array(15).fill(true);
      input.predictionLabel=label;
    };
  });
}
