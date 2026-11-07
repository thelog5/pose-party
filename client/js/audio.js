import { state } from "./state.js";

let audioCtx = null;

/* Short arpeggio of triangle-wave beeps. Silent when muted; never throws
   (autoplay policy can reject the context before the first user gesture). */
export function blip(freqs, dur=0.11){
  if(state.muted) return;
  try{
    audioCtx = audioCtx || new (window.AudioContext||window.webkitAudioContext)();
    const t = audioCtx.currentTime;
    freqs.forEach((f,i)=>{
      const o=audioCtx.createOscillator(), g=audioCtx.createGain();
      o.type="triangle"; o.frequency.value=f;
      g.gain.setValueAtTime(0.12, t+i*dur);
      g.gain.exponentialRampToValueAtTime(0.001, t+(i+1)*dur);
      o.connect(g); g.connect(audioCtx.destination);
      o.start(t+i*dur); o.stop(t+(i+1)*dur);
    });
  }catch(e){}
}
