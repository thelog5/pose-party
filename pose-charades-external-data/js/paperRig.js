/* THE PAPER ROBOT REACHES FOR YOUR CURSOR — Home and the 1v1 lobby.

   Both screens used to carry a stale robot. Home's was four sprites
   (`robot-body`, two arms, a head with two baked faces) waving on a symmetric
   CSS sine; the lobby's was two sprites, `lb-robot-high` and `lb-robot-low`,
   cross-faded every 1300ms. Neither could look at anything, so the one thing
   the player is doing while they read a menu or wait for a friend — moving the
   mouse — got no answer at all.

   Both are now Figma's own `Robot RIg` section (353:752), which ships the
   mascot as ELEVEN cut-outs: head, eyes, mouth, torso, waist, an upper arm and
   a hand per side, and two legs. This module is the puppet that drives them,
   for as many rigs as a screen cares to mount, and the whole of its character
   is one idea:

   **PARALLAX IS A LAG, NOT A SCALE FACTOR.** Every layer chases the same
   cursor, but with its own gain AND its own time constant — the eyes arrive
   first and travel furthest, then the head, then the torso, and the hips
   barely move at all. Give every layer the same time constant and you get a
   sticker being dragged; give them different ones and the body reads as
   following a decision the eyes already made.

   Geometry notes, all of which are Figma's and none of which are eyeballed:

   - **The parts are NOT on a shared canvas** (unlike `assets/ui/rig/`, which
     is). Each layer is its own PNG with its own rect. So this file works in
     ONE square space — side 1309, the rig's own height, with the 1087-wide
     art rect centred in it (OX below) — and every rect, pivot and offset is a
     fraction of that square. A square matters: a rotation composed in a
     non-square normalised space is a shear, and the puppet comes apart.
     `css/screens.css` places each layer's rect inside that same square, so
     the two files agree by construction.
   - **`compose()` folds a part's whole parent chain into one
     `translate(...) rotate(...)`**, in percentages of the square. A chain of
     rotations about different pivots reduces exactly to one rotation plus one
     translation, so the hand — three joints deep — still costs one transform
     and no pixel value appears anywhere.
   - **The angle keys are JOINT names** (`uarmL`), and `compose()` looks each
     one up in `JOINTS`. A key that is not a joint silently resolves to zero.

   `data-j` on each `.pr-part` is the joint it drives; the composer writes to
   whichever of them exist, so the markup and this file cannot drift apart.
   A rig is mounted by putting `data-rig` on its root — nothing here knows
   which screen it is on. */

const DEG = Math.PI / 180;
const TWO_PI = Math.PI * 2;

/* ---------- the square ----------
   Figma's rects are given relative to the `Robot RIg` section; subtracting the
   art's own origin (529, 93) puts them in canvas units, and adding OX to x
   centres that 1087-wide rect in the 1309 square. */
const SQUARE = 1309;
const OX = (SQUARE - 1087) / 2;
const sx = x => (x + OX) / SQUARE;
const sy = y => y / SQUARE;

/* ---------- the skeleton ----------
   `hips` is a joint with no art: it is the point the whole body pivots about,
   and giving the waist, the legs and the torso a common parent is what keeps
   the stance under him when he leans. Pivots were measured off the layers'
   own ink — a shoulder is the centre of that side's blue cap, a wrist is the
   centre of its cuff — not guessed from the bounding boxes. */
const JOINTS = Object.freeze({
  hips : { parent:null,    px:sx(485), py:sy(930) },
  waist: { parent:"hips",  px:sx(485), py:sy(930) },
  legL : { parent:"hips",  px:sx(392), py:sy(944) },
  legR : { parent:"hips",  px:sx(621), py:sy(967) },
  torso: { parent:"hips",  px:sx(485), py:sy(930) },
  head : { parent:"torso", px:sx(497), py:sy(634) },
  eyes : { parent:"head",  px:sx(497), py:sy(634) },
  mouth: { parent:"head",  px:sx(497), py:sy(634) },
  uarmL: { parent:"torso", px:sx(670), py:sy(739) },
  handL: { parent:"uarmL", px:sx(940), py:sy(686) },
  uarmR: { parent:"torso", px:sx(311), py:sy(760) },
  handR: { parent:"uarmR", px:sx(145), py:sy(955) },
});

