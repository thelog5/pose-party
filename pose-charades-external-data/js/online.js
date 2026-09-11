/* Online private-room 1v1.

   The server is authoritative: it deals words, times rounds, validates
   point claims, and keeps scores. This module mirrors its events into the
   local FSM/UI. Classification still runs locally. The network sees the
   player's name, trained word labels, match settings, timestamped recognition
   claims, and an ephemeral top-label/confidence update for the rival paper.
   Video remains peer-to-peer through opaque WebRTC signaling blobs; landmarks
   and training clips never leave the browser.

   Lobby flow (Figma "1v1 Lobby" frame): opening 1v1 auto-creates a room
   and shows the code. A friend joins via code or link. The host picks the
   match settings — MATCH TIME (total; most points when it ends wins) and
   WORD TIME (per word) — and presses START MATCH.

   The socket.io client script loads lazily from the game server itself, so
   offline modes still work from any static host. */

import { $, esc } from "./dom.js";
import { state } from "./state.js";
import { toast, fmtTime, fmtScore, fitMatchPaperText,
         renderRemoteMatchGuess, setCountdown, showTimesUp,
         showSuddenDeath, hideSuddenDeath, stopMatchFill,
         MATCH_ROBOT } from "./ui.js";
import { robotMiss } from "./robot.js";
import { blip } from "./audio.js";
import { gameState, transition, onTransition } from "./fsm.js";
import { gameTick } from "./game.js";
import { createPeer } from "./webrtc.js";
import { confettiFrom, greenFlash } from "./soloRound.js";
import { THRESH } from "./constants.js";
import {
  markGuessRecognized,
  prepareWordFeedback, playWordLockFeedback, playWordMissFeedback,
  fitGameplayText,
} from "./gameplayFeedback.js";
import {
  captureMoment,
  setRematchState,
  setRematchUnavailable,
  showResults,
} from "./results.js";
import { showHowToPlay, hideHowToPlay } from "./howToPlay.js";
import { leaveLobby } from "./lobbyAlive.js";
import { stampSeatAward, deliverSeatAward, clearSeatAward,
         setSeatAwardPoints, seatAwardIsUp,
         SEAT_AWARD_HOLD_MS } from "./seatAward.js";

const NAME_KEY = "poseCharadesName";
/* time-based mode: the match runs for matchSecs total, most points wins */
const DEFAULT_SETTINGS = { matchSecs:120, wordSecs:20 };
const NAME_MAX = 10;
const LOBBY_NAME_IDS = ["lobbyName", "lobbyYouName", "lobbyOppName"];

let socket = null;
let peer = null;
let peerName = "Rival";
let isHost = false;
let roomCode = null;
let peerReady = false;
let settings = { ...DEFAULT_SETTINGS };
let clockOffset = 0;          // serverNow ≈ Date.now() + clockOffset
let countdownTimer = null;
let wired = false;
let pendingJoin = null;       // code from a #join-XXXXXX link
let nameFitCanvas = null;
let nameFitFrame = 0;
let lastGuessSentAt = 0;
let lastGuessLabel = "";
let lastGuessConfidence = -1;
let roomAttemptVersion = 0;
let statusFitFrame = 0;
let retryTimer = 0;
/* reset whenever the player walks into a lobby — see offlineExplain */
let offlineToasted = false;

const serverNow = () => Date.now() + clockOffset;
const perfFromServer = tServer => performance.now() + (tServer - serverNow());

/* party.js registers its handlers here; the shared lobby chrome (join
   input, settings steppers, start, copy) routes by stage mode. */
export const partyBridge = {
  create:null, join:null, start:null, settings:null, leave:null, rename:null, rejoin1v1:null,
};
const lobbyMode = () => $("lobbyStage").dataset.mode || "1v1";

/* Preserve the large Figma type for short names, then measure and shrink only
   when a longer valid name would otherwise escape its paper label. */
function fitLobbyNameElement(el){
  if(!el || !el.clientWidth) return;
  el.style.removeProperty("font-size");
  const style=getComputedStyle(el);
  const base=parseFloat(style.fontSize);
  const raw=("value" in el ? el.value : el.textContent).trim() || "YOU";
  const text=style.textTransform==="uppercase" ? raw.toUpperCase() : raw;
  if(!nameFitCanvas) nameFitCanvas=document.createElement("canvas");
  const ctx=nameFitCanvas.getContext("2d");
  ctx.font=style.fontStyle+" "+style.fontWeight+" "+base+"px "+style.fontFamily;
  const spacing=parseFloat(style.letterSpacing)||0;
  const measured=ctx.measureText(text).width+Math.max(0,text.length-1)*spacing;
  const available=el.clientWidth-(parseFloat(style.paddingLeft)||0)-
    (parseFloat(style.paddingRight)||0)-base*.16;
  const scale=Math.min(1, available/Math.max(measured,1));
  const fitted=scale<1 ? base*scale*.97 : base;
  el.style.fontSize=Math.max(base*.36,fitted)+"px";
}

function fitLobbyNames(){
  cancelAnimationFrame(nameFitFrame);
  nameFitFrame=requestAnimationFrame(()=>{
    for(const id of LOBBY_NAME_IDS) fitLobbyNameElement($(id));
  });
}

/* The status line is anchored near the bottom of the stage and grows DOWNWARD
   as it wraps, so "does it fit" means "does it still end above the stage
   edge". Two changes from the old version: it measures every line rather than
   only ones over 34 characters — "BARTHOLOMEW joined! Press START MATCH" is
   34 wide characters and skipped the fit entirely — and it computes the scale
   in one step instead of shrinking 10% at a time through up to twelve forced
   reflows. Layout metrics only: getBoundingClientRect is inflated by whatever
   lobby transition happens to be mid-flight. */
function fitLobbyStatus(){
  cancelAnimationFrame(statusFitFrame);
  statusFitFrame=requestAnimationFrame(()=>{
    const line=$("lobbyStatus"), stage=$("lobbyStage");
    if(!line || !stage || !line.clientWidth) return;
    line.style.removeProperty("font-size");
    const room=stage.clientHeight-line.offsetTop-Math.max(2,stage.clientHeight*.004);
    if(room<=0 || line.offsetHeight<=room) return;
    const base=parseFloat(getComputedStyle(line).fontSize);
    line.style.fontSize=Math.max(5.5,base*room/line.offsetHeight*.98)+"px";
    /* one reconciliation pass — shrinking can change the line count */
    if(line.offsetHeight>room){
      const size=parseFloat(getComputedStyle(line).fontSize);
      line.style.fontSize=Math.max(5.5,size*room/line.offsetHeight*.98)+"px";
    }
  });
}

