/* True ink extents for both rigs, plus how much bezel the eyes/mouth have left.

   MEASURE THE ROTATED QUAD, NOT THE CLIENT RECT. Every `.pr-part` carries a
   rotation, and `getBoundingClientRect()` returns the AXIS-ALIGNED box of a
   rotated element — which is taller and wider than the art. An earlier version
   of this probe read those rects and reported Home's antenna ~20px higher than
   it really is, which is the difference between "he is at his ceiling" and "he
   has room to grow". The parts' layout boxes are untransformed
   (offsetLeft/Top/Width/Height against `.pr-canvas`, which never transforms),
   so the honest number is: ink corners in canvas-local px -> the img's own
   matrix (the two legs are placed by one) -> the part's composed matrix ->
   the canvas's own client rect. */
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

const INK = { head:[.0670,.0116,.9265,.9893], handR:[.1532,.0767,.8643,.9249],
              handL:[.1188,.0534,.9745,.9378], legL:[.2262,.0572,.8362,.9061],
              legR:[.2173,.0822,.8736,.9537], uarmR:[.2467,.0127,.8053,.9971],
              uarmL:[.0299,.1660,.9798,.8916], torso:[.1302,.0146,.8678,.9570],
              waist:[.0535,.1904,.9465,.9243] };
const SCREEN = [.2427,.3477,.7552,.7878], EYE = [.3183,.4685,.6817,.5919], MOUTH = [.4321,.6191,.5679,.7026];

const scan = (root, stage) => page.evaluate(([root, stage, INK, SCREEN, EYE, MOUTH]) => {
  const st = document.getElementById(stage).getBoundingClientRect();
  const canvas = document.querySelector(`#${root} .pr-canvas`);
  const cr = canvas.getBoundingClientRect();          /* never transformed */
  const quad = (j, f) => {
    const part = document.querySelector(`#${root} .pr-part[data-j="${j}"]`);
    const img = part.querySelector("img");
    const P = new DOMMatrixReadOnly(getComputedStyle(part).transform);
    const I = new DOMMatrixReadOnly(getComputedStyle(img).transform);
    const x0 = img.offsetLeft, y0 = img.offsetTop, w = img.offsetWidth, h = img.offsetHeight;
    const pts = [];
    for (const fx of [f[0], f[2]]) for (const fy of [f[1], f[3]]) {
      /* the img's own matrix has transform-origin 0 0 at its own box corner */
      const lx = fx * w, ly = fy * h;
      const ix = I.a * lx + I.c * ly + I.e, iy = I.b * lx + I.d * ly + I.f;
      const cx = x0 + ix, cy = y0 + iy;               /* canvas-local px */
      pts.push([P.a * cx + P.c * cy + P.e, P.b * cx + P.d * cy + P.f]);
    }
    return [Math.min(...pts.map(p => p[0])), Math.min(...pts.map(p => p[1])),
            Math.max(...pts.map(p => p[0])), Math.max(...pts.map(p => p[1]))];
  };
  let L = 1e9, T = 1e9, R = -1e9, B = -1e9, topJoint = null;
  for (const [j, f] of Object.entries(INK)) {
    const b = quad(j, f);
    L = Math.min(L, b[0]); R = Math.max(R, b[2]); B = Math.max(B, b[3]);
    if (b[1] < T) { T = b[1]; topJoint = j; }
  }
  const scr = quad("head", SCREEN), eye = quad("eyes", EYE), mou = quad("mouth", MOUTH);
  const headInk = quad("head", INK.head);
  const slack = b => [b[0] - scr[0], scr[2] - b[2], b[1] - scr[1], scr[3] - b[3]].map(v => +v.toFixed(1));
  const toStage = (v, axis) => +(v + (axis ? cr.top - st.top : cr.left - st.left)).toFixed(1);
  return { ink:[toStage(L,0), toStage(T,1), toStage(R,0), toStage(B,1)], topJoint,
           head:[toStage(headInk[0],0), toStage(headInk[1],1), toStage(headInk[2],0), toStage(headInk[3],1)],
           stage:[+st.width.toFixed(0), +st.height.toFixed(0)],
           eyeSlack:slack(eye), mouthSlack:slack(mou) };
}, [root, stage, INK, SCREEN, EYE, MOUTH]);

const CORNERS = [[2,2],[1438,2],[2,808],[1438,808],[720,405],[1438,405],[2,405],[720,2],[720,808]];
const worst = async (root, stage, label) => {
  let ink = [1e9,1e9,-1e9,-1e9], eS = [1e9,1e9,1e9,1e9], mS = [1e9,1e9,1e9,1e9], st, tj;
  let hd = [1e9,1e9,-1e9,-1e9];
  for (const [x,y] of CORNERS) {
    await page.mouse.move(x,y); await sleep(60); await page.mouse.move(x+1,y);
    await sleep(780);
    const s = await scan(root, stage); st = s.stage;
    if (s.ink[1] < ink[1]) tj = s.topJoint;
    ink = [Math.min(ink[0],s.ink[0]), Math.min(ink[1],s.ink[1]),
           Math.max(ink[2],s.ink[2]), Math.max(ink[3],s.ink[3])];
    hd = [Math.min(hd[0],s.head[0]), Math.min(hd[1],s.head[1]),
          Math.max(hd[2],s.head[2]), Math.max(hd[3],s.head[3])];
    eS = eS.map((v,i) => Math.min(v, s.eyeSlack[i]));
    mS = mS.map((v,i) => Math.min(v, s.mouthSlack[i]));
  }
  console.log(label, "stage", st.join("x"));
  console.log("   true ink  L", ink[0], " T", ink[1], `(${tj})`, " R", ink[2], " B", ink[3]);
  console.log("   head ink  L", hd[0], " T", hd[1], " R", hd[2], " B", hd[3]);
  console.log("   eye  slack L", eS[0], "R", eS[1], "U", eS[2], "D", eS[3],
              eS.every(v => v > 0) ? " ON SCREEN" : " *** OFF ***");
  console.log("   mouth slack L", mS[0], "R", mS[1], "U", mS[2], "D", mS[3],
              mS.every(v => v > 0) ? " ON SCREEN" : " *** OFF ***");
};
await worst("homeRobot", "homeStage", "HOME ");
await page.click("#modeVS");
await page.waitForFunction(() => document.body.dataset.screen === "lobby", { timeout:15000, polling:40 });
await sleep(2200);
await worst("lobbyRobotWait", "lobbyStage", "LOBBY");
await browser.close();
