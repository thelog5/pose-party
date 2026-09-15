/* Compare the pose model options on this machine, on the live fake camera:
   full vs lite, GPU vs CPU delegate, and the full 720p frame vs a frame
   shrunk to 640 or 480 wide on a canvas first. Same caveat as _perf.mjs: the
   fake camera has no person, so this times the person DETECTOR path.
   Run with CPU throttling through RATE=4 to see which options are CPU-bound. */
import puppeteer from "puppeteer-core";
import { passCameraGate } from "./_gate.mjs";

const APP = process.env.APP_URL || "http://localhost:8124";
const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const RATE = Number(process.env.RATE || 1);
const b = await puppeteer.launch({ executablePath:CHROME, headless:"new",
  args:["--use-fake-device-for-media-stream","--use-fake-ui-for-media-stream","--no-first-run", ...(process.env.ARGS||"").split(" ").filter(Boolean)] });
const p = await b.newPage();
p.on("pageerror", e => console.log("PAGEERROR:", e.message));
await p.goto(APP, { waitUntil:"networkidle2", timeout:60000 });
await passCameraGate(p);
await p.waitForFunction(async () => {
  const { state } = await import("/js/state.js");
  return !!state.landmarker && !!state.mediaStream && document.getElementById("video").readyState >= 2;
}, { timeout:90000, polling:250 });
const cdp = await p.createCDPSession();
await cdp.send("Emulation.setCPUThrottlingRate", { rate:RATE });
const out = await p.evaluate(async () => {
  const { state } = await import("/js/state.js");
  state.landmarker = null;   // stop the game's own loop so it does not compete
  const V = await import("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14");
  const vision = await V.FilesetResolver.forVisionTasks("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm");
  const url = k => `https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_${k}/float16/1/pose_landmarker_${k}.task`;
  const video = document.getElementById("video");
  const rows = []; let t = performance.now();
  for(const [kind, delegate] of [["full","GPU"],["lite","GPU"],["full","CPU"],["lite","CPU"]]){
    let lm;
    try{
      lm = await V.PoseLandmarker.createFromOptions(vision, { baseOptions:{ modelAssetPath:url(kind), delegate },
        runningMode:"VIDEO", numPoses:1 });
    }catch(e){ rows.push(`${kind} ${delegate}: failed ${e.message}`); continue; }
    for(const w of [0, 640, 480]){
      const c = w ? Object.assign(document.createElement("canvas"), { width:w, height:Math.round(w * 9 / 16) }) : null;
      const cx = c?.getContext("2d");
      const times = [];
      for(let i = 0; i < 40; i++){
        await new Promise(r => requestAnimationFrame(r));
        const a = performance.now();
        let src = video;
        if(c){ cx.drawImage(video, 0, 0, c.width, c.height); src = c; }
        lm.detectForVideo(src, t += 50);
        if(i >= 5) times.push(performance.now() - a);
      }
      times.sort((x, y) => x - y);
      rows.push(`${kind} ${delegate} ${w ? w + "w" : video.videoWidth + "w"}: median ${times[times.length >> 1].toFixed(1)}ms`);
    }
    lm.close();
  }
  return rows;
});
console.log(`CPU x${RATE}\n` + out.join("\n"));
await b.close();
