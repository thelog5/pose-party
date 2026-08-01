/* Party match — the Figma "Party Mode" frame (189:273).

   Six players perform the SAME word simultaneously. The server is
   authoritative for placement, points, the team-completion bonus and the
   final chase window; this module only reports a synchronized recognition
   timestamp and renders what comes back.

   Seating: each team's featured player fills their half of the split, the
   remaining team-mates ride the torn-paper tiles hugging the divider. The
   local player is always featured on their own side, so you see yourself
   large. A 2v2 drops the bottom pair of centre tiles (`data-size`).

   Video comes from the mesh party.js already maintains — one peer link per
   pair — so nothing new is negotiated when the match starts. */

import { $ } from "./dom.js";
import { state } from "./state.js";
import { fmtTime, fmtScore, setCountdown, showTimesUp } from "./ui.js";
import { blip } from "./audio.js";
import { gameState, transition, onTransition } from "./fsm.js";
import { mountCamera } from "./screens.js";
import { PARTY_CHASE_WINDOW_MS,
         calculatePartyPlayerPoints } from "./scoring.js";
import { AWARD_MS, showPointsAward, confettiFrom, flyPoints,
         greenFlash } from "./soloRound.js";
import {
  RECOGNITION_FILL_MIN, RECOGNITION_FILL_MAX,
  advanceRecognitionFill,
  createGuessHistory, resetGuessHistory, updateGuessHistory,
  restartFeedbackAnimation, markGuessRecognized,
  setWordRecognitionMotion, prepareWordFeedback, playWordLockFeedback,
  playWordMissFeedback,
  fitGameplayText, impactFrozen,
} from "./gameplayFeedback.js";
import { captureShot, showResults, setRematchState } from "./results.js";

/* Recognition uses the same stability window as the rest of the game: the
   target must stay on top and over threshold before we dare claim. */
const CLAIM_THRESH = 0.60, CLAIM_HOLD_MS = 250;
const LOCK_FILL = CLAIM_THRESH;      // the bar completes at the real claim threshold
const GUESS_SEND_MS = 240;
const ORDINALS = ["1ST", "2ND", "3RD", "4TH", "5TH", "6TH"];

let ctx = null;          // {socket, roster, myId, peers, myName}
let seats = new Map();   // seatKey -> playerId
let rafId = null;
let shownFill = 0;
let fillAt = 0;
let lastGuessAt = 0, lastGuessLabel = "", lastGuessConf = -1;
let foeFeaturedId = null;
const partyGuess = {
  pmMyTop: createGuessHistory(2),
  pmFoeTop: createGuessHistory(2),
};

const stage = () => $("pmStage");
const seatEl = key => document.querySelector('#pmStage [data-seat="' + key + '"]');
const seatOf = id => [...seats].find(([, pid]) => pid === id)?.[0] || null;
const setTxt = (id, v) => { const e = $(id); if(e) e.textContent = v; };
const disp = name => (name || "Player").trim().slice(0, 10).toUpperCase() || "PLAYER";

/* ---------------- entry ---------------- */

export function startPartyMatch(bridge, payload){
  ctx = bridge;
  const g = {
    mode: "party", word: null, roundId: null, claimed: false,
    holdSince: 0, phase: "countdown",
    matchEndsAt: bridge.perfFromServer(payload.matchEndsAt),
    matchLimitMs: Math.max(0,
      Number(payload.matchEndsAt) - Number(payload.startAt)),
    wordEnd: 0, wordLimitMs: payload.wordMs || 20000,
    scores: payload.scores, myPlace: null,
    lastChaseSecond: null,
    /* per-player match record, for the results breakdown */
    tally: new Map(),
  };
  state.game = g;
  ctx.roster = payload.roster;
  if(!transition("countdown")){ state.game = null; return; }

  layoutSeats();
  scorePaintHeld = false;
  applyScores(payload.scores);
  stage().dataset.phase = "waiting";
  setTxt("pmWord", "—");
  setTxt("pmMatchTime", fmtTime(Math.max(0, Math.min(
    g.matchLimitMs || Infinity,
    g.matchEndsAt - performance.now())), { compact:true }));
  setTxt("pmWordTime", fmtTime(g.wordLimitMs));
  resetGuessPapers();
  /* Clear the board BEFORE the 3·2·1. onPartyRound only does this after the
     countdown, so a rematch counted in on the previous match's completed word
     — bar pinned at 95%, card still .locked. Same fix 1v1 and Solo already
     have (clearMatchBoard / resetSoloBoard). */
  shownFill = 0; fillAt = 0;
  prepareWordFeedback($("pmWordCard"), $("pmWordFill"), CLAIM_THRESH, false);
  $("pmAward")?.classList.remove("show");

  clearInterval(g.timer);
  g.timer = setInterval(tick, 100);
  if(!rafId) rafId = requestAnimationFrame(frame);
  runCountdown(payload.startAt);
}