const CHAIN = Object.freeze(Object.fromEntries(Object.keys(JOINTS).map(k => {
  const out = [];
  for(let j = k; j; j = JOINTS[j].parent) out.unshift(j);
  return [k, out];
})));

/* The two shoulders and the two wrists AT REST, in square coords. The reach is
   the angle between "shoulder -> resting wrist" and "shoulder -> cursor", so
   these are what make it a rotation of the arm he already has rather than a
   pose swapped in from somewhere. */
const SHOULDER_L = { x:JOINTS.uarmL.px, y:JOINTS.uarmL.py };
const WRIST_L    = { x:JOINTS.handL.px, y:JOINTS.handL.py };
const SHOULDER_R = { x:JOINTS.uarmR.px, y:JOINTS.uarmR.py };
const WRIST_R    = { x:JOINTS.handR.px, y:JOINTS.handR.py };
/* the heart on his chest — deflection is measured from here, not from the box
   centre, so leaning "towards" the cursor means what a body means by it */
const CHEST = { x:sx(485), y:sy(800) };

/* ---------- tuning ----------
   Every offset is a fraction of the square, every angle is degrees. */

/* THE REACH IS NORMALISED PER SIDE, against the distance from his chest to
   that edge of the window, not against one fixed number. Home's robot stands
   hard against the LEFT edge and the lobby's sits right of centre; a single
   divisor pinned whichever side had less room at full deflection across most
   of the screen, so he looked identical whether you were beside him or against
   the far wall. Same bug, and same fix, as the gameplay rig's gaze. The clamps
   stop a rig in the middle of a very wide window from needing the cursor at
   the very edge, and stop one tucked into a corner from twitching. */
const REACH_MIN = .75, REACH_MAX = 2.6;

/* the parallax ladder: gain, then time constant. Ordered deliberately — a
   layer that travels further must also arrive sooner, or the lag reads as the
   body dragging the head rather than the head leading the body. */
const CH = Object.freeze({
  gaze : { tau: 70 },
  head : { tau:150 },
  torso: { tau:320 },
  hips : { tau:620 },
  arm  : { tau:190 },
  hand : { tau:110 },
});

/* THE BODY HAS TO KEEP UP WITH THE FACE AND THE ARMS. These are the biggest
   numbers in the ladder and they used to be the smallest: the head's own share
   was doing most of the work, so his face and hands answered the cursor while
   his chest and hips barely acknowledged it — a talking head on a stand.
   Because the head is a CHILD of the torso, its travel is the SUM of the three,
   so the hips and torso can be opened right up while the head's own share
   comes DOWN and the total barely changes:

     total head x   .069 -> .086 (+25%)      torso x  .035 -> .060 (+71%)
     total head y   .049 -> .046 (-6%)       hips  x  .009 -> .018 (+100%)

   The head's VERTICAL share is deliberately cut. Home's antenna clears the
   PARTY letters by about 20px and the lobby's clears its panel by 1.5px, so
   vertical head travel is the one number in this file that is paid for out of
   somebody else's composition. Sideways there is room; upwards there is not. */
const OFF_HIPS  = { x:.018, y:.008 };
const OFF_TORSO = { x:.042, y:.020 };
const OFF_HEAD  = { x:.026, y:.018 };
/* THE FACE'S BUDGET IS THE BLUE SCREEN, and it was barely being spent. The
   eyes and mouth slide INSIDE the head, so what limits them is the cream bezel
   they would climb onto, not anything on the board — measured off the art
   (head-blank's screen against each feature's ink, in square percentages):

     eyes    left 4.80   right 5.35   up 6.24   down 10.64
     mouth   left 12.72  right 12.58  up 14.59  down 4.48

   They were set to 2.0/1.5 and 1.1/0.8 — under half of the tightest side, on a
   face that is the only part of him a player actually looks at. These spend
   about 70% of the eyes' horizontal room and stay clear on every side. The
   mouth stays UNDER the eyes on purpose: that difference is parallax inside
   the face, and it is what reads as a head turning rather than a decal
   sliding. */
const OFF_EYES  = { x:.034, y:.028 };
const OFF_MOUTH = { x:.020, y:.015 };

