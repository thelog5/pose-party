/* presence.js — "where is the player, and what are they doing", as one small
   smoothed signal.

   The pose landmarks are already computed every frame for the classifier; this
   turns the two or three of them that describe a *person* (rather than a pose)
   into something a character can be driven off — a head to look at, a distance,
   and how animated they currently are. Deliberately dependency-free so it can
   be imported from engine.js and from anything that draws, without an import
   cycle (same reason `robot.js` and `textFit.js` are).

   Three things a future reader will get wrong if they are not spelled out —
   the mirroring, the dt-independence, and the deadzone — so each has its own
   note below. */

/* ── SCREEN SPACE, NOT VIDEO SPACE ────────────────────────────────────────
   MediaPipe hands back landmarks in VIDEO space, but the camera is displayed
   MIRRORED everywhere in this game (see `mapVideoPoint()` in engine.js, which
   maps with `1-x`). A player raising their right hand sees it on the right of
   the screen, at video x≈0.25. Every x this module publishes is therefore
   already flipped to `1 - x`, once, at the point of measurement — so consumers
   never have to think about it. Publishing video space instead is the failure
   that makes a character look AWAY from the player, which reads worse than a
   character that does not track them at all. y needs no flip: nothing is
   mirrored vertically.
   Distances (the size span, the motion energy) are computed on the raw video
   coordinates on purpose: a reflection preserves lengths, so flipping first
   would be identical work for an identical number. */

/* ── TIME CONSTANTS ───────────────────────────────────────────────────────
   Each is a first-order low-pass time constant in ms: the time to cover ~63%
   of the remaining distance to the target. They are NOT per-frame lerp
   factors — see `alpha()`. Chosen by what each channel is for:
     position — a gaze target. Must arrive fast enough to feel attentive.
     scale    — how far away the player is. This genuinely changes slowly, and
                it modulates size on screen, so any speed here reads as
                breathing/pumping. Slowest by a wide margin.
     energy   — an excitement level. Fast enough to catch a burst of movement,
                slow enough that it does not strobe on one twitchy frame. */
const POS_TAU_MS    = 90;
const SCALE_TAU_MS  = 400;
const ENERGY_TAU_MS = 180;

/* Party caps vision work (`PARTY_VISION_MIN_MS`) and `loop()` returns early
   while `document.hidden`, so dt is irregular by design and can be *minutes*
   after a tab comes back. Clamped to roughly two slow frames: long enough that
   a 30 Hz party frame is still integrated honestly, short enough that
   returning to a tab does not apply one giant step. */
const DT_CLAMP_MS = 120;

/* Landmark visibility below this is noise pretending to be a body part. The
   thresholds match the ones engine.js already trusts for crown placement:
   slightly stricter for the single point we anchor on than for the pairs we
   only measure a width across. */
const MIN_VIS_HEAD = .4;
const MIN_VIS_SPAN = .35;

/* ── SIZE ─────────────────────────────────────────────────────────────────
   REFERENCE: a player standing at a normal "playing charades in a room"
   distance spans about 30% of the frame width shoulder to shoulder, and that
   is defined to be scale 0.5. So scale = shoulderWidth / (2 × 0.30): arm's
   length from the lens lands near 1, across the room near 0.2. */
const SHOULDER_REF = .30;
const SCALE_MAX = 1.5;
/* Ear span is the fallback when the shoulders are low-visibility (sitting at a
   desk, arms crossed over the chest, a tight crop). Head width is roughly a
   2.8th of shoulder width, so scale it up to an equivalent shoulder span
   rather than publishing a second, differently-calibrated number. */
const EAR_TO_SHOULDER = 2.8;
/* Last-resort head estimate when only the shoulders are usable: the head sits
   a bit over half a shoulder-width above the line between them. */
const HEAD_ABOVE_SHOULDERS = .55;
const SPAN_FLOOR = .06;

/* ── ENERGY ───────────────────────────────────────────────────────────────
   The points that actually express gesture. The torso barely moves while
   someone acts out a word; the hands and the head carry all of it. */
