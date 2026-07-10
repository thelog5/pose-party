/* Round loop for the local modes.
   "ai": you score when the AI holds the right guess above THRESH.
   "vs": same word, but the simulated rival races you to it.

   All flow control goes through the FSM:
     countdown -> playing -> word-won -> playing ... -> results
   Scoring is only accepted in "playing", which makes the per-word scoring
   lock structural rather than a boolean flag. */

import { $, esc } from "./dom.js";
import { state } from "./state.js";
import { CATEGORIES, ROUNDS, WORD_MS, THRESH, RIVAL_THRESH, HOLD_MS,
         PTS_CORRECT, PTS_PER_SEC, PTS_SKIP } from "./constants.js";
import { toast, flash, pointBurst, renderGuesses, topGuesses } from "./ui.js";
import { blip } from "./audio.js";
import { gameState, transition, onTransition } from "./fsm.js";
import { fakeRivalGuesses } from "./rival.js";

const PRECOUNT_FROM = 3, PRECOUNT_STEP_MS = 800;
const WORD_WON_PAUSE_MS = 1050;

let preCountTimer = null;

/* Registered from main.js AFTER the render listener, so the screen is
   repainted before the game object disappears. */
export function bindGameLifecycle(){
  onTransition((to, from)=>{
    // Leaving the in-game states for anything but results = abandon the game.
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

export function startGame(mode="ai"){
  state.lastMode=mode;
  if(!state.model || state.model.labels.filter(l=>l!=="idle").length<1){
    toast("Train the AI first — record idle plus at least one action word. Tap the gear.");
    transition("training"); return;
  }
  state.game={ mode, deck:shuffledDeck(), word:null, round:0, wordEnd:0,
               holdSince:0, score:0, rivalScore:0, results:[], bestWrong:{} };
  if(!transition("countdown")){ state.game=null; return; }
  $("pillScore").textContent="0";
  $("pillRivalScore").textContent="0";
  $("pillRound").textContent="1/"+ROUNDS;
  if($("bub1")) $("bub1").textContent="I’m guessing…";
  runPreCount(()=>{
    if(gameState()!=="countdown" || !state.game) return; // user backed out
    transition("playing");
    nextWord();
    state.game.timer=setInterval(gameTick,100);
  });
}

function animateWordChange(){
  [$("wordcard"), $("vsWordCard")].forEach(el=>{
    if(!el) return;
    el.classList.remove("wordswap"); void el.offsetWidth; el.classList.add("wordswap");
  });
}

function nextWord(){
  const game=state.game;
  game.round++;
  if(game.round>ROUNDS){ endGame(); return; }
  if(!game.deck.length) game.deck=shuffledDeck();
  game.word=game.deck.pop();
  game.wordEnd=performance.now()+WORD_MS;
  game.holdSince=0; game.bestWrong={};
  const cat=CATEGORIES[game.word]||"Your Words";
  $("gameWord").textContent=game.word;
  $("gameCatTxt").textContent=cat;
  if($("vsWord")) $("vsWord").textContent=game.word;
  if($("vsCat")) $("vsCat").textContent=cat;
  $("pillRound").textContent=game.round+"/"+ROUNDS;
  animateWordChange();
}

/* Base points plus a speed bonus for every whole second left on the clock. */
function pointsForCurrentWord(){
  const game=state.game;
  if(!game) return PTS_CORRECT;
  const bonus=Math.ceil(Math.max(0, game.wordEnd-performance.now())/1000)*PTS_PER_SEC;
  return PTS_CORRECT+bonus;
}

/* winner: "you" | "rival" | "miss". The playing->word-won transition is the
   scoring lock: it can only fire once per word, so a word can never be
   awarded twice even if two code paths race in the same tick. */
function finishWord(winner, opts={}){
  const game=state.game;
  if(!game || gameState()!=="playing") return;
  if(!transition("word-won", {winner, word:game.word})) return;
  game.holdSince=0;
  const pts=pointsForCurrentWord();

  if(winner==="you"){
    game.score+=pts;
    game.results.push({word:game.word, ok:true, pts, confidence:opts.confidence||0});
    $("pillScore").textContent=game.score;
    const msg = game.mode==="vs" ? "You won the word! +"+pts : "AI got it! +"+pts;
    toast(msg);
    pointBurst(game.mode==="vs" ? "You win!" : "+"+pts+" points", game.word+" · +"+pts, "good");
    if($("bub1")) $("bub1").textContent=msg;
    flash("good");
    blip([523,659,784]);
  }else if(winner==="rival"){
    game.rivalScore+=pts;
    game.results.push({word:game.word, ok:false, rival:true, rivalPts:pts, thought:"Rival guessed it first"});
    $("pillRivalScore").textContent=game.rivalScore;
    toast("Rival won the word! +"+pts);
    pointBurst("Rival wins!", game.word+" · +"+pts, "rival");
    flash("bad");
    blip([330,247]);
  }else{
    game.results.push({word:game.word, ok:false, thought:game.bestWrong.lab});
    const missMsg = opts.skip ? "Skipped" : "Time up";
    toast(missMsg+" — next word");
    pointBurst(missMsg, "Next word coming up", "bad");
    flash("bad");
    blip([220,165]);
  }

  setTimeout(()=>{
    if(gameState()!=="word-won" || !state.game) return;
    if(state.game.round>=ROUNDS){ endGame(); return; }
    if($("bub1")) $("bub1").textContent="I’m guessing…";
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
  const now=performance.now();
  const wLeft=Math.max(0,game.wordEnd-now);
  const txt="0:"+String(Math.ceil(wLeft/1000)).padStart(2,"0");
  $("pillTime").textContent=txt;
  if($("autoskipTxtVs")) $("autoskipTxtVs").textContent=txt;

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
  if(isSkip){
    game.score=Math.max(0,game.score-PTS_SKIP);
    $("pillScore").textContent=game.score;
  }
  finishWord("miss", {skip:isSkip});
}

export function endGame(){
  cancelPreCount();
  clearInterval(state.game.timer);
  const g=state.game; state.game=null;
  const rows=g.results.map(r=>{
    const right='<span class="ok">You +'+ (r.pts||0)+'</span>';
    const rival='<span class="miss">Rival +'+(r.rivalPts||0)+'</span><span class="thought">Rival guessed it first.</span>';
    const wrong='<span class="miss">missed</span>'+(r.thought?'<span class="thought">AI thought: '+esc(r.thought)+'</span>':'');
    return '<div class="resrow"><span>'+esc(r.word)+'</span><span>'+(r.ok?right:(r.rival?rival:wrong))+'</span></div>';
  }).join("");
  const got=g.results.filter(r=>r.ok).length;
  const title = g.mode==="vs" ? 'YOU '+g.score+' — RIVAL '+g.rivalScore : 'SCORE '+g.score;
  const sub = g.mode==="vs" ? (g.score>=g.rivalScore?'You won the showdown':'Rival won the showdown') : (got+' of '+g.results.length+' words guessed');
  $("rescard").innerHTML='<h2>'+title+'</h2><div class="sub">'+sub+'</div>'+rows;
  transition("results");
  $("pillScore").textContent=g.score;
}
