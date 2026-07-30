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
let focusId = null;       // which player's carousel is open
let shotIx = 0;
let wired = false;

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
  { key:"points",  title:"MENACE",   sub:"Most points scored",  pick:ps => best(ps, p => p.score) },
  { key:"fast",    title:"PROPHET",  sub:"Fastest recognition", pick:ps => best(ps, p => p.fastest ? -p.fastest : -Infinity) },
  { key:"firsts",  title:"MACHINE",  sub:"Most first places",   pick:ps => best(ps, p => p.firsts || 0) },
  { key:"clutch",  title:"CLUTCH",   sub:"Scored in the chase", pick:ps => best(ps, p => p.clutch || 0) },
  { key:"steady",  title:"METRONOME",sub:"Most consistent",     pick:ps => best(ps, p => p.avg ? -p.avg : -Infinity) },
];
const AWARD_TAIL = [
  { title:"WILDCARD",  sub:"Kept us guessing" },
  { title:"ROMANTIC",  sub:"Played with feeling" },
  { title:"PHILOSPHER",sub:"Took the scenic route" },
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
  st.dataset.page = "stage";
  st.dataset.size = String(payload.size || 3);
  st.dataset.mode = payload.mode || "party";

  setTxt("rsHeadline", payload.headline || "GAME OVER");
  renderScoreLine();
  renderSeats();
  renderRematch();
  if(gameState() !== "results") transition("results");
}

function renderScoreLine(){
  const el = $("rsScoreLine");
  if(!el) return;
  const t = payload.teams;
  if(!t){ el.innerHTML = '<b class="blue">' + fmt(payload.soloScore || 0) + "</b>"; return; }
  el.innerHTML = '<b class="blue">' + fmt(t.blue) + '</b> - <b class="orange">' + fmt(t.orange) + "</b>";
}
const fmt = n => (n || 0).toLocaleString("en-US");

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

  for(const key of SEATS){
    const el = seatEl(key);
    if(!el) continue;
    const team = key.startsWith("blue") ? "blue" : "orange";
    const p = byTeam[team][Number(key.slice(-1))];
    el.classList.toggle("vacant", !p);
    el.classList.toggle("ready", !!(p && p.ready));
    if(!p){ el.innerHTML = ""; delete el.dataset.pid; continue; }
    if(el.dataset.pid !== p.id){
      el.dataset.pid = p.id;
      el.innerHTML =
        '<div class="slot"></div>' +
        '<img class="rs-border" src="assets/ui/figma/pm-border-' + team + '.png" alt="">' +
        '<div class="rs-nametag"><img src="assets/ui/figma/lb-name-chip.png" alt=""><b></b></div>' +
        '<div class="rs-ready"><img src="assets/ui/figma/pm-got-it.png" alt=""><b>READY</b></div>';
      mountSeatVideo(el, p);
    }
    el.querySelector(".rs-nametag b").textContent = disp(p.name);
  }
}

/* Live faces are the whole point of this page, so the feeds keep running. */
function mountSeatVideo(el, p){
  const slot = el.querySelector(".slot");
  if(!slot) return;
  if(p.mine){ mountCamera(slot); return; }
  if(p.stream){
    const v = document.createElement("video");
    v.autoplay = true; v.playsInline = true; v.muted = true;
    slot.appendChild(v);
    v.srcObject = p.stream;
    v.play().catch(() => {});
    return;
  }
  /* no live feed (offline, or they left): fall back to their last still */
  const last = (shots.get(p.id) || []).slice(-1)[0];
  if(last){
    const img = document.createElement("img");
    img.src = last.url; img.alt = "";
    slot.appendChild(img);
  }
}

function renderRematch(){
  const r = payload.rematch;
  const btn = $("rsRematch");
  if(!btn) return;
  const total = r?.total ?? payload.players.length;
  const ready = r?.ready ?? 0;
  setTxt("rsRematchLabel",
    payload.mode === "solo" ? "PLAY AGAIN" : "REMATCH? " + ready + "/" + total + " READY");
  btn.classList.toggle("mine", !!r?.mine);
  btn.disabled = false;
}

/* the server pushes new counts as team-mates vote */
export function setRematchState(ready, total, mine){
  if(!payload) return;
  payload.rematch = { ready, total, mine };
  renderRematch();
}

/* ---------------- breakdown page ---------------- */

function renderBreakdown(){
  for(const team of ["blue", "orange"]){
    const strip = $(team === "blue" ? "rsStripBlue" : "rsStripOrange");
    if(!strip) return;
    strip.innerHTML = "";
    for(const p of payload.players.filter(x => x.team === team)){
      const t = document.createElement("div");
      t.className = "rs-thumb" + (p.id === focusId ? " on" : "");
      t.dataset.pid = p.id;
      const last = (shots.get(p.id) || []).slice(-1)[0];
      t.innerHTML =
        '<div class="shotwrap">' + (last ? '<img src="' + last.url + '" alt="">' : "") + "</div>" +
        '<img class="rs-border" src="assets/ui/figma/rs-photo-' + team + '.png" alt="">' +
        '<div class="rs-nametag"><img src="assets/ui/figma/lb-name-chip.png" alt=""><b>' +
        esc(disp(p.name)) + "</b></div>";
      t.onclick = () => { focusId = p.id; shotIx = 0; renderBreakdown(); blip([523, 659], .05); };
      strip.appendChild(t);
    }
  }
  renderFocus();
}

