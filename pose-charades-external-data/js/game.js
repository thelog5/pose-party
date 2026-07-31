/* Round loop for the local modes.
   "ai": solo — score when the AI holds the right guess above THRESH.
   "vs": practice 1v1 — the simulated robot rival races you.

   All flow control goes through the FSM:
     countdown -> playing -> word-won -> playing ... -> results
   Scoring is only accepted in "playing", which makes the per-word scoring
   lock structural rather than a boolean flag.

   Solo and online 1v1 use the shared 300–500 time-scaled point formula.
   The Solo streak remains a run indicator; it no longer multiplies points. */

import { $, esc } from "./dom.js";
import { state } from "./state.js";
import { ROUNDS, WORD_MS, THRESH, RIVAL_THRESH, HOLD_MS, SOLO,
         PTS_CORRECT, PTS_FAST_BONUS, FAST_WINDOW_MS, PTS_SKIP } from "./constants.js";
import { toast, flash, renderGuesses, topGuesses, fmtTime, fmtScore,
         localMatchGuessIs, setCountdown, showTimesUp } from "./ui.js";
import { blip } from "./audio.js";
import { gameState, transition, onTransition } from "./fsm.js";
import { renderDots } from "./screens.js";
import { fakeRivalGuesses } from "./rival.js";
import { partyCheck } from "./partyMatch.js";
import { captureShot, showResults } from "./results.js";
import { beginRound as soloBegin, failRound as soloFail, endRound as soloEnd,
         timerFrozen as soloFrozen, roundState as soloState,
         ROUND_END_PAUSE_MS, showPointsAward, confettiFrom,
         clearCelebrations, resetSoloBoard } from "./soloRound.js";
import {
  markGuessRecognized,
  prepareWordFeedback, playWordLockFeedback, playWordMissFeedback,
  fitGameplayText,
} from "./gameplayFeedback.js";
import { calculateFirstPoints } from "./scoring.js";

const PRECOUNT_FROM = 3, PRECOUNT_STEP_MS = 800;
const WORD_WON_PAUSE_MS = 1050;

let preCountTimer = null;

/* Registered from main.js AFTER the render listener, so the screen is
   repainted before the game object disappears. */
export function bindGameLifecycle(){
  onTransition((to, from)=>{
    const inGame = s => s==="countdown"||s==="playing"||s==="word-won";
    if(!inGame(to)) clearCelebrations();
    if(inGame(from) && !inGame(to) && to!=="results" && state.game){
      cancelPreCount();
      clearInterval(state.game.timer);
      if(state.game.mode==="ai") soloEnd();
      state.game=null;
    }
  });
}

function cancelPreCount(){
  if(preCountTimer){ clearInterval(preCountTimer); preCountTimer=null; }
  $("countdown").classList.add("hidden");
}

function runPreCount(done){
  let n=PRECOUNT_FROM;
  const cd=$("countdown");
  cd.classList.remove("hidden"); setCountdown(n);
  blip([440]);
  preCountTimer=setInterval(()=>{
    n--;
    if(n>0){ setCountdown(n); blip([440]); return; }
    clearInterval(preCountTimer); preCountTimer=null;
    cd.classList.add("hidden");
    done();
  }, PRECOUNT_STEP_MS);
}

function shuffledDeck(){
  const words=state.model.labels.filter(l=>l!=="idle");
  for(let i=words.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [words[i],words[j]]=[words[j],words[i]]; }
  return words;
}

const setTxt=(id,v)=>{ const el=$(id); if(el) el.textContent=v; };

function bump(id){ const el=$(id); if(!el) return; el.classList.remove("bump"); void el.offsetWidth; el.classList.add("bump"); }

function updateHud(){
  const g=state.game; if(!g) return;
  setTxt("pillScore",fmtScore(g.score));
  setTxt("pillStreak","x"+Math.max(1,g.streak));
  setTxt("pillRound",g.round+" / "+g.rounds);
  const prevScore=$("soloScoreVal")?.textContent, prevStreak=$("soloStreakVal")?.textContent;
  const newScore=fmtScore(g.score), newStreak="x"+Math.max(1,g.streak);
  setTxt("soloScoreVal",newScore);
  setTxt("soloStreakVal",newStreak);
  if(prevScore!==undefined && prevScore!==newScore) bump("soloScoreCard");
  if(prevStreak!==undefined && prevStreak!==newStreak) bump("soloStreakCard");
  /* 0: no run · 1: warming · 2: hot · 3: on fire — CSS owns the treatment */
  const streakCard=$("soloStreakCard");
  if(streakCard){
    const n=Math.max(1,g.streak);
    streakCard.dataset.tier = n>=6 ? "3" : n>=4 ? "2" : n>=2 ? "1" : "0";
  }
  if(state.screen==="match") renderDots(g.round, g.rounds);
}

