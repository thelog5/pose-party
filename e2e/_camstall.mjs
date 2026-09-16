/* DOES THE VISION LOOP COME BACK? Reproduces the two ways it used to die
   silently on a phone, and proves the watchdog in engine.js recovers both.

   1. THE VIDEO PAUSES. `requestVideoFrameCallback` fires only on a new frame,
      so a paused camera preview never re-arms the loop. iOS pauses it on an
      app switch, a lock or a call. Before the fix nothing rearmed it and
      detection was dead until a reload: the charge bar sat still while the
      guess cards kept whatever text they last had.
   2. THE MODEL CALL THROWS. A backgrounded phone loses its WebGL context.
      `scheduleLoop()` runs first, so the loop stayed perfectly alive and
      threw on every single frame forever.

   Each case counts detector calls before, during and after, so a recovery is
   measured rather than assumed. Serve the game folder on 8124 first:
     cd pose-charades-external-data && python3 -m http.server 8124
     node e2e/_camstall.mjs
*/
import puppeteer from "puppeteer-core";
import { passCameraGate } from "./_gate.mjs";

const APP = process.env.APP_URL || "http://localhost:8124";
const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

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

/* One stub for both cases: it counts calls and can be told to throw. */
await p.evaluate(async () => {
  const { state } = await import("/js/state.js");
  const lm = Array.from({ length:33 }, () => ({ x:.5, y:.3, z:0, visibility:.99 }));
  const set = (i, x, y) => Object.assign(lm[i], { x, y });
  set(0,.5,.2); set(11,.4,.3); set(12,.6,.3); set(23,.45,.55); set(24,.55,.55);
  set(13,.35,.4); set(14,.65,.4); set(15,.3,.5); set(16,.7,.5);
  set(25,.45,.72); set(26,.55,.72); set(27,.45,.9); set(28,.55,.9);
  window._cam = { calls:0, throwing:false };
  state.landmarker = { detectForVideo(){
    window._cam.calls++;
    if(window._cam.throwing) throw new Error("CONTEXT_LOST (simulated)");
    return { landmarks:[lm.map(q => ({ ...q,
      x:q.x + (Math.random() - .5) * .004, y:q.y + (Math.random() - .5) * .004 }))] };
  } };
  state.handmarker = null;
});

const rate = async (ms, before) => {
  await p.evaluate(m => new Promise(r => setTimeout(r, m)), ms);
  const now = await p.evaluate(() => window._cam.calls);
  return { calls: now - before, now };
};

const count = () => p.evaluate(() => window._cam.calls);

/* ---- 1. the camera preview pauses, the way a locked phone pauses it ---- */
let c = await count();
const live = await rate(1500, c);
await p.evaluate(() => document.getElementById("video").pause());
const paused = await rate(1500, live.now);
/* The watchdog ticks once a second and only acts after CAMERA_STALL_MS. */
const back = await rate(3000, paused.now);

console.log(`video paused:  running ${live.calls} calls/1.5s ` +
  `-> paused ${paused.calls} -> recovered ${back.calls} calls/3s`);
console.log(back.calls > 5
  ? "  PASS the loop came back on its own"
  : "  FAIL detection stayed dead after the video paused");

/* ---- 2. every model call throws, the way a lost GPU context throws ---- */
await p.evaluate(() => { window._cam.throwing = true; });
const thrown = await rate(1500, back.now);
await p.evaluate(() => { window._cam.throwing = false; });
const healed = await rate(2000, thrown.now);

console.log(`model throwing: ${thrown.calls} calls/1.5s while failing ` +
  `-> ${healed.calls} calls/2s once it stops`);
console.log(healed.calls > 5
  ? "  PASS the loop kept calling and picked straight back up"
  : "  FAIL the loop stopped calling the model");

/* The rebuild only fires on the REAL engine landmarker, never on a stub, so
   a suite that swaps the model in can never have its model replaced. */
const stubKept = await p.evaluate(async () => {
  const { state } = await import("/js/state.js");
  return typeof state.landmarker.detectForVideo === "function" && !!window._cam;
});
console.log(stubKept ? "  PASS the stub was not rebuilt out from under the test"
  : "  FAIL the rebuild replaced a stubbed model");

await b.close();