/* Leaving the lobby or an online match through navigation or connection
   teardown tells the server and drops the peer link. Registered at import
   time, before game.js's lifecycle listener. */
const inGame = s => s==="countdown"||s==="playing"||s==="word-won";
onTransition((to, from) => {
  if(state.game?.mode==="online" && inGame(from) && !inGame(to) && to!=="results"){
    leaveRoom();
    state.onlineClaim=null;
    state.onlineGuess=null;
    clearInterval(countdownTimer);
  }
  if(from==="lobby" && to!=="countdown" && to!=="lobby") leaveRoom();
  /* A completed 1v1 now stays in its room while the results-ready vote is
     open. Leaving results ends that membership; a same-room rematch is the
     one transition that deliberately keeps it. */
  if(from==="results" && to!=="countdown" &&
     $("resStage")?.dataset.mode==="1v1" && roomCode)
    leaveRoom();
  /* party.js owns party -> lobby cleanup so room:leave is emitted once. */
});

/* ---------------- lobby ---------------- */

export function setPendingJoin(code){ pendingJoin=code; }

export function enterLobby(mode="1v1"){
  if(!state.model || state.model.labels.filter(l=>l!=="idle").length<1){
    toast("Train the AI first. Record idle plus at least one action word, then tap SETTINGS.");
    transition("training"); return;
  }
  /* render() runs inside transition listeners. Publish the lobby variant
     first so the first party frame mounts the camera/controls into the party
     composition rather than briefly rendering the stale 1v1 arrangement. */
  const lobbyStage = $("lobbyStage");
  const previousMode = lobbyStage.dataset.mode;
  lobbyStage.dataset.mode = mode;
  if(!transition(mode==="party" ? "party" : "lobby")){
    lobbyStage.dataset.mode = previousMode;
    return;
  }
  wireLobby();
  $("lobbyName").value = localStorage.getItem(NAME_KEY) || "";
  resetLobbyUi();
  fitLobbyNames();
  const joining=pendingJoin; pendingJoin=null;
  if(mode==="party"){
    if(joining && partyBridge.join) partyBridge.join(joining);
    else if(partyBridge.create) partyBridge.create();
    return;
  }
  if(joining) joinRoom(joining);
  else createRoom();
}

function resetLobbyUi(){
  /* THE OPPONENT PANEL IS THE RIVAL'S VIDEO, so putting the lobby back to
     "waiting for a friend" has to include taking that video down. Without
     this, a rival who leaves the room leaves their last decoded frame frozen
     in the panel the waiting robot lives in: `.joined` came off, the robot
     came back, and the departed player's face stayed sitting behind him until
     someone else's stream replaced it. `leaveRoom()` always closed the peer;
     the `peer:left` path reached only this function and never did. */
  closePeer();
  roomCode=null; isHost=false; peerReady=false;
  settings={ ...DEFAULT_SETTINGS };
  renderCode("");
  renderSettings(true);
  $("joinCode").value="";
  $("lobbyStage").classList.remove("joined");
  $("lobbyOppName").textContent="RIVAL";
  $("lobbyYouName").textContent=(localStorage.getItem(NAME_KEY)||"YOU").slice(0,NAME_MAX);
  fitLobbyNames();
  const start=$("btnStartMatch");
  start.disabled=true; start.classList.remove("ready");
  setLobbyStatus("Connecting…");
}

function wireLobby(){
  if(wired) return;
  wired=true;
  $("btnCopyLink").onclick=async()=>{
    if(!roomCode) return;
    const link=location.origin+"/#join-"+roomCode;
    try{ await navigator.clipboard.writeText(link); toast("Invite link copied! Send it to your friend."); }
    catch(e){ toast("Copy failed. The code is "+roomCode); }
  };
  $("roomCodeText").onclick=async()=>{
    if(!roomCode) return;
    /* navigator.clipboard is undefined on an insecure origin — which is
       exactly the http://<host>:3000 LAN setup this game is played on. An
       empty catch made the click read as broken. */
    try{
      await navigator.clipboard.writeText(roomCode);
      toast("Room code copied!");
      blip([659,880],.05);
    }catch(e){ toast("Copy failed. The code is "+roomCode); }
  };
  $("btnJoinRoom").onclick=()=>{
    const code=$("joinCode").value.trim().toUpperCase();
    if(code.length!==6) return setLobbyStatus("Codes are 6 letters/numbers, like ABC234");
    if(lobbyMode()==="party"){
      partyBridge.leave?.();
      partyBridge.join?.(code);
      return;
    }
    leaveRoom();
    joinRoom(code);
  };
  $("btnStartMatch").onclick=()=>{
    if(lobbyMode()==="party"){ partyBridge.start?.(); return; }
    if(!socket || !isHost) return;
    socket.emit("match:begin", {}, res=>{
      if(res && res.error) setLobbyStatus(beginError(res.error));
    });
  };
  /* The mode paper pops back off the board first, mirroring the press that
     opened this room; the fsm listener still handles leaveRoom. */
  $("btnExitLobby").onclick=()=>leaveLobby(()=>transition("menu"));
  $("joinCode").addEventListener("input", e=>{ e.target.value=e.target.value.toUpperCase().replace(/[^A-Z0-9]/g,""); });
  $("lobbyName").addEventListener("input", e=>{
    const v=e.target.value.slice(0,NAME_MAX);
    e.target.value=v;
    $("lobbyYouName").textContent=v.trim()||"YOU";
    if(lobbyMode()==="party") partyBridge.rename?.(v);
    fitLobbyNames();
  });
  $("lobbyName").onchange=()=>{
    const name=$("lobbyName").value.trim().slice(0,NAME_MAX);
    localStorage.setItem(NAME_KEY, name);
    /* Input stays debounced while typing; change/commit flushes the final
       Party name before another player can join against a stale roster. */
    if(lobbyMode()==="party") partyBridge.rename?.(name, true);
    toast("Name saved. It applies to the next room you create or join.");
  };
  addEventListener("resize", ()=>{
    fitLobbyNames();
    fitLobbyStatus();
  });
  document.fonts?.ready.then(()=>{
    fitLobbyNames();
    fitLobbyStatus();
  });
  wireStepper("match", v=>({...settings, matchSecs:clamp(v,60,600)}), 30);
  wireStepper("word",  v=>({...settings, wordSecs:clamp(v,10,60)}), 5);
}

const clamp=(v,lo,hi)=>Math.max(lo,Math.min(hi,v));
const fmtSecs=s=>Math.floor(s/60)+":"+String(s%60).padStart(2,"0");

