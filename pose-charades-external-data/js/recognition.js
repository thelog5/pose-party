/* The recognition CHARGE METER.

   What this replaces
   ------------------
   Recognition used to be a straight readout: the bar was
   `smoothedConfidence / threshold`, and the word locked the moment that
   confidence sat over the line for one classifier tick. Two things fell out
   of that, and both of them were bad:

     · The kNN is decisive. A pose it knows goes 0 -> 0.9 inside two samples,
       so the bar snapped from empty to full in about a third of a second and
       the word was simply gone. There was no moment to play into.
     · Everything interesting happened in the first 400ms and nothing
       happened after, so a pose the model was unsure about never resolved at
       all — you just held it, watched a number sit at 61%, and lost the word.

   What it is now
   --------------
   Charge is EARNED OVER TIME while you hold the pose above a moving gate:

     · **You have to hold it.** Confidence above the gate accumulates charge;
       below the gate it drains. A flicker of 0.9 buys almost nothing.
     · **It gets harder near the top.** The rate falls as the meter fills, so
       the last stretch is the one you have to work for. Combined with the
       display curve below, the meter visibly sticks in the high nineties.
     · **It gets easier the longer you take.** The gate slides down and the
       rate climbs across the word clock. Early is strict and worth more
       points; late is forgiving, so a word the model is shaky on still
       resolves rather than timing out. This is the whole difficulty curve —
       the player feels themselves "getting through" to the AI.
     · **Progress ratchets.** Dropping below the gate cannot wipe you out; the
       meter drains to a floor under your best, so a wobble costs you a moment
       rather than the word.

   The number on screen is a LIE, deliberately
   -------------------------------------------
   `display` is a concave curve over the true charge, so the meter moves
   generously early and crawls at the top: 60% charge already reads as 76%,
   and the final quarter of the real work plays out between 94 and 99. It is
   capped BELOW 100 until the lock actually fires, because a bar that reads
   100 while nothing happens is the single most frustrating thing a meter can
   do. When the word locks it snaps to 100 and stays there.

   Nothing here talks to the network or scores anything. 1v1 and Party still
   send a timestamped claim the server validates; this only decides when the
   client believes it has one. */

/* Per-mode shape. Solo is the reference tuning; the two online modes charge
   faster because they are races and a word is shared by everyone. */
import { canRecognize } from "./poseInput.js";

export const CHARGE_PROFILES = Object.freeze({
  solo:  { gateFrom:.80, gateTo:.44, upMs:1250, downMs:620, lateBoost:1.00 },
  match: { gateFrom:.74, gateTo:.42, upMs:1050, downMs:560, lateBoost:1.10 },
  party: { gateFrom:.66, gateTo:.38, upMs: 900, downMs:520, lateBoost:1.20 },
});

/* How hard the top of the meter is: at full charge the rate is multiplied by
   (1 - TOP_DRAG), so the last stretch takes roughly twice as long as the
   first. This is what makes 97 -> 98 -> lock feel like effort. */
const TOP_DRAG = .48;
/* A marginal pose (just over the gate) still charges, at this fraction of
   full rate, so "barely recognised" is slow progress rather than none. */
const FLOOR_RATE = .34;
/* Draining can never take you below this fraction of your best charge. Some
   ratchet is essential — one wobble wiping the word is miserable — but too
   much and dropping the pose entirely leaves the bar sitting near full. */
const RATCHET = .25;
/* The meter is in two bands. Below the gate it shows APPROACH: how close the
   model is to even listening to you, capped here. That band is not earned and
   cannot lock, but it means the bar always answers what your body is doing.
   Everything above it is charge you held for. */
const APPROACH_MAX = .42;
/* The charged band's curve. < 1 is concave: generous early, sticky late — so
   the last tenth of the real work plays out between 96 and 99. */
const DISPLAY_GAMMA = .62;
/* Never show a full meter before the lock. A bar reading 100 while nothing
   happens is the single most frustrating thing a meter can do. */
const DISPLAY_CAP = .995;

const clamp01 = v => Math.max(0, Math.min(1, Number(v) || 0));

