/* THE ROBOT — the other player at the table.

   He used to be `sp-robot.png`: one bust, one expression, parked over the top
   guess card in all three modes, never moving for the length of a match. That
   is a decoration, not a character — and the screen that most needs a
   character is the one where you are posing at a camera with nobody watching.

   Figma's "RObot Sprites" section (286:599) ships him as a RIG rather than a
   picture: eight full bodies, each with a blank screen for a head, and eight
   faces drawn to composite into that screen. The bodies were exported through
   ONE shared crop box (see the note in CLAUDE.md), so they are in register
   with each other and the face is a single rectangle over the head — with a
   nudge for the only two poses that move it, `present` (leans right) and
   `sad` (slumps down). That is why one CSS rule dresses all eight.

   What he does
   ------------
   · He READS THE METER. The same charge that drives the word bar drives his
     pose — idle → squinting → calling it out → leaning in — plus a scale, a
     glow and a bob speed that climb with it. "Am I getting through to it" is
     answerable off his body, without reading a number.
   · He TALKS on the beats that matter: crossing a band, a recognition, a
     miss, a streak. One line at a time, never the same line twice running,
     through the Figma paper speech bubble. Only the LOCAL robot talks —
     two of them chattering across a split screen is noise, so the rival and
     foe rigs carry `data-mute` and react in body only.
   · He SLAMS when you get it. The celebrate pose punches in at ~1.5x with the
     glow behind him and wobbles like a sticker before settling. That is the
     "you did it" moment; the points paper no longer has to carry it alone
     from the middle of the screen.
   · He WATCHES YOU. This is the one thing this game can do that a mascot on
     any other web page cannot: the player's own body is already being tracked
     33 points at a time, every frame, to run the classifier. presence.js
     turns that into where you are, how close you are and how much you are
     moving, and the life loop below points him at it. Attention is what reads
     as consciousness — more than any pose, any line, any glow — and when you
     walk out of frame he notices, looks where you were, and goes looking.

   WHY THE LIFE LOOP IS HERE AND NOT IN CSS
   ----------------------------------------
   He used to be: eight sprites, a symmetric sine bob, and one float. A sine
   is the universal signature of a cheap sprite — nothing alive moves at a
   constant rate on one axis — and one input can only ever produce one
   behaviour, however many sprites you hang off it. So the continuous motion
   moved here, where it can be asymmetric, where the face can lag the body by
   a beat (overlapping action: the difference between a rigid object and
   something with weight), and where it can be driven by more than the meter.

   CSS keeps what CSS is better at: the slam, the swap squash, the bubble pop
   — short, fixed, authored beats. JS owns what has to respond: breath, gaze,
   lean, blink.

   Nothing here is authoritative. Every mode already owns its own recognition,
   scoring and network state; this only reflects it. */

/* Deliberately dependency-free: gameplayFeedback.js is where every mode
   signals recognition, so it calls INTO this module. Importing anything back
   out of it would close a cycle around the one primitive all three modes
   share. The reduced-motion check is two lines; the import was not worth it. */
import { ROBOT_DIALOGUE } from "./robotDialogue.js";
import { fitWrappedTextToBox } from "./textFit.js";
import { presence, resetPresence } from "./presence.js";

const reducedMotion = () => typeof matchMedia === "function" &&
  matchMedia("(prefers-reduced-motion: reduce)").matches;

const ART = "assets/ui/rig/";

/* ================= THE SKELETON =================
   Straight out of the pack's rig.json, converted from its 1024px canvas into
   FRACTIONS of the shared canvas, because everything downstream is expressed
   in percentages of that box and so survives any viewport.

   `parent` is the real thing this buys us. A hand is parented to a forearm is
   parented to an upper arm is parented to the torso, so lifting one shoulder
   carries the whole arm — which is the entire difference between a puppet and
   a pile of stickers that each have to be keyframed in agreement. */
const P = 1 / 1024;
const JOINTS = Object.freeze({
  torso: { px: 512 * P, py: 675 * P, parent: null },
  head:  { px: 512 * P, py: 526 * P, parent: "torso" },
  /* character-left is the VIEWER'S RIGHT — the pack is explicit about this and
     it is the easiest thing in here to get backwards. */
  uarmL: { px: 675 * P, py: 584 * P, parent: "torso" },
  farmL: { px: 678 * P, py: 660 * P, parent: "uarmL" },
  handL: { px: 677 * P, py: 776 * P, parent: "farmL" },
  uarmR: { px: 349 * P, py: 584 * P, parent: "torso" },
  farmR: { px: 346 * P, py: 660 * P, parent: "uarmR" },
  handR: { px: 347 * P, py: 776 * P, parent: "farmR" },
  legL:  { px: 571 * P, py: 762 * P, parent: "torso" },
  legR:  { px: 453 * P, py: 762 * P, parent: "torso" },
});
/* Root-first, so a chain can be folded in one pass with no recursion. */
const CHAIN = Object.freeze(Object.fromEntries(Object.keys(JOINTS).map(k => {
  const out = [];
  for(let j = k; j; j = JOINTS[j].parent) out.unshift(j);
  return [k, Object.freeze(out)];
})));

/* The mouth's rest centre on the canvas — where the speech tail is aimed. */
const MOUTH = Object.freeze({ x: 511.5 * P, y: 400 * P });

/* mood -> eye state, mouth shape, and a POSE: the angle every joint wants, in
   degrees. `arm` is written as a RAISE, positive = outward and up, and the
   sign is flipped per side when it is applied — otherwise every pose has to be
   authored twice and the two drift apart the first time one is edited.

   Nothing here is a keyframe. The rig springs toward these, so a mood change
   is a move rather than a cut, and two moods blend if they land close
   together. That is what the eight baked sprites could never do.

   THE LIMITS BELOW ARE MEASURED, AND THEY ARE TIGHTER THAN THE PACK CLAIMS.
   · SHOULDER: only 17% of the upper arm is tucked behind the torso at rest and
     0.2% at a 66-degree raise, so the README's "these overlaps prevent gaps
     during rotation" does not hold. A connectivity check passes the whole way
     — the pieces still touch — which is exactly why it is the wrong check: the
     failure is the arm becoming a separate capsule with its own closed
     outline lying against the body. `socket()` slides it back into the joint
     as it turns, which buys the range back; raises are still kept under ~60.
   · ELBOW: it can only bend OUTWARD, because the forearm is drawn behind the
     torso and an inward bend simply swallows the arm. Outward past ~30 reads
     as hyperextension. So bends live in 0..26, never negative.
   · WRIST: the blue cuff covers it cleanly past 60 — the one join the art
     genuinely handles — so the hands are free, and they are what stop a
     raised arm ending in a flat plank. */