function wireStepper(key, apply, step){
  const read=()=> key==="match"?settings.matchSecs:settings.wordSecs;
  const change=delta=>{
    if(lobbyMode()==="party"){
      settings=apply(read()+delta*step);
      renderSettings(true);
      partyBridge.settings?.(settings);
      return;
    }
    if(!isHost) return;
    settings=apply(read()+delta*step);
    renderSettings(isHost);
    if(socket && roomCode) socket.emit("room:settings", { settings }, ()=>{});
  };
  $(key+"Minus").onclick=()=>change(-1);
  $(key+"Plus").onclick=()=>change(1);
}

function renderSettings(editable){
  /* A stepper that only rewrites a number reads as unresponsive on a paper
     card. Pop the value that actually moved. */
  setSettingValue("setMatch", fmtSecs(settings.matchSecs));
  setSettingValue("setWord", fmtSecs(settings.wordSecs));
  for(const id of ["matchMinus","matchPlus","wordMinus","wordPlus"])
    $(id).disabled=!editable;
}

function setSettingValue(id, text){
  const el=$(id);
  if(!el || el.textContent===text) return;
  el.textContent=text;
  el.classList.remove("bump");
  void el.offsetWidth;
  el.classList.add("bump");
  blip([440,554],.04);
}

function renderCode(code){
  const el=$("roomCodeText");
  el.textContent=code||"------";
  el.classList.toggle("loading", !code);
}

function setLobbyStatus(text){
  const el=$("lobbyStatus");
  el.classList.toggle("compact", Boolean(text && text.length > 34));
  if(!text){
    el.innerHTML='Waiting for friend to join<i id="dotsSmall">...</i>';
    fitLobbyStatus();
    return;
  }
  el.textContent=text;
  fitLobbyStatus();
}

function myName(){
  const raw=$("lobbyName").value.trim().slice(0,NAME_MAX) || "Player";
  localStorage.setItem(NAME_KEY, raw);
  return raw;
}

/* ---------------- socket ---------------- */

function loadSocketScript(){
  if(window.io) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s=document.createElement("script");
    s.src="/socket.io/socket.io.js";
    s.onload=resolve;
    s.onerror=()=>reject(new Error("socket.io script failed to load"));
    document.head.appendChild(s);
    setTimeout(()=>reject(new Error("socket.io script timed out")), 5000);
  });
}

async function ensureSocket(){
  if(socket && socket.connected) return socket;
  await loadSocketScript();
  if(socket){ socket.disconnect(); }
  /* Polling first, then upgrade: plain-HTTP polling works anywhere the page
     itself loads, while a websocket-first connect dies on machines whose
     antivirus/filters block unencrypted ws:// to LAN addresses. */
  socket=window.io({ transports:["polling","websocket"] });
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("connect_error", e=>reject(new Error("cannot reach server: "+e.message)));
    setTimeout(()=>reject(new Error("server connection timed out")), 8000);
  });
  await syncClock();
  _ice = await fetchIceServers(socket);
  wireSocket(socket);
  return socket;
}

/* THE ICE LIST COMES FROM THE SERVER, so switching a TURN relay on is a
   deployment decision and never a code change. With TURN_SECRET set the
   credential in it is signed and short-lived, which is why it is fetched per
   connection rather than baked in anywhere.
   It must never be able to hold up a lobby: a server that does not answer
   this (an older build, a hiccup) leaves the list null and webrtc.js falls
   back to the STUN-only default, which is exactly the behaviour that shipped
   before any of this existed. */
let _ice = null;

function fetchIceServers(s){
  return new Promise(resolve => {
    let settled = false;
    const finish = v => { if(!settled){ settled = true; resolve(v); } };
    setTimeout(() => finish(null), 2500);
    try{ s.emit("ice:servers", {}, res => finish(res?.iceServers || null)); }
    catch(_error){ finish(null); }
  });
}

export function iceServers(){ return _ice; }

function syncClock(){
  return new Promise(resolve => {
    const t0=Date.now();
    socket.emit("time:sync", {}, res=>{
      const t1=Date.now();
      if(res && Number.isFinite(res.serverNow)) clockOffset=res.serverNow-(t0+t1)/2;
      resolve();
    });
    setTimeout(resolve, 2000);
  });
}

function wireSocket(s){
  s.on("room:peer", ({name}={}) => {          // we are the host; a friend arrived
    peerName=String(name||"Rival");
    onPeerHere();
    setLobbyStatus(peerName+" joined! Press START MATCH when you’re ready");
    openPeer(true);
  });

  s.on("room:ready", () => {                   // both players ready
    peerReady=true;
    if(isHost){
      const b=$("btnStartMatch");
      b.disabled=false; b.classList.add("ready");
    }
    else setLobbyStatus("Waiting for "+peerName+" to start the match…");
  });

  s.on("room:settings", ({settings:incoming}={}) => {
    if(incoming){ settings={...settings, ...incoming}; renderSettings(isHost); }
  });

  s.on("rtc:signal", ({data}={}) => { if(peer) peer.handleSignal(data); });

  s.on("match:prepare", payload => onMatchPrepare(payload));
  s.on("match:start", payload => onMatchStart(payload));
  s.on("round:start", payload => onRoundStart(payload));
  s.on("round:guess", ({roundId,label,confidence}={}) =>
    renderRemoteMatchGuess(roundId,label,confidence));
  s.on("round:chase", payload => onRoundChase(payload));
  s.on("round:result", payload => onRoundResult(payload));
  s.on("match:sudden", payload => onMatchSudden(payload));
  s.on("match:end", payload => onMatchEnd(payload));
  s.on("match:rematch", ({ready, total, mine, voters=[]}={}) => {
    const mappedVoters = voters.map(id => id===s.id ? "me" : "rival");
    setRematchState(ready, total, mine, mappedVoters);
  });

  s.on("room:error", ({error}={}) => {
    toast(error==="no-shared-words"
      ? "You two have no words in common. Train the same words first."
      : "Room error: "+error);
  });

  s.on("peer:left", () => {
    toast(peerName+" left the game.");
    if(state.game && state.game.mode==="online") endOnline(null, "peer-left");
    else if(gameState()==="results" && $("resStage")?.dataset.mode==="1v1"){
      roomCode=null;
      closePeer();
      setRematchUnavailable(peerName+" left. Start a new room to play again.");
    }
    else if(gameState()==="lobby"){ resetLobbyUi(); createRoom(); }
  });

  s.on("disconnect", () => {
    if(state.game && state.game.mode==="online"){
      toast("Connection to the server was lost.");
      endOnline(null, "disconnected");
    }else if(gameState()==="results" && $("resStage")?.dataset.mode==="1v1"){
      roomCode=null;
      closePeer();
      setRematchUnavailable("Connection lost. Reconnect to play again.");
    }
  });
}