export function startGame(mode="ai"){
  state.lastMode=mode;
  if(!state.model || state.model.labels.filter(l=>l!=="idle").length<1){
    toast("Train the AI first — record idle plus at least one action word. Tap SETTINGS.");
    transition("training"); return;
  }
  state.game={ mode, deck:shuffledDeck(), word:null, round:0, rounds:ROUNDS, wordEnd:0,
               wordStart:0, holdSince:0, score:0, rivalScore:0, streak:0,
               results:[], bestWrong:{},
               roundEndsAt: mode==="ai" ? performance.now()+SOLO.roundMs : 0 };
  if(!transition("countdown")){ state.game=null; return; }
  updateHud();
  if(mode==="ai"){
    /* The word card and guess stack are only cleared in beginRound, which
       runs AFTER the 3·2·1 — so a second run counted in under the last word
       of the previous one, its bar still full. Clear before the countdown. */
    resetSoloBoard();
    setTxt("soloRoundTime", fmtTime(SOLO.roundMs,{compact:true}));
    setTxt("soloWordTime", fmtTime(SOLO.wordMs));
  }else{
    document.querySelector(".statpill.round .lab").textContent="Round";
    $("pillRound").textContent="1 / "+ROUNDS;
  }
  runPreCount(()=>{
    if(gameState()!=="countdown" || !state.game) return; // user backed out
    transition("playing");
    nextWord();
    state.game.timer=setInterval(gameTick,100);
  });
}

function animateWordChange(){
  [$("promptBar")].forEach(el=>{
    if(!el) return;
    el.classList.remove("wordswap"); void el.offsetWidth; el.classList.add("wordswap");
  });
}

function nextWord(){
  const game=state.game;
  game.round++;
  const ai=game.mode==="ai";
  if(!ai && game.round>game.rounds){ endGame(); return; }
  if(ai && game.roundEndsAt-performance.now()<=0){ endGame(); return; }
  if(!game.deck.length) game.deck=shuffledDeck();
  game.word=game.deck.pop();
  game.wordStart=performance.now();
  game.wordEnd=game.wordStart+(ai ? SOLO.wordMs : WORD_MS);
  game.holdSince=0; game.bestWrong={};
  setTxt("vsWord",game.word);
  setTxt("soloWord",game.word);
  updateHud();
  if(ai){
    game.pendingPts=pointsForCurrentWord();
    soloBegin(game.word, onSoloResolve);
  }else{
    const stage=$("matchStage");
    stage?.classList.remove("you-locked","rival-locked");
    prepareWordFeedback($("vsWordCard"),$("v1WordFill"),THRESH,true);
    markGuessRecognized($("myGuessTop"),false);
    markGuessRecognized($("rivalGuessTop"),false);
    $("v1Award")?.classList.remove("show");
    $("v1RivalAward")?.classList.remove("show");
    fitGameplayText($("vsWord"));
  }
  animateWordChange();
}

/* Resolution callback from soloRound.js — for wins it fires when the points
   chip ARRIVES at the score card, so this is the only place solo score and
   streak ever change. */
function onSoloResolve({won, skip}){
  const game=state.game;
  if(!game || game.mode!=="ai" || gameState()!=="playing") return;
  if(!transition("word-won", {winner:won?"you":"miss", word:game.word})) return;

  if(won){
    game.streak++;
    const pts=game.pendingPts||PTS_CORRECT;
    game.score+=pts;
    /* the held pose at recognition — see results.js */
    captureShot("me", game.word, $("video"), true);
    game.results.push({word:game.word, ok:true, pts,
      secs:Math.max(.1,(SOLO.wordMs-Math.max(0,game.wordEnd-performance.now()))/1000)});
  }else{
    game.streak=0;
    if(skip) game.score=Math.max(0,game.score-SOLO.skipPenalty);
    game.results.push({word:game.word, ok:false, thought:game.bestWrong.lab, skipped:!!skip});
  }
  updateHud();

  setTimeout(()=>{
    if(gameState()!=="word-won" || !state.game) return;
    if(state.game.roundEndsAt-performance.now()<=0){ endGame(); return; }
    transition("playing");
    nextWord();
  }, ROUND_END_PAUSE_MS);
}

/* Solo and 1v1 share the exact 300–500 curve. A streak is still celebrated
   in Solo, but never changes the points awarded for a recognition. */
