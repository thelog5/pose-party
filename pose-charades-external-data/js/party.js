/* Party lobby (3v3) — the Figma "Party Lobby" frame, sharing the 1v1
   lobby's stage and chrome (invite card, settings, name tag, exit, start).

   The server is authoritative for the roster: players auto-balance onto
   teams, may switch while the target team has room (JOIN THIS TEAM), and
   the host can start once both teams have at least two players. Video is
   a WebRTC mesh — one peer link per pair — with every feed sandwiched
   between the panel's offwhite paper and its three-window overlay.

   The party GAME isn't built yet; starting celebrates and says so. */

import { $ } from "./dom.js";
import { state } from "./state.js";
import { toast } from "./ui.js";
import { blip } from "./audio.js";
import { gameState, onTransition } from "./fsm.js";
import { mountCamera } from "./screens.js";
import { createPeer } from "./webrtc.js";
import { partyBridge, enterLobby, ensureSocket, myName, setLobbyStatus,
         lobbySettings, renderLobbySettings, setLobbyCode } from "./online.js";

const TEAM_CAP = 3, MIN_PER_TEAM = 2;
const TILES = { blue: ["ptB0", "ptB1", "ptB2"], orange: ["ptO0", "ptO1", "ptO2"] };

let socket = null;
let roster = null;            // {hostId, players:[{id,name,team}], settings}
let myId = null;
const peers = new Map();      // peerId -> {peer, stream}
let wired = false;

const myTeam = () => roster?.players.find(p => p.id === myId)?.team;
const teamOf = t => roster ? roster.players.filter(p => p.team === t) : [];
const isHost = () => roster && roster.hostId === myId;

/* ---------------- entry ---------------- */

export function enterParty(){
  enterLobby("party");        // shared stage, party center
}

export function wireParty(){
  if(wired) return;
  wired = true;
  partyBridge.create = createParty;
  partyBridge.join = joinParty;
  partyBridge.start = startParty;
  partyBridge.settings = sendSettings;
  partyBridge.leave = leaveParty;
  $("btnJoinBlue").onclick = () => requestTeam("blue");
  $("btnJoinOrange").onclick = () => requestTeam("orange");
  onTransition((to, from) => {
    if(from === "party" && to !== "party") leaveParty();
  });
}

function resetPartyUi(){
  roster = null;
  for(const ids of Object.values(TILES)) for(const id of ids) renderEmptyTile($(id));
  $("btnJoinBlue").disabled = false;
  $("btnJoinOrange").disabled = false;
  $("btnStartMatch").disabled = true;
}

/* ---------------- socket flows ---------------- */

async function createParty(){
  resetPartyUi();
  try{
    socket = await ensureSocket();
    wirePartySocket(socket);
    myId = socket.id;
    setLobbyStatus("Opening a party room…");
    socket.emit("party:create", { name: myName(), settings: lobbySettings() }, res => {
      if(!res || res.error) return setLobbyStatus(partyError(res));
      setLobbyCode(res.code);
      applyRoster(res.roster);
      setLobbyStatus(null);
    });
  }catch(e){ partyOffline(e); }
}

async function joinParty(code){
  resetPartyUi();
  try{
    socket = await ensureSocket();
    wirePartySocket(socket);
    myId = socket.id;
    setLobbyStatus("Joining party " + code + "…");
    socket.emit("party:join", { code, name: myName() }, res => {
      if(!res || res.error){
        if(res && res.error === "1v1-room"){
          partyBridge.rejoin1v1?.(code);   // typed a 1v1 code — hop over
          return;
        }
        return setLobbyStatus(partyError(res));
      }
      setLobbyCode(res.code);
      applyRoster(res.roster);
      setLobbyStatus(null);
      blip([523, 659], 0.07);
    });
  }catch(e){ partyOffline(e); }
}

function requestTeam(team){
  if(!socket || !roster) return;
  if(myTeam() === team){
    toast("You’re already on this team — recruit a friend!");
    return;
  }
  socket.emit("party:team", { team }, res => {
    if(res && res.error === "team-full") toast("That team is full!");
    else if(res && res.error) toast("Couldn’t switch (" + res.error + ")");
    else blip([440, 554], 0.06);
  });
}