const MOODS = Object.freeze({
  idle:  { name:"idle",      eyes:"open",    mouth:"smile",  pose:{ uaL:0,  faL:0,  haL:0,   uaR:0,  faR:0,  haR:0,   head:0,  torso:0 } },
  watch: { name:"thinking",  eyes:"open",    mouth:"M_BP",   pose:{ uaL:6,  faL:14, haL:-6,  uaR:22, faR:26, haR:-10, head:-5, torso:-1 } },
  read:  { name:"present",   eyes:"open",    mouth:"A_AH",   pose:{ uaL:20, faL:16, haL:10,  uaR:18, faR:14, haR:8,   head:3,  torso:1 } },
  close: { name:"surprised", eyes:"open",    mouth:"O_OH",   pose:{ uaL:34, faL:20, haL:14,  uaR:32, faR:18, haR:12,  head:5,  torso:2 } },
  got:   { name:"celebrate", eyes:"happy",   mouth:"A_AH",   pose:{ uaL:58, faL:22, haL:22,  uaR:58, faR:22, haR:22,  head:0,  torso:0 } },
  proud: { name:"thumbsup",  eyes:"happy",   mouth:"smile",  pose:{ uaL:48, faL:26, haL:18,  uaR:12, faR:8,  haR:4,   head:-3, torso:0 } },
  lost:  { name:"shrug",     eyes:"worried", mouth:"E_EE",   pose:{ uaL:30, faL:18, haL:-12, uaR:30, faR:18, haR:-12, head:6,  torso:0 } },
  down:  { name:"sad",       eyes:"worried", mouth:"FV",     pose:{ uaL:-4, faL:4,  haL:-4,  uaR:-4, faR:4,  haR:-4,  head:13, torso:3 } },
  /* idle-only: he stays put and only the face moves, which is what keeps a
     still pose from reading as a frozen sprite */
  peek:  { name:"peek",      eyes:"happy",   mouth:"smile",  pose:{ uaL:2,  faL:2,  haL:2,   uaR:4,  faR:3,  haR:2,   head:-4, torso:0 } },
});

const REST = MOODS.idle.pose;

/* Where the meter puts him, highest band first. These read the meter's
   DISPLAY value (recognition.js), so .42 is exactly APPROACH_MAX — the line
   where the AI stops merely approaching and starts banking charge. His face
   crossing from squinting to speaking on the same number is the point: the
   character and the bar can never disagree about how you are doing. */
const BANDS = Object.freeze([
  [.74, "close"],
  [.42, "read"],
  [.08, "watch"],
  [0,   "idle"],
]);

/* What he does with his hands when nothing is happening. Weighted hard to
   THINKING — he is a robot working out what your body is doing, and that is
   the pose that says so. Without this loop he stood perfectly still until the
   meter moved, which read as a sprite waiting for input rather than someone
   watching you: all his life was in the half-second before a catch. */
const IDLE_BEATS = Object.freeze([
  "watch", "watch", "read", "watch", "peek", "watch", "lost", "idle",
]);
const IDLE_GAP_MS  = [2200, 3900];   // rest between beats
const IDLE_HOLD_MS = [1200, 2000];   // how long one beat is held
/* If no mode has fed him for this long, nobody is looking at his screen and
   the loop stops itself rather than swapping sprites into the void. */
const IDLE_STALE_MS = 2000;

const SLAM_MS  = 1450;   // the celebrate beat, matched to the CSS keyframe
const PROUD_MS =  900;   // ...then a thumbs-up before he goes back to work
const MISS_MS  = 1250;
const LINE_MS  = 1700;   // how long one bubble stays up
const NUDGE_MS = 8500;   // silence before he pokes you

const robots = new Map();
let preloaded = false;

/* Every layer, warmed once. A mood change swaps the eye and mouth art, and
   the first use of each would otherwise pop a frame late — most visibly on
   the recognition slam, which is the one beat that has to be instant. */
function preload(){
  if(preloaded || typeof Image !== "function") return;
  preloaded = true;
  const want = new Set();
  for(const m of Object.values(MOODS)){
    want.add(EYE_FILE(m.eyes, "left"));
    want.add(EYE_FILE(m.eyes, "right"));
    want.add(MOUTH_FILE(m.mouth));
  }
  /* every viseme, not just the resting shapes — they are what he speaks with */
  for(const v of ["A_AH", "E_EE", "O_OH", "M_BP", "FV"]) want.add(MOUTH_FILE(v));
  want.add(EYE_FILE("blink", "left"));
  want.add(EYE_FILE("blink", "right"));
  for(const f of want) new Image().src = ART + f;
}
const EYE_FILE = (state, side) => state + "_" + side + ".png";
const MOUTH_FILE = shape =>
  shape === "smile" ? "smile.png" : "phoneme_" + shape + ".png";

function get(id){
  const cached = robots.get(id);
  if(cached?.node.isConnected) return cached;
  const node = document.getElementById(id);
  if(!node) return null;
  preload();
  const r = {
    node,
    rig:    node.querySelector(".rb-rig"),
    /* every .rp keyed by the joint it hangs off, so the render loop can walk
       the parts without touching the DOM again */
    parts:  [...node.querySelectorAll(".rp")].map(el => ({ el, j: el.dataset.j })),
    eyeL:   node.querySelector(".rb-eye-l"),
    eyeR:   node.querySelector(".rb-eye-r"),
    mouth:  node.querySelector(".rb-mouth"),
    bubble: node.querySelector(".rb-bubble"),
    line:   node.querySelector(".rb-bubble b"),
    /* `data-mute` marks a rig that stands for a player whose camera we do NOT
       own — 1v1's rival, Party's foe. It means two things, and they are the
       same fact: he has no bubble (two robots talking across a split screen
       is noise), and he cannot watch anyone, because no landmarks for that
       player ever cross the wire. He still breathes and blinks. */
    mute:   node.hasAttribute("data-mute"),
    mood:   null,
    band:   null,
    hype:   -1,
    run:    0,           // words got in a row, HIS count — see robotGot
    holdUntil: 0,
    lineUntil: 0,
    lastLine: "",
    /* NOT 0. `now - lastSaidAt > NUDGE_MS` is true against zero on the second
       frame a rig exists, so a rig that has just been registered arrived
       already overdue to speak. Solo hid this because resetSoloBoard() reaches
       resetRobot(); 1v1 and Party never reset a rig on the way IN —
       clearCelebrations() only runs on the way out, and it iterates a map that
       is still empty for a rig nobody has charged yet. */
    lastSaidAt: performance.now(),
    moodTimer: 0,
    slamTimer: 0,
    bubbleTimer: 0,
    idleTimer: 0,
    swapTimer: 0,
    beat: 0,
    lastChargeAt: 0,
    ...lifeState(),
  };
  robots.set(id, r);
  setMood(r, "idle");
  setHype(r, 0);
  wake();
  return r;
}