const ENERGY_POINTS = [0, 13, 14, 15, 16]; // nose, elbows, wrists
/* Speed is measured in SHOULDER-WIDTHS PER SECOND, so standing closer to the
   camera does not read as being more excited. The curve is
   `s / (s + ENERGY_HALF)`: exactly 0.5 at ENERGY_HALF, saturating toward 1 and
   never reaching it. One shoulder-width of hand travel per second is a normal
   conversational gesture, which is what puts ordinary gesturing mid-range;
   flailing runs 4-8× that and sits at .8-.9. */
const ENERGY_HALF = .9;
/* A landmark that jumps this far in one frame is the tracker re-locking onto a
   different body, not a human arm. Counting it would spike energy to 1 at the
   exact moment we know least. */
const MAX_STEP = .25;

/* ── DEADZONE / HYSTERESIS ────────────────────────────────────────────────
   A perfectly still player still wobbles ±0.5% of frame width, because the
   landmarker re-estimates from scratch every frame. Smoothing alone cannot fix
   it: a low-pass short enough to feel attentive passes that wobble straight
   through, and a low-pass long enough to kill it feels drugged. So the filter
   is *disengaged* while the target sits close to where we already are.

   Two radii, not one. A single threshold chatters on and off at exactly its
   own boundary, which is the jitter it was added to remove. We start following
   only once the target is DEAD_OUT away (1% of the frame — smaller than the
   width of a nose on screen, so engaging is never something you can see late),
   and stop following again only once we have closed to DEAD_IN. Between the
   two the previous decision stands.

   The cost is a bounded stutter for movement so slow that the filter's own lag
   stays under DEAD_IN — under ~4% of the frame per second — and the stutter is
   itself bounded by DEAD_OUT, i.e. 1%. That is the trade: jitter reads as a
   twitching robot, lag reads as a stoned one, and 1% of a frame reads as
   neither. */
const DEAD_OUT = .010;
const DEAD_IN  = .0035;

/* Coming back after this long is a REACQUISITION, not a movement. Gliding the
   smoothed head from where the last person stood to where this one is would
   drag a character's gaze across the screen for no reason, so we snap. */
const REACQUIRE_MS = 500;

let px = 0, py = 0;        // smoothed head position, SCREEN space
let pScale = 0;            // smoothed apparent size
let pEnergy = 0;           // smoothed 0..1 motion energy
let havePos = false;       // has a real measurement ever landed?
let following = false;     // deadzone latch (see above)
/* -1, not 0, because 0 is a perfectly legal `performance.now()` and a falsy
   "never set" sentinel here means the very first frames re-snap forever. */
let lastT = -1;
let lastGoodT = 0;
/* Time of the first frame we were ever asked about, so `lostMs` can answer
   "how long has there been nobody here" at boot too — before the camera has
   ever found a player, which is the same question with the same answer as
   after they walk away. Reporting 0 until the first acquisition would mean a
   consumer's `!seen && lostMs > 1500` branch is dead for the entire startup,
   which is exactly when a character has nothing else to react to. */
let firstT = -1;
let energyValid = false;   // is prevPts from the immediately preceding frame?

const prevPts = new Float64Array(ENERGY_POINTS.length * 2);
const prevOk = new Uint8Array(ENERGY_POINTS.length);

/* Measurement scratch, module-level so the hot path allocates nothing. */
let mX = 0, mY = 0, mSpan = 0;

/* The published object is reused every frame and returned by reference: this
   runs per video frame in three modes and a fresh literal per read is exactly
   the kind of garbage a 30 Hz loop does not need. Read it, don't retain it. */
/* ── FRAMING ──────────────────────────────────────────────────────────────
   "Too close" is not a distance, it is a CROP. The only question worth asking
   is whether enough of the player is in the picture for a pose to be readable
   at all, and the answer is: their head and their hips both have to be in it.
   Knees and ankles are NOT required. That is deliberate — plenty of people
   play in a room where their feet will never be in shot, and a warning they
   cannot act on is worse than no warning.

   Measured on the RAW landmark coordinates rather than on `visibility`,
   because MediaPipe extrapolates a landmark that has left the frame and marks
   it low-visibility for exactly that reason: gating on visibility would
   suppress the one signal we are looking for. An off-frame landmark reports a
   coordinate outside 0..1, and that is what this reads.

   The margin is generous on purpose. Hips at y = 1.0 are on the bottom edge
   and still technically visible, so nothing fires until they are a clear 3%
   past it. */
