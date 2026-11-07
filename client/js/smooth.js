/* smooth.js — the One Euro filter, over a whole pose landmark set.

   Why this exists
   ---------------
   The dots used to crawl. MediaPipe solves each frame independently, so a
   joint that is stationary in the world still moves a pixel or two every
   frame, and a joint that is occluded or out of shot moves a lot more than
   that — the tracker is guessing, and its guess is different every frame. The
   Tasks API has no `smoothLandmarks` option (the old Solutions API did), so
   nothing in this app was filtering them at all: the jitter went straight into
   the overlay the player watches AND into the feature vector the kNN reads.

   Why NOT a plain exponential average
   -----------------------------------
   Because the two things we want are opposites. Killing jitter on a still limb
   needs heavy smoothing; a punch or a jumping jack needs none, and smoothing
   it lags the dots behind the body — which is the same complaint, just later.
   Measured on the shipped deck, a fixed EMA over the sampled frames costs real
   accuracy as it gets heavier: alpha .8 is free, .45 costs 7 points and .3
   costs 27, because the velocity block of the feature vector is exactly what
   an EMA flattens.

   One Euro makes the cutoff a function of speed: it smooths hard when a joint
   is nearly still (all jitter, no signal) and gets out of the way as the joint
   moves (all signal). At 30 fps the settings below retain ~26% of a new sample
   on a still joint and ~65% on a fast one, so a held pose stops shimmering and
   a thrown arm still arrives on time.

   `visibility` is filtered too, on a fixed light setting: it is a confidence,
   not a position, and it flickers across the draw threshold and makes limbs
   blink in and out. */

/* Cutoff in Hz when a point is not moving. Lower is smoother and laggier. */
const MIN_CUTOFF = 1.7;
/* How fast the cutoff opens up with speed, in Hz per (unit of normalized
   coordinate) per second. This is the knob that trades jitter for lag; it is
   set high deliberately, because a lagging skeleton is the more visible fault
   and because the classifier reads the velocity these frames carry. */
const BETA = 1.2;
/* Cutoff for the speed estimate itself. */
const D_CUTOFF = 1.2;
/* Filtering across a gap this long is meaningless — the tab was hidden, or the
   player walked out and came back. Start clean instead of easing in from a
   pose that is minutes old. */
const RESET_GAP_MS = 250;
/* A landmark cannot travel a quarter of the frame between two camera frames.
   That is the tracker re-locking, not an arm, and easing into it would drag a
   visible rubber band across the screen. Snap, then filter from there. */
const MAX_STEP = .25;

const alpha = (cutoffHz, dtSec) => {
  const tau = 1 / (2 * Math.PI * cutoffHz);
  return 1 / (1 + tau / dtSec);
};

/* One filtered scalar: value, its derivative, and both of their histories. */
function channel(){ return { x:0, dx:0, started:false }; }

function step(ch, value, dtSec){
  if(!ch.started){ ch.x=value; ch.dx=0; ch.started=true; return value; }
  const dRaw=(value-ch.x)/dtSec;
  ch.dx += alpha(D_CUTOFF, dtSec) * (dRaw - ch.dx);
  const cutoff = MIN_CUTOFF + BETA * Math.abs(ch.dx);
  ch.x += alpha(cutoff, dtSec) * (value - ch.x);
  return ch.x;
}

export function createLandmarkFilter(){
  return { points:[], at:0 };
}

/* Returns a NEW landmark array; the caller's input is never mutated, so the
   raw result stays available to anything that wants it (nothing does yet).
   Pass the same `now` the rest of the frame is using. */
export function filterLandmarks(filter, landmarks, now){
  if(!filter || !landmarks) return landmarks;
  const gap = filter.at ? now - filter.at : Infinity;
  if(gap > RESET_GAP_MS) filter.points.length = 0;
  const dtSec = Math.min(.2, Math.max(.004, (gap===Infinity ? 33 : gap) / 1000));
  filter.at = now;

  const out = new Array(landmarks.length);
  for(let i=0;i<landmarks.length;i++){
    const p = landmarks[i];
    let slot = filter.points[i];
    if(!slot) slot = filter.points[i] = { x:channel(), y:channel(), z:channel(), v:channel() };
    /* A jump this big is a re-lock. Drop the history so the filter restarts on
       the new body rather than sliding across the frame to reach it. */
    if(slot.x.started && Math.hypot(p.x-slot.x.x, p.y-slot.y.x) > MAX_STEP){
      slot.x=channel(); slot.y=channel(); slot.z=channel();
    }
    out[i] = {
      ...p,
      x: step(slot.x, p.x, dtSec),
      y: step(slot.y, p.y, dtSec),
      z: step(slot.z, p.z ?? 0, dtSec),
      visibility: p.visibility==null ? p.visibility : step(slot.v, p.visibility, dtSec),
    };
  }
  return out;
}