function pointsForCurrentWord(){
  const game=state.game;
  if(game.mode==="ai"){
    return calculateFirstPoints(game.wordEnd-performance.now(), SOLO.wordMs);
  }
  const streak = Math.max(1, game.streak);
  const fast = performance.now()-game.wordStart <= FAST_WINDOW_MS;
  return (PTS_CORRECT + (fast?PTS_FAST_BONUS:0)) * streak;
}

/* winner: "you" | "rival" | "miss". The playing->word-won transition is the
   scoring lock: it can only fire once per word. */
function finishWord(winner, opts={}){
  const game=state.game;
  if(!game || gameState()!=="playing") return;
  if(!transition("word-won", {winner, word:game.word})) return;
  game.holdSince=0;

  if(winner==="you"){
    game.streak++;
    const pts=pointsForCurrentWord();
    game.score+=pts;
    game.results.push({word:game.word, ok:true, pts, confidence:opts.confidence||0});
    $("matchStage")?.classList.add("you-locked");
    markGuessRecognized($("myGuessTop"),true);
    blip([523]);
    playWordLockFeedback({
      card:$("vsWordCard"),fill:$("v1WordFill"),threshold:THRESH,
      onImpact:()=>{
        showPointsAward("v1Award","v1AwardPts",pts);
        confettiFrom($("vsWordCard"));
        flash("good");
        blip([523,659,784]);
      },
    });
  }else if(winner==="rival"){
    game.streak=0;
    const pts=PTS_CORRECT;
    game.rivalScore+=pts;
    game.results.push({word:game.word, ok:false, rival:true, rivalPts:pts, thought:"Rival guessed it first"});
    showPointsAward("v1RivalAward","v1RivalAwardPts",pts);
    $("matchStage")?.classList.add("rival-locked");
    markGuessRecognized($("rivalGuessTop"),true);
    playWordMissFeedback($("vsWordCard"),THRESH);
    flash("bad");
    blip([330,247]);
  }else{
    game.streak=0;
    game.results.push({word:game.word, ok:false, thought:game.bestWrong.lab, skipped:!!opts.skip});
    if(opts.skip) toast("Skipped — −"+PTS_SKIP+" points");
    else showTimesUp();
    playWordMissFeedback($("vsWordCard"),THRESH);
    flash("bad");
    blip([220,165]);
  }
  updateHud();

  setTimeout(()=>{
    if(gameState()!=="word-won" || !state.game) return;
    if(state.game.round>=state.game.rounds){ endGame(); return; }
    transition("playing");
    nextWord();
  }, WORD_WON_PAUSE_MS);
}

/* Called from the classifier whenever fresh guesses land. Awards only when
   the right word stays over THRESH for HOLD_MS (stability window). */
export function gameCheck(){
  const game=state.game;
  if(!game || gameState()!=="playing") return;
  if(game.mode==="ai") return; // solo locking lives in soloRound.js
  const t=topGuesses(1)[0]; if(!t) return;
  const [topLab, topP]=t;
  if(game.mode==="party") return partyCheck(topLab, topP); // party claims live in partyMatch.js

  if(topLab && topLab!==game.word && topLab!=="idle"){
    if((game.bestWrong.p||0)<topP) game.bestWrong={lab:topLab, p:topP};
  }

  /* renderGuesses() runs immediately before this check. Requiring its local
     paper to show the target keeps the visible robot, progress bar and score
     claim in one order even when a previous label is being debounced out. */
  if(topLab===game.word && localMatchGuessIs(game.word) && topP>=THRESH){
    if(!game.holdSince) game.holdSince=performance.now();
    if(performance.now()-game.holdSince>=HOLD_MS){
      if(game.mode==="online"){
        // point claims are validated and awarded by the server
        if(state.onlineClaim) state.onlineClaim(topP);
        game.holdSince=0;
      }else{
        finishWord("you", {confidence:topP});
      }
    }
  } else {
    game.holdSince=0;
  }
}

