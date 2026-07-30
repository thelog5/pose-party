/* Results — Figma "Results S1" (203:367 / 203:581) and "results breakdown"
   (211:635).

   Two beats on one screen:
     stage      the shared moment. Live faces behind torn borders, who won,
                and REMATCH as the loudest thing on screen.
     breakdown  the personal record. Per-player carousels of the stills we
                captured mid-round, one award each, three stat chips.

   Stills are grabbed from the video elements already on screen at the moment
   the AI recognises someone — that pose is the funny frame, not a posed shot
   afterwards. They live in memory only, are never uploaded, and are dropped
   when the screen closes. */

import { $, esc } from "./dom.js";
import { state } from "./state.js";
import { toast } from "./ui.js";
import { blip } from "./audio.js";
import { gameState, transition, onTransition } from "./fsm.js";
import { mountCamera } from "./screens.js";

const SHOT_W = 640, SHOT_H = 426;     // 3:2 — covers both the square thumb and the frame
const MAX_SHOTS = 8;                  // per player
const SEATS = ["blue0", "blue1", "blue2", "orange0", "orange1", "orange2"];

/* playerId -> [{url, word}] — in memory for this results screen only */
const shots = new Map();
let shotCanvas = null;

let payload = null;       // the match summary being displayed
let cycleTimer = 0;       // drives the GIF-style still cycle
const CYCLE_MS = 900;     // one beat per still
let focusId = null;       // which player's carousel is open
let shotIx = 0;
let wired = false;
let awardFitFrame = 0;
let awardMeasureCanvas = null;
let rematchPulseTimer = 0;
let rematchPendingTimer = 0;
let rematchVersion = 0;

const stage = () => $("resStage");
const seatEl = k => document.querySelector('#resStage [data-seat="' + k + '"]');
const setTxt = (id, v) => { const e = $(id); if(e) e.textContent = v; };
const disp = n => (n || "Player").trim().slice(0, 10).toUpperCase() || "PLAYER";

/* ---------------- capture ---------------- */

/* Called at each recognition. `videoEl` is whichever element is already
   showing that player, so remote players are captured from their mesh feed
   without anything extra crossing the wire. */
export function captureShot(playerId, word, videoEl, mirror = false){
  if(!playerId || !videoEl) return;
  if(!videoEl.videoWidth || !videoEl.videoHeight) return;
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
  let url;
  try{ url = shotCanvas.toDataURL("image/jpeg", .72); }
  catch{ return; }                          // tainted canvas: skip silently
  const list = shots.get(playerId) || [];
  list.push({ url, word: word || "" });
  while(list.length > MAX_SHOTS) list.shift();
  shots.set(playerId, list);
}

export function clearShots(){ shots.clear(); }

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
  shotIx = 0;

  const st = stage();
  const mode = payload.mode || "party";
  /* Solo has no shared moment to hold, so its results and breakdown are one
     screen — the Figma frame carries both. Everyone else gets the two beats. */
  st.dataset.page = mode === "solo" ? "solo" : "stage";
  st.dataset.size = String(payload.size || 3);
  st.dataset.mode = mode;
  orderResultsControls(st.dataset.page);

  setTxt("rsHeadline", payload.headline || "GAME OVER");
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
   "spiking a volleyball". Shrink the list until the longest row fits rather
   than truncating someone's word. */
function fitPoseList(){
  const list = $("rsPoseList");
  if(!list) return;
  list.style.removeProperty("--pl-fs");
  requestAnimationFrame(() => {
    const rows = [...list.querySelectorAll("li")];
    if(!rows.length) return;
    let worst = 1;
    for(const li of rows){
      const avail = li.clientWidth;
      if(!avail) continue;
      const want = [...li.children].reduce((sum, c) => sum + c.scrollWidth, 0) + 6;
      if(want > avail) worst = Math.max(worst, want / avail);
    }
    /* also keep the tallest column inside the block, so late rows never slide
       under the rematch button */
    for(const col of list.querySelectorAll(".rs-posecol"))
      if(col.scrollHeight > col.clientHeight && col.clientHeight)
        worst = Math.max(worst, col.scrollHeight / col.clientHeight);
    if(worst > 1) list.style.setProperty("--pl-fs", (1 / worst * .96).toFixed(3));
  });
}