function bandFor(display){
  for(const [at, name] of BANDS) if(display >= at) return name;
  return "idle";
}

function bandRank(name){
  const i = BANDS.findIndex(b => b[1] === name);
  return i < 0 ? -1 : BANDS.length - i;
}

function setMood(r, mood){
  if(!r || r.mood === mood) return;
  const m = MOODS[mood] || MOODS.idle;
  r.mood = mood;
  /* The DESCRIPTIVE name, not the internal band name — this is what CSS and
     the E2E suites read as "what is he doing", and `celebrate` says more than
     `got` to anyone debugging. Nothing about his body is keyed off it any
     more: the pose is a set of joint angles the rig springs toward, so a mood
     change is a movement rather than one picture cutting to another. */
  r.node.dataset.pose = m.name;
  r.want = m.pose;
  /* Blink art wins over the mood's eyes while a blink is running, so a mood
     that lands mid-blink does not snap his eyes back open. */
  r.eyeState = m.eyes;
  if(!r.blinking) dressEyes(r, m.eyes);
  /* Keep stepMouth's write-guard in step. Setting src without updating
     mouthSrc left the guard believing the old shape was still on screen, so
     the next frame skipped its write and a mood change mid-line flipped his
     mouth to the resting shape until the viseme track happened to move. */
  r.restMouth = m.mouth;
  if(r.mouth && !r.viseme){
    r.mouthSrc = ART + MOUTH_FILE(m.mouth);
    r.mouth.src = r.mouthSrc;
  }
}

function dressEyes(r, state){
  if(r.eyeL) r.eyeL.src = ART + EYE_FILE(state, "left");
  if(r.eyeR) r.eyeR.src = ART + EYE_FILE(state, "right");
}

/* One number drives his scale, his glow and how fast he bobs. Quantised so a
   60Hz frame loop is not writing three custom properties every tick. */
function setHype(r, value){
  const h = Math.round(Math.max(0, Math.min(1, Number(value) || 0)) * 50) / 50;
  if(h === r.hype) return;
  r.hype = h;
  const style = r.node.style;
  style.setProperty("--rb-hype", h.toFixed(2));
  style.setProperty("--rb-scale", (1 + .1 * h).toFixed(3));
  style.setProperty("--rb-bob", Math.round(2600 - 1750 * h) + "ms");
}

function say(r, poolName, force = false){
  if(!r || r.mute || !r.line || !r.bubble) return;
  const now = performance.now();
  if(!force && now < r.lineUntil) return;      // one line at a time
  const pool = ROBOT_DIALOGUE[poolName];
  if(!pool?.length) return;

  let text = pool[(Math.random() * pool.length) | 0];
  /* never the same line twice running — the fastest way to make a character
     read as a script instead of a reaction */
  if(pool.length > 1 && text === r.lastLine)
    text = pool[(pool.indexOf(text) + 1) % pool.length];

  r.lastLine = text;
  r.lastSaidAt = now;
  r.lineUntil = now + LINE_MS;
  r.line.textContent = text;
  /* AND HE MOUTHS IT. The pack ships five visemes, so the line above can
     actually run through his face instead of text appearing over a robot
     holding one expression. Built from the real characters, so the rhythm
     belongs to the sentence. */
  r.viseme = speakTrack(text);
  r.visemeAt = now;
  /* Fit synchronously before `.show` reveals the paper. The shared observer
     repeats this after fonts/viewport changes, but waiting for its next frame
     here would expose one overflowing frame whenever dialogue changes. */
  fitWrappedTextToBox(r.line);
  r.bubble.classList.remove("show");
  void r.bubble.offsetWidth;
  r.bubble.classList.add("show");
  clearTimeout(r.bubbleTimer);
  r.bubbleTimer = setTimeout(() => r.bubble.classList.remove("show"), LINE_MS);
}

function hush(r){
  clearTimeout(r.bubbleTimer);
  r.bubbleTimer = 0;
  r.lineUntil = 0;
  r.viseme = null;          // ...and shut his mouth with the paper
  r.bubble?.classList.remove("show");
}

/* Take him off the meter for a beat — a recognition or a miss owns his body
   until it is done, however the charge moves underneath. */
function hold(r, mood, ms){
  clearTimeout(r.moodTimer);
  r.moodTimer = 0;
  stopIdle(r);
  r.holdUntil = performance.now() + ms;
  r.band = null;
  setMood(r, mood);
}

const rand = (lo, hi) => lo + Math.random() * (hi - lo);

function stopIdle(r){
  clearTimeout(r.idleTimer);
  r.idleTimer = 0;
}

/* The idle loop: every couple of seconds he plays one short beat — a pose and
   a face — then drops back to whatever band he is actually in. It never runs
   over a payoff (`holdUntil`) or over a band he has genuinely climbed into,
   and it reschedules rather than stopping in those cases, so it resumes the
   moment he is idle again. Under reduced motion it still runs: swapping a
   pose is not motion, and a character who never changes is the thing this is
   here to fix. */
