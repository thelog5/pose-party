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

   Nothing here is authoritative. Every mode already owns its own recognition,
   scoring and network state; this only reflects it. */

/* Deliberately dependency-free: gameplayFeedback.js is where every mode
   signals recognition, so it calls INTO this module. Importing anything back
   out of it would close a cycle around the one primitive all three modes
   share. The reduced-motion check is two lines; the import was not worth it. */
import { ROBOT_DIALOGUE } from "./robotDialogue.js";
import { fitWrappedTextToBox } from "./textFit.js";

const reducedMotion = () => typeof matchMedia === "function" &&
  matchMedia("(prefers-reduced-motion: reduce)").matches;

const ART = "assets/ui/figma/";

/* mood -> [body sprite, face sprite] */
const MOODS = Object.freeze({
  idle:  ["idle",      "neutral"],
  watch: ["thinking",  "thinking"],
  read:  ["present",   "speaking"],
  close: ["surprised", "surprised"],
  got:   ["celebrate", "joyful"],
  proud: ["thumbsup",  "happy"],
  lost:  ["shrug",     "confused"],
  down:  ["sad",       "sad"],
  /* idle-only: the body stays put and just the face changes, which is what
     keeps a still pose from reading as a frozen sprite */
  peek:  ["idle",      "happy"],
});

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

/* Every sprite, warmed once. A mood swap is a `src` change, so the first
   time each pose is used it would otherwise pop in a frame late — most
   visibly on the recognition slam, which is the one that has to be instant. */
function preload(){
  if(preloaded || typeof Image !== "function") return;
  preloaded = true;
  for(const [body, face] of Object.values(MOODS)){
    new Image().src = ART + "rb-body-" + body + ".png";
    new Image().src = ART + "rb-face-" + face + ".png";
  }
}

function get(id){
  const cached = robots.get(id);
  if(cached?.node.isConnected) return cached;
  const node = document.getElementById(id);
  if(!node) return null;
  preload();
  const r = {
    node,
    rig:    node.querySelector(".rb-rig"),
    body:   node.querySelector(".rb-body"),
    face:   node.querySelector(".rb-face"),
    bubble: node.querySelector(".rb-bubble"),
    line:   node.querySelector(".rb-bubble b"),
    mute:   node.hasAttribute("data-mute"),
    mood:   null,
    band:   null,
    hype:   -1,
    run:    0,           // words got in a row, HIS count — see robotGot
    holdUntil: 0,
    lineUntil: 0,
    lastLine: "",
    lastSaidAt: 0,
    moodTimer: 0,
    slamTimer: 0,
    bubbleTimer: 0,
    idleTimer: 0,
    beat: 0,
    lastChargeAt: 0,
  };
  robots.set(id, r);
  setMood(r, "idle");
  setHype(r, 0);
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
  const pair = MOODS[mood] || MOODS.idle;
  r.mood = mood;
  /* the pose name is what the CSS keys the two face nudges off */
  r.node.dataset.pose = pair[0];
  if(r.body) r.body.src = ART + "rb-body-" + pair[0] + ".png";
  if(r.face) r.face.src = ART + "rb-face-" + pair[1] + ".png";
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
    say(r, "nudge");
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
  hush(r);
  setMood(r, "idle");
  setHype(r, 0);
}

export function resetRobot(id){
  const r = robots.get(id);
  if(!r) return;
  robotNewWord(id);
  r.run = 0;
  r.lastLine = "";
  r.lastSaidAt = performance.now();   // no nudge the instant a board opens
}

/* Every rig on the board — called wherever the celebrations are swept, so a
   slam or a bubble never survives the screen it belongs to. */
export function resetRobots(){
  for(const id of robots.keys()) resetRobot(id);
}
