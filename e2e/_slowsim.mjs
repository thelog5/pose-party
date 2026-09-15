/* What does a slow computer do to RECOGNITION, not just to the frame rate?

   Replaces the pose model with a stub that returns one fixed full-body pose
   and burns MODEL_MS of main-thread time per call, with an occasional longer
   stall (HITCH_MS every ~2s, like a garbage collection or a video decoder
   catching up). Then, over SECONDS, it counts:
     resets    how many times the 2s motion window was thrown away
     ready     share of display frames on which a held pose COULD charge
               (canRecognize for the model's own current guess)
   A fast computer scores 0 resets and ~100% ready. */
import puppeteer from "puppeteer-core";
import { passCameraGate } from "./_gate.mjs";

const APP = process.env.APP_URL || "http://localhost:8124";
const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const MODEL_MS = Number(process.env.MODEL_MS || 150);
const HITCH_MS = Number(process.env.HITCH_MS || 350);
const SECONDS = Number(process.env.SECONDS || 10);

const b = await puppeteer.launch({ executablePath:CHROME, headless:"new",
  args:["--use-fake-device-for-media-stream","--use-fake-ui-for-media-stream","--no-first-run"] });
const p = await b.newPage();
p.on("pageerror", e => console.log("PAGEERROR:", e.message));
await p.goto(APP, { waitUntil:"networkidle2", timeout:60000 });
await passCameraGate(p);
await p.waitForFunction(async () => {
  const { state } = await import("/js/state.js");
  return !!state.landmarker && !!state.model;
}, { timeout:90000, polling:250 });

const out = await p.evaluate(async (modelMs, hitchMs, secs) => {
  const { state } = await import("/js/state.js");
  const { resetPoseInput, canRecognize } = await import("/js/poseInput.js");
  const lm = Array.from({ length:33 }, () => ({ x:.5, y:.3, z:0, visibility:.99 }));
  const set = (i, x, y) => Object.assign(lm[i], { x, y });
  set(0,.5,.2); set(11,.4,.3); set(12,.6,.3); set(23,.45,.55); set(24,.55,.55);
  set(13,.35,.4); set(14,.65,.4); set(15,.3,.5); set(16,.7,.5); set(19,.29,.52); set(20,.71,.52);
  set(25,.45,.72); set(26,.55,.72); set(27,.45,.9); set(28,.55,.9);
  let next = performance.now() + 2000;
  const burn = ms => { const a = performance.now(); while(performance.now() - a < ms){} };
  state.landmarker = { detectForVideo(){
    burn(modelMs);
    if(performance.now() > next){ burn(hitchMs); next = performance.now() + 1500 + Math.random() * 1000; }
    /* a little tracker noise, so the filter and the window see real input */
    return { landmarks:[lm.map(q => ({ ...q, x:q.x + (Math.random() - .5) * .004, y:q.y + (Math.random() - .5) * .004 }))] };
  } };
  state.handmarker = null;
  resetPoseInput(state.poseInput);
  await new Promise(r => setTimeout(r, 3000));   // settle: fill the first window
  const g0 = state.poseInput.generation;
  let frames = 0, ready = 0;
  const t0 = performance.now();
  await new Promise(res => { const f = () => {
    frames++;
    const input = state.poseInput;
    if(canRecognize(input, input.predictionLabel)) ready++;
    performance.now() - t0 < secs * 1000 ? requestAnimationFrame(f) : res();
  }; requestAnimationFrame(f); });
  return { resets: state.poseInput.generation - g0, ready: ready / frames,
    gap: state.poseInput.gapMs ?? null };
}, MODEL_MS, HITCH_MS, SECONDS);
console.log(`model ${MODEL_MS}ms + ${HITCH_MS}ms stall every ~2s, ${SECONDS}s: ` +
  `window thrown away ${out.resets} times, pose can charge ${(out.ready * 100).toFixed(0)}% of the time` +
  (out.gap ? ` (gap allowed ${Math.round(out.gap)}ms)` : ""));
await b.close();
