/* Results — Figma "Results S1" (203:367 / 203:581) and "results breakdown"
   (211:635).

   Two beats on one screen:
     stage      the shared moment. Live faces behind torn borders, who won,
                and REMATCH as the loudest thing on screen.
     breakdown  the personal record. Per-player carousels of the stills we
                captured mid-round, one award each, three stat chips.

   Stills are grabbed from the video elements already on screen at the moment
   the AI recognises someone — that pose is the funny frame, not a posed shot
   afterwards — plus CANDIDS on a plain clock, so nobody's photos depend on
   their score. They live in memory only, are never uploaded, and are dropped
   when the screen closes. SEE PHOTO STRIPS lays them out on the Figma photo
   strip boards (js/photoStrips.js) and saves that board as one picture. */

import { $, esc } from "./dom.js";
import { state } from "./state.js";
import { toast } from "./ui.js";
import { blip } from "./audio.js";
import { gameState, transition, onTransition } from "./fsm.js";
import { mountCamera } from "./screens.js";
import { mountPhotoStrips, unmountPhotoStrips, renderPhotoStrips, stripSlots }
  from "./photoStrips.js";

const SHOT_W = 640, SHOT_H = 426;     // 3:2 — covers both the square thumb and the frame
/* TWO PHOTOS PER WORD, AND KEEP THEM ALL. There used to be one still per
   word and a cap of 8, so a good run lost most of its own photos before the
   breakdown ever showed them. Now every word a player gets yields a pair —
   the instant the AI locks it, and SHOT_PAIR_GAP_MS later, which is usually
   the reaction — and the reel flips through every one.
   MAX_SHOTS is a memory guard, not a design limit: the most words anybody can
   get in a two-minute run is about forty, so 2 x 40. Each still is a ~50KB
   JPEG data URL, and a six-player party holds six of these lists. */
const MAX_SHOTS = 80;                 // per player
const SHOT_PAIR_GAP_MS = 700;
const SEATS = ["blue0", "blue1", "blue2", "orange0", "orange1", "orange2"];

/* A PLAYER WHO SCORES NOTHING STILL GETS PHOTOS. Recognition stills only
   exist for words the AI got, so a player who went zero used to reach the
   photo strips with sixteen empty windows. CANDIDS are taken on a plain
   clock for everybody on the board while a word is live, and they fill the
   windows the recognition stills cannot. They are kept apart from `shots`
   so they can never push a real recognition out of MAX_SHOTS.
   MAX_CANDIDS is a memory guard. Past it the list is THINNED (every other
   still dropped), not trimmed from the front, so a long match keeps photos
   from its whole length rather than only from its end. */
const CANDID_MS = 4000, CANDID_FIRST_MS = 1500, MAX_CANDIDS = 48;

/* playerId -> [{url, word, moment, at}] — in memory for this results screen
   only. `moment` ties the two stills of one recognition together; `at` puts
   every still, candid or not, back in match order on the strips. */
const shots = new Map();
const candids = new Map();
/* () => [{id, video, mirror}] — whichever elements are showing each player.
   Each mode registers its own when a match starts. */
let candidSources = null;
let candidTimer = 0;
let shotCanvas = null;
let momentSeq = 0;
/* Bumped on every clear. The second still of a pair is taken on a timer, and
   one fired by the final word of a match must not land in a list that has
   since been emptied for the NEXT match's results. */
let shotEpoch = 0;

let payload = null;       // the match summary being displayed
let cycleTimer = 0;       // drives the GIF-style still cycle
/* A flipbook of the round, not a slideshow. It reads as a GIF only if the
   frames actually move; at 2600ms it read as a stalled slideshow that
   happened to change. Paired with the hard cut in CSS (no cross-fade, no
   scale) so each still simply replaces the last. */
const CYCLE_MS = 900;
let focusId = null;       // which player's carousel is open
let wired = false;
let awardFitFrame = 0;
let poseFitFrame = 0;
let awardMeasureCanvas = null;
let rematchPulseTimer = 0;
let rematchPendingTimer = 0;
let rematchVersion = 0;
let enterTimer = 0;
/* which pages have already played their assembly beat this results session */
const entered = new Set();

const stage = () => $("resStage");
const seatEl = k => document.querySelector('#resStage [data-seat="' + k + '"]');
const setTxt = (id, v) => { const e = $(id); if(e) e.textContent = v; };
const disp = n => (n || "Player").trim().slice(0, 10).toUpperCase() || "PLAYER";
const is1v1 = () => payload?.mode === "1v1";

/* The paper-assembly beat is an ARRIVAL, not a page transition. Driving it
   straight off [data-page] re-slammed every paper on screen each time you
   flipped stage <-> breakdown; it now runs once per page per results session
   under [data-enter], which is cleared as soon as the sequence lands. */
function setResultsPage(page){
  const st = stage();
  if(!st) return;
  st.dataset.page = page;
  /* papers that were display:none measured 0 — re-fit now they have a box */
  scheduleAwardFit();
  clearTimeout(enterTimer);
  if(entered.has(page)){ delete st.dataset.enter; return; }
  entered.add(page);
  st.dataset.enter = page;
  enterTimer = setTimeout(() => {
    enterTimer = 0;
    const el = stage();
    if(el && el.dataset.enter === page) delete el.dataset.enter;
  }, 820);
}

/* ---------------- capture ---------------- */

/* Called at each recognition: the pair for one word. `videoEl` is whichever
   element is already showing that player, so remote players are captured from
   their mesh feed without anything extra crossing the wire. The element is
   held by reference, so the second still follows the same player even if
   Party hands their seat over in the meantime. */
export function captureMoment(playerId, word, videoEl, mirror = false){
  if(!playerId || !videoEl) return;
  const moment = ++momentSeq, epoch = shotEpoch;
  captureShot(playerId, word, videoEl, mirror, moment);
  setTimeout(() => {
    if(epoch === shotEpoch) captureShot(playerId, word, videoEl, mirror, moment);
  }, SHOT_PAIR_GAP_MS);
}

/* One frame of `videoEl` as a JPEG data URL, or null. */
function stillOf(videoEl, mirror){
  if(!videoEl?.videoWidth || !videoEl.videoHeight) return null;
  if(!shotCanvas){
    shotCanvas = document.createElement("canvas");
    shotCanvas.width = SHOT_W; shotCanvas.height = SHOT_H;
  }
  const ctx = shotCanvas.getContext("2d");
  const vw = videoEl.videoWidth, vh = videoEl.videoHeight;
  /* cover-crop so the still frames like the on-screen tile did */
  const scale = Math.max(SHOT_W / vw, SHOT_H / vh);
  const dw = vw * scale, dh = vh * scale;
  ctx.save();
  ctx.clearRect(0, 0, SHOT_W, SHOT_H);
  if(mirror){ ctx.translate(SHOT_W, 0); ctx.scale(-1, 1); }
  ctx.drawImage(videoEl, (SHOT_W - dw) / 2, (SHOT_H - dh) / 2, dw, dh);
  ctx.restore();
  try{ return shotCanvas.toDataURL("image/jpeg", .72); }
  catch{ return null; }                     // tainted canvas: skip silently
}

/* One still. Exported on its own for the dev fixture, which seeds the reel. */
export function captureShot(playerId, word, videoEl, mirror = false, moment = 0){
  if(!playerId) return;
  const url = stillOf(videoEl, mirror);
  if(!url) return;
  const list = shots.get(playerId) || [];
  list.push({ url, word: word || "", moment: moment || ++momentSeq, at: performance.now() });
  while(list.length > MAX_SHOTS) list.shift();
  shots.set(playerId, list);
}