function scheduleIdle(r){
  stopIdle(r);
  r.idleTimer = setTimeout(() => {
    r.idleTimer = 0;
    if(performance.now() - r.lastChargeAt > IDLE_STALE_MS) return;
    if(performance.now() < r.holdUntil || bandRank(r.band) > bandRank("watch")){
      scheduleIdle(r);
      return;
    }
    r.beat = (r.beat + 1) % IDLE_BEATS.length;
    setMood(r, IDLE_BEATS[r.beat]);
    r.idleTimer = setTimeout(() => {
      r.idleTimer = 0;
      if(performance.now() >= r.holdUntil) setMood(r, r.band || "idle");
      scheduleIdle(r);
    }, rand(IDLE_HOLD_MS[0], IDLE_HOLD_MS[1]));
  }, rand(IDLE_GAP_MS[0], IDLE_GAP_MS[1]));
}

function slam(r){
  if(!r.rig || reducedMotion()) return;
  r.rig.classList.remove("slam");
  void r.rig.offsetWidth;
  r.rig.classList.add("slam");
  clearTimeout(r.slamTimer);
  r.slamTimer = setTimeout(() => r.rig.classList.remove("slam"), SLAM_MS);
}

/* ================= THE LIFE LOOP =================
   One rAF for every rig on the board. It writes eight custom properties per
   rig and nothing else; all the geometry is percentages of his own box, so
   none of it needs to know the viewport.

   It stops itself. Nothing here is worth a frame of work on a screen nobody
   is looking at, so it exits when the tab is hidden and when no mode has fed
   a rig for IDLE_STALE_MS — the same dead-man switch the idle beats use. */

/* How far he leans, looks and breathes. All small on purpose: he is about
   176px tall in Solo and less in Party, and at that size the legible signals
   are the tilt and the lean, with the eye offset as fine detail on top. Push
   these and he stops being a robot watching you and starts being a bobblehead. */
const BREATH_AMP   = 1.9;    // % of his own height, the rise of one breath
const BREATH_TILT  = 1.15;   // deg, the roll that goes with it
const FACE_LAG_MS  = 85;     // the face trails the body — overlapping action
const GAZE_MIN_REACH = .30;  // floor for a rig standing on the stage edge
const GAZE_EYE_X   = 3.6;    // the EXTRA the eyes take over the mouth: this
const GAZE_EYE_Y   = 2.4;    // difference is the whole parallax effect
const LEAN_X       = 1.5;    // % of his box
const TILT_X       = 2.4;    // deg
const NEAR_PUSH    = 1.6;    // % he gives way when you crowd the camera
/* Time constants, in ms, for the exponential smoothers. Eyes lead and the
   body follows — that asymmetry is what makes a look read as intent rather
   than as a slider being dragged. */
const TAU_GAZE = 80;
const TAU_LEAN = 300;
const TAU_NEAR = 500;
const TAU_AMP  = 220;   // how fast the breath grows in and out of a held beat
/* Limbs are heavy. Slower than the gaze on purpose: the eyes get there first
   and the arms catch up, which is the same lead-and-follow that makes the
   look read as intent rather than as a slider being dragged. */
const TAU_POSE = 190;

/* HOW HARD THE NECK WORKS. His head is a real joint now, so a look can be a
   head turn instead of the whole body leaning — which is all the sprite rig
   could ever do, because head and torso were one picture. HEAD_COUNTER keeps
   his face upright through the torso's breath roll; without it he nods along
   with his own chest, which reads as a bobblehead. */
const HEAD_TURN    = 7;    // deg at full gaze
const HEAD_NOD     = 4;
const HEAD_COUNTER = .55;  // of the torso's roll, cancelled at the neck
const FACE_LAG_TILT = 2.2; // the head arrives a beat after the chest
const LEG_SHIFT    = .35;  // a hint of weight transfer, not a walk cycle

/* Where the shared 640 canvas sits inside .grobot's box — see screens.css.
   Kept here as well because the speech tail is aimed through it. */
const CANVAS_X = -.1366, CANVAS_Y = -.0569, CANVAS_S = 1.0801;
const GROBOT_AR = 520 / 610;

const BLINK_GAP_MS  = [2600, 6400];
/* 130ms rather than 105: Party's frame budget only samples a blink three or
   four times, and on a stuttering frame the shorter version renders as one
   hard flicker instead of an eyelid. */
const BLINK_MS      = 130;
const DOUBLE_BLINK  = .16;
/* Blinking through a celebration reads as a glitch, and half these faces have
   their eyes shut or squeezed already. */
const NO_BLINK = new Set(["got", "proud", "close", "down"]);

const SEARCH_RATE = .00154;     // radians per ms — one sweep of the room ≈ 4.1s
const SEARCH_AFTER_MS = 900;    // gone this long and his eyes start hunting
const MISSING_AFTER_MS = 2600;  // ...this long and he says something about it
/* Above this, the player is plainly working and the AI simply is not getting
   it — which is his problem to own, not theirs. */
const STRUGGLE_ENERGY = .28;

let lifeRaf = 0;
let lifeLastT = 0;

function lifeState(){
  return {
    breath: Math.random(),          // cycles; desyncs the two rigs on a board
    amp: 0,                         // the breath grows in rather than cutting in
    gx: 0, gy: 0, lx: 0, near: 0,
    /* live joint angles. They SPRING toward MOODS[mood].pose, so a mood change
       is a movement and two moods landing close together blend instead of
       fighting — the thing eight baked sprites could never do. */
    j: { uaL:0, faL:0, haL:0, uaR:0, faR:0, haR:0, head:0, torso:0 },
    want: REST,
    blinking: false, eyeState: "open", restMouth: "smile",
    viseme: null, visemeAt: 0,
    blinkAt: performance.now() + rand(BLINK_GAP_MS[0], BLINK_GAP_MS[1]),
    blinkUntil: 0, blinkAgain: false, blinkV: 1,
    searchPhase: Math.random() * 6.28,
    everSeen: false,
    wasSeen: true,
    saidMissing: false,
    rect: null, rectAt: 0,
  };
}

/* Frame-rate independent: at 30Hz (Party caps vision work) and at 144Hz this
   converges to the same place in the same wall-clock time. A plain per-frame
   lerp constant does not, and the rig would visibly settle at different
   speeds on different machines. */
const approach = (from, to, tau, dt) =>
  from + (to - from) * (1 - Math.exp(-dt / tau));

const DEG = Math.PI / 180, RAD = 180 / Math.PI;

