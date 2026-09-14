/* Probe: on a leg word with the legs out of shot, the local robot asks for
   the feet in his own paper bubble, and the old caption box stays hidden. */
import puppeteer from "puppeteer-core";
import { installVisionFixture } from "./vision-fixture.mjs";
import { passCameraGate } from "./_gate.mjs";
const APP = process.env.APP_URL || "http://localhost:8123";
const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new",
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--no-first-run"] });
const page = await browser.newPage();
const errors = []; page.on("pageerror", e => errors.push(e.message));
await page.setViewport({ width: 1440, height: 810 });
await page.goto(APP, { waitUntil: "networkidle2", timeout: 60000 });
await passCameraGate(page);
await page.waitForFunction(() => document.getElementById("status").style.display === "none", { timeout: 60000 });
await installVisionFixture(page);
const out = await page.evaluate(async () => {
  const r = await import(location.origin + "/js/robot.js");
  const { ROBOT_DIALOGUE } = await import(location.origin + "/js/robotDialogue.js");
  const bubble = () => document.querySelector("#v1RobotYou .rb-bubble")?.textContent.trim() || "";
  const said = new Set();
  const until = performance.now() + 4500;
  await new Promise(done => { const step = () => {
    r.setRobotFeetHidden(true); r.robotCharge("v1RobotYou", 0); said.add(bubble());
    performance.now() < until ? requestAnimationFrame(step) : done(); }; step(); });
  return { said:[...said].filter(Boolean), feet:ROBOT_DIALOGUE.feet,
    hint:getComputedStyle(document.getElementById("poseHint")).display,
    status:getComputedStyle(document.getElementById("status")).display };
});
console.log(JSON.stringify(out));
console.log("feet line said:", out.said.some(s => out.feet.includes(s)), "| page errors:", errors.length);
await browser.close();