/* The room is created FOR you the moment you walk into the lobby, so when
   that create fails there is no button on the screen to press again — the
   code paper just sits at `------` with a line of grey text in the corner,
   which is exactly what "1v1 doesn't work" looks like from the sofa. Say it
   out loud on the toast, and keep trying: `rate-limited` clears itself as the
   server's per-minute bucket refills, and a dropped server comes back. */
const RETRY_MS = 4000;
function retryCreateLater(attempt){
  clearTimeout(retryTimer);
  retryTimer = setTimeout(() => {
    if(attempt === roomAttemptVersion && roomAttemptActive(attempt)) createRoom();
  }, RETRY_MS);
}

async function createRoom(){
  const attempt = ++roomAttemptVersion;
  const name=myName();
  clearTimeout(retryTimer);
  try{
    const s=await ensureSocket();
    if(!roomAttemptActive(attempt)) return;
    setLobbyStatus("Creating room…");
    s.emit("room:create", { name, labels:state.model.labels, settings }, res=>{
      if(!roomAttemptActive(attempt)) return;
      if(!res || res.error){
        const why = lobbyError(res);
        setLobbyStatus(why + " Retrying…");
        toast(why);
        retryCreateLater(attempt);
        return;
      }
      isHost=true; roomCode=res.code;
      renderCode(res.code);
      renderSettings(true);
      setLobbyStatus(null); // back to waiting-with-dots
      s.emit("player:ready", {}, ()=>{});
    });
  }catch(e){ if(roomAttemptActive(attempt)) offlineExplain(e, attempt); }
}

async function joinRoom(code){
  const attempt = ++roomAttemptVersion;
  const name=myName();
  try{
    const s=await ensureSocket();
    if(!roomAttemptActive(attempt)) return;
    setLobbyStatus("Joining "+code+"…");
    s.emit("room:join", { code, name, labels:state.model.labels }, res=>{
      if(!roomAttemptActive(attempt)) return;
      if(res && res.error==="party-room"){
        // that code is a party — hop over with the same code
        $("lobbyStage").dataset.mode="party";
        transition("party");
        partyBridge.join?.(code);
        return;
      }
      if(!res || res.error){
        const why = lobbyError(res);
        setLobbyStatus(why);
        toast(why);   // the JOIN button is right there; this one is not retried
        return;
      }
      isHost=false; roomCode=code;
      peerName=String(res.peerName||"Rival");
      if(res.settings){ settings={...settings, ...res.settings}; }
      renderCode(code);
      renderSettings(false);
      onPeerHere();
      $("btnStartMatch").disabled=true;
      setLobbyStatus("Joined "+peerName+"’s room. Waiting for them to start");
      openPeer(false);
      s.emit("player:ready", {}, ()=>{});
    });
  /* No attempt id, so no retry: retryCreateLater CREATES a room, and silently
     turning a failed join into a new room of your own is the one outcome a
     player pressing JOIN cannot want. The JOIN button is still right there. */
  }catch(e){ if(roomAttemptActive(attempt)) offlineExplain(e); }
}

function roomAttemptActive(attempt){
  return attempt === roomAttemptVersion && gameState() === "lobby" &&
    $("lobbyStage")?.dataset.mode !== "party";
}

function lobbyError(res){
  const e=res && res.error;
  return {
    "no-such-room":"No room with that code. Check it and try again.",
    "room-full":"That room already has two players.",
    "match-in-progress":"That match already started.",
    "rate-limited":"Slow down a little and try again.",
    "already-in-room":"You’re already in a room.",
    "server-full":"The server is full right now.",
    "bad-payload":"That didn’t look right. Check the code and your name.",
  }[e] || "Something went wrong ("+e+").";
}

function beginError(e){
  return {
    "not-host":"Only the host can start the match.",
    "not-ready":"Your rival’s camera isn’t ready yet. Give it a second.",
    "need-two":"Wait for a rival to join first!",
    "no-shared-words":"You two have no words in common. Train the same words first.",
  }[e] || "Couldn’t start ("+e+").";
}

/* A LOBBY THAT CANNOT REACH THE SERVER IS A DEAD END, and it was the only
   failure left that way. `room:create` returning an error already toasts and
   retries — see retryCreateLater, which exists precisely because the room is
   made FOR you on the way in and there is no button to press again. But
   `ensureSocket` REJECTING, which is what happens when there is no server at
   all, landed here: one line of grey text in the corner of the lobby, no
   toast, and nothing that would ever try again. The invite paper just sits at
   `------`, which is exactly what "1v1 doesn't work, I can't join" looks
   like from the sofa.

   Two failures reach this, and they want opposite things said:

   · The page was served by something that is not the game server — a plain
     static host, `python -m http.server`, a file:// open, a CDN preview. The
     game itself runs fine there, which is why Solo works and only the online
     modes are dead, and no amount of waiting will fix it. Say where the
     server is supposed to be.
   · The server is simply down, restarting, or the machine dropped its
     network. That one fixes itself, so keep trying.

   Both retry: retrying costs one socket attempt every four seconds and it
   means a lobby left open while `npm start` is still booting comes to life on
   its own rather than needing the player to guess and walk back out. */
async function offlineExplain(e, attempt){
  console.warn("online unavailable:", e);
  const wrongHost = await servedWithoutServer();
  const why = wrongHost
    ? "This page isn’t being served by the game server, so online play can’t connect. Run the server and open http://localhost:3000."
    : "Can’t reach the game server right now, retrying. You can head back and play Solo against the AI.";
  setLobbyStatus(why);
  /* ONCE PER VISIT. The status line is the running state and can say this for
     as long as it is true, but the retry fires every four seconds and a toast
     on every one of them is a strobe, not a message. */
  if(!offlineToasted){ offlineToasted = true; toast(why, wrongHost ? 9000 : undefined); }
  /* A static host will still be a static host in four seconds, so there is
     nothing to retry into. A server that is down is exactly the case that
     fixes itself. */
  if(attempt !== undefined && !wrongHost) retryCreateLater(attempt);
}

/* WHICH FAILURE IS IT? `window.io` cannot answer this: socket.io is fetched
   lazily on the first online action, so it is undefined on a perfectly good
   page too. Nor can the script's own load error — the script 404s on a static
   host AND fails to fetch from a server that has stopped.

   What separates them is whether ANYTHING answered. A game server replies to
   /socket.io/ with a handshake; a static host replies 404; a dead server
   replies not at all. So a response that is not ok means the origin is up and
   simply is not a game server, which no amount of retrying will change, and a
   network error means nothing answered — down, or offline, and that does come
   back. One probe, only ever on the failure path. */