function runCountdown(startAt){
  const cd = $("countdown");
  cd.classList.remove("hidden");
  clearInterval(ctx.countdownTimer);
  ctx.countdownTimer = setInterval(() => {
    const s = gameState();
    if(s !== "countdown" && s !== "playing"){
      clearInterval(ctx.countdownTimer); cd.classList.add("hidden"); return;
    }
    const left = Math.ceil((startAt - ctx.serverNow()) / 1000);
    if(left > 0){
      if(setCountdown(left)) blip([440]);
    }else{ clearInterval(ctx.countdownTimer); cd.classList.add("hidden"); }
  }, 100);
}

/* ---------------- seating ----------------
   Featured seat per team, then the centre tiles in roster order. The local
   player is pulled to the front of their own team so they are always the
   featured one. */
function layoutSeats(){
  const roster = ctx.roster;
  seats = new Map();
  const perTeam = {};
  for(const team of ["blue", "orange"]){
    const members = roster.players.filter(p => p.team === team);
    const mine = members.findIndex(p => p.id === ctx.myId);
    if(mine > 0) members.unshift(members.splice(mine, 1)[0]);
    perTeam[team] = members;
    members.forEach((p, i) => { if(i < 3) seats.set(team + i, p.id); });
  }
  foeFeaturedId = perTeam[myTeam() === "blue" ? "orange" : "blue"][0]?.id || null;

  const biggest = Math.max(perTeam.blue.length, perTeam.orange.length);
  stage().dataset.size = biggest >= 3 ? "3" : "2";

  for(const key of ["blue0", "blue1", "blue2", "orange0", "orange1", "orange2"]){
    const el = seatEl(key);
    if(!el) continue;
    const pid = seats.get(key);
    el.classList.toggle("vacant", !pid && el.classList.contains("pm-tile"));
    el.classList.remove("got", "gone");
    el.classList.toggle("mine", pid === ctx.myId);
    const tag = el.querySelector(".pm-nametag b");
    const player = pid && ctx.roster.players.find(p => p.id === pid);
    if(tag) tag.textContent = player ? disp(player.name) : "";
    const sticker = el.querySelector(".pm-gotit");
    if(sticker){
      sticker.classList.remove("tracked");
      sticker.removeAttribute("style");
      sticker.querySelector("b").textContent = "";
    }
    if(pid) mountSeatVideo(el, pid);
  }
}

function mountSeatVideo(el, pid){
  const slot = el.querySelector(".slot");
  if(!slot) return;
  if(pid === ctx.myId){ mountCamera(slot); return; }
  let v = slot.querySelector("video");
  if(!v){
    v = document.createElement("video");
    v.autoplay = true; v.playsInline = true; v.muted = true;
    slot.appendChild(v);
  }
  const stream = ctx.peers.get(pid)?.stream;
  if(stream && v.srcObject !== stream){ v.srcObject = stream; v.play().catch(() => {}); }
}

/* Somebody walked out mid-round. Their tile kept the last frame they sent,
   which reads as a player standing perfectly still rather than a player who
   is gone — so grey the seat out and stop the dead feed. */