function startParty(){
  if(!socket) return;
  socket.emit("party:start", {}, res => {
    if(res && res.error === "need-teams")
      setLobbyStatus("Need at least " + MIN_PER_TEAM + " players on each team to start");
    else if(res && res.error === "not-host")
      setLobbyStatus("Only the host can start the party");
    else if(res && res.error) setLobbyStatus("Couldn’t start (" + res.error + ")");
  });
}

function sendSettings(settings){
  if(socket && roster) socket.emit("party:settings", { settings }, () => {});
}

export function leaveParty(){
  if(socket && socket.connected && roster) socket.emit("room:leave", {}, () => {});
  for(const [, entry] of peers) entry.peer.close();
  peers.clear();
  roster = null;
}

function wirePartySocket(s){
  if(s._partyWired) return;
  s._partyWired = true;
  s.on("party:roster", payload => { if(gameState() === "party") applyRoster(payload); });
  s.on("party:signal", ({from, data} = {}) => { peers.get(from)?.peer.handleSignal(data); });
  s.on("party:left", ({id} = {}) => {
    const entry = peers.get(id);
    if(entry){ entry.peer.close(); peers.delete(id); }
  });
  s.on("party:started", () => {
    bigPoof();
    blip([523, 659, 784, 1047], 0.09);
    toast("Everyone’s in! Party matches are coming soon — this lobby is ready for them.");
  });
}

function partyError(res){
  const e = res && res.error;
  return {
    "no-such-room": "No party with that code — check it and try again",
    "room-full": "That party is full (6 players max)",
    "match-in-progress": "That party already started",
    "rate-limited": "Slow down a little and try again",
    "already-in-room": "You’re already in a room",
    "server-full": "The server is full right now",
  }[e] || "Something went wrong (" + e + ")";
}

function partyOffline(e){
  console.warn("party unavailable:", e);
  setLobbyStatus("Can’t reach the game server. Online play needs the app served by the Node server: run “npm start” inside server/ and open the address it prints.");
}

/* ---------------- roster → tiles ---------------- */

function applyRoster(payload){
  const prevIds = roster ? roster.players.map(p => p.id) : [];
  roster = payload;
  if(payload.settings){
    Object.assign(lobbySettings(), payload.settings);
    renderLobbySettings(isHost());
  }

  const newcomers = roster.players.filter(p => !prevIds.includes(p.id) && p.id !== myId);

  renderTiles();
  syncPeers();
  updateGate();

  /* new arrivals get a confetti poof at their tile */
  for(const p of newcomers){
    const ix = teamOf(p.team).findIndex(q => q.id === p.id);
    if(ix >= 0) poofAt($(TILES[p.team][ix]));
  }
  if(newcomers.length && prevIds.length) blip([659, 784], 0.07);
}

function renderEmptyTile(tile){
  if(!tile) return;
  /* never nuke the live camera dock with innerHTML */
  const dock = $("cameraDock");
  if(dock && tile.contains(dock)) document.body.appendChild(dock);
  tile.innerHTML = '<div class="pt-empty"><img src="assets/ui/figma/pt-person.png" alt="">' +
    '<span>WAITING FOR PLAYER</span></div>';
  delete tile.dataset.pid;
}