async function servedWithoutServer(){
  try{
    const r = await fetch("/socket.io/?EIO=4&transport=polling", { cache: "no-store" });
    return !r.ok;
  }catch(_){
    return false;
  }
}

/* ---------------- webrtc video ---------------- */

/* Opponent arrived: the waving robot steps aside, the VS badge pops, the
   opponent's name chip appears over their frame. */
function onPeerHere(){
  $("lobbyOppName").textContent=peerName.slice(0,NAME_MAX).toUpperCase();
  $("lobbyStage").classList.add("joined");
  fitLobbyNames();
  blip([523,659], 0.08);
}

function openPeer(initiator){
  closePeer();
  if(!state.mediaStream){ toast("Camera isn’t ready yet."); return; }
  peer=createPeer({
    initiator,
    stream: state.mediaStream,
    iceServers: iceServers(),
    sendSignal: data => socket && socket.emit("rtc:signal", { data }),
    onRemoteStream: stream => {
      const v=$("videoRemote");
      v.srcObject=stream;
      v.classList.remove("hidden");
      const ph=$("rivalPlaceholder");
      if(ph) ph.classList.add("hidden");
      v.play().catch(()=>{});
    },
    onConnectionChange: st => {
      if(st==="failed") toast("Video connection failed. The game still works, you just can’t see each other.");
    },
    /* Route diagnostics only: which candidate types won, or that none did.
       No addresses, and nothing about the media itself. */
    onIceReport: r => { if(socket) socket.emit("net:report", { mode:"1v1", ...r }); },
  });
}

function closePeer(){
  if(peer){ peer.close(); peer=null; }
  const v=$("videoRemote");
  if(v){ v.srcObject=null; v.classList.add("hidden"); }
  const ph=$("rivalPlaceholder");
  if(ph) ph.classList.remove("hidden");
}

/* ---------------- match flow (server-driven) ---------------- */

/* #rivalMeter and #rivalGuessList belonged to the old dashboard HUD and no
   longer exist in the markup; the "?" they paired with also flashed for one
   classifier tick before renderGuesses overwrote it with "0%". */
function resetRivalPanel(){
  const word=$("rivalTopWord"), pct=$("rivalTopPct");
  if(word) word.textContent="GUESSING…";
  if(pct) pct.textContent="0%";
}

/* Everything the split-screen board carries from one word to the next. Shared
   by the countdown and each new round so the two can never drift. */
function clearMatchBoard(){
  hideSuddenDeath();
  const stage=$("matchStage");
  if(stage){
    stage.classList.remove("you-locked","rival-locked","chase-urgent","chase-final");
    delete stage.dataset.chaseSecond;
  }
  $("vsWord").textContent="…";
  scorePaintHeld=false;
  stopMatchFill();
  prepareWordFeedback($("vsWordCard"),$("v1WordFill"),THRESH,true);
  for(const id of ["myGuessTop","rivalGuessTop"]) markGuessRecognized($(id),false);
  /* Last word's papers were thrown into the score cards when it resolved, but
     a word that ends while one is still in the air must not carry it into the
     next — and settling it releases whatever repaint it was holding. */
  clearSeatAward(v1Seat(false));
  clearSeatAward(v1Seat(true));
}

function onMatchPrepare({tutorialId, tutorialStartsAt, matchMs, players}={}){
  if(typeof tutorialId!=="string" || !tutorialId) return;
  const myId=socket.id;
  const rec=(players||[]).find(p=>p.id!==myId);
  if(rec && rec.name) peerName=rec.name;
  if(!peer) openPeer(isHost);

  state.game={ mode:"online", tutorialId, word:null, round:0, rounds:0,
               matchEndsAt:0,
               matchLimitMs:Math.max(0,Number(matchMs)) || settings.matchSecs*1000,
               wordEnd:0, wordStart:0, wordLimitMs:settings.wordSecs*1000,
               holdSince:0, score:0, rivalScore:0,
               results:[], roundId:null, claimed:false, bestWrong:{},
               roundPhase:"waiting", firstId:null, firstPoints:0,
               suddenDeath:false };
  if(!transition("countdown")){ state.game=null; return; }

  resetRivalPanel();
  /* Clear last match's board BEFORE the 3·2·1: the lock classes pin the fill
     bar at 95% green, so a rematch otherwise counts in under the word you
     already won, apparently already solved. */
  clearMatchBoard();
  $("pillScore").textContent="0";
  /* time-based mode: the round pill becomes the match clock */
  document.querySelector(".statpill.round .lab").textContent="Match";
  const initialMatchLeft=state.game.matchLimitMs;
  $("pillRound").textContent=fmtTime(initialMatchLeft);
  if($("v1MatchTime")) $("v1MatchTime").textContent=fmtTime(
    initialMatchLeft, {compact:true});
  if($("v1YouName")) $("v1YouName").textContent=myName();
  if($("v1RivalName")) $("v1RivalName").textContent=peerName;
  requestAnimationFrame(fitMatchPaperText);
  applyScores(players);

  /* The board may assemble behind the modal, but neither the 3-2-1 nor a
     word is live until the server releases the room. BOTH players readying
     releases it at once; otherwise the server's grace does, and
     `tutorialStartsAt` is that moment — handed to the card so it can count it
     down on its own button rather than leaving anyone to wonder. Esc counts
     as an acknowledgement too: it dismisses the same decision and must not
     strand the peer. */
  clearInterval(countdownTimer);
  $("countdown").classList.add("hidden");
  const acknowledge=()=>{
    if(!socket?.connected) return;
    socket.emit("match:tutorial-ready", { tutorialId }, res=>{
      if(res?.error && res.error!=="match-in-progress")
        toast("Couldn’t ready the match ("+res.error+")");
    });
  };
  showHowToPlay({ mode:"1v1", ready:acknowledge, back:acknowledge,
    startsAt: Number(tutorialStartsAt) ? perfFromServer(Number(tutorialStartsAt)) : 0 });

  state.onlineClaim = () => {
    const g=state.game;
    if(!g || g.mode!=="online" || g.claimed || !g.roundId || !socket) return;
    g.claimed=true;
    /* The local stamp, taken here rather than off any packet: this is the
       actual instant the AI recognized this player, with no network in it. */
    g.claimedAt=performance.now();
    const recognizedAt=Math.round(serverNow());
    socket.emit("round:claim", { roundId:g.roundId, recognizedAt }, res=>{
      if(res?.error==="already-claimed") g.claimed=true;
      else if(res?.error && g.roundId) g.claimed=false;
    });
  };

  /* Four small label/confidence updates per second make the rival paper feel
     live without sending video frames, landmarks, or training data. */
  state.onlineGuess = (label,confidence) => {
    const g=state.game;
    if(!g || g.mode!=="online" || !g.roundId || g.claimed || !socket) return;
    if(g.roundPhase!=="word" && g.roundPhase!=="chase" && g.roundPhase!=="sudden") return;
    if(typeof label!=="string" || !Number.isFinite(confidence)) return;
    const now=performance.now();
    const changed=label!==lastGuessLabel ||
      Math.abs(confidence-lastGuessConfidence)>=.035;
    if(now-lastGuessSentAt<240 && !changed) return;
    if(now-lastGuessSentAt<140) return;
    lastGuessSentAt=now;
    lastGuessLabel=label;
    lastGuessConfidence=confidence;
    socket.emit("round:guess",{
      roundId:g.roundId,
      label,
      confidence:Math.round(Math.max(0,Math.min(1,confidence))*1000)/1000,
    });
  };
}