export function markPartyPlayerGone(pid){
  const g = state.game;
  if(!g || g.mode !== "party") return;
  const key = seatOf(pid);
  if(!key) return;
  const el = seatEl(key);
  if(!el) return;
  el.classList.add("gone");
  el.classList.remove("got");
  for(const v of el.querySelectorAll("video")){ v.pause?.(); v.srcObject = null; }
  const player = ctx.roster?.players.find(p => p.id === pid);
  ctx.toast?.(disp(player?.name) + " left the party.");
  /* foeFeaturedId is otherwise only assigned in layoutSeats(), which runs once
     at match start — so losing the featured opponent killed the rival guess
     paper for the rest of the match. Promote the next one still seated. */
  if(pid === foeFeaturedId){
    const foeTeam = myTeam() === "blue" ? "orange" : "blue";
    foeFeaturedId = [...seats]
      .filter(([key, id]) => key.startsWith(foeTeam) && id !== pid &&
        !seatEl(key)?.classList.contains("gone"))
      .map(([, id]) => id)[0] || null;
    resetGuessPapers();
  }
}

/* party.js calls this when a mesh stream lands after the match began */
export function attachPartyStream(pid, stream){
  const key = seatOf(pid);
  if(!key) return;
  const slot = seatEl(key)?.querySelector(".slot");
  const v = slot?.querySelector("video");
  if(v){ v.srcObject = stream; v.play().catch(() => {}); }
}

const myTeam = () =>
  ctx.roster.players.find(p => p.id === ctx.myId)?.team || "blue";

/* ---------------- server events ---------------- */

export function onPartyRound(payload){
  const g = state.game;
  if(!g || g.mode !== "party") return;
  if(gameState() !== "playing" && !transition("playing")) return;
  g.roundId = payload.roundId;
  g.word = String(payload.word || "");
  g.claimed = false;
  g.holdSince = 0;
  g.myPlace = null;
  g.lastChaseSecond = null;
  g.phase = "word";
  g.wordEnd = ctx.perfFromServer(payload.endsAt);
  shownFill = 0;
  fillAt = 0;
  lastGuessAt = 0; lastGuessLabel = ""; lastGuessConf = -1;
  /* confidence must be re-earned for this word — see soloRound.js */
  if(state.smooth) state.smooth[g.word] = 0;

  stage().dataset.phase = "round";
  stage().classList.remove("chase-urgent", "chase-final");
  /* a new word can never inherit the previous one's in-flight chip */
  scorePaintHeld = false;
  setTxt("pmWordTimerLabel", "WORD TIME");
  setTxt("pmWord", g.word);
  fitGameplayText($("pmWord"));
  resetGuessPapers();
  $("pmAward")?.classList.remove("show");
  setTxt("pmAwardLabel", "POINTS!");
  for(const key of seats.keys()){
    const el = seatEl(key);
    if(!el) continue;
    el.classList.remove("got");
    const sticker = el.querySelector(".pm-gotit");
    if(sticker){
      sticker.classList.remove("tracked");
      sticker.removeAttribute("style");
      sticker.querySelector("b").textContent = "";
    }
  }
  applyScores(payload.scores);
  const card = $("pmWordCard");
  prepareWordFeedback(card, $("pmWordFill"), CLAIM_THRESH, true);
}