function renderScoreLine(){
  const el = $("rsScoreLine");
  if(!el) return;
  const t = payload.teams;
  if(!t){ el.innerHTML = '<b class="blue">' + plain(payload.soloScore || 0) + "</b>"; return; }
  el.innerHTML = '<b class="blue">' + plain(t.blue) +
    '</b><i class="rs-score-sep"> - </i><b class="orange">' +
    plain(t.orange) + "</b>";
}
const fmt = n => (n || 0).toLocaleString("en-US");
const plain = n => String(Math.round(n || 0));

function orderResultsControls(page){
  const rematch = $("rsRematch");
  const status = $("rsRematchStatus");
  if(!rematch) return;
  if(page === "breakdown") $("rsBack")?.after(rematch, status);
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
    el.classList.toggle("ready", !!(p && p.ready));
    if(!p){ el.innerHTML = ""; delete el.dataset.pid; continue; }
    if(el.dataset.pid !== p.id){
      el.dataset.pid = p.id;
      el.innerHTML =
        '<div class="slot"></div>' +
        '<img class="rs-border" src="assets/ui/figma/pm-border-' + team + '.png" alt="">' +
        '<div class="rs-nametag"><div class="rs-nametag-art">' +
        '<img src="assets/ui/figma/rs-nametag-' + team + '.png" alt=""><b></b></div></div>' +
        '<div class="rs-ready"><img src="assets/ui/figma/rs-ready-paper.png" alt=""><b>READY</b></div>';
    }
    el.querySelector(".rs-nametag b").textContent = disp(p.name);
  }

  /* Local first keeps the shared dock out of any remote slot; every later
     pass then reconciles/reuses its own video or still without duplicates. */
  if(local) mountSeatVideo(seatEl(local.key), local.p);
  for(const entry of occupied)
    if(entry.p && !entry.p.mine) mountSeatVideo(seatEl(entry.key), entry.p);
}

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
  if(p.stream){
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
  const last = (shots.get(p.id) || []).slice(-1)[0];
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
  const teams = { blue:0, orange:0 };
  for(const p of payload.players)
    if(p.team === "blue" || p.team === "orange") teams[p.team]++;
  const needsTeams = payload.mode === "party" && total > 0 && ready === total &&
    (teams.blue < 2 || teams.orange < 2);
  const previous = btn.dataset.ready === undefined ? null : Number(btn.dataset.ready);
  setTxt("rsRematchLabel",
    payload.mode === "solo" || payload.mode === "vs"
      ? "PLAY AGAIN"
      : needsTeams
        ? "NEED  2  PER  TEAM"
        : "REMATCH?  " + ready + "/" + total + "  READY");
  btn.classList.toggle("mine", mine);
  btn.dataset.waiting = needsTeams ? "need-teams" : "";
  if(payload.mode === "party" || payload.mode === "1v1"){
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
    btn.setAttribute("aria-label", "Play again");
    setTxt("rsRematchStatus", "");
  }
  btn.dataset.ready = String(ready);
  btn.dataset.mine = String(mine);
  if(animate && previous !== null && ready !== previous)
    pulseRematch(btn, ready - previous);
  btn.disabled = btn.classList.contains("pending");
}

function syncPlayerReady(mine, voters){
  if(!payload) return;
  if(Array.isArray(voters)){
    const set = new Set(voters);
    for(const p of payload.players) p.ready = set.has(p.id);
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
  payload.rematch = { ...(payload.rematch || {}), ready, total, mine };
  syncPlayerReady(mine, voters);
  renderSeats();
  renderRematch(true);
}

/* A party room survives on the results screen. If somebody leaves there,
   keep the papers in sync without rebuilding streams for the survivors. */
export function syncResultsRoster(nextPlayers = []){
  if(!payload || payload.mode !== "party" || !Array.isArray(nextPlayers)) return;
  const previous = new Map(payload.players.map(p => [p.id, p]));
  payload.players = nextPlayers.map(member => {
    const player = previous.get(member.id);
    return player ? { ...player, name: member.name, team: member.team } : null;
  }).filter(Boolean);

  const total = payload.players.length;
  const ready = payload.players.filter(p => p.ready).length;
  payload.rematch = {
    ...(payload.rematch || {}),
    ready: Math.min(total, ready),
    total,
    mine: !!payload.players.find(p => p.mine)?.ready,
  };
  if(!payload.players.some(p => p.id === focusId)){
    focusId = (payload.players.find(p => p.mine) || payload.players[0])?.id || null;
    shotIx = 0;
  }

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
    : "Couldn’t update rematch readiness — try again.");
}