/* One candid. Exported for the dev fixture, like captureShot. */
export function captureCandid(playerId, videoEl, mirror = false){
  if(!playerId) return;
  const url = stillOf(videoEl, mirror);
  if(!url) return;
  let list = candids.get(playerId) || [];
  list.push({ url, word: "", moment: 0, at: performance.now() });
  if(list.length > MAX_CANDIDS) list = list.filter((_, i) => i % 2 === 1);
  candids.set(playerId, list);
}

/* Each mode hands over a way to find every player's video when its match
   starts. The clock itself runs off the FSM (see wireResults), so a mode
   never has to remember to stop it. */
export function setCandidSources(fn){
  candidSources = typeof fn === "function" ? fn : null;
}

const wordLive = () => gameState() === "playing" || gameState() === "word-won";

function candidTick(){
  candidTimer = 0;
  if(!wordLive() || !candidSources) return;
  let sources = [];
  try{ sources = candidSources() || []; }catch{ sources = []; }
  const epoch = shotEpoch;
  /* Staggered: six JPEG encodes on one frame is a hitch in a party of six. */
  sources.forEach((src, i) => setTimeout(() => {
    if(epoch === shotEpoch && wordLive()) captureCandid(src.id, src.video, src.mirror);
  }, i * 90));
  candidTimer = setTimeout(candidTick, CANDID_MS);
}

function stopCandids(){
  clearTimeout(candidTimer);
  candidTimer = 0;
}

export function clearShots(){ shots.clear(); candids.clear(); shotEpoch++; }

/* What a player's reel shows: their recognitions, or their candids when the
   AI never recognised them. Nobody reaches the breakdown with a blank frame
   because they had a bad round. */
function reelOf(id){
  const list = shots.get(id);
  return list?.length ? list : candids.get(id) || [];
}

/* Test hooks, read-only (same convention as fsm.js's _reset): a copy of one
   player's stills, so the suite can count them without a results screen. */
export const _shotsFor = id => (shots.get(id) || []).map(s => ({ ...s }));
export const _candidsFor = id => (candids.get(id) || []).map(s => ({ ...s }));

/* ---------------- awards ----------------
   Everyone gets exactly one. Ending a match with no callout is the difference
   between "fun" and "I got dunked on", so the generic tail is deliberate —
   and nothing in the list is an insult. */
const AWARD_POOL = [
  { key:"points",  title:"MENACE",   sub:"Most Points scored",  pick:ps => best(ps, p => p.score) },
  { key:"fast",    title:"PROPHET",  sub:"Fastest recognition", pick:ps => best(ps, p => p.fastest ? -p.fastest : -Infinity) },
  { key:"firsts",  title:"MACHINE",  sub:"Most first places",   pick:ps => best(ps, p => p.firsts || 0) },
  { key:"clutch",  title:"CLUTCH",   sub:"Scored in the chase", pick:ps => best(ps, p => p.clutch || 0) },
  { key:"steady",  title:"METRONOME",sub:"Most consistent",     pick:ps => best(ps, p => p.avg ? -p.avg : -Infinity) },
];
const AWARD_TAIL = [
  { title:"WILDCARD",  sub:"Kept us guessing" },
  { title:"ROMANTIC",  sub:"Played with feeling" },
  { title:"PHILOSOPHER",sub:"Took the scenic route" },
  { title:"LEGEND",    sub:"Showed up and posed" },
  { title:"SPECIALIST",sub:"Had a signature move" },
  { title:"NATURAL",   sub:"Made it look easy" },
];

function best(players, score){
  let top = null, topV = -Infinity;
  for(const p of players){
    const v = score(p);
    if(Number.isFinite(v) && v > topV){ topV = v; top = p; }
  }
  return topV === -Infinity ? null : top;
}

function assignAwards(players){
  const taken = new Set();
  for(const a of AWARD_POOL){
    const winner = a.pick(players.filter(p => !taken.has(p.id)));
    if(!winner) continue;
    winner.award = { title: a.title, sub: a.sub };
    taken.add(winner.id);
  }
  let t = 0;
  for(const p of players)
    if(!p.award) p.award = AWARD_TAIL[t++ % AWARD_TAIL.length];
}

/* ---------------- entry ---------------- */

export function showResults(next){
  payload = next;
  assignAwards(payload.players);
  focusId = (payload.players.find(p => p.mine) || payload.players[0])?.id || null;

  const st = stage();
  const mode = payload.mode || "party";
  entered.clear();
  /* Solo has no shared moment to hold, so its results and breakdown are one
     screen — the Figma frame carries both. Everyone else gets the two beats. */
  st.dataset.size = String(payload.size || 3);
  st.dataset.mode = mode;
  setResultsPage(mode === "solo" ? "solo" : "stage");
  const divider = st.querySelector(".rs-divider");
  if(divider)
    divider.src = mode === "1v1" || mode === "solo"
      ? "assets/ui/figma/v1-divider.webp"
      : "assets/ui/figma/pm-divider.webp";
  orderResultsControls(st.dataset.page);

  setTxt("rsHeadline", payload.headline || "GAME OVER");
  scheduleHeadlineFit();
  renderScoreLine();
  renderSeats();
  setRematchPending(false);
  renderRematch(false);
  if(mode === "solo"){
    renderPoseList();
    renderFocus();
  }
  if(gameState() !== "results") transition("results");
}

/* Solo's record is every pose of the run and what it paid, split into the two
   Figma columns. Missed words stay on the list at 0 — the run is the story. */
function renderPoseList(){
  const colA = $("rsPoseColA"), colB = $("rsPoseColB");
  if(!colA || !colB) return;
  const rounds = payload.rounds || [];
  const half = Math.ceil(rounds.length / 2);
  const row = r =>
    '<li><span class="pl-word">' + esc((r.word || "").toUpperCase()) + '</span>' +
    '<span class="pl-dash">-</span>' +
    '<span class="pl-pts' + (r.pts > 0 ? " got" : " missed") + '">' +
    plain(r.pts) + " Pts</span></li>";
  colA.innerHTML = rounds.slice(0, half).map(row).join("");
  colB.innerHTML = rounds.slice(half).map(row).join("");
  if(!rounds.length)
    colA.innerHTML = '<li class="pl-empty">No words this run.</li>';
  fitPoseList();
}

/* Figma sized these columns around "JUMPING - 560 Pts"; real decks carry
   "spiking a volleyball". Fit only the row that needs help so the remaining
   copy keeps the authored 27.44px type instead of shrinking both columns. */
