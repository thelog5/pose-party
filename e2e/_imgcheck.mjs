/* Every image the game references loads and decodes.

   Collects every <img src> in the DOM and every url() in every stylesheet
   rule, fetches each one and decodes it with createImageBitmap. Also records
   any image request that fails while the page boots, passes the camera gate
   and runs Home, so art built from strings in JS (the rig's eyes and mouths,
   the camera gate's beats) is covered too.

   Written for the WebP conversion (scripts/to-webp.sh). Serve the game
   statically and point APP_URL at it:
     python3 -m http.server 8123 -d client
     node e2e/_imgcheck.mjs */
import puppeteer from "puppeteer-core";
import { passCameraGate } from "./_gate.mjs";

const APP = process.env.APP_URL || "http://localhost:8123";
const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--no-first-run"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 810 });

const bad = [];
const seen = new Set();
page.on("response", r => {
  if(r.request().resourceType() !== "image") return;
  seen.add(r.url());
  if(r.status() >= 400) bad.push(`${r.status()} ${r.url()}`);
});
page.on("requestfailed", r => {
  if(r.resourceType() === "image") bad.push(`failed ${r.url()} ${r.failure()?.errorText}`);
});

await page.goto(APP, { waitUntil: "networkidle2", timeout: 60000 });
await passCameraGate(page);
await new Promise(r => setTimeout(r, 4000));

const report = await page.evaluate(async () => {
  const urls = new Set();
  for(const img of document.querySelectorAll("img[src]")) urls.add(img.src);
  const walk = rules => {
    for(const rule of rules){
      if(rule.cssRules) walk(rule.cssRules);
      const text = rule.cssText || "";
      for(const m of text.matchAll(/url\(["']?([^"')]+)["']?\)/g)){
        if(!m[1].startsWith("data:")) urls.add(new URL(m[1], rule.parentStyleSheet?.href || location.href).href);
      }
    }
  };
  for(const sheet of document.styleSheets){ try{ walk(sheet.cssRules); }catch(e){} }
  const out = { total: 0, byExt: {}, broken: [] };
  for(const u of urls){
    if(!/\/assets\//.test(u)) continue;
    out.total++;
    const ext = u.split(".").pop();
    out.byExt[ext] = (out.byExt[ext] || 0) + 1;
    try{
      const res = await fetch(u);
      if(!res.ok){ out.broken.push(`${res.status} ${u}`); continue; }
      const bmp = await createImageBitmap(await res.blob());
      if(!bmp.width) out.broken.push(`zero-size ${u}`);
    }catch(e){ out.broken.push(`${e.message} ${u}`); }
  }
  return out;
});

console.log(`static refs checked: ${report.total}`, report.byExt);
console.log(`image requests during boot + Home: ${seen.size}`);
const all = [...bad, ...report.broken];
if(all.length){ console.log("BROKEN:\n  " + all.join("\n  ")); }
else console.log("all images load and decode");
await browser.close();
process.exit(all.length ? 1 : 0);
