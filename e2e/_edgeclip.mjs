/* Finding 8: does rbSlam push the edge-tucked 1v1/Party rigs off-screen?
   Measures the rig's painted box against the viewport at the slam's peak,
   frozen through the WAAPI timeline. Throwaway. */
import puppeteer from "puppeteer-core";
import { passCameraGate } from "./_gate.mjs";
const APP="http://localhost:8123";
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const b=await puppeteer.launch({executablePath:"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",headless:"new",args:["--use-fake-device-for-media-stream","--use-fake-ui-for-media-stream","--no-first-run"]});
const VW=Number(process.env.VW)||1440, VH=Number(process.env.VH)||810;
const p=await b.newPage(); await p.setViewport({width:VW,height:VH});
await p.goto(APP,{waitUntil:"networkidle2",timeout:60000});
await passCameraGate(p);
await p.waitForFunction(()=>document.getElementById("status").style.display==="none",{timeout:60000});
await p.evaluate(()=>{document.querySelectorAll("section.screen").forEach(s=>s.classList.add("hidden"));});
await p.evaluate(async a=>{window.__rb=await import(a+"/js/robot.js")},APP);
for (const [scr,mode,rigs] of [["scrMatch","match",["v1RobotYou","v1RobotRival"]],["scrPartyMatch","pmatch",["pmRobotMine","pmRobotFoe"]]]) {
  await p.evaluate((scr,mode)=>{document.querySelectorAll("section.screen").forEach(s=>s.classList.add("hidden"));
    document.getElementById(scr).classList.remove("hidden"); document.body.dataset.screen=mode;},scr,mode);
  await sleep(600);
  for (const id of rigs) {
    await p.evaluate(id=>window.__rb.robotGot(id),id);
    await p.evaluate(id=>{for(const a of document.getElementById(id).getAnimations({subtree:true})){a.pause();a.currentTime=261;}},id);
    const r=await p.evaluate((id,VW)=>{
      const n=document.getElementById(id);
      const rig=n.querySelector(".rb-rig").getBoundingClientRect();
      const canvas=n.querySelector(".rb-canvas").getBoundingClientRect();
      const box=n.getBoundingClientRect();
      return {id, rigL:+rig.left.toFixed(1), rigR:+rig.right.toFixed(1),
        canvasL:+canvas.left.toFixed(1), canvasR:+canvas.right.toFixed(1),
        boxW:+box.width.toFixed(1),
        offLeftPx:+Math.max(0,-canvas.left).toFixed(1),
        offRightPx:+Math.max(0,canvas.right-VW).toFixed(1),
        offLeftPctOfSelf:+(Math.max(0,-canvas.left)/box.width*100).toFixed(1),
        offRightPctOfSelf:+(Math.max(0,canvas.right-VW)/box.width*100).toFixed(1)};
    },id,VW);
    console.log(VW+"x"+VH, JSON.stringify(r));
    await p.evaluate(id=>window.__rb.resetRobot(id),id); await sleep(300);
  }
}
await b.close();