const LEAN_HIPS = 2.6, LEAN_TORSO = 5.0, TILT_HEAD = 5.4;

/* HOW MUCH ROOM THIS RIG HAS TO MOVE IN, from `data-rig-room` on the root
   (default 1). Not a taste knob — a statement about the board. The lobby robot
   stands in the middle of an empty orange panel and can use all of it. Home's
   stands in a CORNER: the screen edge is on his left, the settings and volume
   buttons are under his far hand, and his own speech balloon is over his right
   shoulder, so a full-size lean threw that hand off the board one way and onto
   the volume button the other. It scales the body's travel and the FAR arm —
   never the near arm's reach, which swings into open space on both screens and
   is the whole point of the rig. */
const roomOf = root => {
  const v = Number(root.dataset.rigRoom);
  return Number.isFinite(v) && v > 0 ? v : 1;
};
/* A head DROPPING has less room than a head rising: the neck tab between the
   skull and the torso is only ~13px on screen, and the full downward offset
   ate most of it — he stopped having a neck the moment the cursor went below
   him. */
const HEAD_DOWN = .55;

/* HE SINKS MORE THAN HE RISES. Every vertical channel is damped going UP and
   left alone going down, for two reasons that happen to agree. It is what a
   body does — you slouch to look down, you do not levitate to look up — and
   UP is the direction that costs somebody else's composition: Home's antenna
   clears the PARTY letters by ~20px and the lobby's clears its panel by a
   couple, while below him both boards are empty. Opening the body's travel up
   without this put his antenna through the title at the top corners of the
   window. Sideways there is room; upwards there is not. */
const RISE = .45;
const sink = v => v < 0 ? v * RISE : v;

/* KEEP THE RAISE MODEST. The shoulder cap rotates WITH the arm and only the
   torso hides its inner edge; swung far enough the cap clears the torso and he
   reads as a doll coming apart. Measured against the silhouette, -34 is the
   last angle that still looks jointed. */
const ARM_L_UP = -34, ARM_L_DOWN = 30;

/* THE ARM THAT REACHES IS THE ARM ON THE CURSOR'S SIDE.
   Before this, only the viewer-RIGHT arm (uarmL, the raised one) reached, and
   the viewer-LEFT arm was a fixed supporting gesture at 55%. Put the cursor to
   his left and the right arm cannot get there: `reachAngle` takes the short
   way round, hits the -34 clamp, and STAYS there. The arm reads as stuck in
   the air, and it does not change however far left you go. That is the strange
   hand.
   Now a weight moves between the two arms as the cursor crosses him, so the
   near arm reaches to the right and the far arm reaches to the left. The
   handover is a slow ease, not a switch: the arms must never swap in one
   frame. The arm that is NOT reaching goes back to its idle wave, so he waves
   with one hand while he reaches with the other.
   The far arm's angles are its own. It rests pointing DOWN and left at 130.5
   degrees, so a POSITIVE angle raises it towards the cursor and a negative one
   swings it behind him. It gets less range than the near arm because it has
   further to travel from rest and because, on Home, it is the arm nearest the
   screen edge and the corner buttons — which is what `room` is for. */
const ARM_R_BACK = -18, ARM_R_REACH = 46;
const SIDE_SPAN = .34, TAU_SIDE = 340;
/* the hand keeps the palm roughly forward while the arm swings under it, then
   adds its own faster lead on top — that difference IS the wrist */
const HAND_FOLLOW = -.34, HAND_LEAD = 16;

const BREATH_MS = 3100, BREATH_Y = .0058, BREATH_ROLL = .7, HEAD_COUNTER = .8;
const WAVE_MS = 1500, WAVE_DEG = 15, WAVE_HAND = 20;

/* A cheer is a POSE, not a picture — which is just as well, because the rig
   pack authors exactly one face. Home's robot used to answer a tap by swapping
   `robot-head-happy` for `robot-head-surprised`; he now answers with his
   body, on a rise-and-fall that cannot be left half-played. */
const CHEER_MS = 820, CHEER_ARM = 26, CHEER_HAND = 22, CHEER_HOP = .022;

/* He goes back to waving when the cursor stops mattering: gone from the
   window, or simply parked. A robot that holds a reach at a motionless cursor
   for a minute is a robot stuck, not a robot attentive. */
