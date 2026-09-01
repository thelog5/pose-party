/* QA scratch: does a NON-ZERO rest pose fight the count-in entrance?
   `.grobot` owns gamePaperIn (fill:both, lands at translate 0/rotate 0) and the
   .rp joints spring independently, so the two cannot clobber each other — this
   samples both through a real Solo count-in to prove it, and checks the joints
   travel monotonically to rest instead of snapping. */
import puppeteer from "puppeteer-core";
import { passCameraGate } from "./_gate.mjs";
const APP = process.env.APP_URL || "http://localhost:8123";
const b = await puppeteer.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: "new", args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--no-first-run"] });
const p = await b.newPage();
await p.setViewport({ width: 1440, height: 810 });
const errs = [];
p.on("pageerror", e => errs.push(e.message));
p.on("console", m => { if (m.type() === "error") errs.push(m.text()); });
await p.goto(APP, { waitUntil: "networkidle2" });
await passCameraGate(p);
await p.waitForFunction(() => document.getElementById("status").style.display === "none", { timeout: 60000 });
await p.click("#modeAI");
await p.waitForFunction(() => !document.getElementById("howToPlay").classList.contains("hidden"), { timeout: 8000, polling: 25 });
/* start sampling BEFORE the count-in so the entrance is covered end to end */
await p.evaluate(() => {
  window.__s = [];
  const n = document.getElementById("spRobot");
  const arm = n.querySelector('[data-j="uarmL"]');
  const t0 = performance.now();
  const step = () => {
    const m = new DOMMatrix(getComputedStyle(arm).transform);
    const g = new DOMMatrix(getComputedStyle(n).transform);
    window.__s.push({ t: Math.round(performance.now() - t0),
      arm: +(Math.atan2(m.b, m.a) * 180 / Math.PI).toFixed(2),
      rigY: +g.f.toFixed(1), op: +getComputedStyle(n).opacity });
    if (performance.now() - t0 < 6000) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
});
await p.click("#htpReady");
await new Promise(r => setTimeout(r, 6500));
const s = await p.evaluate(() => window.__s);
let snap = { d: 0 };
for (let i = 1; i < s.length; i++) {
  const d = Math.abs(s[i].arm - s[i - 1].arm);
  if (d > snap.d) snap = { d: +d.toFixed(2), at: s[i].t, from: s[i - 1].arm, to: s[i].arm };
}
console.log("frames", s.length, "| final arm", s[s.length - 1].arm, "deg (idle uaL 17 -> -17)",
  "| final rig translateY", s[s.length - 1].rigY, "| final opacity", s[s.length - 1].op);
console.log("largest single-frame arm step:", JSON.stringify(snap));
console.log("trace:", s.filter((_, i) => i % 12 === 0).map(x => `${x.t}:${x.arm}/${x.rigY}`).join(" "));
console.log("errors", errs);
await b.close();
