/* Where does a camera frame's time go on a slow computer?

   Boots the real game on the fake camera, then times each part of the
   detection loop: the pose model call, the classifier, and how often the loop
   actually runs. It repeats under CDP CPU throttling (x1, x4, x6), which slows
   JavaScript and wasm but NOT the GPU, so treat the throttled numbers as a
   lower bound for a weak laptop.

   The fake camera shows no person, so the pose model runs its person
   DETECTOR every frame instead of the landmark model. The absolute numbers
   are therefore not a player's numbers; the ratios between the rows are the
   useful part.

   APP_URL defaults to a static host on 8124 (serve pose-charades-external-data). */
import puppeteer from "puppeteer-core";
import { passCameraGate } from "./_gate.mjs";

const APP = process.env.APP_URL || "http://localhost:8124";
const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const RATES = (process.env.RATES || "1,4,6").split(",").map(Number);
const SECONDS = Number(process.env.SECONDS || 5);

const b = await puppeteer.launch({ executablePath:CHROME, headless:"new",
  args:["--use-fake-device-for-media-stream","--use-fake-ui-for-media-stream","--no-first-run", ...(process.env.ARGS||"").split(" ").filter(Boolean)] });
const p = await b.newPage();
await p.setViewport({ width:1440, height:810 });
p.on("pageerror", e => console.log("PAGEERROR:", e.message));
p.on("console", m => { if(/Pose model|Slow computer|delegate/.test(m.text())) console.log("PAGE:", m.text()); });
await p.goto(APP, { waitUntil:"networkidle2", timeout:60000 });
await passCameraGate(p);
await p.waitForFunction(async () => {
  const { state } = await import("/js/state.js");
  return !!state.landmarker && !!state.model && !!state.mediaStream;
}, { timeout:90000, polling:250 });

const info = await p.evaluate(async () => {
  const { state } = await import("/js/state.js");
  const t = state.mediaStream.getVideoTracks()[0].getSettings();
  const gl = document.createElement("canvas").getContext("webgl2");
  const ext = gl?.getExtension("WEBGL_debug_renderer_info");
  return { camera:`${t.width}x${t.height}@${t.frameRate}`,
    gpu: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : "?",
    samples: state.model.samples.length, slow: (await import("/js/speed.js")).isSlowComputer() };
});
console.log(info);

/* Wrap the model call and time the classifier on a real-shaped window. */
await p.evaluate(async () => {
  const { state } = await import("/js/state.js");
  const lm = state.landmarker;
  if(!lm.__timed){
    const real = lm.detectForVideo.bind(lm);
    lm.detectForVideo = (v, t) => {
      const a = performance.now(); const r = real(v, t);
      window.__detect.push(performance.now() - a); return r;
    };
    lm.__timed = true;
  }
  window.__detect = [];
});

const cdp = await p.createCDPSession();
const pct = (a, q) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(q * (s.length - 1))] ?? NaN; };
for(const rate of RATES){
  await cdp.send("Emulation.setCPUThrottlingRate", { rate });
  await p.evaluate(() => { window.__detect = []; });
  const loop = await p.evaluate(async secs => {
    /* Long tasks: main-thread blocks over 50ms, the thing a player sees as jank. */
    const longs = [];
    const obs = new PerformanceObserver(l => { for(const e of l.getEntries()) longs.push(e.duration); });
    obs.observe({ type:"longtask", buffered:false });
    let raf = 0; const t0 = performance.now();
    await new Promise(res => { const f = () => { raf++; performance.now() - t0 < secs * 1000 ? requestAnimationFrame(f) : res(); }; requestAnimationFrame(f); });
    obs.disconnect();
    return { raf: raf / secs, longs };
  }, SECONDS);
  const cls = await p.evaluate(async () => {
    const { state } = await import("/js/state.js");
    const { features, classifyDetailed } = await import("/js/classifier.js");
    const frames = Array.from({ length:30 }, (_, i) =>
      Array.from({ length:57 }, (_, j) => [Math.sin(i * .2 + j) * .5, Math.cos(i * .3 + j) * .7]));
    const f = features(frames), full = Array(15).fill(true), legsOut = full.map((_, j) => j < 11);
    const time = mask => { const a = performance.now();
      for(let i = 0; i < 10; i++) classifyDetailed(f, state.model, { jointMask:mask, reject:false });
      return (performance.now() - a) / 10; };
    time(full);
    return { all:time(full), legsHidden:time(legsOut) };
  });
  const d = await p.evaluate(() => window.__detect);
  console.log(`CPU x${rate}: model calls ${(d.length / SECONDS).toFixed(1)}/s, ` +
    `model ms median ${pct(d, .5).toFixed(1)} p90 ${pct(d, .9).toFixed(1)}, ` +
    `classify ms ${cls.all.toFixed(1)} (legs hidden ${cls.legsHidden.toFixed(1)}), ` +
    `page frames ${loop.raf.toFixed(0)}/s, long tasks ${loop.longs.length} ` +
    `(${loop.longs.reduce((s, x) => s + x, 0).toFixed(0)}ms)`);
}
await b.close();
