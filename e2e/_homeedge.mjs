/* Worst-case ink extents for the Home rig: he stands at the screen edge, so
   the question is not where he rests but how far his lean can carry his hand
   off the board. Ink fractions are the layers' own, measured off the PNGs. */
import puppeteer from "puppeteer-core";
import { mkdir } from "node:fs/promises";
import { passCameraGate } from "./_gate.mjs";
const APP = process.env.APP_URL || "http://localhost:8123";
const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const OUT = process.env.OUT || "./shots";
const sleep = ms => new Promise(r => setTimeout(r, ms));
await mkdir(OUT, { recursive: true });
const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new",
  args: ["--use-fake-device-for-media-stream","--use-fake-ui-for-media-stream","--no-first-run"] });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 810, deviceScaleFactor: 2 });
await page.goto(APP, { waitUntil: "networkidle2", timeout: 60000 });
await passCameraGate(page);
await page.waitForFunction(() => document.getElementById("status").style.display === "none", { timeout: 60000 });
await sleep(2500);
const INK = { head:[.0670,.0116,.9265,.9893], handR:[.1532,.0767,.8643,.9249],
              handL:[.1188,.0534,.9745,.9378], legL:[.2262,.0572,.8362,.9061],
              legR:[.2173,.0822,.8736,.9537], uarmR:[.2467,.0127,.8053,.9971] };
const probe = () => page.evaluate(ink => {
  const st = document.getElementById("homeStage").getBoundingClientRect();
  const out = {}; let L=1e9,T=1e9,R=-1e9,B=-1e9;
  for (const [j,f] of Object.entries(ink)) {
    const el = document.querySelector('#homeRobot .pr-part[data-j="'+j+'"]>img');
    const r = el.getBoundingClientRect();
    const x0=r.left+f[0]*r.width, y0=r.top+f[1]*r.height,
          x1=r.left+f[2]*r.width, y1=r.top+f[3]*r.height;
    out[j]=[+(x0-st.left).toFixed(1),+(y0-st.top).toFixed(1),+(x1-st.left).toFixed(1),+(y1-st.top).toFixed(1)];
    L=Math.min(L,x0);T=Math.min(T,y0);R=Math.max(R,x1);B=Math.max(B,y1);
  }
  out.ALL=[+(L-st.left).toFixed(1),+(T-st.top).toFixed(1),+(R-st.left).toFixed(1),+(B-st.top).toFixed(1)];
  return out;
}, INK);
for (const [n,at] of [["rest",[720,120]],["hardleft",[2,808]],["upleft",[2,2]],["right",[1438,300]]]) {
  await page.mouse.move(at[0],at[1]); await sleep(60); await page.mouse.move(at[0]+1,at[1]);
  await sleep(1100);
  const p = await probe();
  console.log(n, "ALL", JSON.stringify(p.ALL), "handR", JSON.stringify(p.handR), "head", JSON.stringify(p.head));
  await page.screenshot({ path: `${OUT}/edge-${n}.png`, clip:{x:0,y:230,width:660,height:580} });
}
await browser.close();