const IDLE_MS = 2600;
const TAU_REACH = 300;

/* HIS BALLOON IS TETHERED TO HIM, NOT TO THE BOARD. A speech bubble nailed to
   the wallpaper while the character under it leans and turns reads as a label,
   not as something he is saying. It follows the same deflection at about half
   the head's gain and a slower time constant, so it trails him the way a
   balloon on a string trails a hand, and takes a little swing with it. The
   element is named by `data-rig-bubble` on the rig root; a rig without one
   simply skips this. Written to `translate`/`rotate`, never `transform` —
   `.fh.bubble:hover` owns `transform`, and one owner per property is the rule
   this whole rig is built on. */
const BUBBLE = { x:.036, y:.014 }, BUBBLE_TILT = 1.6, TAU_BUBBLE = 260;
/* ...and it drifts LESS to the right than to the left, for the same reason
   every other asymmetry in this file exists: there is a hard object that way.
   Home's balloon was already narrowed from its authored 25% to 21.6% so its
   tap-pop keeps a 12px design gap from the 1V1 card (see the `.fh.bubble`
   note in screens.css); letting it drift right at full gain spent that margin
   and `offline.test.mjs` caught it at 10.9px. Worse, the TAP that fires the pop
   also puts the cursor to his right, so the drift and the pop reach for the
   card in the same frame — damping it to .2 still landed the gap on 12.0
   against a 12px bar, and .08 only bought it back to 12.3 against an untethered
   baseline of 13.9. It is ZERO: the balloon simply never drifts toward the
   card. The whole swing is spent to the LEFT, where there is nothing but
   wallpaper for 250px, and the tilt stays symmetric and does most of the
   reading anyway. */
const BUBBLE_RIGHT = 0;

/* HE LOOKS AROUND WHEN NOBODY IS MOVING THE MOUSE. Breath and a wave are the
   only things a rig with no cursor to chase has, and breath is symmetric and a
   wave is a loop — between them he was a held pose most of the time. The
   wander is fed in as the deflection TARGET rather than added to the output,
   so it travels the same ladder the cursor does: the eyes lead it, the head
   follows, the torso follows that. The two periods are deliberately
   incommensurate, so the path never visibly repeats. Phase is in CYCLES. */
const DRIFT_MS = 5200, DRIFT_Y_RATIO = .73, DRIFT_X = .55, DRIFT_Y = .34;

const clamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;

/* ---------- the composer ----------
   Each joint on its own is `translate(p) rotate(a) translate(-p)`; walking the
   chain accumulates them into a single rotation plus a single translation. An
   `off` at a joint rides in the PARENT's frame and is therefore inherited by
   everything below it — slide a shoulder and the hand comes with it, which is
   the only reason a per-joint offset is safe here. */
