/* The GOT IT paper, stamped on the player who earned it.

   This replaces the standing score sign that used to sit in every seat for a
   whole match. That sign was on screen constantly, which meant it was never
   an EVENT: six green boxes holding six numbers is a spreadsheet, and the
   number a player actually cares about — what this word was worth — was a
   1.6-second flash inside it.

   So the paper goes back to being a stamp, and it is the same POINTS AWARD
   paper Solo lands centre stage (`sp-award.png`, GOT IT! / +N / POINTS!):

     · recognition  → it SLAMS onto that player's seat and stays there. For
       the rest of the word it is the answer to "who has already got this",
       which in 1v1 is exactly what the 5-second chase is about.
     · round end    → every stamped paper is DRAGGED into the score card it
       pays, and the total only moves when it arrives.

   Same object, same motion, same rule as Solo — only the launch point moved
   from the middle of the screen to the person who earned it.

   Why `position:fixed` on `document.body` rather than a child of the seat:
   `.pm-side` clips to `overflow:hidden` and every seat sits in its own
   stacking context, so a paper parked inside one is clipped at the seat edge
   and painted under the board the moment it starts flying. Solo's award has
   always been fixed for the same reason. The seat only supplies the
   geometry, refreshed on resize while a paper is up. */

import { prefersReducedMotion } from "./gameplayFeedback.js";

export const SEAT_AWARD_HOLD_MS = 420;    // readable beat before it is thrown
export const SEAT_AWARD_FLIGHT_MS = 560;  // ...then carried into the card

/* Where the paper sits on each kind of seat, as a fraction of that seat's own
   box: [centre-x, centre-y, width]. The party tile figure is Figma's — the
   "GOT IT Indicator" in frame 189:273 spans 81.6% of its tile's width, low in
   the portrait, clear of the name chip at the top and the crown on the head.
   Its centre is at 81.9% of the tile height there, but that paper is a thin
   one-line strip; this one is the three-line award and 6.8% of the stage tall.
   The centre tiles are authored OVERLAPPING, like stacked photos — orange1
   runs to 57% and orange2 starts at 50% — so a paper pinned that low covers
   the name chip of the tile beneath. .66 keeps the Figma reading (low in the
   portrait, not floating over the face) and clears every neighbour.

   THE HALF-SCREEN SEATS OBEY THE SAME READING, and that is a correction. They
   used to sit at .34 of the seat's height, which on a full-height half is
   34% of the stage — head height, and a party half is a PORTRAIT crop of a
   landscape camera, so a player standing back to pose has their face at
   roughly 12-30% of the stage and their body down the middle. The paper
   therefore landed square on the one thing you watch while holding a pose. It
   is now low in the frame like the tiles', in the band each half genuinely
   leaves empty: measured at 1440x810 the blue paper spans x 12.3-27.4% of the
   stage and y 55-67.8%, which clears the robot (ends 7.1%), the centre tiles
   (start 31.9%), the WORD TIME tape (starts y 70.9%) and the guess papers
   (start y 73.3%). Orange is the exact mirror. 1v1's halves are a different
   crop and keep their own figures. */
const PLACEMENT = [
  [".pm-tile",              .50, .66, .86],
  [".pm-side.blue",         .394, .614, .30],
  [".pm-side.orange",       .606, .614, .30],
  [".v1-video-side.you",    .32, .34, .34],
  [".v1-video-side.rival",  .68, .34, .34],
];

const live = new Set();
let resizeBound = false;

const fmt = n => "+" + (Number(n) || 0).toLocaleString("en-US");

function placementFor(seat){
  for(const spec of PLACEMENT) if(seat.matches(spec[0])) return spec;
  return [null, .5, .5, .6];
}

/* One paper per seat, cached on the seat element. Seats are stable DOM (they
   are re-tenanted between matches, never rebuilt), so this is a fixed pool of
   at most six rather than a node churned per word. */
function paperFor(seat){
  let node = seat._seatAward;
  if(node?.isConnected) return node;
  node = document.createElement("div");
  node.className = "pp-award";
  node.setAttribute("aria-hidden", "true");
  node.innerHTML =
    '<img class="sp-art" src="assets/ui/figma/sp-award.png" alt="">' +
    '<span class="aw-got">GOT IT!</span>' +
    '<span class="aw-pts">+0</span>' +
    '<span class="aw-lbl">POINTS!</span>';
  /* A fixed paper parked on <body> has nothing in the DOM tying it to its
     owner. Name it, so "whose award is that" is answerable from the element —
     party seats already carry their key, the 1v1 halves carry a class. */
  node.dataset.seat = seat.dataset.seat ||
    (seat.classList.contains("rival") ? "rival" : "you");
  document.body.appendChild(node);
  seat._seatAward = node;
  node._seat = seat;
  return node;
}

/* Fixed papers do not follow their seat, so the geometry is copied over on
   every stamp — and again on resize for anything still on the board. */
function place(node){
  const seat = node._seat;
  const box = seat?.getBoundingClientRect();
  if(!box?.width) return;
  const [, cx, cy, w] = placementFor(seat);
  node.style.width = (box.width * w) + "px";
  node.style.left = (box.left + box.width * cx) + "px";
  node.style.top = (box.top + box.height * cy) + "px";
}

function line(node, cls, text){
  const target = node.querySelector("." + cls);
  if(target && text != null) target.textContent = text;
}

function bump(node){
  if(!node) return;
  node.classList.remove("bump");
  void node.offsetWidth;
  node.classList.add("bump");
}

/* Pay the score this paper is carrying — exactly once, wherever it is when it
   happens. A paper swept mid-flight still has to release whatever repaint its
   mode is holding, or the score card freezes on the previous total. */