function fitPoseList(){
  const list = $("rsPoseList");
  if(!list) return;
  cancelAnimationFrame(poseFitFrame);
  const rows = [...list.querySelectorAll("li")];
  rows.forEach(li => li.style.removeProperty("--pl-row-fs"));
  poseFitFrame = requestAnimationFrame(() => {
    poseFitFrame = 0;
    if(!rows.length) return;
    const factors = new Map();
    for(const li of rows){
      const avail = li.clientWidth;
      if(!avail) continue;
      const style = getComputedStyle(li);
      const gap = parseFloat(style.columnGap || style.gap) || 0;
      const want = [...li.children].reduce((sum, c) => sum + c.scrollWidth, 0) +
        gap * Math.max(0, li.children.length - 1);
      const factor = want > avail ? Math.max(.46, avail / want * .92) : 1;
      factors.set(li, factor);
      if(factor < 1) li.style.setProperty("--pl-row-fs", factor.toFixed(3));
    }
    /* Flex intrinsic widths and fractional font metrics can leave a few
       pixels beyond the paper even after the first canvas-style estimate.
       Reconcile against the browser's painted row until it is genuinely in. */
    for(const li of rows){
      if(!li.clientWidth) continue;
      let factor = factors.get(li) || 1;
      for(let pass=0; pass<4 && li.scrollWidth > li.clientWidth + .5; pass++){
        factor *= li.clientWidth / li.scrollWidth * .96;
        li.style.setProperty("--pl-row-fs", factor.toFixed(3));
      }
      factors.set(li, factor);
    }
    /* The authored text boxes run five 30px lines through a 145px frame and
       use the small clear strip above REMATCH. Real decks can be longer, so
       use all of that safe space without ever clipping under the button. */
    const rematchTop = $("rsRematch")?.getBoundingClientRect().top;
    let verticalFactor = 1;
    for(const col of list.querySelectorAll(".rs-posecol")){
      const top = col.getBoundingClientRect().top;
      const safeHeight = Number.isFinite(rematchTop)
        ? Math.max(col.clientHeight, rematchTop - top - 7)
        : col.clientHeight;
      if(col.scrollHeight > safeHeight && safeHeight)
        verticalFactor = Math.min(verticalFactor, safeHeight / col.scrollHeight * .985);
    }
    if(verticalFactor < 1){
      for(const li of rows){
        const factor = (factors.get(li) || 1) * verticalFactor;
        li.style.setProperty("--pl-row-fs", factor.toFixed(3));
      }
    }
  });
}

function renderScoreLine(){
  const el = $("rsScoreLine");
  if(!el) return;
  const t = payload.teams;
  if(!t){
    el.innerHTML = '<b class="blue">' + plain(payload.soloScore || 0) +
      '</b><i class="rs-score-sep"> POINTS</i>';
  }else{
    el.innerHTML = '<b class="blue">' + plain(t.blue) +
      '</b><i class="rs-score-sep"> - </i><b class="orange">' +
      plain(t.orange) + "</b>";
  }
  scheduleAwardFit();
}
const fmt = n => (n || 0).toLocaleString("en-US");
const plain = n => String(Math.round(n || 0));

function orderResultsControls(page){
  const rematch = $("rsRematch");
  const status = $("rsRematchStatus");
  if(!rematch) return;
  if(page === "solo") $("rsSeeStrips")?.after(rematch, status);
  else if(page === "breakdown") $("rsBack")?.after(rematch, status);
  else $("rsSeeBreakdown")?.before(rematch, status);
}

/* ---------------- stage page ---------------- */

function renderSeats(){
  const byTeam = { blue: [], orange: [] };
  for(const p of payload.players) (byTeam[p.team] || byTeam.blue).push(p);
  /* the local player takes their side's first seat, so you always see yourself
     in the same place you were during the match */
  for(const team of ["blue", "orange"]){
    const mine = byTeam[team].findIndex(p => p.mine);
    if(mine > 0) byTeam[team].unshift(byTeam[team].splice(mine, 1)[0]);
  }

  const occupied = SEATS.map(key => {
    const team = key.startsWith("blue") ? "blue" : "orange";
    return { key, team, p:byTeam[team][Number(key.slice(-1))] };
  });
  const local = occupied.find(entry => entry.p?.mine);
  const localEl = local ? seatEl(local.key) : null;
  const dock = $("cameraDock");
  const localMediaStable = !!(localEl && dock &&
    localEl.dataset.pid === local.p.id &&
    dock.parentElement === localEl.querySelector(".slot"));
  /* Never delete the one shared camera dock when a repeated results render
     rebuilds or vacates the local player's old seat. */
  if(dock?.closest("#resStage") && !localMediaStable)
    mountCamera($("slotHomePark"));

  for(const {key, team, p} of occupied){
    const el = seatEl(key);
    if(!el) continue;
    el.classList.toggle("vacant", !p);
    el.classList.toggle("gone", !!p?.gone);
    /* Pop the READY paper only when readiness actually turns on. Driving the
       animation off `.ready` alone replayed it every time the seat came back
       from display:none — i.e. on every flip to the breakdown and back. */
    const wasReady = el.classList.contains("ready");
    const nowReady = !!(p && p.ready);
    el.classList.toggle("ready", nowReady);
    if(!p){ el.innerHTML = ""; delete el.dataset.pid; continue; }
    const rebuilt = el.dataset.pid !== p.id;
    if(rebuilt){
      el.dataset.pid = p.id;
      el.innerHTML =
        '<div class="slot"></div>' +
        '<img class="rs-border" src="assets/ui/figma/pm-border-' + team + '.webp" alt="">' +
        '<div class="rs-nametag"><div class="rs-nametag-art">' +
        '<img src="assets/ui/figma/rs-nametag-' + team + '.webp" alt=""><b></b></div></div>' +
        '<div class="rs-ready"><img src="assets/ui/figma/rs-ready-paper.webp" alt=""><b>READY</b></div>';
    }
    /* after the rebuild, so a freshly built seat still has a paper to pop */
    if(nowReady && !wasReady && !rebuilt) popReady(el);
    else if(!nowReady) el.querySelector(".rs-ready")?.classList.remove("pop");
    el.querySelector(".rs-nametag b").textContent = disp(p.name);
    /* A departed player is never ready, so the READY paper's slot is free to
       say the one thing the board still owes the others: they are not coming
       back to this rematch. Same paper, greyed. */
    const stamp = el.querySelector(".rs-ready b");
    if(stamp) stamp.textContent = p.gone ? "LEFT" : "READY";
  }

  /* Local first keeps the shared dock out of any remote slot; every later
     pass then reconciles/reuses its own video or still without duplicates. */
  if(local) mountSeatVideo(seatEl(local.key), local.p);
  for(const entry of occupied)
    if(entry.p && !entry.p.mine) mountSeatVideo(seatEl(entry.key), entry.p);
}

function popReady(seat){
  const paper = seat.querySelector(".rs-ready");
  if(!paper) return;
  paper.classList.remove("pop");
  void paper.offsetWidth;
  paper.classList.add("pop");
  /* drop the class once it has played: a leftover .pop replays the whole pop
     the next time the seat comes back from display:none */
  clearTimeout(paper._popTimer);
  paper._popTimer = setTimeout(() => paper.classList.remove("pop"), 420);
}

const streamIsLive = stream =>
  stream.getVideoTracks?.().some(t => t.readyState === "live") ?? false;

/* Live faces are the whole point of this page, so the feeds keep running. */
function mountSeatVideo(el, p){
  const slot = el.querySelector(".slot");
  if(!slot) return;
  const removeDirect = selector => {
    for(const node of slot.querySelectorAll(":scope > " + selector)) node.remove();
  };
  if(p.mine){
    removeDirect("video");
    removeDirect("img");
    mountCamera(slot);
    return;
  }

  if($("cameraDock")?.parentElement === slot) mountCamera($("slotHomePark"));
  /* A rival who left ends the match with a stream whose tracks are already
     stopped — attaching it paints a black rectangle where their face was.
     Treat a dead stream as no stream and show their last still instead. */
  if(!p.gone && p.stream && streamIsLive(p.stream)){
    removeDirect("img");
    const videos = [...slot.querySelectorAll(":scope > video")];
    const v = videos.shift() || document.createElement("video");
    for(const extra of videos) extra.remove();
    v.className = "rs-seat-video";
    v.autoplay = true; v.playsInline = true; v.muted = true;
    if(v.parentElement !== slot) slot.appendChild(v);
    if(v.srcObject !== p.stream) v.srcObject = p.stream;
    v.play().catch(() => {});
    return;
  }
  /* no live feed (offline, or they left): fall back to their last still */
  removeDirect("video");
  const last = reelOf(p.id).slice(-1)[0];
  if(last){
    const images = [...slot.querySelectorAll(":scope > img")];
    const img = images.shift() || document.createElement("img");
    for(const extra of images) extra.remove();
    img.className = "rs-seat-still";
    if(img.src !== last.url) img.src = last.url;
    img.alt = "";
    if(img.parentElement !== slot) slot.appendChild(img);
  }else{
    removeDirect("img");
  }
}

