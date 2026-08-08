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
import { confettiFrom, greenFlash } from "./soloRound.js";
import {
  RECOGNITION_FILL_MIN, RECOGNITION_FILL_MAX,
  createGuessHistory, resetGuessHistory, updateGuessHistory,
  restartFeedbackAnimation, markGuessRecognized,
  setWordRecognitionMotion, prepareWordFeedback, playWordLockFeedback,
  playWordMissFeedback,
  fitGameplayText, impactFrozen,
} from "./gameplayFeedback.js";
import { captureShot, showResults, setRematchState } from "./results.js";
import { stampSeatAward, deliverSeatAward, clearSeatAward,
         setSeatAwardPoints, seatAwardIsUp,
         SEAT_AWARD_HOLD_MS } from "./seatAward.js";
import { createChargeMeter, resetChargeMeter, advanceCharge,
         chargePercent } from "./recognition.js";
import { robotCharge, robotMiss, robotNewWord } from "./robot.js";
import { showHowToPlay, hideHowToPlay } from "./howToPlay.js";

/* Recognition is the shared charge meter (recognition.js): the pose has to be
   HELD over a gate that relaxes across the word clock, and the claim goes out
   when the meter fills. Party charges fastest of the three modes — six people
   are racing the same word, so a slow board would just hand it to whoever the
   model happens to like. */
const CLAIM_THRESH = 1;              // the meter's own full-charge scale
const GUESS_SEND_MS = 240;
const ORDINALS = ["1ST", "2ND", "3RD", "4TH", "5TH", "6TH"];

let ctx = null;          // {socket, roster, myId, peers, myName}
let seats = new Map();   // seatKey -> playerId
let rafId = null;
const meter = createChargeMeter("party");
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
  if(typeof payload?.tutorialId !== "string" || !payload.tutorialId) return;
  const g = {
    mode: "party", tutorialId: payload.tutorialId,
    word: null, roundId: null, claimed: false,
    holdSince: 0, phase: "countdown",
    matchEndsAt: 0,
    matchLimitMs: Math.max(0, Number(payload.matchMs)) ||
      Number(payload.roster?.settings?.matchSecs) * 1000 || 120000,
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
  setTxt("pmMatchTime", fmtTime(g.matchLimitMs, { compact:true }));
  setTxt("pmWordTime", fmtTime(g.wordLimitMs));
  resetGuessPapers();
  /* Clear the board BEFORE the 3·2·1. onPartyRound only does this after the
     countdown, so a rematch counted in on the previous match's completed word
     — bar pinned at 95%, card still .locked. Same fix 1v1 and Solo already
     have (clearMatchBoard / resetSoloBoard). */
  resetChargeMeter(meter);
  prepareWordFeedback($("pmWordCard"), $("pmWordFill"), CLAIM_THRESH, false);

  clearInterval(g.timer);
  clearInterval(ctx.countdownTimer);
  $("countdown").classList.add("hidden");
  const tutorialId = payload.tutorialId;
  const acknowledge = () => {
    if(!ctx.socket?.connected) return;
    ctx.socket.emit("party:tutorial-ready", { tutorialId }, res => {
      if(res?.error && res.error !== "match-in-progress")
        ctx.toast?.("Couldn’t ready the party (" + res.error + ")");
    });
  };
  showHowToPlay({ mode:"party", ready:acknowledge, back:acknowledge });
}

export function startPartyCountdown({tutorialId, startAt, matchEndsAt}={}){
  const g = state.game;
  if(!g || g.mode !== "party" || g.tutorialId !== tutorialId) return;
  g.matchEndsAt = ctx.perfFromServer(matchEndsAt);
  g.matchLimitMs = Math.max(0, Number(matchEndsAt) - Number(startAt)) ||
    g.matchLimitMs;
  setTxt("pmMatchTime", fmtTime(Math.max(0, Math.min(
    g.matchLimitMs, g.matchEndsAt - performance.now())), { compact:true }));
  clearInterval(g.timer);
  g.timer = setInterval(tick, 100);
  if(!rafId) rafId = requestAnimationFrame(frame);
  runCountdown(startAt);
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
    el.classList.remove("got", "gone", "first");
    el.classList.toggle("mine", pid === ctx.myId);
    const tag = el.querySelector(".pm-nametag b");
    const player = pid && ctx.roster.players.find(p => p.id === pid);
    if(tag) tag.textContent = player ? disp(player.name) : "";
    resetSeatCrown(el);
    clearSeatAward(el);
    if(pid) mountSeatVideo(el, pid);
  }
}