/* Someone — anyone — was recognized. Green border + placement sticker. */
export function onPartyGot({ id, place } = {}){
  const key = seatOf(id);
  if(!key) return;
  const el = seatEl(key);
  if(!el || el.classList.contains("got")) return;
  el.classList.add("got");
  const sticker = el.querySelector(".pm-gotit");
  if(sticker) sticker.querySelector("b").textContent = "I GOT IT " + (ORDINALS[place] || "");
  const g = state.game;
  /* the pose they were holding when the AI got it is the funny frame */
  const slot = el.querySelector(".slot");
  const vid = slot?.querySelector("video") || (id === ctx.myId ? $("video") : null);
  captureShot(id, g?.word, vid, id === ctx.myId);
  if(g) recordFinish(g, id, place);
  if(id === ctx.myId){
    if(g) g.myPlace = place;
    const card = $("pmWordCard");
    const roundId = g?.roundId;
    const update = updateGuessHistory(partyGuess.pmMyTop, g?.word || "", 1,
      { force:true,locked:true });
    renderPartyGuess("pmMyTop", "pmMyPast", partyGuess.pmMyTop, update.changed);
    markGuessRecognized($("pmMyTop"), true);
    blip([523]);
    playWordLockFeedback({
      card,
      fill: $("pmWordFill"),
      threshold: CLAIM_THRESH,
      onImpact: () => {
        const live = state.game;
        if(!live || live.mode !== "party" || live.roundId !== roundId) return;
        showPartyPlacement(place);
        greenFlash(card);
        confettiFrom(card);
        blip([523, 659, 784], .08);
        /* the same physical hand-off Solo and 1v1 use: points travel from
           the word you landed to your team's card, and the team total is
           only repainted when they arrive */
        const myCard = $(myTeam() === "orange" ? "pmScoreOrange" : "pmScoreBlue");
        scorePaintHeld = true;
        /* The paper shows a PLACE at this moment, so reading it back gave the
           chip the ordinal — it always flew "+1".."+6". Compute the real
           figure from the same shared formula the server scores with. */
        const earned = calculatePartyPlayerPoints(
          place, Math.max(0, live.wordEnd - performance.now()));
        flyPoints(card, myCard, earned, () => {
          scorePaintHeld = false;
          applyScores(state.game?.scores);
          blip([880]);
        });
      },
    });
  }else{
    if(id === foeFeaturedId && g?.word){
      const update = updateGuessHistory(partyGuess.pmFoeTop, g.word, 1,
        { force:true,locked:true });
      renderPartyGuess("pmFoeTop", "pmFoePast", partyGuess.pmFoeTop,
        update.changed);
      markGuessRecognized($("pmFoeTop"), true);
    }
    blip([494, 622], .05);
  }
}

export function onPartyChase({ team, chaseEndsAt, bonus } = {}){
  const g = state.game;
  if(!g || g.mode !== "party") return;
  g.phase = "chase";
  g.chaseEndsAt = ctx.perfFromServer(chaseEndsAt);
  g.lastChaseSecond = null;
  stage().dataset.phase = "chase";
  stage().classList.remove("chase-urgent", "chase-final");
  setTxt("pmWordTimerLabel", "FINAL CHASE");
  fitGameplayText($("pmWordTimerLabel"));
  fitGameplayText($("pmWordTime"));
  const mine = team === myTeam();
  ctx.toast(mine
    ? "Your team finished! +" + bonus + " bonus"
    : (team === "blue" ? "Blue" : "Orange") + " team finished — " +
      Math.round(PARTY_CHASE_WINDOW_MS / 1000) + "s to land yours!");
  blip(mine ? [659, 880] : [330, 262]);
}

export function onPartyResult(payload){
  const g = state.game;
  if(!g || g.mode !== "party") return;
  g.phase = "between";
  g.roundId = null;
  stage().dataset.phase = "between";
  stage().classList.remove("chase-urgent", "chase-final");
  setWordRecognitionMotion($("pmWordCard"), 0, CLAIM_THRESH, false);
  applyScores(payload.scores);
  if(gameState() === "playing") transition("word-won");

  /* Placement events are optimistic and arrive live. Reconcile every sticker
     to the server's timestamp-sorted final order before the next word. */
  for(const result of payload.results || []){
    const resultSeat = seatEl(seatOf(result.id));
    if(!resultSeat) continue;
    resultSeat.classList.add("got");
    const resultSticker = resultSeat.querySelector(".pm-gotit b");
    if(resultSticker){
      resultSticker.textContent = "I GOT IT " + (ORDINALS[result.place] || "");
    }
  }

  const mine = (payload.results || []).find(r => r.id === ctx.myId);
  /* TIME'S UP is the clock beating you, not five other people beating you.
     Firing it whenever you simply didn't place made a normal round of party
     read as a failure state; a miss gets the word card's miss beat instead. */
  if(!mine && payload.reason === "timeout") showTimesUp();
  if(mine){
    setTxt("pmAwardTitle", "GOT IT " + (ORDINALS[mine.place] || "") + "!");
    setTxt("pmAwardLabel", "POINTS!");
    showPointsAward("pmAward", "pmAwardPts", mine.points);
  }else{
    playWordMissFeedback($("pmWordCard"), CLAIM_THRESH);
  }
}

export function onPartyEnd(payload){
  const g = state.game;
  if(!g || g.mode !== "party") return;
  endPartyMatch(payload);
}

/* the featured rival's live read, relayed by the server */
export function onPartyGuess({ id, label, confidence } = {}){
  if(id !== foeFeaturedId) return;
  pushGuess("pmFoeTop", "pmFoePast", label, confidence);
}