function pulseRematch(btn, direction){
  btn.classList.remove("count-up", "count-down");
  /* Restart even when two server updates land in the same frame. */
  void btn.offsetWidth;
  btn.classList.add(direction > 0 ? "count-up" : "count-down");
  clearTimeout(rematchPulseTimer);
  rematchPulseTimer = setTimeout(() =>
    btn.classList.remove("count-up", "count-down"), 420);
}

function setRematchPending(pending, onTimeout){
  const btn = $("rsRematch");
  if(!btn) return;
  clearTimeout(rematchPendingTimer);
  rematchPendingTimer = 0;
  btn.classList.toggle("pending", !!pending);
  if(pending) btn.setAttribute("aria-busy", "true");
  else btn.removeAttribute("aria-busy");
  btn.disabled = !!pending;
  if(pending && onTimeout)
    rematchPendingTimer = setTimeout(onTimeout, 5000);
}

function renderRematch(animate = true){
  const r = payload.rematch;
  const btn = $("rsRematch");
  if(!btn) return;
  const total = Math.max(0, Number(r?.total ?? payload.players.length) || 0);
  const ready = Math.max(0, Math.min(total, Number(r?.ready) || 0));
  const mine = !!r?.mine;
  /* A departed player keeps their seat on this page, but they cannot stand on
     a team for the NEXT match — count only who is still in the room, or a 2-1
     roster reads as 2-2 and NEED 2 PER TEAM never appears. */
  const teams = { blue:0, orange:0 };
  for(const p of payload.players)
    if(!p.gone && (p.team === "blue" || p.team === "orange")) teams[p.team]++;
  const needsTeams = payload.mode === "party" && total > 0 && ready === total &&
    (teams.blue < 2 || teams.orange < 2);
  const previous = btn.dataset.ready === undefined ? null : Number(btn.dataset.ready);
  setTxt("rsRematchLabel",
    payload.mode === "solo"
      ? "REMATCH? READY UP!"
      : r?.unavailable
        ? "RIVAL LEFT"
      : r?.direct
        ? "PLAY AGAIN"
      : needsTeams
        ? "NEED  2  PER  TEAM"
        : "REMATCH?  " + ready + "/" + total + "  READY");
  scheduleRematchFit();
  btn.classList.toggle("mine", mine);
  btn.dataset.waiting = needsTeams ? "need-teams" : "";
  if((payload.mode === "party" || payload.mode === "1v1") && !r?.direct){
    btn.setAttribute("aria-pressed", String(mine));
    btn.setAttribute("aria-label",
      mine ? "Cancel rematch readiness" : "Ready for a rematch");
    setTxt("rsRematchStatus", needsTeams
      ? ready + " of " + total + " players ready. " +
        "Need at least 2 players on each team to rematch."
      : ready + " of " + total + " players ready. " +
        (mine ? "You are ready." : "You are not ready."));
  }else{
    btn.removeAttribute("aria-pressed");
    btn.setAttribute("aria-label", r?.unavailable ? "Rival left" : "Play again");
    setTxt("rsRematchStatus", r?.unavailable
      ? r.message || "Your rival left the room."
      : "");
  }
  btn.dataset.ready = String(ready);
  btn.dataset.mine = String(mine);
  if(animate && previous !== null && ready !== previous)
    pulseRematch(btn, ready - previous);
  btn.disabled = btn.classList.contains("pending") || !!r?.unavailable;
}

function syncPlayerReady(mine, voters){
  if(!payload) return;
  if(Array.isArray(voters)){
    const set = new Set(voters);
    for(const p of payload.players) p.ready = !p.gone && set.has(p.id);
    return;
  }
  const local = payload.players.find(p => p.mine);
  if(local) local.ready = !!mine;
}

/* The server remains authoritative. The optional voter list lets every
   READY paper mirror the shared tally, not just the local player's paper. */
export function setRematchState(ready, total, mine, voters){
  if(!payload) return;
  rematchVersion++;
  setRematchPending(false);
  payload.rematch = {
    ...(payload.rematch || {}),
    ready, total, mine, direct:false, unavailable:false,
  };
  syncPlayerReady(mine, voters);
  renderSeats();
  renderRematch(true);
}

export function setRematchUnavailable(message){
  if(!payload || payload.mode !== "1v1") return;
  rematchVersion++;
  setRematchPending(false);
  payload.rematch = {
    ...(payload.rematch || {}),
    ready:0, total:1, mine:false, direct:true, unavailable:true, message,
  };
  syncPlayerReady(false, []);
  renderSeats();
  renderRematch(false);
}

/* THE RESULTS SCREEN IS THE MATCH'S RECORD, SO NOBODY IS ERASED FROM IT.
   A party room survives here, and a player who walks out to the lobby used to
   be dropped from `payload.players` on the next roster event: their seat went
   vacant, their name, score, award and stat chips vanished from the
   breakdown, and their windows emptied out of the photo strips — on everyone
   else's screen, while the match they had just played together was still
   being read. They played the match; they stay on the page that reports it.
   `gone` is the only thing that changes: no live feed (their last still
   instead), no rematch vote, and a seat marked LEFT so the board is honest
   about who is still in the room. It all goes when the screen closes, with
   the stills. */
function markGone(player){
  if(!player || player.gone) return;
  player.gone = true;
  player.ready = false;
  player.stream = null;
}

/* 1v1's two players are built once at match end and never re-sent, so its
   departure arrives as a single event from online.js instead. */
export function markResultsPlayerGone(id){
  const player = payload?.players.find(p => p.id === id);
  if(!player) return;
  markGone(player);
  renderSeats();
  if(stage()?.dataset.page === "breakdown") renderBreakdown();
}

export function syncResultsRoster(nextPlayers = []){
  if(!payload || payload.mode !== "party" || !Array.isArray(nextPlayers)) return;
  const present = new Map(nextPlayers.map(member => [member.id, member]));
  for(const player of payload.players){
    const member = present.get(player.id);
    if(!member){ markGone(player); continue; }
    player.name = member.name;
    player.team = member.team;
  }

  const staying = payload.players.filter(p => !p.gone);
  const total = staying.length;
  const ready = staying.filter(p => p.ready).length;
  payload.rematch = {
    ...(payload.rematch || {}),
    ready: Math.min(total, ready),
    total,
    mine: !!payload.players.find(p => p.mine)?.ready,
  };

  renderSeats();
  renderRematch(true);
  if(stage()?.dataset.page === "breakdown") renderBreakdown();
}

function rollbackReadyVote(version, before, error){
  if(!payload || version !== rematchVersion) return;
  rematchVersion++;
  setRematchPending(false);
  payload.rematch = before;
  syncPlayerReady(before.mine);
  renderSeats();
  renderRematch(true);
  toast(error === "rate-limited"
    ? "Give it a beat, then try your rematch vote again."
    : "Couldn’t update rematch readiness. Try again.");
}