/* The crown is the FIRST-place mark, not a "you were recognised" sticker —
   only one of the six wears it per word. engine.js head-tracks it onto the
   local player's brow; everyone else keeps the head-band fallback position
   the CSS authors, because remote poses are never transmitted. */
function resetSeatCrown(el){
  const crown = el?.querySelector(".pp-crown");
  if(!crown) return;
  crown.classList.remove("tracked");
  crown.removeAttribute("style");
}

function crownSeat(key){
  for(const other of seats.keys()){
    const el = seatEl(other);
    if(el && other !== key){ el.classList.remove("first"); resetSeatCrown(el); }
  }
  const el = seatEl(key);
  if(!el) return;
  el.classList.add("first");
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
  el.classList.remove("got", "first");
  resetSeatCrown(el);
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
  /* A non-responsive tab gets the entire bounded tutorial window plus the
     synchronized count-in; once the authoritative word arrives, never leave
     live play obscured behind the modal. */
  hideHowToPlay();
  if(gameState() !== "playing" && !transition("playing")) return;
  g.roundId = payload.roundId;
  g.word = String(payload.word || "");
  g.claimed = false;
  g.holdSince = 0;
  g.myPlace = null;
  g.lastChaseSecond = null;
  g.phase = "word";
  g.wordEnd = ctx.perfFromServer(payload.endsAt);
  resetChargeMeter(meter);
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
  for(const key of seats.keys()){
    const el = seatEl(key);
    if(!el) continue;
    /* Last word's paper is gone by now — it was thrown into the team card at
       the end of that word — but a round that ends while one is still in the
       air must not carry it into this one. */
    clearSeatAward(el);
    el.classList.remove("got", "first");
    resetSeatCrown(el);
  }
  applyScores(payload.scores);
  const card = $("pmWordCard");
  prepareWordFeedback(card, $("pmWordFill"), CLAIM_THRESH, true);
}

/* Someone — anyone — was recognized. Green border, the crown if they got there
   first, and the GOT IT paper STAMPED on their seat. The paper stays put for
   the rest of the word: while the other team is still chasing, the board reads
   as "these four are in, these two are not", which is the whole shape of a
   party round. It is thrown into the team card at the end of the word, by
   onPartyResult. */
export function onPartyGot({ id, place } = {}){
  const key = seatOf(id);
  if(!key) return;
  const el = seatEl(key);
  if(!el || el.classList.contains("got")) return;
  el.classList.add("got");
  if(place === 0) crownSeat(key);
  const g = state.game;
  /* the pose they were holding when the AI got it is the funny frame */
  const slot = el.querySelector(".slot");
  const vid = slot?.querySelector("video") || (id === ctx.myId ? $("video") : null);
  captureShot(id, g?.word, vid, id === ctx.myId);
  if(g) recordFinish(g, id, place);
  /* The server sorts finishes by timestamp at the END of the word, so nothing
     authoritative exists yet — quote the same shared formula it scores with,
     and let onPartyResult correct the paper before it is thrown. */
  const earned = g ? calculatePartyPlayerPoints(
    place, Math.max(0, g.wordEnd - performance.now())) : 0;
  stampSeatAward(el, {
    title: "GOT IT " + (ORDINALS[place] || "") + "!", points: earned,
  });
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
        greenFlash(card);
        confettiFrom(card);
        blip([523, 659, 784], .08);
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
  if(gameState() === "playing") transition("word-won");

  /* Placement events are optimistic and arrive live. Reconcile the crown and
     every stamped paper to the server's timestamp-sorted final order before
     the word is banked — a late packet with an earlier stamp can move who
     actually came first, and therefore what each paper is worth. */
  const results = payload.results || [];
  for(const result of results){
    const resultKey = seatOf(result.id);
    const resultSeat = seatEl(resultKey);
    if(!resultSeat) continue;
    resultSeat.classList.add("got");
    if(result.place === 0) crownSeat(resultKey);
    setSeatAwardPoints(resultSeat, result.points || 0);
  }

  /* THE payoff, once per word: every paper on the board is thrown into the
     team card it pays, and the team totals are only repainted once the last
     one has arrived. Held rather than painted now — the figures in
     payload.scores are already authoritative, it is the PAINT that waits. */
  bankRoundAwards(payload.scores, results);

  const mine = results.find(r => r.id === ctx.myId);
  /* TIME'S UP is the clock beating you, not five other people beating you.
     Firing it whenever you simply didn't place made a normal round of party
     read as a failure state; a miss gets the word card's miss beat instead. */
  if(!mine && payload.reason === "timeout") showTimesUp();
  if(!mine){
    playWordMissFeedback($("pmWordCard"), CLAIM_THRESH);
    robotMiss("pmRobotMine");
  }
}