function toggleRematchReady(){
  if(!payload) return;
  if($("rsRematch")?.classList.contains("pending")) return;
  if(payload.mode !== "party"){
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
    if(!strip) return;
    strip.innerHTML = "";
    for(const p of payload.players.filter(x => x.team === team)){
      const t = document.createElement("button");
      t.type = "button";
      t.className = "rs-thumb" + (p.id === focusId ? " on" : "");
      t.dataset.pid = p.id;
      t.dataset.team = team;
      t.setAttribute("aria-pressed", String(p.id === focusId));
      t.setAttribute("aria-label", "View " + disp(p.name) + "’s result photos");
      const last = (shots.get(p.id) || []).slice(-1)[0];
      t.innerHTML =
        '<div class="shotwrap">' + (last ? '<img src="' + last.url + '" alt="">' : "") + "</div>" +
        '<img class="rs-border" src="assets/ui/figma/rs-photo-' + team + '.png" alt="">' +
        '<div class="rs-nametag"><div class="rs-nametag-art">' +
        '<img src="assets/ui/figma/rs-nametag-' + team + '.png" alt=""><b>' +
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
  shotIx = 0;
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
  const list = shots.get(p.id) || [];
  panelState.set(suffix, { suffix, pid: p.id, ix: 0 });

  const wrap = $("rsFocusShots" + suffix);
  if(wrap) wrap.innerHTML = list.length
    ? list.map((s, i) =>
        '<img class="' + (i === 0 ? "on" : "") + '" src="' + s.url + '" alt="">').join("")
    : '<div class="rs-empty">No photos this round —<br>they’re taken the moment the AI recognises you.</div>';

  const tag = $("rsFocusName" + suffix);
  if(tag){
    tag.querySelector("img").src = "assets/ui/figma/rs-nametag-" + p.team + ".png";
    tag.querySelector("b").textContent = disp(p.name);
    tag.classList.toggle("orange", p.team === "orange");
  }
  setTxt("rsShotWord" + suffix, list.length ? (list[0].word || "").toUpperCase() : "");

  const A = suffix === "B" ? "B" : "";
  setAwardText("rsAward" + (A ? "TitleB" : "Title"), p.award.title);
  setAwardText("rsAward" + (A ? "SubB" : "Sub"), p.award.sub);
  const chip = n => "rsStat" + (A ? "B" + n : n);
  statChip(chip(1), fmt(p.score) + " PTS");
  statChip(chip(2), p.avg ? p.avg.toFixed(1) + " AVG" : "— AVG");
  statChip(chip(3), (p.firsts || 0) + (p.firsts === 1 ? " First" : " Firsts"));
}

function renderFocus(){
  const p = payload.players.find(x => x.id === focusId);
  if(!p) return;
  syncThumbSelection();
  panelState.clear();

  if(payload.mode === "1v1" || payload.mode === "vs"){
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

function fitAwardDescription(){
  const node = $("rsAwardSub");
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
    fitAwardLine("rsAwardSub", baseCqw, 6.2);
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
    fitAwardLine("rsAwardTitle", 20.603, 8.8);
    fitAwardDescription();
  });
}

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

/* Stills read as a little GIF of the round rather than something to click
   through, so every visible panel advances on the same beat. */
function startShotCycle(){
  stopShotCycle();
  cycleTimer = setInterval(() => {
    let moved = false;
    for(const panel of visiblePanels()){
      const list = shots.get(panel.pid) || [];
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
function paintPanelFrame(panel){
  const wrap = $("rsFocusShots" + panel.suffix);
  if(!wrap) return;
  const imgs = wrap.querySelectorAll("img");
  imgs.forEach((im, i) => im.classList.toggle("on", i === panel.ix));
  const list = shots.get(panel.pid) || [];
  setTxt("rsShotWord" + panel.suffix,
    list.length ? (list[panel.ix]?.word || "").toUpperCase() : "");
}

/* ---------------- photo strip ---------------- */

/* Stitches the focused player's stills into one image and hands it to the
   browser as a download. Nothing leaves the machine. */
function savePhotoStrip(){
  const p = payload.players.find(x => x.id === focusId);
  const list = shots.get(focusId) || [];
  if(!list.length){ toast("No photos to save from this round yet."); return; }
  const pad = 18, w = SHOT_W, h = SHOT_H;
  const c = document.createElement("canvas");
  c.width = w + pad * 2;
  c.height = pad + list.length * (h + pad);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#f4ece0";
  ctx.fillRect(0, 0, c.width, c.height);
  let loaded = 0;
  list.forEach((s, i) => {
    const img = new Image();
    img.onload = () => {
      ctx.drawImage(img, pad, pad + i * (h + pad), w, h);
      if(++loaded !== list.length) return;
      const a = document.createElement("a");
      a.download = "pose-party-" + (p ? p.name.toLowerCase().replace(/\W+/g, "-") : "strip") + ".png";
      a.href = c.toDataURL("image/png");
      a.click();
      toast("Photo strip saved.");
    };
    img.src = s.url;
  });
}

function teardownResultsMedia(){
  stopShotCycle();
  panelState.clear();
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
  $("rsFocusShots")?.replaceChildren();
}

/* ---------------- wiring ---------------- */

export function wireResults(){
  if(wired) return;
  wired = true;

  $("rsSeeBreakdown").onclick = () => {
    stage().dataset.page = "breakdown";
    renderBreakdown();
    orderResultsControls("breakdown");
    blip([659, 784], .06);
  };
  $("rsBack").onclick = () => {
    stage().dataset.page = "stage";
    orderResultsControls("stage");
    renderSeats();
    blip([494, 392], .06);
  };
  $("rsPrev").onclick = () => step(-1);
  $("rsNext").onclick = () => step(1);
  $("rsSaveStrip").onclick = savePhotoStrip;
  $("rsRematch").onclick = toggleRematchReady;
  addEventListener("resize", scheduleAwardFit);
  document.fonts?.ready.then(scheduleAwardFit);

  addEventListener("keydown", e => {
    if(gameState() !== "results" || stage().dataset.page !== "breakdown") return;
    if(e.key === "ArrowLeft") step(-1);
    if(e.key === "ArrowRight") step(1);
  });

  /* stills are for this results screen only */
  onTransition((to, from) => {
    if(from === "results" && to !== "results"){
      clearShots();
      teardownResultsMedia();
      cancelAnimationFrame(awardFitFrame);
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
  const WORDS = ["jumping jacks", "boxing", "t-rex", "hula hoop", "guitar", "archery"];
  const seed = async players => {
    const v = $("video");
    if(!v || !v.videoWidth) return;
    for(let i = 0; i < 4; i++){
      for(const p of players)
        captureShot(p.id, WORDS[(i + players.indexOf(p)) % WORDS.length], v, true);
      await new Promise(r => setTimeout(r, 160));
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
    me.score = 1460;
    showResults({
      mode: "solo", size: 1, headline: "GAME OVER",
      teams: null, soloScore: 1460, players: [me],
      rounds: WORDS.concat(WORDS.slice(0, 4)).map((w, i) =>
        ({ word: w, pts: i % 3 === 1 ? 0 : 560 })),
      rematch: { ready: 0, total: 1, mine: false },
      onRematch: () => toast("Dev fixture — nothing to rematch into."),
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
      onRematch: () => toast("Dev fixture — nothing to rematch into."),
    });
    await seed(players);
    if(kind === "1v1-breakdown"){
      stage().dataset.page = "breakdown";
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
    onRematch: () => toast("Dev fixture — no room to rematch into."),
  });
  await seed(players);
  if(kind === "breakdown"){
    stage().dataset.page = "breakdown";
    renderBreakdown();
  }
}