function toggleRematchReady(){
  if(!payload) return;
  if($("rsRematch")?.classList.contains("pending")) return;
  const votes = (payload.mode === "party" || payload.mode === "1v1") &&
    !payload.rematch?.direct;
  if(!votes){
    payload.onRematch?.();
    return;
  }

  const current = payload.rematch || {};
  const total = Math.max(0, Number(current.total ?? payload.players.length) || 0);
  const before = {
    ...current,
    ready: Math.max(0, Math.min(total, Number(current.ready) || 0)),
    total,
    mine: !!current.mine,
  };
  const mine = !before.mine;
  const ready = Math.max(0, Math.min(total, before.ready + (mine ? 1 : -1)));
  const version = ++rematchVersion;

  payload.rematch = { ...before, ready, mine };
  syncPlayerReady(mine);
  renderSeats();
  renderRematch(true);

  let result;
  try{
    result = payload.onRematch?.({ ready, total, mine });
  }catch(error){
    rollbackReadyVote(version, before, error?.message);
    return;
  }
  if(result?.error){
    rollbackReadyVote(version, before, result.error);
  }else if(result && typeof result.then === "function"){
    setRematchPending(true, () =>
      rollbackReadyVote(version, before, "timeout"));
    result.then(response => {
      if(response?.error){
        rollbackReadyVote(version, before, response.error);
      }else if(response?.waiting === "need-teams"){
        if(payload?.mode === "party" && gameState() === "results"){
          setRematchPending(false);
          renderRematch(false);
          toast("Need at least 2 players on each team to rematch.");
        }
      }else if(payload && version === rematchVersion){
        setRematchPending(false);
      }
    }).catch(error => rollbackReadyVote(version, before, error?.message));
  }
}

/* ---------------- breakdown page ---------------- */

function renderBreakdown(){
  for(const team of ["blue", "orange"]){
    const strip = $(team === "blue" ? "rsStripBlue" : "rsStripOrange");
    if(!strip) continue;
    strip.innerHTML = "";
    for(const p of payload.players.filter(x => x.team === team)){
      const t = document.createElement("button");
      t.type = "button";
      t.className = "rs-thumb" + (p.id === focusId ? " on" : "");
      t.dataset.pid = p.id;
      t.dataset.team = team;
      t.setAttribute("aria-pressed", String(p.id === focusId));
      t.setAttribute("aria-label", "View " + disp(p.name) + "’s result photos");
      const last = reelOf(p.id).slice(-1)[0];
      t.innerHTML =
        '<div class="shotwrap">' + (last ? '<img src="' + last.url + '" alt="">' : "") + "</div>" +
        '<img class="rs-border" src="assets/ui/figma/rs-photo-' + team + '.webp" alt="">' +
        '<div class="rs-nametag"><div class="rs-nametag-art">' +
        '<img src="assets/ui/figma/rs-nametag-' + team + '.webp" alt=""><b>' +
        esc(disp(p.name)) + "</b></div></div>";
      t.onclick = () => selectBreakdownPlayer(p.id, t);
      strip.appendChild(t);
    }
  }
  renderFocus();
  orderResultsControls("breakdown");
}

function syncThumbSelection(){
  document.querySelectorAll(".rs-thumb").forEach(t => {
    const selected = t.dataset.pid === focusId;
    t.classList.toggle("on", selected);
    t.setAttribute("aria-pressed", String(selected));
  });
}

function selectBreakdownPlayer(id, control){
  if(!payload?.players.some(p => p.id === id)) return;
  const changed = focusId !== id;
  focusId = id;
  syncThumbSelection();
  if(control){
    /* Re-selecting the open print should still feel like picking it up. */
    control.style.animation = "none";
    void control.offsetWidth;
    control.style.removeProperty("animation");
  }
  renderFocus();
  control?.focus({ preventScroll: true });
  if(changed) blip([523, 659], .05);
}

/* Paints one panel (frame + name + award + stats) for a given player.
   suffix "" is the primary panel; "B" is the mirrored 1v1 one. */
function paintPanel(suffix, p){
  if(!p) return;
  const list = reelOf(p.id);
  panelState.set(suffix, { suffix, pid: p.id, ix: 0 });

  const wrap = $("rsFocusShots" + suffix);
  if(wrap) wrap.innerHTML = list.length
    ? list.map((s, i) =>
        '<img class="' + (i === 0 ? "on" : "") + '" src="' + s.url +
        '" alt="" aria-hidden="' + (i === 0 ? "false" : "true") +
        '" data-active="' + (i === 0 ? "true" : "false") + '">').join("")
    : '<div class="rs-empty">No photos this round.<br>The camera took none while you played.</div>';

  /* The reel plays itself. It carries no tap, swipe or key handling, so it
     is described as a plain gallery rather than an interactive control. */
  const focus = $("rsFocus" + suffix);
  if(focus){
    /* `group` so aria-roledescription is valid, and live="off" so the label
       changing every few seconds does not make a screen reader chatter. */
    focus.setAttribute("role", "group");
    focus.setAttribute("aria-roledescription", "photo gallery");
    focus.setAttribute("aria-live", "off");
  }

  const tag = $("rsFocusName" + suffix);
  if(tag){
    tag.querySelector("img").src = "assets/ui/figma/rs-nametag-" + p.team + ".webp";
    tag.querySelector("b").textContent = disp(p.name);
    tag.classList.toggle("orange", p.team === "orange");
  }
  setTxt("rsShotWord" + suffix, list.length ? (list[0].word || "").toUpperCase() : "");
  syncPanelA11y({ suffix, pid:p.id, ix:0 });

  const A = suffix === "B" ? "B" : "";
  setAwardText("rsAward" + (A ? "TitleB" : "Title"), p.award.title);
  setAwardText("rsAward" + (A ? "SubB" : "Sub"), p.award.sub);
  const chip = n => "rsStat" + (A ? "B" + n : n);
  statChip(chip(1), fmt(p.score) + " PTS");
  statChip(chip(2), p.avg ? p.avg.toFixed(1) + " AVG" : "0.0 AVG");
  statChip(chip(3), (p.firsts || 0) + (p.firsts === 1 ? " First" : " Firsts"));
}

function renderFocus(){
  const p = payload.players.find(x => x.id === focusId);
  if(!p) return;
  syncThumbSelection();
  panelState.clear();

  if(is1v1()){
    /* both players are on screen at once, so there is nothing to arrow past */
    paintPanel("", payload.players.find(x => x.team === "blue") || p);
    paintPanel("B", payload.players.find(x => x.team === "orange"));
  }else{
    paintPanel("", p);
  }

  /* arrows step between players, and only earn their place when there is
     more than one to step to */
  const many = breakdownOrder().length > 1 && payload.mode === "party";
  if($("rsPrev")) $("rsPrev").style.visibility = many ? "visible" : "hidden";
  if($("rsNext")) $("rsNext").style.visibility = many ? "visible" : "hidden";

  scheduleAwardFit();
  startShotCycle();
}

function statChip(id, text){
  const el = $(id);
  if(el) el.querySelector("b").textContent = text;
}

function setAwardText(id, text){
  const node = $(id);
  if(!node) return;
  node.dataset.fullText = text || "";
  node.textContent = text || "";
  node.classList.remove("fit-wrap");
  node.style.fontSize = "";
  node.style.scale = "";
}

function awardLineWidth(node, text = node.textContent || ""){
  if(!awardMeasureCanvas) awardMeasureCanvas = document.createElement("canvas");
  const ctx = awardMeasureCanvas.getContext("2d");
  if(!ctx) return node.scrollWidth;
  const style = getComputedStyle(node);
  ctx.font = [
    style.fontStyle,
    style.fontVariant,
    style.fontWeight,
    style.fontSize,
    style.fontFamily,
  ].join(" ");
  const spacing = parseFloat(style.letterSpacing) || 0;
  return ctx.measureText(text).width +
    Math.max(0, text.length - 1) * spacing;
}