/* Fold a joint chain into ONE transform.
   Each joint is `translate(p) rotate(a) translate(-p)`, and a chain of those
   composes to a plain rotation plus a translation — rotations simply add, and
   the offsets accumulate through the rotations above them. So a hand four
   joints deep still costs the element one `translate(...) rotate(...)`, in
   percentages of its own box, which is the same box for every part. No pixel
   value appears anywhere, so the whole puppet is resolution-independent for
   free and nothing has to know the viewport. */
function compose(chain, ang, off){
  let th = 0, tx = 0, ty = 0;
  for(let i = 0; i < chain.length; i++){
    const name = chain[i];
    const j = JOINTS[name];
    const a = (ang[name] || 0) * DEG;
    const o = off && off[name];
    if(!a && !o) continue;
    const ca = Math.cos(a), sa = Math.sin(a);
    /* this joint on its own: the pivot must map to itself, plus any socket
       slide, which rides in the PARENT's frame and is therefore inherited by
       everything further down the chain — slide a shoulder and the forearm and
       hand come with it, which is the only reason this is safe to do */
    let jx = j.px - (ca * j.px - sa * j.py);
    let jy = j.py - (sa * j.px + ca * j.py);
    if(o){ jx += o.x; jy += o.y; }
    const c0 = Math.cos(th), s0 = Math.sin(th);
    tx += c0 * jx - s0 * jy;
    ty += s0 * jx + c0 * jy;
    th += a;
  }
  return { th, tx, ty };
}

/* ---- THE SOCKET SLIDE ----
   The pack's README promises the overlap tabs "prevent gaps during rotation".
   Measured, they do not: only 17% of the upper arm is tucked behind the torso
   at rest, 5% by a 15-degree raise and 0.2% by 66 — at which point the limb is
   a separate blue capsule with its own closed outline lying against the body.
   It is not a hole, which is why a connectivity test says everything is fine
   and the render plainly is not.

   So the arm is pushed back INTO its socket as it turns, along the line to the
   body. Sliding it by this much restores the resting overlap at every angle,
   and it is small enough to be invisible: 5.6px at the loudest pose on a
   176px-tall rig, against an arm that has swung 66 degrees. Standard cutout
   rigging, and it costs nothing but this function. */
const SOCKET_MAX = 17 / 640, SOCKET_K = .32 / 640, SOCKET_BIAS = 1.6 / 640;
const SOCKET_DY = .38;
function socket(a, inward){
  const s = Math.min(SOCKET_MAX, SOCKET_K * Math.abs(a) + SOCKET_BIAS);
  return { x: s * inward, y: s * SOCKET_DY };
}

/* Breathing is NOT a sine. Air goes in quickly and comes out slowly, and the
   turn at the top is a hold, not a corner. 0..1 in, 0..1 out. */
function breathShape(u){
  u -= Math.floor(u);
  if(u < .34) return .5 - .5 * Math.cos(Math.PI * (u / .34));       // in
  if(u < .46) return 1;                                             // hold
  return .5 + .5 * Math.cos(Math.PI * ((u - .46) / .54));           // out
}

/* His own centre, in stage-normalized coordinates, so a look can be aimed as
   a direction rather than a pixel. Cached: reading a rect while the same loop
   is writing custom properties every frame is a layout flush per rig. */
function siteOf(r, now){
  if(r.rect && now - r.rectAt < 500) return r.rect;
  const stage = r.node.offsetParent || r.node.parentElement;
  if(!stage) return null;
  const a = r.node.getBoundingClientRect();
  const b = stage.getBoundingClientRect();
  if(!b.width || !b.height) return null;
  r.rectAt = now;
  r.rect = {
    x: (a.left + a.width * .5 - b.left) / b.width,
    /* aim from his HEAD, not his middle — the offset is where the face sits */
    y: (a.top + a.height * .31 - b.top) / b.height,
  };
  return r.rect;
}

/* Where he wants to be looking, as -1..1 on each axis.

   The player's position arrives in video space and his own is in stage space.
   The two differ by the object-fit:cover crop, which is at most a few percent
   here and is not corrected for: a gaze is a DIRECTION, it is clamped to a
   couple of degrees, and nobody can perceive the difference at his size. What
   would be perceivable is looking the wrong way, which is why presence.js
   hands back mirrored coordinates — see the note there. */
function gazeTarget(r, p, now, dt){
  if(r.mute || !p) return null;
  /* NEVER AIM AT A DEFAULT. presence() publishes x:0,y:0 until it gets its
     first fix, and 0,0 is the top-left corner of the stage — so between a
     board opening and the camera finding a body, he would stand there
     staring hard into the corner. Until there has been one real observation
     he has nothing to look at, and neutral is the honest pose. */
  if(!r.everSeen){
    if(!p.seen) return null;
    r.everSeen = true;
  }
  const site = siteOf(r, now);
  if(!site) return null;
  if(!p.seen && p.lostMs > SEARCH_AFTER_MS){
    /* He does not just freeze when you leave. He looks at where you were and
       then sweeps, slowly, the way you scan a room for someone. Advanced by
       dt, not per call: a fixed step per frame would have him hunting 2.4x
       faster on a 144Hz display than on Party's 30Hz vision budget. */
    r.searchPhase += SEARCH_RATE * dt;
    return {
      x: Math.cos(r.searchPhase) * .55,
      y: Math.sin(r.searchPhase * .7) * .3 - .1,
    };
  }
  /* NORMALIZE PER SIDE, not against one fixed reach. A single `/ .42` is fine
     for Solo, whose rig sits at x .76 with the whole board to its left — but
     1v1 and Party tuck their local rigs THROUGH the outer edge, at x ≈ .03.
     From there every player position is to the right, and a fixed reach pinned
     the gaze at full deflection for the right-hand 55% of the frame: he looked
     the same whether you were mid-board or against the far wall, and never
     once looked left. Dividing each side by the distance to that edge maps the
     whole frame onto the full gaze range wherever the rig stands. */
  return {
    x: span(p.x - site.x, site.x),
    y: span(p.y - site.y, site.y),
  };
}

/* `d` is the offset to the player, `before` how much board lies on the
   negative side. The floor keeps a rig hard against an edge from turning its
   own 3% of headroom into a hair-trigger. */
function span(d, before){
  return d >= 0
    ? Math.min(1, d / Math.max(GAZE_MIN_REACH, 1 - before))
    : Math.max(-1, d / Math.max(GAZE_MIN_REACH, before));
}

