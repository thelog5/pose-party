/* Simulated opponent for 1v1. Its confidence in the true word ramps with the
   round clock plus a slow wobble, so it feels like it is "working it out".
   Lives apart from game.js so the guess UI can render it without a cycle. */

import { WORD_MS } from "./constants.js";
import { state } from "./state.js";

export function fakeRivalGuesses(){
  const { game, model } = state;
  if(!game || !game.word || !model) return [];
  const labels=model.labels.filter(l=>l!=="idle" && l!==game.word);
  const elapsed=Math.max(0, 1-((game.wordEnd-performance.now())/WORD_MS));
  const top=Math.min(.88, .34 + elapsed*.42 + (Math.sin(performance.now()/900)+1)*.035);
  const out=[[game.word, top]];
  for(const lab of labels.slice(0,3)) out.push([lab, Math.max(.08, top-(.22+out.length*.12))]);
  return out;
}