/* Figma sizes each paper against exactly one sample string — "LOGAN WINS!",
   "REMATCH? 4/6 READY", "420 PTS". Real names, real tallies and six-figure
   scores are longer. Shrink a single line until it fits its box, whatever
   unit authored it: clear the inline size so the responsive rule recomputes,
   measure with the canvas (never a transform-inflated client rect), then
   translate the overflow back into px. `room` is the Figma text box as a
   fraction of the paper, so type never touches a torn edge. */
function fitLine(node, room = .95, floor = .58){
  if(!node) return;
  node.style.fontSize = "";
  node.style.scale = "";
  if(!node.clientWidth) return;
  const base = parseFloat(getComputedStyle(node).fontSize) || 0;
  if(!base) return;
  const available = node.clientWidth * room;
  const wanted = awardLineWidth(node);
  if(wanted <= available || !wanted) return;
  const fitted = Math.max(base * floor, base * available / wanted * .99);
  node.style.fontSize = fitted + "px";
  const remaining = awardLineWidth(node);
  if(remaining > available)
    node.style.scale = Math.min(1, available / remaining * .99) + " 1";
}

function fitAwardLine(id, baseCqw, minimumCqw){
  const node = $(id);
  if(!node || !node.clientWidth) return;
  const fullText = node.dataset.fullText ?? node.textContent ?? "";
  node.classList.remove("fit-wrap");
  node.textContent = fullText;
  node.style.fontSize = baseCqw + "cqw";
  node.style.scale = "";
  const available = node.clientWidth * .955;
  const wanted = awardLineWidth(node, fullText);
  if(wanted <= available) return;

  const fitted = Math.max(minimumCqw, baseCqw * available / wanted * .985);
  node.style.fontSize = fitted + "cqw";
  const remaining = awardLineWidth(node, fullText);
  if(remaining > available)
    node.style.scale = Math.min(1, available / remaining * .99) + " 1";
}

function fitAwardDescription(id = "rsAwardSub"){
  const node = $(id);
  if(!node || !node.clientWidth) return;
  const fullText = (node.dataset.fullText ?? node.textContent ?? "").trim();
  const baseCqw = 12.362;
  node.classList.remove("fit-wrap");
  node.textContent = fullText;
  node.style.fontSize = baseCqw + "cqw";
  node.style.scale = "";

  const oneLineAvailable = node.clientWidth * .955;
  const oneLineWidth = awardLineWidth(node, fullText);
  if(oneLineWidth <= oneLineAvailable) return;

  /* Preserve the authored single-line card whenever a modest reduction is
     enough. Truly long descriptions become two deliberately balanced lines. */
  const oneLineFit = baseCqw * oneLineAvailable / oneLineWidth * .985;
  if(oneLineFit >= 8.4){
    node.style.fontSize = oneLineFit + "cqw";
    return;
  }

  const words = fullText.split(/\s+/).filter(Boolean);
  if(words.length < 2){
    fitAwardLine(id, baseCqw, 6.2);
    return;
  }

  let best = null;
  for(let i = 1; i < words.length; i++){
    const first = words.slice(0, i).join(" ");
    const second = words.slice(i).join(" ");
    const a = awardLineWidth(node, first);
    const b = awardLineWidth(node, second);
    const score = Math.max(a, b) + Math.abs(a - b) * .18;
    if(!best || score < best.score) best = { first, second, width: Math.max(a, b), score };
  }

  node.classList.add("fit-wrap");
  node.innerHTML = esc(best.first) + "<br>" + esc(best.second);
  const available = node.clientWidth * .96;
  const fitted = Math.max(6.2, Math.min(baseCqw,
    baseCqw * available / best.width * .985));
  node.style.fontSize = fitted + "cqw";
  const remaining = Math.max(
    awardLineWidth(node, best.first),
    awardLineWidth(node, best.second));
  if(remaining > available)
    node.style.scale = Math.min(1, available / remaining * .99) + " 1";
}

function scheduleAwardFit(){
  cancelAnimationFrame(awardFitFrame);
  awardFitFrame = requestAnimationFrame(() => {
    awardFitFrame = 0;
    fitAwardLine("rsAwardTitle", 20.603, 8.8);
    fitAwardDescription();
    if(is1v1()){
      fitAwardLine("rsAwardTitleB", 20.603, 8.8);
      fitAwardDescription("rsAwardSubB");
    }
    /* Figma text boxes as a fraction of their paper: headline 42.02/45.56,
       rematch 46.94/51.50; the score line is already inset by CSS. */
    fitLine($("rsHeadline"), .922);
    fitLine($("rsScoreLine"), .97);
    fitLine($("rsRematchLabel"), .911);
    /* the stat chips sit at a Figma rotation and their type is nudged
       sideways by --text-x, so they need more slack than a centred paper */
    for(const id of ["rsStat1", "rsStat2", "rsStat3",
                     "rsStatB1", "rsStatB2", "rsStatB3"])
      fitLine($(id)?.querySelector("b"), .87);
  });
}
/* the same pass — named at each call site for what triggered it */
const scheduleHeadlineFit = scheduleAwardFit;
const scheduleRematchFit = scheduleAwardFit;

/* The arrows move between PLAYERS. The stills cycle themselves — see
   startShotCycle — so there is nothing to step through by hand. */
function step(dir){
  const order = breakdownOrder();
  if(order.length < 2) return;
  const at = Math.max(0, order.findIndex(p => p.id === focusId));
  const next = order[(at + dir + order.length) % order.length];
  selectBreakdownPlayer(next.id,
    document.querySelector('.rs-thumb[data-pid="' + CSS.escape(next.id) + '"]'));
}

/* blue side first, then orange — the order the thumbnails are stacked in */
function breakdownOrder(){
  if(!payload) return [];
  return [...payload.players.filter(p => p.team === "blue"),
          ...payload.players.filter(p => p.team === "orange")];
}

/* The stills play themselves — a little GIF of the round. There is no tap,
   swipe or key handling on the reel in any mode, and hovering it does not
   pause: it just runs. The only thing that stops it is the tab going away.

   Reduced motion still advances, because the point of the screen is seeing
   your photos; the CSS drops the cross-fade to a plain cut instead. */
function startShotCycle(){
  stopShotCycle();
  /* nothing to animate under the photo strips, which cover the whole stage */
  if(document.hidden || stripsOpen()) return;
  cycleTimer = setInterval(() => {
    let moved = false;
    for(const panel of visiblePanels()){
      const list = reelOf(panel.pid);
      if(list.length < 2) continue;
      panel.ix = (panel.ix + 1) % list.length;
      paintPanelFrame(panel);
      moved = true;
    }
    if(!moved) stopShotCycle();
  }, CYCLE_MS);
}
function stopShotCycle(){ if(cycleTimer){ clearInterval(cycleTimer); cycleTimer = 0; } }

/* the panels currently on screen, each tracking its own place in the loop */
const panelState = new Map();   // suffix ("" | "B") -> {suffix, pid, ix}
function visiblePanels(){
  return [...panelState.values()].filter(st => {
    const el = $("rsFocus" + st.suffix);
    return el && getComputedStyle(el).display !== "none";
  });
}
function syncPanelA11y(panel){
  const focus = $("rsFocus" + panel.suffix);
  if(!focus) return;
  const list = reelOf(panel.pid);
  const p = payload?.players.find(player => player.id === panel.pid);
  focus.dataset.shotIndex = String(panel.ix);
  focus.setAttribute("aria-label", list.length
    ? disp(p?.name) + " result photo " + (panel.ix + 1) + " of " + list.length
    : disp(p?.name) + " has no captured result photos.");
}