function pay(node){
  const to = node._to;
  node._to = null;
  to?.classList.remove("awaiting");
  if(to) bump(to);
  const land = node._land;
  node._land = null;
  land?.();
}

function hide(node){
  clearTimeout(node._timer);
  node._timer = null;
  node.classList.remove("show", "deliver");
  for(const prop of ["--fly-x", "--fly-y", "--fly-s", "--fly-r", "--fly-ms"])
    node.style.removeProperty(prop);
  live.delete(node);
}

function settle(node){
  if(!node) return;
  pay(node);
  hide(node);
}

/* SLAM. `points` is whatever the mode can quote at this instant — provisional
   is fine, `setSeatAwardPoints` reconciles it to the server's figure before
   the paper is thrown. */
export function stampSeatAward(seat, { title = "GOT IT!", points = 0,
                                       label = "POINTS!" } = {}){
  if(!seat) return null;
  const node = paperFor(seat);
  /* re-stamping a seat inside one word (a chase can) lands the old paper
     first, so its held repaint is never stranded */
  settle(node);
  line(node, "aw-got", title);
  line(node, "aw-pts", fmt(points));
  line(node, "aw-lbl", label);
  place(node);
  void node.offsetWidth;
  node.classList.add("show");
  live.add(node);
  if(!resizeBound){
    resizeBound = true;
    addEventListener("resize", () => {
      for(const paper of live)
        if(!paper.classList.contains("deliver")) place(paper);
    });
  }
  return node;
}

export function seatAwardIsUp(seat){
  return !!seat?._seatAward?.classList.contains("show");
}

/* The server resolves placement by timestamp at the END of the word, so the
   figure stamped at recognition is a quote from the shared formula. Correct
   the paper in place before it is thrown, rather than paying one number and
   printing another. */
export function setSeatAwardPoints(seat, points){
  const node = seat?._seatAward;
  if(!node?.classList.contains("show")) return;
  line(node, "aw-pts", fmt(points));
}

/* Throw it into the card it pays. `onLand` fires once, on arrival — the only
   moment a mode is allowed to repaint that score. Under reduced motion there
   is no flight to wait on, so it pays immediately and the paper simply sits
   for a readable beat: holding a score back for an animation nobody is
   playing just reads broken. */
export function deliverSeatAward(seat, toEl, { holdMs = SEAT_AWARD_HOLD_MS,
                                               onLand } = {}){
  const node = seat?._seatAward;
  if(!node?.classList.contains("show")){ onLand?.(); return; }
  clearTimeout(node._timer);
  node._land = onLand || null;
  node._to = toEl || null;

  if(prefersReducedMotion()){
    pay(node);
    node._timer = setTimeout(() => hide(node), 700);
    return;
  }

  toEl?.classList.add("awaiting");     // braces until the paper actually lands
  node._timer = setTimeout(() => {
    node._timer = null;
    aim(node, toEl);
    node.classList.add("deliver");
    node._timer = setTimeout(() => settle(node), SEAT_AWARD_FLIGHT_MS);
  }, Math.max(0, holdMs));
}

/* Centre-to-centre delta plus the scale that shrinks the paper into the card.
   The paper is centred on its own box by `translate:-50% -50%`, so the
   keyframes only ever touch `transform`. */
function aim(node, toEl){
  const from = node.getBoundingClientRect();
  const to = toEl?.getBoundingClientRect();
  if(!from.width || !to?.width) return;
  node.style.setProperty("--fly-x",
    (to.left + to.width / 2 - (from.left + from.width / 2)) + "px");
  node.style.setProperty("--fly-y",
    (to.top + to.height / 2 - (from.top + from.height / 2)) + "px");
  node.style.setProperty("--fly-s",
    Math.max(.12, Math.min(.7, (to.width * .8) / from.width)).toFixed(3));
  node.style.setProperty("--fly-r",
    (to.left + to.width / 2 < from.left + from.width / 2 ? -14 : 14) + "deg");
  node.style.setProperty("--fly-ms", SEAT_AWARD_FLIGHT_MS + "ms");
}

/* THE PAPER BELONGS TO THE PLAYER, NOT TO THE SEAT. Party hands the featured
   half over to a team-mate who is still performing once you are in, which
   exchanges two players between two seat elements mid-word — and a paper
   cached on the seat they left would stay on the board over somebody else,
   carrying somebody else's number into their team card. So the two seats
   trade papers along with everything else, and each one is re-placed against
   the box it now belongs to. There is no flight here on purpose: this is the
   same object being re-hung, not a payoff being delivered. */
export function swapSeatAwards(a, b){
  if(!a || !b || a === b) return;
  const nodeA = a._seatAward, nodeB = b._seatAward;
  a._seatAward = nodeB;
  b._seatAward = nodeA;
  for(const [node, seat] of [[nodeA, b], [nodeB, a]]){
    if(!node) continue;
    node._seat = seat;
    node.dataset.seat = seat.dataset.seat ||
      (seat.classList.contains("rival") ? "rival" : "you");
    if(node.classList.contains("show") && !node.classList.contains("deliver"))
      place(node);
  }
}

/* One seat — between words, and for a seat nobody is sitting in. */
export function clearSeatAward(seat){
  const node = seat?._seatAward;
  if(node) settle(node);
}

/* Every paper still on the board. Called wherever `clearCelebrations()` is:
   a fixed paper left mid-flight would sail across the Results screen, and any
   repaint it was carrying would never be released. */
export function clearSeatAwards(){
  for(const node of [...live]) settle(node);
  live.clear();
}