/* ---------------- per-frame + per-tick ---------------- */

function frame(){
  rafId = requestAnimationFrame(frame);
  const g = state.game;
  if(!g || g.mode !== "party" || g.phase !== "word" && g.phase !== "chase") return;
  const card = $("pmWordCard");
  if(g.myPlace !== null){
    setWordRecognitionMotion(card, 0, CLAIM_THRESH, false);
    return;
  }

  /* Like Solo/1v1, the progress paper cannot move before the robot's visible
     top-guess paper has actually changed to the target word. */
  const targetIsDisplayed = !!g.word &&
    partyGuess.pmMyTop.items[0]?.label === g.word;
  const raw = targetIsDisplayed ? (state.smooth?.[g.word] || 0) : 0;
  const want = Math.max(0, Math.min(1, raw / LOCK_FILL));
  const next = advanceRecognitionFill(shownFill, want, fillAt);
  shownFill = next.value;
  fillAt = next.at;
  const fill = $("pmWordFill");
  if(fill) fill.style.width = (RECOGNITION_FILL_MIN +
    shownFill * (RECOGNITION_FILL_MAX - RECOGNITION_FILL_MIN)) + "%";
  setWordRecognitionMotion(card, shownFill * LOCK_FILL, CLAIM_THRESH, true);
}

function tick(){
  const g = state.game;
  if(!g || g.mode !== "party") return;
  /* the shared 180ms recognition impact stops the clocks, as it does in Solo */
  if(impactFrozen($("pmWordCard"))) return;
  const now = performance.now();
  const matchLeft = Math.max(0, Math.min(
    g.matchLimitMs || Infinity, g.matchEndsAt - now));
  setTxt("pmMatchTime", fmtTime(matchLeft, { compact:true }));
  /* the match clock warns before it ends, like Solo's run clock */
  $("pmMatchTime")?.classList.toggle("low", matchLeft <= 15000 && matchLeft > 0);
  if(g.phase === "chase"){
    const remaining = Math.max(0, (g.chaseEndsAt || 0) - now);
    const chaseSecond = Math.max(0, Math.ceil(remaining / 1000));
    setTxt("pmWordTime", fmtTime(remaining));
    stage().classList.toggle("chase-urgent", chaseSecond <= 3);
    stage().classList.toggle("chase-final", chaseSecond <= 1);
    if(chaseSecond !== g.lastChaseSecond){
      g.lastChaseSecond = chaseSecond;
      const timer = $("pmWordTimerCard");
      timer?.classList.remove("tick-pop");
      if(timer){ void timer.offsetWidth; timer.classList.add("tick-pop"); }
      if(chaseSecond > 0) blip([chaseSecond <= 2 ? 294 : 392], .035);
    }
  }else if(g.phase === "word"){
    const wordLeft = Math.max(0, g.wordEnd - now);
    setTxt("pmWordTime", fmtTime(wordLeft));
    /* the same last-five-seconds reddening Solo and 1v1 already have */
    $("pmWordTime")?.classList.toggle("low", wordLeft <= 5000 && wordLeft > 0);
  }
  if(g.phase !== "word") $("pmWordTime")?.classList.remove("low");
}

/* ---------------- recognition -> claim ---------------- */

/* Called from the classifier via game.js on every fresh guess. */
export function partyCheck(topLabel, topP){
  const g = state.game;
  if(!g || g.mode !== "party" || !g.roundId) return;
  if(g.phase !== "word" && g.phase !== "chase") return;
  if(g.claimed) return;

  pushGuess("pmMyTop", "pmMyPast", topLabel, topP);
  sendGuess(topLabel, topP);

  const targetIsDisplayed = partyGuess.pmMyTop.items[0]?.label === g.word;
  if(targetIsDisplayed && topLabel === g.word && topP >= CLAIM_THRESH){
    if(!g.holdSince) g.holdSince = performance.now();
    if(performance.now() - g.holdSince >= CLAIM_HOLD_MS) claim();
  }else{
    g.holdSince = 0;
  }
}