/* Swap which still is showing. No direction, because nothing steps it by
   hand any more — the reel only ever moves forward, on its own clock. */
function paintPanelFrame(panel){
  const wrap = $("rsFocusShots" + panel.suffix);
  if(!wrap) return;
  const imgs = wrap.querySelectorAll("img");
  imgs.forEach((im, i) => {
    const active = i === panel.ix;
    im.classList.toggle("on", active);
    im.setAttribute("aria-hidden", String(!active));
    im.dataset.active = String(active);
  });
  const list = reelOf(panel.pid);
  setTxt("rsShotWord" + panel.suffix,
    list.length ? (list[panel.ix]?.word || "").toUpperCase() : "");
  syncPanelA11y(panel);
}

/* ---------------- photo strips ----------------
   SEE PHOTO STRIPS opens a board of paper photo-booth strips over the whole
   stage (js/photoStrips.js), filled from the stills this match kept, and its
   SAVE button writes that exact board out as one picture. Nothing leaves the
   machine: the stills are in-memory data URLs and the picture is made on a
   local canvas.

   Which windows are whose:
   - Solo: all sixteen are yours, under your name.
   - 1v1: the two strips under each name tag are that player's eight.
   - Party: each team fills its own three strips under BLUE TEAM / RED TEAM.
     Three players get one strip each; two split the twelve windows six and
     six, in reading order; one alone gets all twelve. */

/* Recognition poses first (the first still of each pair), then the
   reactions, then candids, each pool spread evenly over the match rather
   than taken from its start. The picks go back into match order, so a strip
   reads top to bottom as the round did. */
function photosFor(id, n){
  if(n <= 0) return [];
  const seen = new Set(), poses = [], reactions = [];
  for(const s of shots.get(id) || []){
    (seen.has(s.moment) ? reactions : poses).push(s);
    seen.add(s.moment);
  }
  const pick = [];
  for(const pool of [poses, reactions, candids.get(id) || []]){
    if(pick.length >= n) break;
    pick.push(...spread(pool, n - pick.length));
  }
  return pick.sort((a, b) => a.at - b.at).map(s => s.url);
}
const spread = (list, k) => list.length <= k ? list.slice()
  : Array.from({ length:k }, (_, i) => list[Math.floor((i + .5) * list.length / k)]);
/* the i-th of `parts` contiguous, near-equal runs of `total` */
const runLength = (total, parts, i) =>
  Math.floor(total * (i + 1) / parts) - Math.floor(total * i / parts);

function stripSpec(){
  const mode = payload.mode;
  const layout = mode === "solo" ? "solo" : mode === "1v1" ? "1v1" : "party";
  const slots = stripSlots(layout);
  const teams = { blue: [], orange: [] };
  for(const p of payload.players) (teams[p.team] || teams.blue).push(p);
  /* your own photos lead your side, as your seat does on the stage page */
  for(const side of ["blue", "orange"]){
    const mine = teams[side].findIndex(p => p.mine);
    if(mine > 0) teams[side].unshift(teams[side].splice(mine, 1)[0]);
  }
  if(layout === "solo") teams.blue = payload.players.slice(0, 1);
  const photos = {}, owners = {};
  for(const side of ["blue", "orange"]){
    const players = teams[side];
    const runs = players.map((p, i) => ({ p, n: runLength(slots[side], players.length, i) }));
    photos[side] = runs.flatMap(({ p, n }) => {
      const urls = photosFor(p.id, n);
      return urls.concat(Array(Math.max(0, n - urls.length)).fill(null));
    });
    owners[side] = runs.flatMap(({ p, n }) => Array(n).fill(p.id));
  }
  const labels = layout === "party"
    ? { blue: "BLUE TEAM", orange: "RED TEAM" }
    : { blue: teams.blue[0] ? disp(teams.blue[0].name) : "",
        orange: teams.orange[0] ? disp(teams.orange[0].name) : "" };
  const names = layout === "party" ? ["team"]
    : [...teams.blue, ...teams.orange].map(p => slug(p.name));
  return { layout, labels, photos, owners,
    filename: "pose-party-" + names.join("-vs-") + "-photo-strips.jpg" };
}

const slug = name => String(name || "strip").toLowerCase().replace(/\W+/g, "-")
  .replace(/^-|-$/g, "") || "player";

let stripsSpec = null;
const stripsOpen = () => !!stage()?.dataset.strips;

function openPhotoStrips(){
  if(!payload || stripsOpen()) return;
  stripsSpec = stripSpec();
  mountPhotoStrips($("psBoard"), stripsSpec);
  const names = Object.values(stripsSpec.labels).filter(Boolean);
  $("psBoard").setAttribute("aria-label", "Photo strips" +
    (names.length ? ": " + names.join(" and ") : ""));
  stage().dataset.strips = "open";
  stopShotCycle();
  $("psSave")?.focus({ preventScroll:true });
  blip([659, 784, 988], .06);
}

function closePhotoStrips({ quiet = false } = {}){
  const st = stage();
  if(!st?.dataset.strips) return;
  delete st.dataset.strips;
  unmountPhotoStrips();
  stripsSpec = null;
  if(quiet) return;
  startShotCycle();
  $("rsSeeStrips")?.focus({ preventScroll:true });
  blip([494, 392], .06);
}

async function savePhotoStrips(){
  const btn = $("psSave");
  if(!payload || !btn || btn.disabled) return;
  const spec = stripsSpec || stripSpec();
  btn.disabled = true;
  btn.setAttribute("aria-busy", "true");
  try{
    const { blob, drawn, wanted } = await renderPhotoStrips(spec, 2);
    if(!blob) throw new Error("encode");
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.download = spec.filename;
    a.href = url;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    toast(!wanted ? "Photo strips saved. The camera took no photos this round."
      : drawn === wanted ? "Photo strips saved."
      : "Photo strips saved with the photos that loaded.");
  }catch{
    toast("Couldn’t save the photo strips. Try again.");
  }finally{
    btn.disabled = false;
    btn.removeAttribute("aria-busy");
  }
}

/* Test hook, read-only: who owns each window, per side, without photos. */
export const _stripSpecForTest = () => {
  if(!payload) return null;
  const { layout, labels, owners, photos, filename } = stripSpec();
  return { layout, labels, owners, filename,
    filled: Object.fromEntries(Object.entries(photos).map(([k, v]) => [k, v.filter(Boolean).length])) };
};

/* Test hook: the picture SAVE would download, as base64 JPEG, without the
   download. e2e/_stripshot.mjs writes it to disk to look at. */
export async function _renderStripsForTest(){
  if(!payload) return null;
  const { blob } = await renderPhotoStrips(stripsSpec || stripSpec(), 2);
  const url = await new Promise(resolve => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.readAsDataURL(blob);
  });
  return String(url).split(",")[1] || null;
}