/* Papers are thrown in placement order, a beat apart, so six of them read as a
   sequence of contributions rather than one shower. The stagger plus the flight
   has to finish inside config.betweenRoundsMs (1800ms), which is why the last
   throw starts at 5 × 90ms and not later. */
const AWARD_STAGGER_MS = 90;

function bankRoundAwards(scores, results){
  const thrown = results
    .map(result => ({ result, key: seatOf(result.id) }))
    .filter(entry => entry.key && seatAwardIsUp(seatEl(entry.key)));
  if(!thrown.length){ applyScores(scores); return; }
  /* Hold BEFORE banking: applyScores stores the authoritative figures either
     way, and only the repaint waits for the papers carrying them. */
  scorePaintHeld = true;
  applyScores(scores);
  let landed = 0;
  thrown.forEach(({ key }, i) => {
    deliverSeatAward(seatEl(key),
      $(key.startsWith("orange") ? "pmScoreOrange" : "pmScoreBlue"), {
        holdMs: SEAT_AWARD_HOLD_MS + i * AWARD_STAGGER_MS,
        onLand: () => {
          blip([880]);
          if(++landed < thrown.length) return;
          scorePaintHeld = false;
          /* the round's own figures, not whatever has arrived since — a match
             can end on this word and repaint from a later packet */
          applyScores(scores);
        },
      });
  });
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
  advanceCharge(meter, raw, wordElapsedFrac(g));
  const fill = $("pmWordFill");
  if(fill) fill.style.width = (RECOGNITION_FILL_MIN +
    meter.display * (RECOGNITION_FILL_MAX - RECOGNITION_FILL_MIN)) + "%";
  setWordRecognitionMotion(card, meter.display, CLAIM_THRESH, true);
  robotCharge("pmRobotMine", meter.display, meter.locked);
  if(targetIsDisplayed) setTxt("pmMyTopPct", chargePercent(meter) + "%");
  /* The claim goes out the instant the meter fills — not on the next
     classifier tick, which in a six-way race is 250ms of nothing. */
  if(meter.locked && !g.claimed) claim();
}

/* The chase runs on its own short clock; either way the meter wants "how far
   through the window am I", because that is what relaxes the gate. */
function wordElapsedFrac(g){
  const now = performance.now();
  if(g.phase === "chase"){
    const left = Math.max(0, (g.chaseEndsAt || 0) - now);
    return Math.max(0, Math.min(1, 1 - left / PARTY_CHASE_WINDOW_MS));
  }
  if(!g.wordEnd || !g.wordLimitMs) return 0;
  return Math.max(0, Math.min(1,
    1 - Math.max(0, g.wordEnd - now) / g.wordLimitMs));
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
  /* The claim itself is decided by the charge meter in frame(); this only
     keeps the robot papers and the relay fed. */
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
  /* your own paper reports CHARGE toward the claim when it is showing the
     target word, so the number and the meter never disagree */
  const live = topId === "pmMyTop" && !current.locked &&
    current.label === state.game?.word;
  setTxt(pctEl, (live ? chargePercent(meter)
    : Math.round(current.pct * 100)) + "%");
  /* Yours runs off the meter each frame; the foe rig has only the number on
     his own paper to read, which is all anyone watching him would have. */
  if(topId === "pmFoeTop" && !current.locked)
    robotCharge("pmRobotFoe", current.pct || 0);
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
  robotNewWord("pmRobotMine");
  robotNewWord("pmRobotFoe");
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

/* ---------------- scores ---------------- */

/* Never let the team total jump ahead of the paper that is carrying it. */
let scorePaintHeld = false;

function applyScores(scores){
  if(!scores) return;
  const g = state.game;
  /* Always keep the authoritative figure; only the PAINT waits for the award
     paper, so releasing the hold has a current total to show. */
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
