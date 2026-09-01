import puppeteer from "puppeteer-core";
import { passCameraGate } from "./_gate.mjs";
const APP="http://localhost:8123";
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const b=await puppeteer.launch({executablePath:"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",headless:"new",args:["--use-fake-device-for-media-stream","--use-fake-ui-for-media-stream","--no-first-run"]});
const p=await b.newPage(); await p.setViewport({width:1440,height:810});
await p.goto(APP,{waitUntil:"networkidle2",timeout:60000});
await passCameraGate(p);
await p.waitForFunction(()=>document.getElementById("status").style.display==="none",{timeout:60000});
await p.click("#modeAI");
await p.waitForFunction(()=>!document.getElementById("howToPlay").classList.contains("hidden"),{timeout:8000,polling:25});
await p.click("#htpReady");
await p.waitForFunction(()=>document.body.dataset.state==="playing",{timeout:20000,polling:50});
await sleep(1500);
await p.evaluate(async a=>{window.__rb=await import(a+"/js/robot.js")},APP);
const read=async v=>{await p.evaluate(v=>window.__rb.robotCharge("spRobot",v),v); await sleep(600);
  return p.evaluate(()=>{const el=document.querySelector("#spRobot .rb-bubble");
    return {pose:document.getElementById("spRobot").dataset.pose,
      x:el.style.getPropertyValue("--talk-x"),y:el.style.getPropertyValue("--talk-y"),
      tilt:getComputedStyle(document.getElementById("spRobot")).getPropertyValue("--rb-tilt")||"(unset)"};});};
for(const v of [0,.25,.6,.93]) console.log(JSON.stringify(await read(v)));
await b.close();