function teardownResultsMedia(){
  stopShotCycle();
  closePhotoStrips({ quiet:true });
  panelState.clear();
  entered.clear();
  clearTimeout(enterTimer);
  enterTimer = 0;
  delete stage()?.dataset.enter;
  const dock = $("cameraDock");
  if(dock?.closest("#resStage")) mountCamera($("slotHomePark"));
  for(const el of document.querySelectorAll("#resStage .rs-seat")){
    for(const video of el.querySelectorAll("video")){
      video.pause?.();
      video.srcObject = null;
      video.removeAttribute("src");
    }
    el.replaceChildren();
    delete el.dataset.pid;
    el.classList.remove("ready");
    el.classList.add("vacant");
  }
  $("rsStripBlue")?.replaceChildren();
  $("rsStripOrange")?.replaceChildren();
  $("rsPoseColA")?.replaceChildren();
  $("rsPoseColB")?.replaceChildren();
  for(const suffix of ["", "B"]){
    $("rsFocusShots" + suffix)?.replaceChildren();
    const focus = $("rsFocus" + suffix);
    if(!focus) continue;
    focus.removeAttribute("role");
    focus.removeAttribute("aria-roledescription");
    focus.removeAttribute("aria-label");
    delete focus.dataset.shotIndex;
  }
}

/* ---------------- wiring ---------------- */

export function wireResults(){
  if(wired) return;
  wired = true;

  $("rsSeeBreakdown").onclick = () => {
    setResultsPage("breakdown");
    renderBreakdown();
    orderResultsControls("breakdown");
    blip([659, 784], .06);
  };
  $("rsBack").onclick = () => {
    setResultsPage("stage");
    orderResultsControls("stage");
    renderSeats();
    blip([494, 392], .06);
  };
  $("rsPrev").onclick = () => step(-1);
  $("rsNext").onclick = () => step(1);
  $("rsSeeStrips").onclick = openPhotoStrips;
  $("psBack").onclick = () => closePhotoStrips();
  $("psSave").onclick = savePhotoStrips;
  $("rsRematch").onclick = toggleRematchReady;
  addEventListener("resize", () => {
    scheduleAwardFit();
    fitPoseList();
  });
  document.fonts?.ready.then(() => {
    scheduleAwardFit();
    fitPoseList();
  });
  if("ResizeObserver" in globalThis && $("rsPoseList"))
    new ResizeObserver(() => {
      if(stage()?.dataset.page === "solo") fitPoseList();
    }).observe($("rsPoseList"));

  /* The photo reels carry no handlers at all — no tap, no swipe, no keys.
     They auto-advance and that is the whole interaction. The arrow keys
     still step between PLAYERS on the party breakdown, which is what the
     on-screen arrows do too. */
  addEventListener("keydown", e => {
    if(gameState() !== "results") return;
    /* Esc backs out of the photo strips, the way BACK TO RESULTS does */
    if(stripsOpen()){
      if(e.key === "Escape" && !e.repeat){ e.preventDefault(); closePhotoStrips(); }
      return;
    }
    if(stage().dataset.page !== "breakdown" || is1v1()) return;
    if(e.key === "ArrowLeft") step(-1);
    if(e.key === "ArrowRight") step(1);
  });

  document.addEventListener("visibilitychange", () => {
    if(gameState() !== "results") return;
    if(document.hidden) stopShotCycle();
    else if(!stripsOpen()) startShotCycle();
  });

  onTransition((to, from) => {
    /* A new match starts with no photos. Leaving results already clears
       them, but a match abandoned with Esc never reaches results, and its
       stills would otherwise land in the NEXT match's strips. */
    if(to === "countdown") clearShots();
    /* candids run while a word can be live, and only then */
    if(to === "playing" && !candidTimer)
      candidTimer = setTimeout(candidTick, CANDID_FIRST_MS);
    if(to !== "playing" && to !== "word-won") stopCandids();
    /* stills are for this results screen only */
    if(from === "results" && to !== "results"){
      clearShots();
      teardownResultsMedia();
      cancelAnimationFrame(awardFitFrame);
      cancelAnimationFrame(poseFitFrame);
      clearTimeout(rematchPulseTimer);
      clearTimeout(rematchPendingTimer);
      setRematchPending(false);
      rematchVersion++;
      payload = null;
    }
  });
}

/* ---------------- dev fixture ----------------
   Opens either results layout without playing a match: your camera fills every
   seat and the carousels are seeded from your own feed. */
export async function devResults(kind = "3v3"){
  const WORDS = ["jumping jacks", "punching", "t-rex", "hula hoop", "guitar", "saluting"];
  const seed = async players => {
    const v = $("video");
    if(!v || !v.videoWidth) return;
    for(let i = 0; i < 4; i++){
      for(const p of players)
        captureShot(p.id, WORDS[(i + players.indexOf(p)) % WORDS.length], v, true);
      await new Promise(r => setTimeout(r, 160));
    }
    /* and a match's worth of candids, so every photo-strip window has one */
    for(let i = 0; i < 12; i++){
      for(const p of players) captureCandid(p.id, v, true);
      await new Promise(r => setTimeout(r, 60));
    }
  };
  const mk = (id, name, team, mine, i) => ({
    id, name, team, mine, stream: state.mediaStream || null,
    score: 420 - i * 70 + (team === "orange" ? -40 : 0),
    firsts: Math.max(0, 2 - i), fastest: 1.4 + i * .6, avg: 2.1 + i * .5,
    clutch: i === 1 ? 90 : 0, ready: team === "blue" && i === 1,
  });

  /* ---- solo: results and breakdown on one screen ---- */
  if(kind === "solo"){
    const me = mk("me", "LOGAN", "blue", true, 0);
    /* The reference frame deliberately demonstrates a 420-point stat while
       the whole run totals 1460; real matches continue to use their payload. */
    me.score = 420;
    showResults({
      mode: "solo", size: 1, headline: "GAME OVER",
      teams: null, soloScore: 1460, players: [me],
      rounds: WORDS.concat(WORDS.slice(0, 4)).map((w, i) =>
        ({ word: w, pts: i % 3 === 1 ? 0 : 560 })),
      rematch: { ready: 0, total: 1, mine: false },
      onRematch: () => toast("Dev fixture: nothing to rematch into."),
    });
    await seed([me]);
    renderFocus();
    return;
  }

  /* ---- 1v1: two full-half seats, then both players side by side ---- */
  if(kind === "1v1" || kind === "1v1-breakdown"){
    const players = [mk("me", "LOGAN", "blue", true, 0), mk("foe", "FRED", "orange", false, 1)];
    players[0].ready = true;
    showResults({
      mode: "1v1", size: 2, headline: "LOGAN WINS!",
      teams: { blue: 1460, orange: 1280 }, players,
      rematch: { ready: 1, total: 2, mine: true },
      onRematch: () => toast("Dev fixture: nothing to rematch into."),
    });
    await seed(players);
    if(kind === "1v1-breakdown"){
      setResultsPage("breakdown");
      renderBreakdown();
    }
    return;
  }

  /* ---- party ---- */
  const size = kind === "2v2" ? 2 : 3;
  const names = { blue: ["LOGAN", "MIA", "SAM"], orange: ["FRED", "ZOE", "NIA"] };
  const players = [];
  for(const team of ["blue", "orange"])
    for(let i = 0; i < size; i++)
      players.push(mk(team + i, names[team][i], team, team === "blue" && i === 0, i));

  showResults({
    mode: "party", size,
    headline: "BLUE TEAM WINS!",
    teams: { blue: 1460, orange: 1280 },
    players,
    rematch: kind === "breakdown"
      ? { ready: 2, total: 4, mine: false }
      : { ready: size === 2 ? 2 : 4, total: size * 2, mine: false },
    onRematch: () => toast("Dev fixture: no room to rematch into."),
  });
  await seed(players);
  if(kind === "breakdown"){
    setResultsPage("breakdown");
    renderBreakdown();
  }
}