function stepBlink(r, now){
  if(r.blinking){
    if(now < r.blinkUntil) return;
    r.blinking = false;
    dressEyes(r, r.eyeState);          // back to whatever the mood wants
  }
  if(now < r.blinkAt) return;
  /* `happy` and `worried` are already drawn with the eyes closed or squeezed,
     and blinking through a celebration reads as a dropped frame. */
  if(r.eyeState !== "open" || now < r.holdUntil){
    r.blinkAt = now + rand(BLINK_GAP_MS[0], BLINK_GAP_MS[1]);
    return;
  }
  r.blinking = true;
  dressEyes(r, "blink");
  r.blinkUntil = now + BLINK_MS;
  /* `blinkAgain` is consumed here, so a double is exactly two. Rolling for it
     again on the second blink made every double a triple. */
  const paired = r.blinkAgain;
  r.blinkAgain = paired ? false : Math.random() < DOUBLE_BLINK;
  r.blinkAt = now + BLINK_MS + (r.blinkAgain || paired
    ? 110 : rand(BLINK_GAP_MS[0], BLINK_GAP_MS[1]));
}

/* ---- he MOUTHS the words ----
   The pack ships five visemes and a smile, so when a line is on the paper his
   mouth can actually run it rather than sitting in one shape while text
   appears above his head. The mapping is deliberately crude — nobody is
   lip-reading a robot at 176px — but the RHYTHM is what sells it, so the
   track is built from the real characters of the real line. */
const VISEME_MS = 85;
const VISEME_OF = { a:"A_AH", e:"E_EE", i:"E_EE", y:"E_EE", o:"O_OH", u:"O_OH",
  m:"M_BP", b:"M_BP", p:"M_BP", f:"FV", v:"FV", w:"O_OH" };
function speakTrack(text){
  const out = [];
  for(const ch of text.toLowerCase()){
    if(ch === " " || ch === "\u2014"){ out.push(null); continue; }   // a beat of rest
    const v = VISEME_OF[ch];
    if(v) out.push(v);
    else if(out.length && out[out.length - 1]) out.push(null);
  }
  return out.slice(0, Math.ceil(LINE_MS / VISEME_MS));
}

function stepMouth(r, now){
  if(!r.mouth) return;
  let shape = r.restMouth;
  if(r.viseme){
    const i = Math.floor((now - r.visemeAt) / VISEME_MS);
    if(i >= r.viseme.length) r.viseme = null;
    else shape = r.viseme[i] || "M_BP";      // a closed mouth between sounds
  }
  const src = ART + MOUTH_FILE(shape);
  if(r.mouthSrc !== src){ r.mouthSrc = src; r.mouth.src = src; }
}

const px2 = v => (Math.round(v * 100) / 100);