function onMatchStart({tutorialId, startAt, matchEndsAt, players}={}){
  const game=state.game;
  if(!game || game.mode!=="online" || game.tutorialId!==tutorialId) return;
  /* The grace releases the room whether or not this client answered, so the
     3-2-1 can arrive with the card still up on a tab that was slow, paused or
     mid-decode. Counting in behind it would deal the first word underneath a
     modal. */
  hideHowToPlay();
  game.matchEndsAt=perfFromServer(matchEndsAt);
  game.matchLimitMs=Math.max(0,Number(matchEndsAt)-Number(startAt)) ||
    game.matchLimitMs;
  applyScores(players);
  const initialMatchLeft=Math.max(0,Math.min(game.matchLimitMs,
    game.matchEndsAt-performance.now()));
  $("pillRound").textContent=fmtTime(initialMatchLeft);
  if($("v1MatchTime")) $("v1MatchTime").textContent=fmtTime(
    initialMatchLeft,{compact:true});

  const cd=$("countdown");
  cd.classList.remove("hidden");
  clearInterval(countdownTimer);
  countdownTimer=setInterval(()=>{
    if(gameState()!=="countdown" && gameState()!=="playing"){ clearInterval(countdownTimer); cd.classList.add("hidden"); return; }
    const left=Math.ceil((startAt-serverNow())/1000);
    if(left>0){ if(setCountdown(left)) blip([440]); }
    else { clearInterval(countdownTimer); cd.classList.add("hidden"); }
  },100);
}

function onRoundStart({roundId, word, roundNum, endsAt, suddenDeath=false}={}){
  const game=state.game;
  if(!game || game.mode!=="online") return;
  /* The bounded server fallback can release a room whose tab never clicked.
     Give it the whole fallback + count-in to read, then guarantee live play
     is never hidden behind the tutorial. */
  hideHowToPlay();
  if(gameState()!=="playing" && !transition("playing")) return;
  game.roundId=roundId;
  game.word=String(word||"");
  game.round=roundNum||game.round+1;
  game.claimed=false;
  game.holdSince=0;
  lastGuessSentAt=0;
  lastGuessLabel="";
  lastGuessConfidence=-1;
  const enteringSudden=!!suddenDeath && !game.suddenDeath;
  game.roundPhase=suddenDeath?"sudden":"word";
  game.suddenDeath=!!suddenDeath;
  if(enteringSudden) showSuddenDeath();
  game.firstId=null;
  game.firstPoints=0;
  game.chaseSecond=null;
  game.wordStart=performance.now();
  game.wordEnd=perfFromServer(endsAt);
  /* Cleared per word. These two are the only source the results screen's AVG
     and FASTEST chips and the METRONOME award have — onRoundResult reads them
     when it pushes the word's result. Online 1v1 never recorded a time at all,
     so every 1v1 results screen read "0.0 AVG" for both players. */
  game.claimedAt=0;
  game.rivalClaimedAt=0;
  if(state.smooth) state.smooth[game.word]=0;
  if($("v1WordTimerLabel")) $("v1WordTimerLabel").textContent=suddenDeath?"SUDDEN DEATH":"WORD TIME";
  clearMatchBoard();
  const stage=$("matchStage");
  if(stage) stage.dataset.phase=suddenDeath?"sudden":"word";
  $("vsWord").textContent=game.word;
  fitGameplayText($("vsWord"));
  requestAnimationFrame(fitMatchPaperText);
  resetRivalPanel();
  if(!game.timer) game.timer=setInterval(gameTick,100);
}

/* Recognition STAMPS the GOT IT paper on that player's own half — Solo's exact
   paper, on the face that earned it. It stays there for the rest of the word,
   which is precisely what the five-second chase needs the board to say: one
   player is already in, the other has until the clock runs out. Nothing is
   paid here; bankWordAwards throws both papers into their score cards when the
   word resolves. */
const v1Seat = rival =>
  document.querySelector(rival?".v1-video-side.rival":".v1-video-side.you");

function showMatchAward(side, points){
  const rival=side==="rival";
  const seat=v1Seat(rival);
  /* The resolving packet repeats what the chase packet already said. That
     player's paper is on their half from then; correct the figure in place
     rather than slamming a second one on top of it. */
  if(seatAwardIsUp(seat)){ setSeatAwardPoints(seat, points); return; }
  stampSeatAward(seat, {
    title:rival?peerName.toUpperCase()+" GOT IT!":"GOT IT!",
    points,
  });
  /* your win earns the paper burst; the rival's stamp stays informational */
  if(!rival) confettiFrom($("vsWordCard"));
  /* grab whoever was recognised, from the feed already showing them */
  const word = state.game?.word;
  if(rival) captureMoment("rival", word, $("videoRemote"), false);
  else captureMoment("me", word, $("video"), true);
}

/* End of the word: every paper still on the board is carried into the card it
   pays, and the totals are repainted only once the last one has landed. */
function bankWordAwards(){
  const sides=[v1Seat(false),v1Seat(true)].filter(seatAwardIsUp);
  if(!sides.length){ releaseScorePaint(); return; }
  holdScorePaint();
  let landed=0;
  sides.forEach((seat,i)=>{
    const rival=seat.classList.contains("rival");
    deliverSeatAward(seat,
      $(rival?"v1RivalScore":"v1YouScore")?.closest(".v1-scorecard"), {
        holdMs:SEAT_AWARD_HOLD_MS+i*140,
        onLand:()=>{
          blip([880]);
          if(++landed<sides.length) return;
          releaseScorePaint();
        },
      });
  });
}

/* `onStamped` exists because the stamp lands on the far side of the hitstop:
   a chaser caught on the resolving packet has no paper on the board yet when
   onRoundResult wants to bank the word. */