export function createChargeMeter(profileName = "solo"){
  const profile = CHARGE_PROFILES[profileName] || CHARGE_PROFILES.solo;
  return {
    profile,
    charge: 0,
    peak: 0,
    display: 0,
    gate: profile.gateFrom,
    locked: false,
    at: 0,
  };
}

export function resetChargeMeter(meter){
  if(!meter) return;
  meter.charge = 0;
  meter.peak = 0;
  meter.display = 0;
  meter.gate = meter.profile.gateFrom;
  meter.locked = false;
  meter.at = 0;
}

/* Every local mode checks the same live observation at display rate. A frozen
   camera or a rejected guess must stop charge even when inference stops too. */
export function advancePoseCharge(meter, confidence, elapsedFrac, input, label,
                                  now = performance.now()){
  if(meter.poseGeneration !== input?.generation){
    resetChargeMeter(meter);
    meter.poseGeneration = input?.generation;
  }
  return advanceCharge(meter, canRecognize(input, label, now) ? confidence : 0, elapsedFrac, now);
}

/* The gate the pose has to clear right now. Public because the HUD wants to
   show how close you are to being *listened to*, not just to locking. */
export function chargeGate(meter, elapsedFrac){
  const { gateFrom, gateTo } = meter.profile;
  /* Slightly eased so the first third of the word stays properly strict and
     the relaxation arrives when the player has started to struggle. */
  const t = Math.pow(clamp01(elapsedFrac), .78);
  return gateFrom + (gateTo - gateFrom) * t;
}

/* Advance the meter.
     confidence   smoothed model confidence for the TARGET word, 0..1
     elapsedFrac  how far through the word clock we are, 0..1
   Returns the meter for convenience. Time-based, so a 30Hz inference loop and
   a 120Hz display agree. */
export function advanceCharge(meter, confidence, elapsedFrac = 0,
                              now = performance.now()){
  if(!meter) return null;
  if(meter.locked){ meter.at = now; return meter; }

  const dt = meter.at ? Math.max(0, Math.min(120, now - meter.at)) : 16.7;
  meter.at = now;

  const conf = clamp01(confidence);
  const gate = chargeGate(meter, elapsedFrac);
  meter.gate = gate;

  if(conf >= gate){
    /* how convincingly you are over the line, 0 at the gate, 1 at certainty */
    const over = gate >= 1 ? 1 : clamp01((conf - gate) / (1 - gate));
    const drag = 1 - TOP_DRAG * meter.charge;      // the top is the hard part
    const late = 1 + meter.profile.lateBoost * clamp01(elapsedFrac);
    const rate = (FLOOR_RATE + (1 - FLOOR_RATE) * over) * drag * late;
    meter.charge = clamp01(meter.charge + dt * rate / meter.profile.upMs);
    meter.peak = Math.max(meter.peak, meter.charge);
  }else{
    /* Below the gate you bleed, but never past the ratchet under your best —
       one wobble should cost a moment, not the word. */
    const floor = meter.peak * RATCHET;
    meter.charge = Math.max(floor,
      meter.charge - dt / meter.profile.downMs);
  }

  /* Approach band while nothing has been earned yet, charged band after. The
     two meet exactly at APPROACH_MAX — crossing the gate is continuous. */
  const approach = (gate > 0 ? clamp01(conf / gate) : 1) * APPROACH_MAX;
  const charged = APPROACH_MAX +
    (1 - APPROACH_MAX) * Math.pow(meter.charge, DISPLAY_GAMMA);
  meter.display = Math.min(DISPLAY_CAP,
    meter.charge > 0 ? Math.max(approach, charged) : approach);

  if(meter.charge >= 1){
    meter.locked = true;
    meter.display = 1;
  }
  return meter;
}

/* The number the player is shown, 0..100. Rounds DOWN so it never reads 100
   before the lock, and never reads 0 once you are genuinely charging. */
export function chargePercent(meter){
  if(!meter) return 0;
  if(meter.locked) return 100;
  const value = Math.floor(meter.display * 100);
  return meter.display > 0 ? Math.max(1, Math.min(99, value)) : 0;
}