function renderFocus(){
  const p = payload.players.find(x => x.id === focusId);
  if(!p) return;
  const list = shots.get(p.id) || [];
  shotIx = list.length ? Math.min(shotIx, list.length - 1) : 0;

  const wrap = $("rsFocusShots");
  wrap.innerHTML = list.length
    ? list.map((s, i) =>
        '<img class="' + (i === shotIx ? "on" : "") + '" src="' + s.url + '" alt="">').join("")
    : '<div class="rs-empty">No photos this round —<br>they’re taken the moment the AI recognises you.</div>';

  $("rsFocusName").querySelector("b").textContent = disp(p.name);
  const tag = $("rsFocusName").querySelector("img");
  tag.style.filter = p.team === "orange"
    ? "hue-rotate(158deg) saturate(1.5) brightness(1.12)" : "";

  setTxt("rsShotWord", list.length ? (list[shotIx].word || "").toUpperCase() : "");
  const nav = list.length > 1;
  $("rsPrev").style.visibility = nav ? "visible" : "hidden";
  $("rsNext").style.visibility = nav ? "visible" : "hidden";

  setTxt("rsAwardTitle", p.award.title);
  setTxt("rsAwardSub", p.award.sub);
  statChip("rsStat1", fmt(p.score) + " PTS");
  statChip("rsStat2", p.avg ? p.avg.toFixed(1) + "s AVG" : "— AVG");
  statChip("rsStat3", (p.firsts || 0) + (p.firsts === 1 ? " First" : " Firsts"));
}

function statChip(id, text){
  const el = $(id);
  if(el) el.querySelector("b").textContent = text;
}

function step(dir){
  const list = shots.get(focusId) || [];
  if(list.length < 2) return;
  shotIx = (shotIx + dir + list.length) % list.length;
  renderFocus();
  blip([440], .04);
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

/* ---------------- wiring ---------------- */

export function wireResults(){
  if(wired) return;
  wired = true;

  $("rsSeeBreakdown").onclick = () => {
    stage().dataset.page = "breakdown";
    renderBreakdown();
    blip([659, 784], .06);
  };
  $("rsBack").onclick = () => {
    stage().dataset.page = "stage";
    renderSeats();
    blip([494, 392], .06);
  };
  $("rsPrev").onclick = () => step(-1);
  $("rsNext").onclick = () => step(1);
  $("rsSaveStrip").onclick = savePhotoStrip;
  $("rsRematch").onclick = () => {
    if(!payload) return;
    if(payload.mode === "solo"){ payload.onRematch?.(); return; }
    payload.onRematch?.();
  };

  addEventListener("keydown", e => {
    if(gameState() !== "results" || stage().dataset.page !== "breakdown") return;
    if(e.key === "ArrowLeft") step(-1);
    if(e.key === "ArrowRight") step(1);
  });

  /* stills are for this results screen only */
  onTransition((to, from) => {
    if(from === "results" && to !== "results"){ clearShots(); payload = null; }
  });
}

/* ---------------- dev fixture ----------------
   Opens either results layout without playing a match: your camera fills every
   seat and the carousels are seeded from your own feed. */
export async function devResults(kind = "3v3"){
  const size = kind === "2v2" ? 2 : 3;
  const names = { blue: ["LOGAN", "MIA", "SAM"], orange: ["FRED", "ZOE", "NIA"] };
  const words = ["jumping jacks", "boxing", "t-rex", "hula hoop", "guitar", "archery"];
  const players = [];
  for(const team of ["blue", "orange"])
    for(let i = 0; i < size; i++)
      players.push({
        id: team + i, name: names[team][i], team,
        mine: team === "blue" && i === 0,
        stream: state.mediaStream || null,
        score: 520 - i * 90 + (team === "orange" ? -40 : 0),
        firsts: Math.max(0, 3 - i), fastest: 1.4 + i * .6, avg: 2.1 + i * .5,
        clutch: i === 1 ? 90 : 0, ready: i === 0,
      });

  showResults({
    mode: "party", size,
    headline: "BLUE TEAM WINS!",
    teams: { blue: 1460, orange: 1280 },
    players,
    rematch: { ready: size === 2 ? 2 : 4, total: size * 2, mine: false },
    onRematch: () => toast("Dev fixture — no room to rematch into."),
  });

  /* seed a few stills off the live camera so the carousel has real content */
  const v = $("video");
  if(v && v.videoWidth){
    for(let i = 0; i < 4; i++){
      for(const p of players) captureShot(p.id, words[(i + players.indexOf(p)) % words.length], v, true);
      await new Promise(r => setTimeout(r, 160));
    }
  }
  if(kind === "breakdown"){
    stage().dataset.page = "breakdown";
    renderBreakdown();
  }
}