function lifeStep(r, now, dt, still){
  const p = r.mute ? null : presence();

  /* ---- gaze: eyes first, body after ---- */
  const want = gazeTarget(r, p, now, dt);
  const tx = want ? want.x : 0, ty = want ? want.y : 0;
  r.gx = approach(r.gx, tx, TAU_GAZE, dt);
  r.gy = approach(r.gy, ty, TAU_GAZE, dt);
  r.lx = approach(r.lx, tx, TAU_LEAN, dt);
  /* Crowding the camera pushes him back a little; standing off draws him in.
     .5 is presence.js's mid-distance reference, and its scale runs to 1.5, so
     this is clamped — a player right up against the lens should not shove him
     3% down the board. */
  const nearTo = p?.seen ? Math.max(-1, Math.min(1, (p.scale - .5) * 2)) : 0;
  r.near = approach(r.near, nearTo, TAU_NEAR, dt);

  /* ---- breath ---- */
  let bY = 0, bTilt = 0, faceLag = 0;
  if(!still){
    const period = Math.max(600, parseFloat(r.node.style.getPropertyValue("--rb-bob")) || 2600);
    /* ACCUMULATE CYCLES, NOT MILLISECONDS. `--rb-bob` is rewritten by setHype
       on every 0.02 step of the meter (2600ms down to 850ms), and if the phase
       is stored as elapsed ms then dividing by a NEW period teleports it by
       breath*Δperiod/period² — an error that grows without bound the longer he
       has been alive. Measured on the ms version: a single hype step moved him
       0.24% at 1.5s old and 1.88% at 47s old, and a normal charge ramp
       produced per-frame steps of 1.90% and 2.30deg. BREATH_AMP is 1.9% and
       the whole tilt range is 2.30deg, so the "breath" became per-frame
       scramble exactly while the player was watching the meter climb. In
       cycles a period change simply re-times the next cycle. */
    r.breath += dt / period;
    const b = breathShape(r.breath);
    /* Held beats own his body — but this used to be a STEP, `now < holdUntil ?
       0 : 1`, which teleported him up to 1.9% and 1.2deg on each edge. Two of
       the four edges per word land in plain sight: the end of a `got` hold is
       900ms after the slam has finished, with him sitting still. It is an
       envelope now. It also starts at 0 on a new word, which is what covers
       the handoff out of the count-in entrance: `gamePaperIn` has fill:both
       and ends at translate:0/rotate:0, so the life loop must arrive at rest
       and grow, not cut in mid-cycle. */
    r.amp = approach(r.amp, now < r.holdUntil ? 0 : 1, TAU_AMP, dt);
    bY = -b * BREATH_AMP * r.amp;
    bTilt = (b - .5) * 2 * BREATH_TILT * r.amp;
    /* The face trails the body by a beat. It is a CHILD of the moving rig, so
       what is applied here is the difference between the lagged breath and
       the current one — the net result is a head that arrives late.
       Be honest about the scale of this one: the breath is 1.9% of his height
       (~3px in Solo) and a lag can only ever be a fraction of that, so at
       gameplay size it is a sub-pixel refinement that mostly shows up on a
       retina panel. The overlapping action you can actually SEE is the gaze —
       `gx` reaches the target while `lx` is still on its way, which is the
       same asymmetry an order of magnitude larger. */
    faceLag = (breathShape(r.breath - FACE_LAG_MS / period) - b) * BREATH_AMP * r.amp;
  }

  /* ---- pose springs ----
     The mood sets a TARGET for every joint and the rig travels there. Nothing
     is keyframed, so a mood that changes mid-move blends out of wherever the
     limbs actually are instead of cutting. */
  const w = r.want || REST;
  for(const k in r.j) r.j[k] = approach(r.j[k], w[k] || 0, TAU_POSE, dt);

  /* ---- drive the skeleton ----
     Under reduced motion the LEAN goes too, not just the breath: it is 1.5% of
     his box of travel and a couple of degrees of roll, running continuously as
     he tracks you, and that is body motion by any reading. The gaze and the
     blink stay — moving the eyes in a still head is not vestibular, and a
     character who never changes at all is what this loop exists to fix. */
  const st = r.node.style;
  const lean = still ? 0 : r.lx;
  st.setProperty("--rb-shift-x", px2(lean * LEAN_X) + "%");
  st.setProperty("--rb-shift-y", px2(bY + (still ? 0 : r.near * NEAR_PUSH)) + "%");

  /* HIS HEAD TURNS NOW. On the sprite rig a "look" could only ever be the
     whole body leaning, because head and torso were one picture. Here the neck
     is a joint, so the gaze cascade finally runs the way it does in a real
     body: eyes first, then the head, then the torso — and the head carries a
     COUNTER of the torso's roll, so leaning does not tip his face with it. */
  const ang = {
    torso: r.j.torso + (still ? 0 : bTilt) + lean * TILT_X,
    head:  r.j.head + r.gx * HEAD_TURN + r.gy * HEAD_NOD
             - (still ? 0 : bTilt) * HEAD_COUNTER
             + (still ? 0 : faceLag * FACE_LAG_TILT),
    /* Keys here are JOINT names, not pose names — `compose` looks each one up
       in JOINTS, so a pose-shaped key (uaL) silently resolves to zero and the
       arm never moves while the head, which happened to share a name, does.
       Raise is positive-outward on both sides and the sign flips here, so the
       pose table stays readable and cannot drift between left and right. */
    uarmL: -r.j.uaL, farmL: -r.j.faL,
    uarmR:  r.j.uaR, farmR:  r.j.faR,
    /* THE WRIST IS THE ONE JOIN THAT HOLDS — the blue cuff covers it cleanly
       past 60 degrees — and it was hardcoded to zero, so the pack shipped hand
       art authored to rotate and the rig left it dead. Hands counter part of
       the forearm's bend, which is what keeps a raised arm from ending in a
       flat plank and gives `got` an actual "yes!" instead of a T-pose. */
    handL: -r.j.haL, handR: r.j.haR,
    /* a hair of weight shift, so the legs are not two nailed posts */
    legL: -lean * LEG_SHIFT, legR: -lean * LEG_SHIFT,
  };
  /* Only the shoulders need it; the wrist cuff covers its own joint and the
     elbow gets its own measured slide. */
  const off = {
    uarmL: socket(ang.uarmL, -1),
    uarmR: socket(ang.uarmR, +1),
  };
  for(let i = 0; i < r.parts.length; i++){
    const part = r.parts[i];
    const m = compose(CHAIN[part.j], ang, off);
    const tf = "translate(" + px2(m.tx * 100) + "%," + px2(m.ty * 100) + "%) rotate("
      + px2(m.th * RAD) + "deg)";
    if(part.tf !== tf){ part.tf = tf; part.el.style.transform = tf; }
    if(part.j === "head") r.headM = m;
  }
  /* The eyes travel a little further than the mouth, on top of the head chain.
     That difference is the whole parallax: features nearer the viewer move
     more, which is what the eye reads as rotation rather than a decal slide. */
  st.setProperty("--rb-eye-x", px2(r.gx * GAZE_EYE_X) + "%");
  st.setProperty("--rb-eye-y", px2(r.gy * GAZE_EYE_Y) + "%");

  /* Aim the speech tail at where his mouth ACTUALLY is, through the same head
     transform his face rides — so the paper follows him when he turns instead
     of hanging off a per-pose constant that has to be re-authored by hand. */
  /* ON THE BUBBLE, NOT ON .grobot. `--talk-x/--talk-y` are declared on
     `.rb-bubble` itself as fallbacks, and a property set on the element beats
     the same property inherited from its parent — so writing these to the rig
     was silently doing nothing and the tail sat 11px above his mouth using the
     stylesheet's default. It cost a full measurement of every term in that
     geometry to find, because every number in the chain looked right. */
  if(r.headM && r.bubble){
    const c = Math.cos(r.headM.th), sn = Math.sin(r.headM.th);
    const mx = r.headM.tx + c * MOUTH.x - sn * MOUTH.y;
    const my = r.headM.ty + sn * MOUTH.x + c * MOUTH.y;
    const bs = r.bubble.style;
    bs.setProperty("--talk-x", px2((CANVAS_X + mx * CANVAS_S / GROBOT_AR) * 100) + "%");
    bs.setProperty("--talk-y", px2((CANVAS_Y + my * CANVAS_S) * 100) + "%");
  }

  stepBlink(r, now);
  stepMouth(r, now);

  /* ---- he notices you are gone, and notices you are back ---- */
  if(!r.mute && p){
    if(p.seen && !r.wasSeen){
      r.wasSeen = true;
      r.saidMissing = false;
      r.blinkAt = Math.min(r.blinkAt, now + 180);   // a blink as he re-focuses
    }else if(!p.seen && p.lostMs > SEARCH_AFTER_MS){
      r.wasSeen = false;
      /* `everSeen` is the whole guard: you can only be LOST by someone who had
         you. Without it a rig announced "STEP BACK IN!" on the first frame it
         existed, having never seen anybody — and on a board where the camera
         has produced nothing at all he would say it forever. */
      if(r.everSeen && !r.saidMissing && p.lostMs > MISSING_AFTER_MS &&
         now >= r.holdUntil && r.mood !== "got"){
        r.saidMissing = true;
        say(r, "missing");
      }
    }
  }
}

function lifeFrame(now){
  lifeRaf = 0;
  const dt = Math.min(64, Math.max(1, now - lifeLastT));   // a returning tab
  lifeLastT = now;                                          // must not lurch
  const still = reducedMotion();
  let live = false;
  for(const r of robots.values()){
    if(!r.node.isConnected) continue;
    if(now - r.lastChargeAt > IDLE_STALE_MS) continue;
    live = true;
    lifeStep(r, now, dt, still);
  }
  if(live) wake();
  else lifeLastT = 0;    // next wake is a cold start, not a 10-minute dt
}

