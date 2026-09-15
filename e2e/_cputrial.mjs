/* The CPU-delegate trial: make the engine's own GPU model slow (a 40ms busy
   wait on the SAME object, so the engine still knows it as its own) and check
   that the engine times the CPU delegate and keeps it. */
import puppeteer from "puppeteer-core";
import { passCameraGate } from "./_gate.mjs";
const APP = process.env.APP_URL || "http://localhost:8124";
const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const b = await puppeteer.launch({ executablePath:CHROME, headless:"new",
  args:["--use-fake-device-for-media-stream","--use-fake-ui-for-media-stream","--no-first-run"] });
const p = await b.newPage();
const lines = [];
p.on("console", m => { if(/Pose model|Slow computer|delegate/.test(m.text())) lines.push(m.text()); });
p.on("pageerror", e => console.log("PAGEERROR:", e.message));
await p.goto(APP, { waitUntil:"networkidle2", timeout:60000 });
await passCameraGate(p);
await p.waitForFunction(async () => !!(await import("/js/state.js")).state.landmarker, { timeout:90000, polling:250 });
const gpu = await p.evaluate(async () => {
  const { state } = await import("/js/state.js");
  const lm = state.landmarker, real = lm.detectForVideo.bind(lm);
  lm.detectForVideo = (v, t) => { const a = performance.now(); while(performance.now() - a < 40){} return real(v, t); };
  window.__gpu = lm; return true;
});
await p.waitForFunction(async () => (await import("/js/state.js")).state.landmarker !== window.__gpu, { timeout:30000, polling:200 });
await new Promise(r => setTimeout(r, 3000));
const out = await p.evaluate(async () => ({ swapped: (await import("/js/state.js")).state.landmarker !== window.__gpu,
  slow: (await import("/js/speed.js")).isSlowComputer() }));
console.log(lines.join("\n")); console.log(out);
await b.close();
process.exit(out.swapped && !out.slow ? 0 : 1);
