/* Honest look: the REAL DOM rig, every pose, plain ground, generous crop
   around the whole 640-canvas (which overflows .grobot on purpose). */
import puppeteer from "puppeteer-core";
import { mkdir } from "node:fs/promises";
import { passCameraGate } from "./_gate.mjs";
const APP="http://localhost:8123", OUT=process.argv[2]||"./look";
const RIG=process.env.RIG||"v1RobotRival";
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
await mkdir(OUT,{recursive:true});
const b=await puppeteer.launch({executablePath:"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",headless:"new",
  args:["--use-fake-device-for-media-stream","--use-fake-ui-for-media-stream","--no-first-run"]});
const p=await b.newPage();
await p.setViewport({width:1440,height:810,deviceScaleFactor:3});
await p.emulateMediaFeatures([{name:"prefers-reduced-motion",value:"reduce"}]);
await p.goto(APP,{waitUntil:"networkidle2",timeout:60000});
await passCameraGate(p);
await p.waitForFunction(()=>document.getElementById("status").style.display==="none",{timeout:60000});
await p.evaluate(()=>{document.querySelectorAll("section.screen").forEach(s=>s.classList.add("hidden"));
  document.getElementById("scrMatch").classList.remove("hidden"); document.body.dataset.screen="match";});
await sleep(900);
/* clear the board, kill the glow, and park the rig dead centre so nothing
   clips it and nothing is behind it but flat grey */
await p.evaluate(RIG=>{
  const st=document.getElementById("matchStage");
  for(const el of st.children) if(el.id!==RIG) el.style.display="none";
  st.style.background="#e9e7ee"; st.style.overflow="visible";
  const n=document.getElementById(RIG);
  n.style.left="34%"; n.style.top="16%"; n.style.width="26%";
  n.style.setProperty("--rb-scale","1");
  const bub=n.querySelector(".rb-bubble"); if(bub) bub.style.display="none";
  const s=document.createElement("style");
  s.textContent=".grobot::before{display:none!important}";
  document.head.appendChild(s);
},RIG);
await sleep(400);
await p.evaluate(async app=>{window.__rb=await import(app+"/js/robot.js");},APP);
const clip=await p.evaluate(RIG=>{const c=document.getElementById(RIG).querySelector(".rb-canvas").getBoundingClientRect();
  const m=c.width*.22;
  return{x:Math.round(c.x-m),y:Math.round(c.y-m),width:Math.round(c.width+m*2),height:Math.round(c.height+m*2)};},RIG);
const feed=v=>p.evaluate((RIG,v)=>{clearInterval(window.__f);window.__f=setInterval(()=>window.__rb.robotCharge(RIG,v),40);},RIG,v);
const shot=async n=>{const pose=await p.evaluate(RIG=>document.getElementById(RIG).dataset.pose,RIG);
  await p.screenshot({path:`${OUT}/${n}.png`,clip}); console.log(n.padEnd(8),"->",pose);};
for(const [k,v] of [["idle",0],["watch",.25],["read",.6],["close",.93]]){
  await feed(0); await sleep(80); await feed(v); await sleep(800); await shot(k);
}
await p.evaluate(RIG=>window.__rb.robotGot(RIG),RIG); await sleep(1000); await shot("got");
await sleep(800); await shot("proud");
await p.evaluate(RIG=>window.__rb.robotMiss(RIG,"skip"),RIG); await sleep(900); await shot("lost");
await p.evaluate(RIG=>window.__rb.robotMiss(RIG,"timeout"),RIG); await sleep(900); await shot("down");
await b.close();