function playLocalMatchLock(points,onStamped){
  const card=$("vsWordCard");
  markGuessRecognized($("myGuessTop"),true);
  blip([523]);
  playWordLockFeedback({
    card,
    fill:$("v1WordFill"),
    threshold:THRESH,
    onImpact:()=>{
      /* the wash covers the whole split — flash() is bounded by #cameraDock */
      greenFlash(card);
      blip([523,659,784]);
      showMatchAward("you",points);
      onStamped?.();
    },
  });
}

/* The papers are not thrown until the word resolves, and the server's score
   packet lands well before that. Buffer the repaint so the number never jumps
   ahead of the paper carrying it. */
let scorePaintHeld=false;
function holdScorePaint(){ scorePaintHeld=true; }
function releaseScorePaint(){
  scorePaintHeld=false;
  const game=state.game;
  if(!game) return;
  paintMatchScores(game);
}

function paintMatchScores(game){
  setScoreText("v1YouScore",fmtScore(game.score));
  setScoreText("v1RivalScore",fmtScore(game.rivalScore));
}

function onRoundChase({firstId, firstPoints, chaseEndsAt, scores}={}){
  const game=state.game;
  if(!game || game.mode!=="online") return;
  const mine=firstId===socket.id;
  /* Hold BEFORE the scores land, whoever was first. The server has already
     banked the points, so painting them here puts the number on the card a
     whole chase window ahead of the paper carrying it — and leaves
     setScoreText with nothing to change on arrival, so the landing bump never
     fires either. onRoundResult's bankWordAwards releases it. */
  holdScorePaint();
  applyScores(scores);
  game.firstId=firstId;
  game.firstPoints=firstPoints|0;
  /* The chase opens the instant the first player locks, so this packet IS
     their recognition time — one network hop late, which is the best the
     rival's clock is ever going to be. Only taken for the rival; the local
     player already has an exact figure from `onlineClaim`. */
  if(!mine && !game.rivalClaimedAt) game.rivalClaimedAt=performance.now();
  game.roundPhase="chase";
  game.wordEnd=perfFromServer(chaseEndsAt);
  game.claimed=mine;
  game.chaseSecond=5;
  if($("v1WordTimerLabel")) $("v1WordTimerLabel").textContent="5 SECONDS LEFT";
  if($("v1WordTime")) $("v1WordTime").textContent="00:05";
  const stage=$("matchStage");
  if(stage){
    stage.dataset.phase="chase";
    stage.dataset.chaseSecond="5";
    stage.classList.toggle("you-locked",mine);
    stage.classList.toggle("rival-locked",!mine);
  }
  /* Phase-specific authored sizes are inline-fit guardrails, so apply them
     after publishing the chase phase instead of waiting a frame for the
     mutation observer. */
  fitGameplayText($("v1WordTimerLabel"));
  fitGameplayText($("v1WordTime"));
  const prefix=mine?"my":"rival";
  const topWord=$(prefix+"TopWord"), topPct=$(prefix+"TopPct"), topBox=$(prefix+"GuessTop");
  if(topWord) topWord.textContent=String(game.word||"").toUpperCase();
  if(topPct) topPct.textContent="100%";
  fitGameplayText(topWord);
  markGuessRecognized(topBox,true);
  if(mine){
    playLocalMatchLock(firstPoints);
  }else{
    showMatchAward("rival", firstPoints);
    blip([392,523,659]);
  }
}

function onRoundResult({
  winnerId, firstId, chaserId, firstPoints=0, chaserPoints=0,
  delaySeconds=null, reason, word, scores,
}={}){
  const game=state.game;
  if(!game || game.mode!=="online") return;
  const myId=socket.id;
  const iWasFirst=firstId===myId;
  const iWasChaser=chaserId===myId;
  const caught=reason==="chase-success";
  /* Same ordering as onRoundChase: the paper has to precede its number. */
  holdScorePaint();
  applyScores(scores);
  game.roundId=null;
  game.roundPhase="between";
  if(caught){
    for(const id of [firstId,chaserId]){
      if(!id) continue;
      const prefix=id===myId?"my":"rival";
      if($(prefix+"TopWord")) $(prefix+"TopWord").textContent=String(word||"").toUpperCase();
      if($(prefix+"TopPct")) $(prefix+"TopPct").textContent="100%";
      fitGameplayText($(prefix+"TopWord"));
      markGuessRecognized($(prefix+"GuessTop"),true);
    }
  }
  /* Seconds from the word being dealt to the AI recognising that player. Null
     whenever we genuinely do not know — the results chips read 0.0 rather than
     inventing a figure. `rivalSecs` falls back to the resolving packet because
     the server ends the word the moment a chase succeeds, so its arrival IS
     the rival's catch to within one hop. */
  const since = at => at ? Math.max(.1, (at-game.wordStart)/1000) : null;
  const mySecs = since(game.claimedAt);
  const rivalSecs = since(game.rivalClaimedAt || (caught&&iWasFirst ? performance.now() : 0));

  /* Every branch below only STAMPS. The word is banked once, at the bottom —
     one payoff per word, no matter how many players got it. */
  let bankAfterStamp=null;
  if(iWasFirst){
    /* `rivalChaser` is the rival's CLUTCH: they were the one caught up during
       the five-second chase. Recorded as a fact here rather than re-derived
       from the shape of the other fields at results time. */
    game.results.push({word, ok:true, pts:firstPoints, rivalPts:chaserPoints, first:true,
      secs:mySecs, rivalSecs:caught?rivalSecs:null, rivalChaser:caught});
    if(caught) showMatchAward("rival", chaserPoints);
    blip(caught?[523,659]:[523,659,784]);
  }else if(iWasChaser && caught){
    game.results.push({word, ok:true, pts:chaserPoints, rivalPts:firstPoints, chaser:true,
      secs:mySecs, rivalSecs});
    /* the local stamp lands on the far side of the hitstop */
    bankAfterStamp=fn=>playLocalMatchLock(chaserPoints,fn);
  }else if(winnerId){
    game.results.push({word, ok:false, rival:true, pts:0, rivalPts:firstPoints,
      secs:null, rivalSecs});
    /* The rival's award paper already says exactly this, in the paper-craft
       language the rest of the game speaks — the old square burst card was
       the last piece of the pre-Figma HUD still showing during a match. */
    showMatchAward("rival", firstPoints);
    blip([330,247]);
  }else{
    game.results.push({word, ok:false, timeout:true, secs:null, rivalSecs:null});
    showTimesUp();
  }
  const localSucceeded=iWasFirst || (caught&&iWasChaser);
  if(!localSucceeded){
    playWordMissFeedback($("vsWordCard"),THRESH);
    robotMiss(MATCH_ROBOT.my);
  }
  const stage=$("matchStage");
  if(stage){
    stage.dataset.phase="between";
    stage.classList.remove("chase-urgent","chase-final");
    delete stage.dataset.chaseSecond;
    /* Both successful players keep their word paper and local meter full
       through the between-word beat, including a successful chaser. */
    const youSucceeded=localSucceeded;
    const rivalSucceeded=(!!firstId&&firstId!==myId) ||
      (caught&&!!chaserId&&chaserId!==myId);
    stage.classList.toggle("you-locked",youSucceeded);
    stage.classList.toggle("rival-locked",rivalSucceeded);
  }
  if(bankAfterStamp) bankAfterStamp(bankWordAwards);
  else bankWordAwards();
  if(gameState()==="playing") transition("word-won");
}

