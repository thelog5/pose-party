import puppeteer from "puppeteer-core";
import { passCameraGate } from "./_gate.mjs";
const APP="http://localhost:8123";
const CHROME=process.env.CHROME_PATH||"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const b=await puppeteer.launch({executablePath:CHROME,headless:"new",
  args:["--use-fake-device-for-media-stream","--use-fake-ui-for-media-stream","--no-first-run"]});
const p=await b.newPage();
p.on("pageerror",e=>console.log("PAGEERROR:",e.message));
p.on("console",m=>{ if(m.type()==="error") console.log("CONSOLE ERROR:",m.text()); });
await p.goto(APP,{waitUntil:"networkidle2",timeout:60000});
await passCameraGate(p);
await new Promise(r=>setTimeout(r,6000));
console.log("status hidden:", await p.evaluate(()=>document.getElementById("status").style.display));
console.log("MOODS ok:", await p.evaluate(async()=>{ try{
  const r=await import(location.origin+"/js/robot.js"); return typeof r.robotCharge==="function";
}catch(e){ return "IMPORT FAILED: "+e.message; }}));
await b.close();