function claim(){
  const g = state.game;
  if(!g || g.claimed || !g.roundId || !ctx.socket) return;
  g.claimed = true;
  ctx.socket.emit("party:claim",
    { roundId: g.roundId, recognizedAt: Math.round(ctx.serverNow()) },
    res => { if(res?.error && res.error !== "already-claimed") g.claimed = false; });
}

function sendGuess(label, confidence){
  const g = state.game;
  if(!g || !g.roundId || g.claimed || !ctx.socket) return;
  if(typeof label !== "string" || !Number.isFinite(confidence)) return;
  const now = performance.now();
  const changed = label !== lastGuessLabel || Math.abs(confidence - lastGuessConf) >= .035;
  if(now - lastGuessAt < GUESS_SEND_MS && !changed) return;
  if(now - lastGuessAt < 140) return;
  lastGuessAt = now; lastGuessLabel = label; lastGuessConf = confidence;
  ctx.socket.emit("party:guess", {
    roundId: g.roundId, label,
    confidence: Math.round(Math.max(0, Math.min(1, confidence)) * 1000) / 1000,
  });
}

/* ---------------- guess papers ---------------- */

function pushGuess(topId, pastId, label, confidence){
  if(typeof label !== "string" || !label) return;
  const history = partyGuess[topId];
  if(!history) return;
  const update = updateGuessHistory(history, label, confidence);
  if(update.committed)
    renderPartyGuess(topId, pastId, history, update.changed);
}

function renderPartyGuess(topId, pastId, history, popped=false){
  const wordEl = topId === "pmMyTop" ? "pmMyTopWord" : "pmFoeTopWord";
  const pctEl = topId === "pmMyTop" ? "pmMyTopPct" : "pmFoeTopPct";
  const pastWordEl = pastId === "pmMyPast" ? "pmMyPastWord" : "pmFoePastWord";
  const pastPctEl = pastId === "pmMyPast" ? "pmMyPastPct" : "pmFoePastPct";
  const current = history.items[0];
  const past = history.items[1];
  if(!current) return;
  const currentText = (current.label === "idle" ? "just standing" :
    current.label).toUpperCase() + (current.locked ? "" : "?");
  setTxt(wordEl, currentText);
  setTxt(pctEl, Math.round(current.pct * 100) + "%");
  fitGameplayText($(wordEl));

  if(past){
    const pastText = (past.label === "idle" ? "just standing" :
      past.label).toUpperCase() + "?";
    setTxt(pastWordEl, pastText);
    setTxt(pastPctEl, Math.round(past.pct * 100) + "%");
    fitGameplayText($(pastWordEl));
    $(pastId).classList.remove("empty");
  }else{
    $(pastId).classList.add("empty");
    setTxt(pastWordEl, "");
    setTxt(pastPctEl, "");
  }
  markGuessRecognized($(topId), !!current.locked);
  if(popped){
    restartFeedbackAnimation($(topId), "pop");
    if(past) restartFeedbackAnimation($(pastId), "shift");
  }
}

function resetGuessPapers(){
  resetGuessHistory(partyGuess.pmMyTop);
  resetGuessHistory(partyGuess.pmFoeTop);
  setTxt("pmMyTopWord", "GUESSING…"); setTxt("pmMyTopPct", "0%");
  setTxt("pmFoeTopWord", "GUESSING…"); setTxt("pmFoeTopPct", "0%");
  for(const id of ["pmMyTop", "pmFoeTop"]){
    markGuessRecognized($(id), false);
  }
  for(const id of ["pmMyPast", "pmFoePast"]){
    $(id)?.classList.add("empty");
  }
  setTxt("pmMyPastWord", ""); setTxt("pmMyPastPct", "");
  setTxt("pmFoePastWord", ""); setTxt("pmFoePastPct", "");
  for(const id of ["pmMyTopWord", "pmFoeTopWord"])
    fitGameplayText($(id));
}

/* The recognition moment reuses Solo/1v1's exact points-award paper and its
   .show keyframes. The server-sorted points replay on the same paper later. */
function showPartyPlacement(place){
  setTxt("pmAwardTitle", "GOT IT!");
  setTxt("pmAwardLabel", "PLACE!");
  /* through the shared helper so this paper is swept by clearCelebrations
     like every other award — it used to run its own timer and outlive the round */
  showPointsAward("pmAward", "pmAwardPts", 0, ORDINALS[place] || "✓");
}