function wake(){
  if(lifeRaf || typeof requestAnimationFrame !== "function") return;
  if(typeof document !== "undefined" && document.hidden) return;
  /* Only rebase the clock on a COLD start. lifeFrame re-arms itself through
     here every frame, and re-stamping then would measure dt from the end of
     one callback to the start of the next instead of frame to frame. */
  if(!lifeLastT) lifeLastT = performance.now();
  lifeRaf = requestAnimationFrame(lifeFrame);
}

if(typeof document !== "undefined"){
  document.addEventListener("visibilitychange", () => {
    if(!document.hidden) wake();
  });
  /* His aim is cached against a stage rect; a resize invalidates every one. */
  addEventListener("resize", () => {
    for(const r of robots.values()) r.rect = null;
  });
}

function clearLife(r){
  Object.assign(r, lifeState());
  const s = r.node.style;
  for(const k of ["--rb-shift-x", "--rb-shift-y", "--rb-eye-x", "--rb-eye-y"])
    s.setProperty(k, "0%");
  /* park every limb back at rest, and clear the cached transform strings so
     the next frame genuinely rewrites them */
  for(const part of r.parts || []){ part.tf = ""; part.el.style.transform = ""; }
}

/* ---------------- the public surface ---------------- */

/* Per frame, from whichever loop owns that mode's charge meter. `display` is
   the meter's displayed value (0..1) — the same number the bar is drawn from,
   which is what keeps the character honest. */
export function robotCharge(id, display, locked = false){
  const r = get(id);
  if(!r) return;
  const value = locked ? 1 : Math.max(0, Math.min(1, Number(display) || 0));
  setHype(r, value);

  const now = performance.now();
  r.lastChargeAt = now;                        // the idle loop's dead-man switch
  wake();                                      // ...and the life loop's
  if(now < r.holdUntil) return;                // a payoff beat owns him
  r.holdUntil = 0;

  const band = bandFor(value);
  if(band !== r.band){
    const climbing = bandRank(band) > bandRank(r.band);
    r.band = band;
    /* a band change outranks an idle beat: if the player has started getting
       through, that has to show on the next frame, not when the beat ends */
    stopIdle(r);
    setMood(r, band);
    /* he only calls out progress, never regress: "I SEE IT!" on the way back
       down is a lie, and a bubble on every wobble is a strobe */
    if(climbing && (band === "read" || band === "close")) say(r, band);
    scheduleIdle(r);
  }else if(band === "idle" && now - r.lastSaidAt > NUDGE_MS){
    /* WHO IS THE METER AT ZERO BLAMING? Until this, always the player: eight
       and a half seconds of nothing and he said "ANY TIME NOW". But an empty
       meter usually means one of two things that are not the player standing
       about — they have walked out of shot, or they are miming their heart
       out at a classifier that cannot see it. Nagging in either case is the
       oldest mistake a companion character can make. So: out of frame, the
       life loop's `missing` line owns the moment and this says nothing;
       moving hard with nothing to show for it, he takes the blame himself;
       genuinely idle, and only then, he pokes you. */
    const p = r.mute ? null : presence();
    if(p && !p.seen && p.lostMs > SEARCH_AFTER_MS) return;
    say(r, p && p.energy > STRUGGLE_ENERGY ? "struggling" : "nudge");
  }
}

/* Recognition. The sticker slam plus the loudest line he has.

   The run is HIS tally, not the game's streak: every mode counts streaks
   differently (Solo banks on delivery, 1v1 resets when the rival takes the
   word, Party has none), and what he is reacting to is simply "that is three
   without me letting you down". Counting it here keeps him out of scoring. */
export function robotGot(id){
  const r = get(id);
  if(!r) return;
  r.run++;
  setHype(r, 1);
  hold(r, "got", SLAM_MS + PROUD_MS);
  slam(r);
  say(r, r.run >= 3 ? "streak" : "got", true);
  r.moodTimer = setTimeout(() => {
    r.moodTimer = 0;
    if(r.mood === "got") setMood(r, "proud");
  }, SLAM_MS);
}

/* A word ran out (`timeout`) or was thrown away (`skip`). Nothing in either
   list is a dig at the player — he takes the blame himself. */
export function robotMiss(id, kind = "timeout"){
  const r = get(id);
  if(!r) return;
  r.run = 0;
  setHype(r, 0);
  hold(r, kind === "skip" ? "lost" : "down", MISS_MS);
  say(r, kind === "skip" ? "skip" : "timeout", true);
}

/* New word: back on the meter, silent, from zero. */
export function robotNewWord(id){
  const r = get(id);
  if(!r) return;
  clearTimeout(r.moodTimer); r.moodTimer = 0;
  clearTimeout(r.slamTimer); r.slamTimer = 0;
  stopIdle(r);
  r.rig?.classList.remove("slam");
  r.holdUntil = 0;
  r.band = null;
  /* Grow the breath back in rather than resuming mid-cycle. This is also what
     covers the handoff out of the count-in: `gamePaperIn` owns .grobot with
     fill:both and lands it at translate:0/rotate:0, and the first word is
     dealt just after — so the life loop takes over at rest and swells, instead
     of stepping straight to wherever the cycle happened to be. */
  r.amp = 0;
  hush(r);
  setMood(r, "idle");
  setHype(r, 0);
}

export function resetRobot(id){
  const r = robots.get(id);
  if(!r) return;
  robotNewWord(id);
  clearLife(r);
  /* presence.js counts `lostMs` from the last time it saw anybody, which on a
     board opened after five minutes in a menu is five minutes. Without this
     the first thing he does on a fresh run is announce that he has lost you —
     before the camera has had a single frame to find you. Rezeroing here ties
     "how long have you been gone" to the run, which is what he is talking
     about. robot.js is its only consumer, so this is the one owner. */
  resetPresence();
  r.run = 0;
  r.lastLine = "";
  r.lastSaidAt = performance.now();   // no nudge the instant a board opens
}

/* Every rig on the board — called wherever the celebrations are swept, so a
   slam or a bubble never survives the screen it belongs to. */
export function resetRobots(){
  for(const id of robots.keys()) resetRobot(id);
}