/* Writes a score and pops its paper — but only when the number actually
   moved, so the per-round score sync doesn't bump on every packet. */
function setScoreText(id, text){
  const el=$(id);
  if(!el || el.textContent===text) return;
  el.textContent=text;
  const card=el.closest(".v1-scorecard");
  if(!card) return;
  card.classList.remove("bump");
  void card.offsetWidth;
  card.classList.add("bump");
}

function applyScores(scores){
  const game=state.game;
  if(!game || !Array.isArray(scores)) return;
  const myId=socket.id;
  for(const p of scores){
    if(p.id===myId) game.score=p.score|0;
    else game.rivalScore=p.score|0;
  }
  $("pillScore").textContent=fmtScore(game.score);
  /* Solo and Party both bump their score card when it changes; 1v1 was the
     one mode where points appeared with no reaction at all. */
  if(!scorePaintHeld) paintMatchScores(game);
  const stage=$("matchStage");
  if(stage){
    stage.classList.toggle("you-leading", game.score>game.rivalScore);
    stage.classList.toggle("rival-leading", game.rivalScore>game.score);
  }
}

function onMatchSudden({scores}={}){
  const game=state.game;
  if(!game || game.mode!=="online") return;
  applyScores(scores);
  game.suddenDeath=true;
  if($("v1WordTimerLabel")) $("v1WordTimerLabel").textContent="SUDDEN DEATH";
  /* The stage carries a sudden-death treatment and the screen edges pulse red
     for as long as it lasts, but the RULE CHANGE itself needs to land once,
     loudly. The banner IS that landing, and it is the only one: a toast at the
     bottom edge of a full-screen camera is not something a player mid-pose
     ever reads, and running both said the same sentence twice. */
  showSuddenDeath();
}

function onMatchEnd({scores, winnerId, suddenDeath=false, rematch}={}){
  applyScores(scores);
  endOnline(scores, "finished", {winnerId, suddenDeath, rematch});
}

/* Build the results card from what the server told us and clean up. */
function endOnline(scores, why, outcome={}){
  const g=state.game;
  if(!g) return;
  clearInterval(g.timer);
  clearInterval(countdownTimer);
  $("countdown").classList.add("hidden");
  state.game=null;
  state.onlineClaim=null;
  state.onlineGuess=null;
  const rivalStream=$("videoRemote")?.srcObject || null;
  const sameRoom=why==="finished" && !!roomCode && !!socket?.connected;
  if(!sameRoom) closePeer();

  const mineTimes=g.results.filter(r=>r.ok && Number.isFinite(r.secs)).map(r=>r.secs);
  const rivalTimes=g.results.filter(r=>Number.isFinite(r.rivalSecs)).map(r=>r.rivalSecs);
  const mean=list=>list.length?list.reduce((a,b)=>a+b,0)/list.length:null;
  const title = why==="finished"
    ? (outcome.winnerId===socket?.id || (!outcome.winnerId && g.score>g.rivalScore)
        ? myName().toUpperCase()+" WINS!"
        : outcome.winnerId ? peerName.toUpperCase()+" WINS!"
        : "IT’S A TIE!")
    : (why==="peer-left" ? peerName.toUpperCase()+" LEFT EARLY" : "MATCH ENDED EARLY");

  showResults({
    mode:"1v1", size:2, headline:title,
    teams:{ blue:g.score, orange:g.rivalScore },
    players:[
      { id:"me", name:myName(), team:"blue", mine:true, score:g.score,
        firsts:g.results.filter(r=>r.ok).length,
        fastest:mineTimes.length?Math.min(...mineTimes):null,
        avg:mean(mineTimes),
        /* `chaser` is the key onRoundResult writes. `chase` was never on any
           result object, so CLUTCH read 0 for the whole life of online 1v1. */
        clutch:g.results.filter(r=>r.ok && r.chaser).length, ready:false },
      { id:"rival", name:peerName, team:"orange", mine:false, score:g.rivalScore,
        firsts:g.results.filter(r=>r.rival).length,
        fastest:rivalTimes.length?Math.min(...rivalTimes):null,
        avg:mean(rivalTimes),
        clutch:g.results.filter(r=>r.rivalChaser).length,
        ready:false, stream:rivalStream },
    ],
    rematch: sameRoom
      ? { ready:outcome.rematch?.ready || 0,
          total:outcome.rematch?.total || 2, mine:false }
      : { ready:0, total:1, mine:false, direct:true },
    onRematch: sameRoom
      ? () => new Promise(resolve =>
          socket.emit("match:rematch", {}, response => resolve(response || {error:"offline"})))
      : () => enterLobby(),
  });
  state.lastMode="online";
}

/* ---------------- leaving ---------------- */

export function leaveRoom(){
  roomAttemptVersion++;
  clearTimeout(retryTimer);
  /* A fresh visit gets to hear it again — this is per-lobby, not per-session,
     because walking back in is exactly when a player is asking why. */
  offlineToasted = false;
  /* Also send during a pending create/join. Socket.IO preserves ordering, so
     create → leave reaches the server even before the create ack sets code. */
  if(socket && socket.connected) socket.emit("room:leave", {}, ()=>{});
  roomCode=null;
  /* Clear the shared invite paper synchronously. Otherwise a fast
     lobby→home→Party handoff can momentarily expose the departed 1v1 code,
     and consumers cannot distinguish it from the new party create ack. */
  renderCode(null);
  state.onlineGuess=null;
  closePeer();
  const stage=$("lobbyStage");
  if(stage) stage.classList.remove("joined");
}

/* Shared-chrome helpers for the party controller. */
export { ensureSocket, myName, setLobbyStatus, serverNow, perfFromServer };
export const lobbySettings = () => settings;
export const renderLobbySettings = editable => renderSettings(editable);
export const setLobbyCode = code => { roomCode = code; renderCode(code); };

partyBridge.rejoin1v1 = code => { transition("lobby"); $("lobbyStage").dataset.mode="1v1"; joinRoom(code); };