const CROP_MARGIN = .03;
/* Below this shoulder span the player is far enough away that a hip reading
   past the bottom edge is a tracker guess, not a person standing too close.
   SHOULDER_REF (.30) is normal playing distance, so this is well short of it
   and cannot fire on somebody across the room. */
const CROP_MIN_SPAN = .20;

const out = {
  x: 0, y: 0, scale: 0, energy: 0, seen: false, lostMs: 0, t: 0,
  /* raw, this-frame: head or hips outside the picture. Deliberately NOT
     debounced here — how long to wait before saying something, and how long to
     keep saying it, are presentation decisions and only the consumer knows
     them. Same reasoning as `seen`/`lostMs` above. */
  cropped: false,
};

/* Head above the top edge, or hips below the bottom one. */
function croppedNow(lm){
  if(mSpan < CROP_MIN_SPAN) return false;
  const nose = lm[0], hipL = lm[23], hipR = lm[24];
  if(Number.isFinite(nose?.y) && nose.y < -CROP_MARGIN) return true;
  if(!Number.isFinite(hipL?.y) || !Number.isFinite(hipR?.y)) return false;
  return (hipL.y + hipR.y) / 2 > 1 + CROP_MARGIN;
}

/* ── FRAME-RATE INDEPENDENCE ──────────────────────────────────────────────
   The one thing that must not be a fixed per-frame constant. `p += (target-p)
   * k` with a constant k converges at a rate that depends entirely on how
   often it is called, so the same smoothing is twice as fast at 60 fps as at
   30 — and Party runs at 30 while Solo runs at the camera rate, so a constant
   k means the robot is visibly snappier in one mode than another for no
   authored reason.
   `1 - exp(-dt/tau)` is the exact discrete solution of the continuous
   first-order filter, so ANY cadence — 16ms, 100ms, or a jittering mix —
   converges to the same place in the same wall-clock time. */
function alpha(dt, tau){
  return dt > 0 ? 1 - Math.exp(-dt / tau) : 0;
}

function usable(p, minVis){
  return !!p && Number.isFinite(p.x) && Number.isFinite(p.y) &&
    (p.visibility ?? 1) >= minVis;
}

/* Fills mX/mY (SCREEN space) and mSpan (video-space shoulder-equivalent
   width; 0 means "size unknown, keep the previous scale"). Returns false when
   nothing in the fallback chain is trustworthy. */
function measure(lm){
  const nose = lm[0], earL = lm[7], earR = lm[8], shL = lm[11], shR = lm[12];
  const earOk = usable(earL, MIN_VIS_SPAN) && usable(earR, MIN_VIS_SPAN);
  const shOk  = usable(shL,  MIN_VIS_SPAN) && usable(shR,  MIN_VIS_SPAN);

  mSpan = shOk ? Math.abs(shL.x - shR.x)
    : earOk ? Math.abs(earL.x - earR.x) * EAR_TO_SHOULDER
    : 0;

  /* nose → ears → shoulders, in descending order of how directly each one
     answers "where is their head". */
  let x, y;
  if(usable(nose, MIN_VIS_HEAD)){
    x = nose.x; y = nose.y;
  }else if(earOk){
    x = (earL.x + earR.x) / 2; y = (earL.y + earR.y) / 2;
  }else if(shOk){
    x = (shL.x + shR.x) / 2;
    /* the shoulder midpoint is the sternum, not the head — lift it by the
       body's own measured width so the estimate stays right at any distance */
    y = (shL.y + shR.y) / 2 - Math.max(mSpan, SPAN_FLOOR) * HEAD_ABOVE_SHOULDERS;
  }else return false;

  mX = 1 - x;                                    // ← the mirror. See the top.
  mY = y;
  if(mX < 0) mX = 0; else if(mX > 1) mX = 1;
  if(mY < 0) mY = 0; else if(mY > 1) mY = 1;
  return true;
}

/* Mean per-point speed over the gesture landmarks, in shoulder-widths/sec.
   Returns -1 when this frame cannot be compared against the previous one. */