export function gameTick(){
  const game=state.game;
  if(!game) return;

  if(game.mode==="ai"){
    /* hitstop and the lock sequence freeze the clocks */
    if(soloFrozen()) return;
    const now=performance.now();
    const roundLeft=Math.max(0,game.roundEndsAt-now);
    const wordLeft=Math.max(0,game.wordEnd-now);
    setTxt("soloRoundTime",fmtTime(roundLeft,{compact:true}));
    setTxt("soloWordTime",fmtTime(wordLeft));
    const wt=$("soloWordTime"); if(wt) wt.classList.toggle("low", wordLeft<=5000 && wordLeft>0);
    if(roundLeft<=0){ if(gameState()==="playing") endGame(); return; }
    if(soloState()==="guessing"){
      game.pendingPts=pointsForCurrentWord();
      if(wordLeft<=0 && gameState()==="playing") missWord(false);
    }
    return;
  }

  const wLeft=Math.max(0,game.wordEnd-performance.now());
  setTxt("pillTime",fmtTime(wLeft));
  setTxt("v1WordTime",fmtTime(wLeft));
  const v1WordTime=$("v1WordTime");
  if(v1WordTime) v1WordTime.classList.toggle("low",wLeft<=5000&&wLeft>0);
  const matchStage=$("matchStage");
  const inChase=game.mode==="online" && game.roundPhase==="chase";
  if(matchStage){
    if(inChase){
      const second=Math.max(0,Math.ceil(wLeft/1000));
      setTxt("v1WordTimerLabel",
        second+" SECOND"+(second===1?"":"S")+" LEFT");
      matchStage.dataset.chaseSecond=String(second);
      matchStage.classList.toggle("chase-urgent",second<=3);
      matchStage.classList.toggle("chase-final",second<=1);
      if(game.chaseSecond!==second){
        game.chaseSecond=second;
        const card=$("v1WordTimerCard");
        if(card){
          card.classList.remove("tick-pop"); void card.offsetWidth;
          card.classList.add("tick-pop");
        }
        if(second>0) blip([second<=2?880:660],.035);
      }
    }else{
      game.chaseSecond=null;
      matchStage.classList.remove("chase-urgent","chase-final");
      delete matchStage.dataset.chaseSecond;
    }
  }
  if(game.mode==="online" && game.matchEndsAt){
    const matchLeft=Math.max(0,Math.min(
      game.matchLimitMs ?? Infinity,
      game.matchEndsAt-performance.now()));
    setTxt("pillRound",fmtTime(matchLeft));
    setTxt("v1MatchTime",fmtTime(matchLeft,{compact:true}));
  }else if(game.mode==="vs"){
    setTxt("v1MatchTime",game.round+" / "+game.rounds);
  }

  if(game.mode==="vs"){
    const rtop=fakeRivalGuesses();
    if(gameState()==="playing" && rtop[0] && rtop[0][0]===game.word && rtop[0][1]>=RIVAL_THRESH){
      finishWord("rival", {confidence:rtop[0][1]});
      renderGuesses();
      return;
    }
    renderGuesses();
  }

  // online rounds are ended authoritatively by the server (round:result)
  if(wLeft<=0 && gameState()==="playing" && game.mode!=="online") missWord(false);
}

export function missWord(isSkip){
  const game=state.game;
  if(!game || gameState()!=="playing") return;
  if(game.mode==="ai"){
    /* bubble flips to its failed state; scoring lands in onSoloResolve */
    soloFail(!!isSkip);
    return;
  }
  if(isSkip) game.score=Math.max(0,game.score-PTS_SKIP);
  finishWord("miss", {skip:isSkip});
}

export function endGame(){
  cancelPreCount();
  clearInterval(state.game.timer);
  if(state.game.mode==="ai") soloEnd();
  const g=state.game; state.game=null;
  const got=g.results.filter(r=>r.ok);
  const times=got.map(r=>r.secs).filter(Number.isFinite);
  const solo=g.mode==="ai";
  /* Figma's solo frame says GAME OVER over the run total. */
  const headline = solo
    ? "GAME OVER"
    : (g.score>=g.rivalScore ? "YOU WIN!" : "RIVAL WINS");
  showResults({
    /* The practice rival is a 1v1 layout with a direct rematch — there is no
       room and nobody to vote with, so it never takes the ready-vote path. */
    mode: solo?"solo":"1v1",
    size: 2,
    headline,
    teams: solo ? null : { blue:g.score, orange:g.rivalScore },
    soloScore: g.score,
    /* every pose of the run and what it paid — solo's breakdown list */
    rounds: g.results.map(r => ({ word:r.word, pts: r.ok ? (r.pts||0) : 0 })),
    players: [{
      id:"me", name:(localStorage.getItem("poseCharadesName")||"YOU"), team:"blue",
      mine:true, score:g.score, firsts:got.length,
      fastest:times.length?Math.min(...times):null,
      avg:times.length?times.reduce((a,b)=>a+b,0)/times.length:null,
      clutch:0, ready:false,
    }].concat(solo?[]:[{
      id:"rival", name:"RIVAL", team:"orange", mine:false,
      score:g.rivalScore, firsts:g.results.filter(r=>r.rival).length,
      fastest:null, avg:null, clutch:0, ready:false,
    }]),
    rematch:{ ready:0, total:1, mine:false, direct:true },
    onRematch: () => startGame(state.lastMode||"ai"),
  });
}