function compose(chain, ang, off){
  let th = 0, tx = 0, ty = 0;
  for(let i = 0; i < chain.length; i++){
    const name = chain[i];
    const j = JOINTS[name];
    const a = (ang[name] || 0) * DEG;
    const o = off[name];
    if(!a && !o) continue;
    const ca = Math.cos(a), sa = Math.sin(a);
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

/* the signed turn from the arm's rest direction to the cursor, in degrees */
function reachAngle(shoulder, wrist, target){
  const rest = Math.atan2(wrist.y - shoulder.y, wrist.x - shoulder.x);
  const want = Math.atan2(target.y - shoulder.y, target.x - shoulder.x);
  let d = want - rest;
  while(d >  Math.PI) d -= TWO_PI;
  while(d < -Math.PI) d += TWO_PI;
  return d / DEG;
}

/* ---------- state ----------
   One cursor and one rAF for the whole document; one entry per mounted rig.
   Two rigs are never on screen together today, but a shared frame is what
   makes that free — and it is the only way the pointer is measured once. */
const motionPreference = matchMedia("(prefers-reduced-motion: reduce)");

const rigs = new Map();
const pointer = { cx:0, cy:0, seenAt:0 };
let frame = 0, wired = false;

function makeRig(root){
  return {
    root, canvas:root.querySelector(".pr-canvas"), parts:new Map(), room:roomOf(root),
    bubble: root.dataset.rigBubble
      ? document.querySelector(root.dataset.rigBubble) : null,
    want:false, running:false, last:0,
    breath:0, wave:0, drift:0, reach:0, cheer:0, side:0, ever:false,
    point:{ x:CHEST.x, y:CHEST.y },
    s:{ gaze:{x:0,y:0}, head:{x:0,y:0}, torso:{x:0,y:0}, hips:{x:0,y:0}, bub:{x:0,y:0},
        arm:{x:CHEST.x,y:CHEST.y}, hand:{x:CHEST.x,y:CHEST.y} },
  };
}

const px2 = n => Math.round(n * 100) / 100;

function onMove(event){
  /* A pointer can fire well over a hundred moves a second and each one would
     want a fresh rect. Only the CLIENT coordinate is recorded here; the frame
     converts it, so each rig's box is measured exactly once per frame — and it
     is measured LIVE, because both screens fly their robot in and a rect
     cached before he lands aims him at where he is about to be. */
  pointer.cx = event.clientX;
  pointer.cy = event.clientY;
  pointer.seenAt = performance.now();
}
function onLeave(){ pointer.seenAt = 0; }

function ease(v, target, dt, tau){ return v + (target - v) * (1 - Math.exp(-dt / tau)); }
function easeVec(v, tx, ty, dt, tau){
  const k = 1 - Math.exp(-dt / tau);
  v.x += (tx - v.x) * k;
  v.y += (ty - v.y) * k;
}

function write(r, name, ang, off){
  const el = r.parts.get(name);
  if(!el) return;
  const m = compose(CHAIN[name], ang, off);
  el.style.transform = "translate(" + px2(m.tx * 100) + "%," + px2(m.ty * 100)
    + "%) rotate(" + px2(m.th / DEG) + "deg)";
}

function advance(r, now, dt){
  /* Party mode and a joined room both take the lobby rig off the board with
     `display:none`. Keep the frame alive so he is already breathing when the
     screen hands him back, but write nothing into a box that is not laid out. */
  if(!r.canvas.offsetParent) return;

  /* THE BREATH PHASE IS IN CYCLES, NOT MILLISECONDS. Stored as elapsed time
     and divided by a period it would teleport the moment a period changed;
     as cycles it cannot drift however long he has been on screen. */
  r.breath += dt / BREATH_MS;
  if(r.cheer > 0) r.cheer = Math.max(0, r.cheer - dt / CHEER_MS);

  /* Does the cursor still count? Gone from the window or parked for IDLE_MS
     and he stands down — which is also what puts the wave back. */
  const box = r.canvas.getBoundingClientRect();
  const live = pointer.seenAt > 0 && now - pointer.seenAt < IDLE_MS && box.width > 0;
  if(live){
    r.point.x = (pointer.cx - box.left) / box.width;
    r.point.y = (pointer.cy - box.top) / box.height;
    if(!r.ever){
      /* first sighting: start the arms AT the cursor rather than at the chest,
         so he does not swing across the board on the very first move */
      r.s.arm.x = r.s.hand.x = r.point.x;
      r.s.arm.y = r.s.hand.y = r.point.y;
      r.ever = true;
    }
  }
  r.reach = ease(r.reach, live ? 1 : 0, dt, TAU_REACH);

  /* the deflection every translation channel answers to, each side measured
     against the room that side actually has — crossfaded with the idle wander
     on the same `reach` the wave uses, so there is never a seam between him
     watching you and him daydreaming */
  r.drift += dt / DRIFT_MS;
  const dx = r.point.x - CHEST.x, dy = r.point.y - CHEST.y;
  const chestX = box.left + CHEST.x * box.width;
  const chestY = box.top  + CHEST.y * box.height;
  const edgeRoom = (px, span) => clamp(px / span, REACH_MIN, REACH_MAX);
  const aimX = live ? clamp(dx / edgeRoom(dx > 0 ? innerWidth - chestX : chestX,
                                          box.width), -1, 1) : 0;
  const aimY = live ? clamp(dy / edgeRoom(dy > 0 ? innerHeight - chestY : chestY,
                                          box.height), -1, 1) : 0;
  const idle = 1 - r.reach;
  const nx = aimX * r.reach + Math.sin(r.drift * TWO_PI) * DRIFT_X * idle;
  const ny = aimY * r.reach +
    Math.sin(r.drift * TWO_PI * DRIFT_Y_RATIO + 1.1) * DRIFT_Y * idle;
  const s = r.s;
  easeVec(s.gaze,  nx, ny, dt, CH.gaze.tau);
  easeVec(s.head,  nx, ny, dt, CH.head.tau);
  easeVec(s.torso, nx, ny, dt, CH.torso.tau);
  easeVec(s.hips,  nx, ny, dt, CH.hips.tau);
  easeVec(s.bub,   nx, ny, dt, TAU_BUBBLE);
  /* the arms chase the cursor ITSELF, not the clamped deflection: an angle
     wants a point, and clamping the point first bends the aim */
  const px = live ? r.point.x : CHEST.x;
  const py = live ? r.point.y : CHEST.y - .5;
  easeVec(s.arm,  px, py, dt, CH.arm.tau);
  easeVec(s.hand, px, py, dt, CH.hand.tau);

  const breath = Math.sin(r.breath * TWO_PI);

  /* which arm is on the cursor's side. `nearW` is 1 with the cursor to his
     right and 0 with it to his left; the far arm takes what is left over. */
  r.side = ease(r.side, clamp((s.arm.x - CHEST.x) / SIDE_SPAN, -1, 1), dt, TAU_SIDE);
  const nearW = (r.side + 1) / 2, farW = 1 - nearW;

  /* the wave belongs to whichever arm is not reaching, so it fades on the near
     arm's own weight, not on `reach`. It only advances while it can be seen,
     so returning to it starts from the top of the gesture. */
  const waving = 1 - r.reach * nearW;
  if(waving > .005) r.wave += dt / WAVE_MS;
  const waveA = Math.sin(r.wave * TWO_PI) * WAVE_DEG * waving;
  const waveH = Math.sin(r.wave * TWO_PI + .5) * WAVE_HAND * waving;
  /* rise and fall, so a cheer cannot be caught half-played and left there */
  const cheer = r.cheer > 0 ? Math.sin(r.cheer * Math.PI) : 0;

  const room = r.room;
  const reachL = clamp(reachAngle(SHOULDER_L, WRIST_L, s.arm), ARM_L_UP, ARM_L_DOWN);
  const reachR = clamp(reachAngle(SHOULDER_R, WRIST_R, s.arm),
                       ARM_R_BACK * room, ARM_R_REACH * room);
  /* the hand's own lead: the difference between where the wrist has got to and
     where the arm has got to is small, fast, and is the entire reason the hand
     reads as reaching rather than as being carried */
  const lead = clamp((s.hand.x - s.arm.x) * HAND_LEAD * 4, -HAND_LEAD, HAND_LEAD);

  const ang = {
    hips : s.hips.x * LEAN_HIPS * room,
    torso: s.torso.x * LEAN_TORSO * room + breath * BREATH_ROLL,
    head : s.head.x * TILT_HEAD * room - breath * HEAD_COUNTER - cheer * 2.5,
    legL : -s.hips.x * .7 * room,
    legR : -s.hips.x * .7 * room,
    uarmL: waveA + reachL * r.reach * nearW - cheer * CHEER_ARM,
    handL: waveH + (reachL * HAND_FOLLOW + lead) * r.reach * nearW
           + cheer * CHEER_HAND,
    uarmR: reachR * r.reach * farW - cheer * CHEER_ARM * .5,
    handR: (reachR * HAND_FOLLOW - lead) * r.reach * farW,
  };
  const off = {
    hips : { x:s.hips.x  * OFF_HIPS.x  * room,
             y:sink(s.hips.y  * OFF_HIPS.y  * room) - cheer * CHEER_HOP },
    torso: { x:s.torso.x * OFF_TORSO.x * room,
             y:sink(s.torso.y * OFF_TORSO.y * room) - breath * BREATH_Y },
    head : { x:s.head.x  * OFF_HEAD.x  * room,
             y:s.head.y  * OFF_HEAD.y  * room *
               (s.head.y > 0 ? HEAD_DOWN : RISE) },
    /* NOT scaled by `room`. That budget is about what can collide with the
       BOARD — an edge, a button, a speech balloon. The eyes and mouth slide
       inside the head and can only ever hit their own bezel, so a rig standing
       in a corner still gets the whole of its face. */
    eyes : { x:s.gaze.x  * OFF_EYES.x,  y:s.gaze.y  * OFF_EYES.y },
    mouth: { x:s.gaze.x  * OFF_MOUTH.x, y:s.gaze.y  * OFF_MOUTH.y },
  };

  for(const name of r.parts.keys()) write(r, name, ang, off);

  if(r.bubble){
    const bx = s.bub.x * BUBBLE.x * (s.bub.x > 0 ? BUBBLE_RIGHT : 1);
    r.bubble.style.translate = px2(bx * box.width) + "px "
      + px2(s.bub.y * BUBBLE.y * box.height) + "px";
    r.bubble.style.rotate = px2(s.bub.x * BUBBLE_TILT) + "deg";
  }
}

function step(now){
  frame = 0;
  let any = false;
  for(const r of rigs.values()){
    if(!r.running) continue;
    any = true;
    const dt = clamp(now - (r.last || now), 0, 50);
    r.last = now;
    advance(r, now, dt);
  }
  if(any) frame = requestAnimationFrame(step);
}

function pump(){ if(!frame) frame = requestAnimationFrame(step); }

function restPose(r){
  for(const el of r.parts.values()) el.style.removeProperty("transform");
  if(r.bubble){
    r.bubble.style.removeProperty("translate");
    r.bubble.style.removeProperty("rotate");
  }
}

function suspend(r){
  r.running = false;
  restPose(r);
}

/* ---------- public surface ---------- */

/* Mount every `[data-rig]` root in the document and start tracking the cursor.
   Idempotent: a screen module can call it without knowing whether another
   already has. */
export function wirePaperRigs(){
  for(const root of document.querySelectorAll("[data-rig]")){
    const id = root.dataset.rig;
    if(rigs.has(id)) continue;
    const r = makeRig(root);
    if(!r.canvas) continue;
    for(const el of root.querySelectorAll(".pr-part[data-j]")){
      if(CHAIN[el.dataset.j]) r.parts.set(el.dataset.j, el);
    }
    if(r.parts.size) rigs.set(id, r);
  }
  if(wired) return;
  wired = true;
  /* The cursor is tracked on the WINDOW, not on any one stage: he should
     already be looking at you by the time you arrive at him, and a hand that
     only starts moving once the pointer is over the robot is a hover state,
     not a character. */
  window.addEventListener("pointermove", onMove, { passive:true });
  window.addEventListener("pointerdown", onMove, { passive:true });
  /* on the ROOT ELEMENT, not on `document` — `pointerleave` is not reliably
     dispatched at the document node, and losing this only means he holds a
     reach at a cursor that has left the window until `IDLE_MS` catches it */
  document.documentElement.addEventListener("pointerleave", onLeave, { passive:true });
  window.addEventListener("blur", onLeave, { passive:true });
  const refresh = () => {
    for(const r of rigs.values()){
      if(!r.want) continue;
      if(motionPreference.matches || document.hidden) suspend(r);
      else startRig(r.root.dataset.rig);
    }
  };
  document.addEventListener("visibilitychange", refresh);
  if(motionPreference.addEventListener)
    motionPreference.addEventListener("change", refresh);
  else motionPreference.addListener?.(refresh);
}

/* `want` is what the screen asked for; `running` is whether a frame is
   actually scheduled. Reduced motion and a hidden tab suspend the second
   without forgetting the first, so turning either back on resumes rather than
   needing the screen to be re-entered. */
export function startRig(id){
  const r = rigs.get(id);
  if(!r) return;
  r.want = true;
  if(motionPreference.matches || document.hidden){ suspend(r); return; }
  if(r.running) return;
  r.running = true;
  r.last = 0;
  pump();
}

export function stopRig(id){
  const r = rigs.get(id);
  if(!r) return;
  r.want = false;
  suspend(r);
}

/* A tap answered with the body. No-op if the rig is not live, so a cheer can
   never be the thing that leaves him parked mid-pose. */
export function cheerRig(id){
  const r = rigs.get(id);
  if(!r || !r.running) return;
  r.cheer = 1;
}

export function rigIsMounted(id){ return rigs.has(id); }
