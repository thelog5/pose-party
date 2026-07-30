/* Party lobby (3v3) — the Figma "Party Lobby" frame, sharing the 1v1
   lobby's stage and chrome (invite card, settings, name tag, exit, start).

   The server is authoritative for the roster: players auto-balance onto
   teams, may switch while the target team has room (JOIN THIS TEAM), and
   the host can start once both teams have at least two players. Video is
   a WebRTC mesh — one peer link per pair — with every feed sandwiched
   between the panel's offwhite paper and its three-window overlay.

   Starting hands the same mesh straight to partyMatch.js, which owns the
   in-game screen; the peer links are never renegotiated. */

import { $ } from "./dom.js";
import { state } from "./state.js";
import { toast } from "./ui.js";
import { blip } from "./audio.js";
import { gameState, onTransition } from "./fsm.js";
import { mountCamera } from "./screens.js";
import { createPeer } from "./webrtc.js";
import { partyBridge, enterLobby, ensureSocket, myName, setLobbyStatus,
         lobbySettings, renderLobbySettings, setLobbyCode,
         serverNow, perfFromServer } from "./online.js";
import { setRematchState } from "./results.js";
import { startPartyMatch, wirePartyMatch, attachPartyStream, onPartyRound,
         onPartyGot, onPartyChase, onPartyResult, onPartyEnd,
         onPartyGuess } from "./partyMatch.js";

const TEAM_CAP = 3, MIN_PER_TEAM = 2;
const TILES = { blue: ["ptB0", "ptB1", "ptB2"], orange: ["ptO0", "ptO1", "ptO2"] };

let socket = null;
let roster = null;            // {hostId, players:[{id,name,team}], settings}
let myId = null;
const peers = new Map();      // peerId -> {peer, stream}
let wired = false;
let nameFitCanvas = null;
let renameTimer = null;

const myTeam = () => roster?.players.find(p => p.id === myId)?.team;
const teamOf = t => roster ? roster.players.filter(p => p.team === t) : [];
const isHost = () => roster && roster.hostId === myId;
const displayName = member => (member?.name || "Player").trim().slice(0, 10) || "Player";

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
  partyBridge.rename = renameParty;
  $("btnJoinBlue").onclick = () => requestTeam("blue");
  $("btnJoinOrange").onclick = () => requestTeam("orange");
  wirePartyMatch();
  addEventListener("resize", fitAllPartyNames);
  document.fonts?.ready.then(fitAllPartyNames);
  onTransition((to, from) => {
    /* Starting the match leaves "party" for "countdown" but keeps the room
       AND the mesh — partyMatch.js takes over the same peer links. */
    if(from === "party" && to !== "party" && to !== "countdown") leaveParty();
    if(to === "menu" || to === "results") leaveParty();
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
    socket.emit("party:create", { name: myName(), settings: lobbySettings(), labels: state.model.labels }, res => {
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
    socket.emit("party:join", { code, name: myName(), labels: state.model.labels }, res => {
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

function renameParty(name){
  const clean = String(name || "").trim().slice(0, 10) || "Player";
  const me = roster?.players.find(p => p.id === myId);
  if(me && me.name !== clean){
    me.name = clean;
    renderTiles();
  }
  clearTimeout(renameTimer);
  renameTimer = setTimeout(()=>{
    if(socket?.connected && roster) socket.emit("party:name", { name:clean }, () => {});
  }, 180);
}

export function leaveParty(){
  if(socket && socket.connected && roster) socket.emit("room:leave", {}, () => {});
  clearTimeout(renameTimer);
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
  s.on("party:started", () => { blip([523, 659, 784, 1047], 0.09); });
  s.on("party:error", ({error} = {}) => {
    setLobbyStatus(error === "no-shared-words"
      ? "No word is trained on every player’s device — train a shared word and try again."
      : partyError({error}));
  });

  /* in-game: partyMatch.js owns the screen, this module owns the mesh */
  s.on("party:match", payload => {
    startPartyMatch({
      socket: s, myId, peers, roster,
      serverNow, perfFromServer, toast,
    }, payload);
  });
  s.on("party:round",  p => onPartyRound(p));
  s.on("party:got",    p => onPartyGot(p));
  s.on("party:chase",  p => onPartyChase(p));
  s.on("party:result", p => onPartyResult(p));
  s.on("party:end",    p => onPartyEnd(p));
  s.on("party:rematch", ({ready, total, voters} = {}) =>
    setRematchState(ready, total, (voters || []).includes(myId)));
  s.on("party:guess",  p => onPartyGuess(p));
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
  setLobbyStatus("Can’t reach the game server right now. Check your connection and try again.");
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

function fitPartyName(chip){
  const label = chip?.querySelector("b");
  if(!label || !label.clientWidth) return;
  requestAnimationFrame(()=>{
    label.style.removeProperty("font-size");
    const style = getComputedStyle(label);
    const base = parseFloat(style.fontSize);
    if(!nameFitCanvas) nameFitCanvas = document.createElement("canvas");
    const ctx = nameFitCanvas.getContext("2d");
    ctx.font = style.fontStyle + " " + style.fontWeight + " " + base + "px " + style.fontFamily;
    const spacing = parseFloat(style.letterSpacing) || 0;
    const measured = ctx.measureText(label.textContent).width +
      Math.max(0, label.textContent.length - 1) * spacing;
    const available = label.clientWidth - (parseFloat(style.paddingLeft) || 0) -
      (parseFloat(style.paddingRight) || 0);
    if(measured > available)
      label.style.fontSize = Math.max(base * .48, base * available / measured * .96) + "px";
  });
}

function fitAllPartyNames(){
  document.querySelectorAll(".pt-name").forEach(fitPartyName);
}

function setTileName(tile, name){
  let chip = tile.querySelector(".pt-name");
  if(!chip){
    chip = document.createElement("span");
    chip.className = "pt-name";
    const art = document.createElement("img");
    art.src = "assets/ui/figma/lb-name-chip.png";
    art.alt = "";
    const label = document.createElement("b");
    chip.append(art, label);
    tile.appendChild(chip);
  }
  chip.title = name;
  chip.querySelector("b").textContent = name;
  fitPartyName(chip);
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
        setTileName(tile, displayName(member));
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
      setTileName(tile, displayName(member));
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
      /* One Party client can encode this camera for five peers. A modest
         sender cap protects the local pose loop while staying sharp enough
         for both the half-screen feed and portrait tiles. */
      videoEncoding:{
        maxBitrate: 500_000,
        maxFramerate: 24,
        scaleResolutionDownBy: 1.25,
      },
      sendSignal: data => socket && socket.emit("party:signal", { to: p.id, data }),
      onRemoteStream: stream => {
        entry.stream = stream;
        attachPartyStream(p.id, stream);
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
