/* Answer the boot gate.

   The ENABLE CAMERA card is shown on EVERY boot now, not only the first one:
   it is a consent/briefing screen rather than a permission notification, and
   nothing downstream (the camera, the status overlay, Home's entrance) happens
   until it is answered. `--use-fake-ui-for-media-stream` reports the origin as
   already granted, so what these probes meet is the returning-player wording
   with a LET'S GO button — the click is the same either way.

   Tolerant on purpose: some probes stub the permission query or never reach
   boot at all, and a missing card must not take a diagnostic script down. */
export async function passCameraGate(page, timeout = 30000){
  try{
    await page.waitForFunction(() => {
      const g = document.getElementById("camGate");
      return g && !g.classList.contains("hidden");
    }, { timeout, polling: 50 });
    await page.click("#cgEnable");
    /* a returning adult player: the online age check is answered */
    await page.evaluate(() => { try{ localStorage.setItem("posePartyOnlineAge", "ok");
      localStorage.setItem("posePartyDev", "1"); }catch(e){} document.body.dataset.dev = "1"; });
    return true;
  }catch(e){ return false; }
}