function renderTiles(){
  for(const team of ["blue", "orange"]){
    const members = teamOf(team);
    TILES[team].forEach((tileId, ix) => {
      const tile = $(tileId);
      tile.classList.toggle("wide", ix === 0);
      tile.dataset.team = team;
      const member = members[ix];
      if(!member){ renderEmptyTile(tile); return; }
      if(tile.dataset.pid === member.id){
        const nameEl = tile.querySelector(".pt-name");
        if(nameEl) nameEl.textContent = member.id === myId ? "YOU" : member.name;
        return;
      }
      renderEmptyTile(tile);       // safely clears (parks the dock if present)
      tile.innerHTML = "";
      tile.dataset.pid = member.id;
      if(member.id === myId){
        mountCamera(tile);
      }else{
        const v = document.createElement("video");
        v.autoplay = true; v.playsInline = true; v.muted = true;
        tile.appendChild(v);
        const entry = peers.get(member.id);
        if(entry?.stream){ v.srcObject = entry.stream; v.play().catch(() => {}); }
        else{
          const ph = document.createElement("div");
          ph.className = "pt-empty";
          ph.innerHTML = '<img src="assets/ui/figma/pt-person.png" alt=""><span>CONNECTING…</span>';
          tile.appendChild(ph);
        }
      }
      const chip = document.createElement("span");
      chip.className = "pt-name";
      chip.textContent = member.id === myId ? "YOU" : member.name;
      tile.appendChild(chip);
    });
    /* the JOIN card occupies the third tile only while there's room */
    const joinBtn = team === "blue" ? $("btnJoinBlue") : $("btnJoinOrange");
    joinBtn.disabled = members.length >= TEAM_CAP;
  }
}

function updateGate(){
  const ok = teamOf("blue").length >= MIN_PER_TEAM && teamOf("orange").length >= MIN_PER_TEAM;
  const b = $("btnStartMatch");
  const was = b.disabled;
  b.disabled = !(ok && isHost());
  if(was && !b.disabled) b.classList.add("ready");
  if(!roster) return;
  if(!isHost()){
    setLobbyStatus(ok ? "Waiting for the host to start the party…" : null);
  }else if(!ok){
    setLobbyStatus("Party " + roster.players.length + "/6 — need " + MIN_PER_TEAM + " per team to start");
  }
}

/* ---------------- webrtc mesh ---------------- */
/* One link per pair; the lexically smaller socket id makes the offer, so
   both sides agree who initiates without negotiating. */
function syncPeers(){
  if(!state.mediaStream || !roster || !socket) return;
  const others = roster.players.filter(p => p.id !== myId);
  for(const p of others){
    if(peers.has(p.id)) continue;
    const entry = { peer: null, stream: null };
    entry.peer = createPeer({
      initiator: myId < p.id,
      stream: state.mediaStream,
      sendSignal: data => socket && socket.emit("party:signal", { to: p.id, data }),
      onRemoteStream: stream => {
        entry.stream = stream;
        const tile = document.querySelector('.pt-tile[data-pid="' + CSS.escape(p.id) + '"]');
        if(tile){
          tile.querySelector(".pt-empty")?.remove();
          const v = tile.querySelector("video");
          if(v){ v.srcObject = stream; v.play().catch(() => {}); }
        }
      },
    });
    peers.set(p.id, entry);
  }
  for(const [id, entry] of peers){
    if(!others.find(p => p.id === id)){ entry.peer.close(); peers.delete(id); }
  }
}

/* ---------------- celebration ---------------- */

function poofAt(el){
  if(!el || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const r = el.getBoundingClientRect();
  burst(r.left + r.width / 2, r.top + r.height / 2, 14);
}

function bigPoof(){
  if(matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  burst(innerWidth / 2, innerHeight * 0.45, 26);
}

function burst(cx, cy, n){
  const wrap = document.createElement("div");
  wrap.className = "burstwrap";
  for(let i = 0; i < n; i++){
    const p = document.createElement("i");
    const ang = (i / n) * Math.PI * 2 + Math.random() * 0.6;
    const dist = 60 + Math.random() * 120;
    p.style.left = cx + "px"; p.style.top = cy + "px";
    p.style.setProperty("--dx", Math.cos(ang) * dist + "px");
    p.style.setProperty("--dy", Math.sin(ang) * dist - 40 + "px");
    p.style.setProperty("--rot", (Math.random() * 540 - 270) + "deg");
    p.className = ["star", "dot", "spark"][i % 3];
    wrap.appendChild(p);
  }
  document.body.appendChild(wrap);
  setTimeout(() => wrap.remove(), 950);
}
