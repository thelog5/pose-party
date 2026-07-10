/* Round loop for both modes.
   "ai": you score when the AI holds the right guess above THRESH.
   "vs": same word, but the simulated rival races you to it. */

import { $, esc } from "./dom.js";
import { state } from "./state.js";
import { CATEGORIES, ROUNDS, WORD_MS, THRESH, RIVAL_THRESH, HOLD_MS,
         PTS_CORRECT, PTS_PER_SEC, PTS_SKIP } from "./constants.js";
import { toast, flash, pointBurst, renderGuesses, topGuesses } from "./ui.js";
import { blip } from "./audio.js";
import { setScreen } from "./screens.js";
import { fakeRivalGuesses } from "./rival.js";

function shuffledDeck(){
  const words=state.model.labels.filter(l=>l!=="idle");
  for(let i=words.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [words[i],words[j]]=[words[j],words[i]]; }
  return words;
}

export function startGame(mode="ai"){
  state.lastMode=mode;
  if(!state.model || state.model.labels.filter(l=>l!=="idle").length<1){
    toast("Train the AI first — record idle plus at least one action word. Tap the gear.");
    setScreen("train"); return;
  }
  setScreen(mode==="vs" ? "versus" : "play");
  state.game={ mode, deck:shuffledDeck(), word:null, round:0, wordEnd:0,
               holdSince:0, score:0, rivalScore:0, results:[], bestWrong:{} };
  $("pillScore").textContent="0";
  $("pillRivalScore").textContent="0";
  if($("bub1")) $("bub1").textContent="I’m guessing…";
  nextWord();
  state.game.timer=setInterval(gameTick,100);
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
  game.holdSince=0; game.bestWrong={}; game.wordLocked=false;
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

/* winner: "you" | "rival" | "miss". wordLocked keeps the loops from
   double-scoring during the pause before the next word. */
function finishWord(winner, opts={}){
  const game=state.game;
  if(!game || game.wordLocked) return;
  game.wordLocked=true;
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
    if(!state.game || !state.game.wordLocked) return;
    if($("bub1")) $("bub1").textContent="I’m guessing…";
    nextWord();
  }, 1050);
}

/* Called from the classifier whenever fresh guesses land. */
export function gameCheck(){
  const game=state.game;
  if(!game || game.wordLocked) return;
  const t=topGuesses(1)[0]; if(!t) return;
  const [topLab, topP]=t;

  if(topLab && topLab!==game.word && topLab!=="idle"){
    if((game.bestWrong.p||0)<topP) game.bestWrong={lab:topLab, p:topP};
  }

  if(topLab===game.word && topP>=THRESH){
    if(!game.holdSince) game.holdSince=performance.now();
    if(performance.now()-game.holdSince>=HOLD_MS) finishWord("you", {confidence:topP});
  } else {
    game.holdSince=0;
  }
}

function gameTick(){
  const game=state.game;
  if(!game) return;
  const now=performance.now();
  const wLeft=Math.max(0,game.wordEnd-now);
  const txt="0:"+String(Math.ceil(wLeft/1000)).padStart(2,"0");
  $("pillTime").textContent=txt;
  if($("autoskipTxtVs")) $("autoskipTxtVs").textContent=txt;

  if(game.mode==="vs"){
    const rtop=fakeRivalGuesses();
    if(!game.wordLocked && rtop[0] && rtop[0][0]===game.word && rtop[0][1]>=RIVAL_THRESH){
      finishWord("rival", {confidence:rtop[0][1]});
      renderGuesses();
      return;
    }
    renderGuesses();
  }

  if(wLeft<=0 && !game.wordLocked) missWord(false);
}

export function missWord(isSkip){
  const game=state.game;
  if(!game || game.wordLocked) return;
  if(isSkip){
    game.score=Math.max(0,game.score-PTS_SKIP);
    $("pillScore").textContent=game.score;
  }
  finishWord("miss", {skip:isSkip});
}

export function endGame(){
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
  setScreen("results");
  $("pillScore").textContent=g.score;
}
