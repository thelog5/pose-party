import puppeteer from "puppeteer-core";
import { passCameraGate } from "./_gate.mjs";
const APP = process.env.APP_URL || "http://localhost:8123";
const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new",
  args: ["--use-fake-device-for-media-stream","--use-fake-ui-for-media-stream","--no-first-run"] });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 810 });
await page.goto(APP, { waitUntil: "networkidle2", timeout: 60000 });
await passCameraGate(page);
await page.waitForFunction(() => document.getElementById("status").style.display === "none", { timeout: 60000 });
await sleep(2400);
const INK = { head:[.0670,.0116,.9265,.9893], handL:[.1188,.0534,.9745,.9378],
              uarmL:[.0299,.1660,.9798,.8916], uarmR:[.2467,.0127,.8053,.9971],
              torso:[.1302,.0146,.8678,.9570], handR:[.1532,.0767,.8643,.9249] };
const look = () => page.evaluate(INK => {
  const st = document.getElementById("homeStage").getBoundingClientRect();
  const out = {};
  for (const [j,f] of Object.entries(INK)) {
    const el = document.querySelector(`#homeRobot .pr-part[data-j="${j}"]`);
    const r = el.querySelector("img").getBoundingClientRect();
    const m = new DOMMatrixReadOnly(getComputedStyle(el).transform);
    out[j] = { top:+(r.top + f[1]*r.height - st.top).toFixed(1),
               ty:+m.f.toFixed(1), rot:+(Math.atan2(m.b,m.a)*180/Math.PI).toFixed(2) };
  }
  return out;
}, INK);
for (const [x,y,n] of [[720,405,"centre"],[2,2,"up-left"],[1438,2,"up-right"],[720,2,"up"]]) {
  await page.mouse.move(x,y); await sleep(60); await page.mouse.move(x+1,y);
  await sleep(1000);
  const o = await look();
  const top = Object.entries(o).sort((a,b)=>a[1].top-b[1].top)[0];
  console.log(n.padEnd(9), "topmost:", top[0], JSON.stringify(top[1]),
    " head:", JSON.stringify(o.head));
}
await browser.close();
