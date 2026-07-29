/* Explicit finite game-state machine.

   The FSM owns *logic* state; screens.js maps it to visible chrome. This
   module is deliberately DOM-free so it can be unit-tested in Node.

   States:
     menu      — home screen, picking a mode
     party     — party-mode waiting room (teams); starting enters countdown
     training  — record/import/train panel
     lobby     — online 1v1: create/join a private room
     countdown — pre-game 3-2-1 (a game object exists, rounds not started)
     playing   — a word is live and can be scored; the ONLY state that
                 accepts score events, so it doubles as the scoring lock
     word-won  — a word just resolved (won/lost/skipped); celebration pause,
                 all scoring rejected until the next word goes live
     results   — final score card
*/

const TRANSITIONS = {
  "menu":      ["menu","training","lobby","countdown","party"],
  "party":     ["menu","training","party","lobby","countdown"],
  "training":  ["menu","training","countdown"],
  "lobby":     ["menu","training","countdown","lobby","party"],
  "countdown": ["playing","menu","training","results"],
  "playing":   ["word-won","results","menu","training"],
  "word-won":  ["playing","results","menu","training"],
  "results":   ["menu","training","lobby","countdown","results"],
};

let current = "menu";
const listeners = [];

export const gameState = () => current;

/* fn(to, from, payload) — fires after the state has changed. */
export function onTransition(fn){ listeners.push(fn); }

/* Returns false (and changes nothing) on an illegal move, so callers can
   guard side effects with `if(!transition(...)) return;`. */
export function transition(to, payload={}){
  if(!TRANSITIONS[to]){
    console.error(`fsm: unknown state "${to}"`);
    return false;
  }
  if(!TRANSITIONS[current].includes(to)){
    console.error(`fsm: illegal transition ${current} -> ${to}`);
    return false;
  }
  const from = current;
  current = to;
  for(const fn of listeners) fn(to, from, payload);
  return true;
}

/* Test hook: reset without notifying listeners. */
export function _reset(state="menu"){ current = state; }
