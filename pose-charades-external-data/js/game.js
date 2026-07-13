/* Round loop for the local modes.
   "ai": solo — score when the AI holds the right guess above THRESH.
   "vs": practice 1v1 — the simulated robot rival races you.

   All flow control goes through the FSM:
     countdown -> playing -> word-won -> playing ... -> results
   Scoring is only accepted in "playing", which makes the per-word scoring
   lock structural rather than a boolean flag.

   Scoring (see constants.js): (100 + fast bonus) × streak per word;
   skip costs 500 and breaks the streak; a miss just breaks the streak. */

import { $, esc } from "./dom.js";
import { state } from "./state.js";
import { ROUNDS, WORD_MS, THRESH, RIVAL_THRESH, HOLD_MS,
         PTS_CORRECT, PTS_FAST_BONUS, FAST_WINDOW_MS, PTS_SKIP } from "./constants.js";
import { toast, flash, pointBurst, renderGuesses, topGuesses, fmtTime, fmtScore } from "./ui.js";
import { blip } from "./audio.js";
import { gameState, transition, onTransition } from "./fsm.js";
import { renderDots } from "./screens.js";
import { fakeRivalGuesses } from "./rival.js";

const PRECOUNT_FROM = 3, PRECOUNT_STEP_MS = 800;
const WORD_WON_PAUSE_MS = 1050;

let preCountTimer = null;

/* Registered from main.js AFTER the render listener, so the screen is
   repainted before the game object disappears. */
export function bindGameLifecycle(){
  onTransition((to, from)=>{
    const inGame = s => s==="countdown"||s==="playing"||s==="word-won";
    if(inGame(from) && !inGame(to) && to!=="results" && state.game){
      cancelPreCount();
      clearInterval(state.game.timer);
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
  cd.classList.remove("hidden"); cd.textContent=n;
  blip([440]);
  preCountTimer=setInterval(()=>{
    n--;
    if(n>0){ cd.textContent=n; blip([440]); return; }
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

function updateHud(){
  const g=state.game; if(!g) return;
  $("pillScore").textContent=fmtScore(g.score);
  $("pillStreak").textContent="x"+Math.max(1,g.streak);
  $("pillRound").textContent=g.round+" / "+g.rounds;
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
               results:[], bestWrong:{} };
  if(!transition("countdown")){ state.game=null; return; }
  updateHud();
  $("pillRound").textContent="1 / "+ROUNDS;
  runPreCount(()=>{
    if(gameState()!=="countdown" || !state.game) return; // user backed out
    transition("playing");
    nextWord();
    state.game.timer=setInterval(gameTick,100);
  });
}

function animateWordChange(){
  [$("soloWordCard"), $("vsWordCard")].forEach(el=>{
    if(!el) return;
    el.classList.remove("wordswap"); void el.offsetWidth; el.classList.add("wordswap");
  });
}

function nextWord(){
  const game=state.game;
  game.round++;
  if(game.round>game.rounds){ endGame(); return; }
  if(!game.deck.length) game.deck=shuffledDeck();
  game.word=game.deck.pop();
  game.wordStart=performance.now();
  game.wordEnd=game.wordStart+WORD_MS;
  game.holdSince=0; game.bestWrong={};
  $("soloWord").textContent=game.word;
  const chicken=/chicken/i.test(game.word);
  $("soloWordArtChicken").classList.toggle("hidden",!chicken);
  $("soloWordArtGeneric").classList.toggle("hidden",chicken);
  $("vsWord").textContent=game.word;
  updateHud();
  animateWordChange();
}

function pointsForCurrentWord(){
  const game=state.game;
  const fast = performance.now()-game.wordStart <= FAST_WINDOW_MS;
  return (PTS_CORRECT + (fast?PTS_FAST_BONUS:0)) * Math.max(1, game.streak);
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
    pointBurst("+"+fmtScore(pts)+" points", game.word+(game.streak>1?" · streak x"+game.streak:""), "good");
    flash("good");
    blip([523,659,784]);
  }else if(winner==="rival"){
    game.streak=0;
    const pts=PTS_CORRECT;
    game.rivalScore+=pts;
    game.results.push({word:game.word, ok:false, rival:true, rivalPts:pts, thought:"Rival guessed it first"});
    pointBurst("Rival wins!", game.word+" · +"+pts, "rival");
    flash("bad");
    blip([330,247]);
  }else{
    game.streak=0;
    game.results.push({word:game.word, ok:false, thought:game.bestWrong.lab, skipped:!!opts.skip});
    const missMsg = opts.skip ? "Skipped" : "Time up";
    pointBurst(missMsg, opts.skip ? "−"+PTS_SKIP+" points" : "Next word coming up", "bad");
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
  const t=topGuesses(1)[0]; if(!t) return;
  const [topLab, topP]=t;

  if(topLab && topLab!==game.word && topLab!=="idle"){
    if((game.bestWrong.p||0)<topP) game.bestWrong={lab:topLab, p:topP};
  }

  if(topLab===game.word && topP>=THRESH){
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
  const wLeft=Math.max(0,game.wordEnd-performance.now());
  $("pillTime").textContent=fmtTime(wLeft);

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
  if(isSkip) game.score=Math.max(0,game.score-PTS_SKIP);
  finishWord("miss", {skip:isSkip});
}

export function endGame(){
  cancelPreCount();
  clearInterval(state.game.timer);
  const g=state.game; state.game=null;
  const rows=g.results.map(r=>{
    const right='<span class="ok">You +'+fmtScore(r.pts||0)+'</span>';
    const rival='<span class="miss">Rival +'+(r.rivalPts||0)+'</span><span class="thought">Rival guessed it first.</span>';
    const wrong='<span class="miss">'+(r.skipped?'skipped':'missed')+'</span>'+(r.thought?'<span class="thought">AI thought: '+esc(r.thought)+'</span>':'');
    return '<div class="resrow"><span>'+esc(r.word)+'</span><span>'+(r.ok?right:(r.rival?rival:wrong))+'</span></div>';
  }).join("");
  const got=g.results.filter(r=>r.ok).length;
  const title = g.mode==="vs" ? 'YOU '+fmtScore(g.score)+' — RIVAL '+fmtScore(g.rivalScore) : 'SCORE '+fmtScore(g.score);
  const sub = g.mode==="vs" ? (g.score>=g.rivalScore?'You won the showdown!':'Rival won the showdown') : (got+' of '+g.results.length+' words guessed');
  $("rescard").innerHTML='<h2>'+title+'</h2><div class="sub">'+sub+'</div>'+rows;
  transition("results");
  $("pillScore").textContent=fmtScore(g.score);
}
