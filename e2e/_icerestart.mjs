/* ICE restart probe (webrtc.js `restart`). Two links in ONE page, joined by
   an in-page signaling relay, with the fake camera as the sender. It asks
   each side for a restart and checks that a new route is negotiated and
   that video keeps arriving. A real network drop cannot be made in headless
   Chrome, so this proves the renegotiation, not the detection.

     cd pose-charades-external-data && python3 -m http.server 8123
     node _icerestart.mjs */
import puppeteer from "puppeteer-core";

const APP = process.env.APP_URL || "http://localhost:8123";
const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
let fails = 0;
const ok = (cond, msg) => { console.log((cond ? "  ok  " : "  FAIL") + " " + msg); if (!cond) fails++; };

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: "new",
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--no-first-run"],
});
try {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.goto(APP + "/privacy.html", { waitUntil: "load" });
  const r = await page.evaluate(async () => {
    const { createPeer } = await import("/js/webrtc.js");
    const cam = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    const sleep = ms => new Promise(res => setTimeout(res, ms));
    const got = { a: null, b: null };
    const sent = { a: [], b: [] };
    let a, b;
    a = createPeer({ initiator: true, stream: cam, iceServers: [],
      sendSignal: d => { sent.a.push(d); setTimeout(() => b.handleSignal(d), 5); },
      onRemoteStream: s => { got.a = s; } });
    b = createPeer({ initiator: false, stream: cam, iceServers: [],
      sendSignal: d => { sent.b.push(d); setTimeout(() => a.handleSignal(d), 5); },
      onRemoteStream: s => { got.b = s; } });
    const video = document.createElement("video");
    video.muted = true; video.autoplay = true; video.playsInline = true;
    document.body.appendChild(video);
    const until = async (fn, ms = 8000) => { const t = performance.now();
      while (!fn() && performance.now() - t < ms) await sleep(50); return fn(); };
    await until(() => a.pc.connectionState === "connected" && got.b);
    video.srcObject = got.b; await video.play().catch(() => {});
    const frames = () => video.getVideoPlaybackQuality().totalVideoFrames;
    const ufrag = pc => /a=ice-ufrag:(\S+)/.exec(pc.localDescription?.sdp || "")?.[1];
    const out = { connected: a.pc.connectionState, ufragA0: ufrag(a.pc) };

    /* the initiator restarts */
    const offersBefore = sent.a.filter(d => d.sdp?.type === "offer").length;
    a.restart();
    await sleep(2500);
    out.offerSent = sent.a.filter(d => d.sdp?.type === "offer").length > offersBefore;
    out.ufragA1 = ufrag(a.pc);
    out.afterA = a.pc.connectionState;
    let f0 = frames(); await sleep(800); out.framesAfterA = frames() - f0;

    /* the other side asks for one; the gap between restarts still applies */
    b.restart();
    out.asked = sent.b.some(d => d.restartIce === true);
    await sleep(9500);
    out.ufragA2 = ufrag(a.pc);
    out.afterB = a.pc.connectionState;
    f0 = frames(); await sleep(800); out.framesAfterB = frames() - f0;
    a.close(); b.close();
    return out;
  });
  ok(r.connected === "connected", "the two links connect");
  ok(r.offerSent && r.ufragA1 && r.ufragA1 !== r.ufragA0,
    `an initiator restart sends an ICE-restart offer (ufrag ${r.ufragA0} -> ${r.ufragA1})`);
  ok(r.afterA === "connected" && r.framesAfterA > 5,
    `the link is connected again and video still arrives (${r.framesAfterA} frames in 0.8s)`);
  ok(r.asked, "the other side asks the initiator to restart");
  ok(r.ufragA2 && r.ufragA2 !== r.ufragA1,
    `the initiator answers the request with a new restart (ufrag ${r.ufragA1} -> ${r.ufragA2})`);
  ok(r.afterB === "connected" && r.framesAfterB > 5,
    `connected again and video still arrives (${r.framesAfterB} frames in 0.8s)`);
  ok(!errors.length, `no page errors (${errors.length})`);
} catch (e) {
  console.error("PROBE ERROR", e); fails++;
} finally {
  await browser.close();
}
console.log(fails ? `\n${fails} FAILED` : "\nall ICE restart checks passed");
process.exit(fails ? 1 : 0);
