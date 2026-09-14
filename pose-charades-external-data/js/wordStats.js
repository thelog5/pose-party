/* WORD STATS: one small, anonymous report per word the player attempts.

   What the AI gets wrong for REAL players, not only for the three people who
   recorded the deck. Each report is the word, the mode, the result (got /
   miss / skip), the time to recognition, how close the AI got (the peak of
   its smoothed score for the word) and the wrong word it guessed most. No
   name, no id, no body data. The server adds it to per-word totals
   (server/wordstats.js); `scripts/pull-stats.mjs` downloads them.

   OFF unless the server says so: the deck response carries `X-Word-Stats: on`
   only when the server has a STATS_TOKEN (data.js). A static host, a local
   test server and the E2E suites therefore never see a report.

   A word counts once it has had at least one classifier tick while live, so
   a word dealt to nobody in shot is not reported as a miss. It resolves as:
     got   markGuessRecognized() on one of the LOCAL papers (gameplayFeedback)
     skip  Solo's or the practice match's skip
     miss  anything else: the next word began, or the match ended. */

import { gameState, onTransition } from "./fsm.js";

const ENDPOINT = "/stats/word";
let enabled = false;
let cur = null;

export function setWordStatsEnabled(on){ enabled = !!on; }

/* Beside every markWordSeen(): the word is live from here. */
export function statsBegin(word, mode){
  statsFlush();
  if(!word) return;
  cur = { word, mode, t0:0, ticks:0, result:null, ms:null, peak:0, wrong:{} };
}

/* Every classifier tick (engine.js): the raw top label and the smoothed score
   for the word on the board. Ticks outside `playing` belong to no word. */
export function statsTick(label, targetScore){
  if(!cur || cur.result || gameState() !== "playing") return;
  const now = performance.now();
  if(!cur.ticks) cur.t0 = now;
  cur.ticks++;
  cur.peak = Math.max(cur.peak, Number(targetScore) || 0);
  if(label && label !== cur.word && label !== "idle")
    cur.wrong[label] = (cur.wrong[label] || 0) + 1;
}

export function statsGot(){
  if(!cur || cur.result) return;
  cur.result = "got";
  cur.ms = cur.ticks ? Math.round(performance.now() - cur.t0) : null;
}

export function statsSkip(){
  if(cur && !cur.result) cur.result = "skip";
}

export function statsFlush(){
  const w = cur;
  cur = null;
  if(!w || !w.ticks || !enabled) return;
  const wrong = Object.entries(w.wrong).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  const body = JSON.stringify({ word:w.word, mode:w.mode, result:w.result || "miss",
    ms:w.ms, peak:Math.round(w.peak * 1000) / 1000, wrong });
  try{
    fetch(ENDPOINT, { method:"POST", keepalive:true, body,
      headers:{ "content-type":"application/json" } }).catch(() => {});
  }catch(e){ /* a report is never worth an error */ }
}

/* Leaving gameplay ends the word in progress; so does the tab going away. */
onTransition(to => { if(to !== "playing" && to !== "word-won") statsFlush(); });
if(typeof document !== "undefined")
  document.addEventListener("visibilitychange", () => { if(document.hidden) statsFlush(); });