function rawEnergy(lm, dt, span){
  let sum = 0, n = 0;
  const comparable = energyValid && dt > 0;
  for(let i = 0; i < ENERGY_POINTS.length; i++){
    const p = lm[ENERGY_POINTS[i]];
    const j = i * 2;
    if(!usable(p, MIN_VIS_SPAN)){ prevOk[i] = 0; continue; }
    if(comparable && prevOk[i]){
      const dx = p.x - prevPts[j], dy = p.y - prevPts[j + 1];
      const d = Math.sqrt(dx * dx + dy * dy);
      if(d < MAX_STEP){ sum += d; n++; }
    }
    prevPts[j] = p.x; prevPts[j + 1] = p.y; prevOk[i] = 1;
  }
  energyValid = true;
  if(!n) return -1;
  const speed = (sum / n) / (dt / 1000) / Math.max(span, SPAN_FLOOR);
  return speed / (speed + ENERGY_HALF);
}

/* Call once per video frame, INCLUDING frames with no landmarks — that is the
   only way `lostMs` can grow. */
export function notePresence(lm, now){
  const t = Number.isFinite(now) ? now : performance.now();
  const dt = lastT >= 0 ? Math.min(Math.max(t - lastT, 0), DT_CLAMP_MS) : 0;
  const gap = havePos ? t - lastGoodT : Infinity;
  lastT = t;
  if(firstT < 0) firstT = t;

  if(!lm || !measure(lm)){
    /* Hold position and scale exactly where they were: the player has not
       moved to (0,0), we simply stopped being able to see them, and snapping a
       character's gaze into the top-left corner on one dropped frame is a
       bigger lie than a stale reading. Energy is different — it is a claim
       about movement we can no longer observe, so it decays out. */
    energyValid = false;
    pEnergy += (0 - pEnergy) * alpha(dt, ENERGY_TAU_MS);
    out.seen = false;
    out.lostMs = Math.max(0, t - (havePos ? lastGoodT : firstT));
    out.energy = pEnergy;
    out.cropped = false;      // nobody in shot is not the same as badly framed
    out.t = t;
    return;
  }

  const reacquired = !havePos || gap > REACQUIRE_MS;
  const span = mSpan > 0 ? mSpan : null;
  const scaleTarget = span === null ? pScale
    : Math.min(SCALE_MAX, span / (2 * SHOULDER_REF));

  if(reacquired){
    px = mX; py = mY;
    pScale = scaleTarget;
    following = false;
    /* the jump back in is not motion, and the stored previous points are from
       whatever was on screen before the gap */
    energyValid = false;
    pEnergy = 0;
  }else{
    const dx = mX - px, dy = mY - py;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if(following){ if(dist < DEAD_IN) following = false; }
    else if(dist > DEAD_OUT) following = true;
    if(following){
      const a = alpha(dt, POS_TAU_MS);
      px += dx * a; py += dy * a;
    }
    pScale += (scaleTarget - pScale) * alpha(dt, SCALE_TAU_MS);
  }

  const e = rawEnergy(lm, dt, span === null ? pScale * 2 * SHOULDER_REF : span);
  if(e >= 0) pEnergy += (e - pEnergy) * alpha(dt, ENERGY_TAU_MS);

  havePos = true;
  lastGoodT = t;
  out.x = px; out.y = py;
  out.scale = pScale;
  out.energy = pEnergy;
  out.seen = true;
  out.lostMs = 0;
  out.cropped = croppedNow(lm);
  out.t = t;
}

/* Live view of the current signal — see the note on `out`.
   `seen` flips false on the FIRST frame without a usable body, with no grace
   period, because the grace a consumer wants depends on what it is driving: a
   gaze can coast for a second, a "come back!" prompt should wait several. Both
   are `p.seen || p.lostMs < yourGrace`, and only the consumer knows the
   number. */
export function presence(){ return out; }

/* Screen changes: the next body in front of the lens is a different framing,
   often a different person. Nothing in here is worth carrying across one. */
export function resetPresence(){
  out.cropped = false;
  px = py = pScale = pEnergy = 0;
  havePos = false;
  following = false;
  energyValid = false;
  lastT = -1;
  firstT = -1;
  lastGoodT = 0;
  prevOk.fill(0);
  out.x = out.y = out.scale = out.energy = 0;
  out.seen = false;
  out.lostMs = 0;
  out.t = 0;
}
