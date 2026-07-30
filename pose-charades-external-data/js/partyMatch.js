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
import { fmtTime, fmtScore, setCountdown } from "./ui.js";
import { blip } from "./audio.js";
import { gameState, transition, onTransition } from "./fsm.js";
import { mountCamera } from "./screens.js";
import { PARTY_CHASE_WINDOW_MS } from "./scoring.js";
import { AWARD_MS, setWordRecognitionMotion, showPointsAward,
         confettiFrom } from "./soloRound.js";
import { captureShot, showResults, setRematchState } from "./results.js";

/* Recognition uses the same stability window as the rest of the game: the
   target must stay on top and over threshold before we dare claim. */
const CLAIM_THRESH = 0.60, CLAIM_HOLD_MS = 250;
const LOCK_FILL = CLAIM_THRESH;      // the bar completes at the real claim threshold
const FILL_MIN = 0, FILL_MAX = 95;
const FILL_LERP = 0.16;
const GUESS_SEND_MS = 240;
const ORDINALS = ["1ST", "2ND", "3RD", "4TH", "5TH", "6TH"];

let ctx = null;          // {socket, roster, myId, peers, myName}
let seats = new Map();   // seatKey -> playerId
let rafId = null;
let shownFill = 0;
let lastGuessAt = 0, lastGuessLabel = "", lastGuessConf = -1;
let foeFeaturedId = null;

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
  applyScores(payload.scores);
  stage().dataset.phase = "waiting";
  setTxt("pmWord", "—");
  setTxt("pmMatchTime", fmtTime(Math.max(0, g.matchEndsAt - performance.now())));
  setTxt("pmWordTime", fmtTime(g.wordLimitMs));
  resetGuessPapers();

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
    el.classList.remove("got");
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
  lastGuessAt = 0; lastGuessLabel = ""; lastGuessConf = -1;
  /* confidence must be re-earned for this word — see soloRound.js */
  if(state.smooth) state.smooth[g.word] = 0;

  stage().dataset.phase = "round";
  stage().classList.remove("chase-urgent", "chase-final");
  setTxt("pmWordTimerLabel", "WORD TIME");
  setTxt("pmWord", g.word);
  fitWord();
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
  if(card){
    setWordRecognitionMotion(card, 0, CLAIM_THRESH, false);
    card.classList.remove("locked");
  }
  if($("pmWordFill")) $("pmWordFill").style.width = FILL_MIN + "%";
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
    blip([523, 659, 784], .08);
    if($("pmWordFill")) $("pmWordFill").style.width = FILL_MAX + "%";
    const card = $("pmWordCard");
    setWordRecognitionMotion(card, 0, CLAIM_THRESH, false);
    card?.classList.add("locked");
    showPartyPlacement(place);
  }else{
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
  if(mine){
    setTxt("pmAwardTitle", "GOT IT " + (ORDINALS[mine.place] || "") + "!");
    setTxt("pmAwardLabel", "POINTS!");
    showPointsAward("pmAward", "pmAwardPts", mine.points);
    confettiFrom($("pmWordCard"));
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
  if(g.claimed){
    setWordRecognitionMotion(card, 0, CLAIM_THRESH, false);
    return;
  }

  /* Like Solo/1v1, the progress paper cannot move before the robot's visible
     top-guess paper has actually changed to the target word. */
  const targetText = g.word
    ? (g.word === "idle" ? "JUST STANDING" : g.word).toUpperCase() + "?"
    : "";
  const targetIsDisplayed = !!targetText && shownLabel.pmMyTop === targetText;
  const raw = targetIsDisplayed ? (state.smooth?.[g.word] || 0) : 0;
  const want = Math.max(0, Math.min(1, raw / LOCK_FILL));
  shownFill += (want - shownFill) * FILL_LERP;
  const fill = $("pmWordFill");
  if(fill) fill.style.width = (FILL_MIN + shownFill * (FILL_MAX - FILL_MIN)) + "%";
  setWordRecognitionMotion(card, shownFill * LOCK_FILL, CLAIM_THRESH, true);
}

function tick(){
  const g = state.game;
  if(!g || g.mode !== "party") return;
  const now = performance.now();
  setTxt("pmMatchTime", fmtTime(Math.max(0, g.matchEndsAt - now)));
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
    setTxt("pmWordTime", fmtTime(Math.max(0, g.wordEnd - now)));
  }
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

  const targetText = g.word === "idle"
    ? "JUST STANDING?"
    : String(g.word || "").toUpperCase() + "?";
  const targetIsDisplayed = shownLabel.pmMyTop === targetText;
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

const shownLabel = { pmMyTop: "", pmFoeTop: "" };

function pushGuess(topId, pastId, label, confidence){
  if(typeof label !== "string" || !label) return;
  const text = (label === "idle" ? "just standing" : label).toUpperCase() + "?";
  const pct = Math.round((confidence || 0) * 100) + "%";
  const wordEl = topId === "pmMyTop" ? "pmMyTopWord" : "pmFoeTopWord";
  const pctEl = topId === "pmMyTop" ? "pmMyTopPct" : "pmFoeTopPct";
  const pastWordEl = pastId === "pmMyPast" ? "pmMyPastWord" : "pmFoePastWord";
  const pastPctEl = pastId === "pmMyPast" ? "pmMyPastPct" : "pmFoePastPct";

  if(shownLabel[topId] && shownLabel[topId] !== text){
    setTxt(pastWordEl, $(wordEl).textContent);
    setTxt(pastPctEl, $(pctEl).textContent);
    $(pastId).classList.remove("empty");
    const p = $(pastId);
    p.classList.remove("shift"); void p.offsetWidth; p.classList.add("shift");
    const t = $(topId);
    t.classList.remove("pop"); void t.offsetWidth; t.classList.add("pop");
  }
  shownLabel[topId] = text;
  setTxt(wordEl, text);
  setTxt(pctEl, pct);
}

function resetGuessPapers(){
  shownLabel.pmMyTop = ""; shownLabel.pmFoeTop = "";
  setTxt("pmMyTopWord", "GUESSING…"); setTxt("pmMyTopPct", "0%");
  setTxt("pmFoeTopWord", "GUESSING…"); setTxt("pmFoeTopPct", "0%");
  for(const id of ["pmMyPast", "pmFoePast"]){
    $(id)?.classList.add("empty");
  }
  setTxt("pmMyPastWord", ""); setTxt("pmMyPastPct", "");
  setTxt("pmFoePastWord", ""); setTxt("pmFoePastPct", "");
}

/* The recognition moment reuses Solo/1v1's exact points-award paper and its
   .show keyframes. The server-sorted points replay on the same paper later. */
function showPartyPlacement(place){
  const award = $("pmAward");
  if(!award) return;
  setTxt("pmAwardTitle", "GOT IT!");
  setTxt("pmAwardPts", ORDINALS[place] || "✓");
  setTxt("pmAwardLabel", "PLACE!");
  clearTimeout(award._awardTimer);
  award.classList.remove("show");
  void award.offsetWidth;
  award.classList.add("show");
  award._awardTimer = setTimeout(() => award.classList.remove("show"), AWARD_MS);
}

/* ---------------- scores ---------------- */

function applyScores(scores){
  if(!scores) return;
  const g = state.game;
  if(g) g.scores = scores;
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

/* Figma sizes the word against "JUMPING"; real decks run longer. */
function fitWord(){
  const t = $("pmWord");
  if(!t) return;
  t.style.fontSize = "14.69cqw";
  const avail = t.clientWidth;
  if(!avail) return;
  const want = t.scrollWidth;
  if(want > avail) t.style.fontSize = (14.69 * (avail / want) * .97) + "cqw";
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
    onRematch: () => ctx.socket?.emit("party:rematch", {}, () => {}),
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
