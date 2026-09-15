/* Is this a slow computer? engine.js decides from how long each pose model
   call blocks the page. webrtc.js listens, so a slow computer both sends and
   receives lighter video. No DOM and no imports, so either side can use it
   without an import cycle. */

let slow = false;
const listeners = new Set();

export const isSlowComputer = () => slow;

export function setSlowComputer(on){
  on = !!on;
  if(on === slow) return;
  slow = on;
  for(const fn of listeners){ try{ fn(slow); }catch(e){ console.warn(e); } }
}

/* Returns the function that removes the listener. */
export function onSlowComputer(fn){
  listeners.add(fn);
  return () => listeners.delete(fn);
}
