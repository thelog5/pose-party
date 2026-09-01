import puppeteer from "puppeteer-core";
import { mkdir } from "node:fs/promises";
import { passCameraGate } from "./_gate.mjs";
const APP="http://localhost:8123", OUT=process.argv[2];
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
await mkdir(OUT,{recursive:true});
const b=await puppeteer.launch({executablePath:"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",headless:"new",args:["--use-fake-device-for-media-stream","--use-fake-ui-for-media-stream","--no-first-run"]});
const p=await b.newPage(); await p.setViewport({width:1440,height:810,deviceScaleFactor:2});
await p.goto(APP,{waitUntil:"networkidle2",timeout:60000});
await passCameraGate(p);
await p.waitForFunction(()=>document.getElementById("status").style.display==="none",{timeout:60000});
await p.evaluate(async a=>{window.__rb=await import(a+"/js/robot.js")},APP);
for (const [scr,mode,tag] of [["scrMatch","match","v1"],["scrPartyMatch","pmatch","party"]]) {
  await p.evaluate((scr,mode)=>{document.querySelectorAll("section.screen").forEach(s=>s.classList.add("hidden"));
    document.getElementById(scr).classList.remove("hidden"); document.body.dataset.screen=mode;},scr,mode);
  await sleep(700);
  const ids = tag==="v1"?["v1RobotYou","v1RobotRival"]:["pmRobotMine","pmRobotFoe"];
  for(const id of ids) await p.evaluate(id=>window.__rb.robotGot(id),id);
  await p.evaluate(ids=>{for(const id of ids)for(const a of document.getElementById(id).getAnimations({subtree:true})){a.pause();a.currentTime=261;}},ids);
  await p.screenshot({path:`${OUT}/${tag}-slampeak-left.png`,clip:{x:0,y:280,width:340,height:420}});
  await p.screenshot({path:`${OUT}/${tag}-slampeak-right.png`,clip:{x:1100,y:280,width:340,height:420}});
}
console.log("ok");
await b.close();