/* ---------------- scores ---------------- */

/* Never let the team total jump ahead of the chip that is carrying it. */
let scorePaintHeld = false;

function applyScores(scores){
  if(!scores) return;
  const g = state.game;
  /* Always keep the authoritative figure; only the PAINT waits for the chip,
     so releasing the hold has a current total to show. */
  if(g) g.scores = scores;
  if(scorePaintHeld) return;
  const prevB = $("pmBlueScore")?.textContent, prevO = $("pmOrangeScore")?.textContent;
  const b = fmtScore(scores.teams?.blue || 0), o = fmtScore(scores.teams?.orange || 0);
  setTxt("pmBlueScore", b);
  setTxt("pmOrangeScore", o);
  if(prevB !== undefined && prevB !== b) bump("pmScoreBlue");
  if(prevO !== undefined && prevO !== o) bump("pmScoreOrange");
}

function bump(id){
  const el = $(id);
  if(!el) return;
  el.classList.remove("bump"); void el.offsetWidth; el.classList.add("bump");
}

/* ---------------- teardown ---------------- */

function recordFinish(g, id, place){
  if(!g.tally) g.tally = new Map();
  const t = g.tally.get(id) || { firsts: 0, times: [], clutch: 0 };
  if(place === 0) t.firsts++;
  const left = Math.max(0, g.wordEnd - performance.now());
  const spent = Math.max(.1, (g.wordLimitMs - left) / 1000);
  t.times.push(spent);
  if(g.phase === "chase") t.clutch++;
  g.tally.set(id, t);
}

function endPartyMatch(payload){
  const g = state.game;
  if(g) clearInterval(g.timer);
  clearInterval(ctx?.countdownTimer);
  if(rafId){ cancelAnimationFrame(rafId); rafId = null; }
  $("countdown")?.classList.add("hidden");

  const teams = payload?.scores?.teams || { blue: 0, orange: 0 };
  const mine = myTeam();
  const won = payload?.winner === mine;
  const title = payload?.winner
    ? (won ? "YOUR TEAM WINS!" : "TEAM " + payload.winner.toUpperCase() + " WINS")
    : "IT'S A DRAW";
  const tally = g?.tally || new Map();
  const perTeam = { blue: 0, orange: 0 };
  const players = (payload?.scores?.players || []).map(p => {
    const t = tally.get(p.id) || { firsts: 0, times: [], clutch: 0 };
    perTeam[p.team] = (perTeam[p.team] || 0) + 1;
    return {
      id: p.id, name: p.name, team: p.team, score: p.score,
      mine: p.id === ctx.myId,
      stream: p.id === ctx.myId ? null : ctx.peers.get(p.id)?.stream || null,
      firsts: t.firsts,
      fastest: t.times.length ? Math.min(...t.times) : null,
      avg: t.times.length ? t.times.reduce((a, b) => a + b, 0) / t.times.length : null,
      clutch: t.clutch,
      ready: false,
    };
  });
  state.game = null;
  showResults({
    mode: "party",
    size: Math.max(perTeam.blue, perTeam.orange, 2) >= 3 ? 3 : 2,
    headline: title,
    teams,
    players,
    rematch: { ready: payload?.rematch?.ready || 0,
               total: payload?.rematch?.total || players.length, mine: false },
    onRematch: () => new Promise(resolve => {
      if(!ctx.socket){ resolve({ error:"offline" }); return; }
      let settled = false;
      const finish = response => {
        if(settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(response || { ok:true });
      };
      const timeout = setTimeout(() => finish({ error:"timeout" }), 4500);
      ctx.socket.emit("party:rematch", {}, finish);
    }),
  });
}

/* Leaving the screen for any reason tears the loop down. */
export function wirePartyMatch(){
  onTransition((to, from) => {
    const inGame = s => s === "countdown" || s === "playing" || s === "word-won";
    if(inGame(from) && !inGame(to) && state.game?.mode === "party"){
      clearInterval(state.game.timer);
      clearInterval(ctx?.countdownTimer);
      if(rafId){ cancelAnimationFrame(rafId); rafId = null; }
      state.game = null;
    }
  });
}
