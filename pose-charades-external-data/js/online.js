/* Online private-room 1v1.

   The server is authoritative: it deals words, times rounds, validates
   point claims, and keeps scores. This module mirrors its events into the
   local FSM/UI. Classification stays 100% local — the only things sent are
   the player's name, word labels, match settings, point claims, and opaque
   WebRTC blobs.

   Lobby flow (matches the mockup): opening 1v1 auto-creates a room and
   shows the code + share link. A friend joins via code or link. The host
   picks match settings (rounds / round timer / target score) and presses
   START MATCH; the joiner's screen says "waiting for host".

   The socket.io client script loads lazily from the game server itself, so
   offline modes still work from any static host. */

import { $, esc } from "./dom.js";
import { state } from "./state.js";
import { toast, flash, pointBurst, fmtTime, fmtScore } from "./ui.js";
import { blip } from "./audio.js";
import { gameState, transition, onTransition } from "./fsm.js";
import { gameTick } from "./game.js";
import { renderDots } from "./screens.js";
import { createPeer } from "./webrtc.js";

const NAME_KEY = "poseCharadesName";
const DEFAULT_SETTINGS = { rounds:5, wordSecs:30, target:5 };

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

const serverNow = () => Date.now() + clockOffset;
const perfFromServer = tServer => performance.now() + (tServer - serverNow());

/* Leaving the lobby or an online match through any exit that isn't the
   results screen tells the server and drops the peer link. Registered at
   import time, before game.js's lifecycle listener. */
const inGame = s => s==="countdown"||s==="playing"||s==="word-won";
onTransition((to, from) => {
  if(state.game?.mode==="online" && inGame(from) && !inGame(to) && to!=="results"){
    leaveRoom();
    state.onlineClaim=null;
    clearInterval(countdownTimer);
  }
  if(from==="lobby" && to!=="countdown" && to!=="lobby") leaveRoom();
});

/* ---------------- lobby ---------------- */

export function setPendingJoin(code){ pendingJoin=code; }

export function enterLobby(){
  if(!state.model || state.model.labels.filter(l=>l!=="idle").length<1){
    toast("Train the AI first — record idle plus at least one action word. Tap SETTINGS.");
    transition("training"); return;
  }
  if(!transition("lobby")) return;
  wireLobby();
  $("lobbyName").value = localStorage.getItem(NAME_KEY) || "";
  resetLobbyUi();
  const joining=pendingJoin; pendingJoin=null;
  if(joining) joinRoom(joining);
  else createRoom();
}

function resetLobbyUi(){
  roomCode=null; isHost=false; peerReady=false;
  settings={ ...DEFAULT_SETTINGS };
  renderCode("");
  renderSettings(true);
  $("roomLink").value="";
  $("rivalBadgeLobby").textContent="RIVAL";
  $("btnStartMatch").disabled=true;
  $("lobbyRoleNote").textContent="Host controls the match.";
  setLobbyStatus("Connecting…");
}

function wireLobby(){
  if(wired) return;
  wired=true;
  $("btnCopyLink").onclick=async()=>{
    if(!$("roomLink").value) return;
    try{ await navigator.clipboard.writeText($("roomLink").value); toast("Link copied — send it to your rival!"); }
    catch(e){ toast("Copy failed — select the link and copy it manually."); }
  };
  $("btnJoinRoom").onclick=()=>{
    const code=$("joinCode").value.trim().toUpperCase();
    if(code.length!==6) return setLobbyStatus("Codes are 6 letters/numbers, like ABC234.");
    leaveRoom();
    joinRoom(code);
  };
  $("btnStartMatch").onclick=()=>{
    if(!socket || !isHost) return;
    socket.emit("match:begin", {}, res=>{
      if(res && res.error) setLobbyStatus(beginError(res.error));
    });
  };
  $("btnViewGuide").onclick=()=>toast("Same word for both players — first AI to hit the threshold wins the word!");
  $("lobbyName").onchange=()=>{
    localStorage.setItem(NAME_KEY, $("lobbyName").value.trim().slice(0,16));
    setLobbyStatus("Name saved — it applies to the next room you create or join.");
  };
  wireStepper("rounds", v=>({...settings, rounds:clamp(v,1,10)}));
  wireStepper("timer",  v=>({...settings, wordSecs:clamp(v,10,60)}));
  wireStepper("target", v=>({...settings, target:clamp(v,1,20)}));
}

const clamp=(v,lo,hi)=>Math.max(lo,Math.min(hi,v));

function wireStepper(key, apply){
  const step = key==="timer" ? 5 : 1;
  const read = () => key==="rounds"?settings.rounds:key==="timer"?settings.wordSecs:settings.target;
  const change = delta => {
    if(!isHost) return;
    settings=apply(read()+delta*step);
    renderSettings(isHost);
    if(socket && roomCode) socket.emit("room:settings", { settings }, ()=>{});
  };
  $(key+"Minus").onclick=()=>change(-1);
  $(key+"Plus").onclick=()=>change(1);
}

function renderSettings(editable){
  $("setRounds").textContent=settings.rounds;
  $("setTimer").textContent=settings.wordSecs+"s";
  $("setTarget").textContent=settings.target;
  for(const id of ["roundsMinus","roundsPlus","timerMinus","timerPlus","targetMinus","targetPlus"])
    $(id).disabled=!editable;
}

function renderCode(code){
  const boxes=$("codeBoxes").children;
  for(let i=0;i<boxes.length;i++) boxes[i].textContent=code[i]||"·";
}

function setLobbyStatus(text){
  const el=$("lobbyStatus");
  if(!text){ el.classList.remove("show"); return; }
  el.classList.add("show");
  el.textContent=text;
}

function myName(){
  const raw=$("lobbyName").value.trim().slice(0,16) || "Player";
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
  wireSocket(socket);
  return socket;
}

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
    $("rivalBadgeLobby").textContent=peerName.slice(0,12).toUpperCase();
    setLobbyStatus(peerName+" joined! Press START MATCH when you’re ready.");
    setRivalPlaceholder(peerName+" connected", "video connecting…");
    openPeer(true);
  });

  s.on("room:ready", () => {                   // both players ready
    peerReady=true;
    if(isHost){ $("btnStartMatch").disabled=false; }
    else setLobbyStatus("Waiting for "+peerName+" to start the match…");
  });

  s.on("room:settings", ({settings:incoming}={}) => {
    if(incoming){ settings={...settings, ...incoming}; renderSettings(isHost); }
  });

  s.on("rtc:signal", ({data}={}) => { if(peer) peer.handleSignal(data); });

  s.on("match:start", payload => onMatchStart(payload));
  s.on("round:start", payload => onRoundStart(payload));
  s.on("round:result", payload => onRoundResult(payload));
  s.on("match:end", payload => onMatchEnd(payload));

  s.on("room:error", ({error}={}) => {
    toast(error==="no-shared-words"
      ? "You two have no words in common — train the same words first."
      : "Room error: "+error);
  });

  s.on("peer:left", () => {
    toast(peerName+" left the game.");
    if(state.game && state.game.mode==="online") endOnline(null, "peer-left");
    else if(gameState()==="lobby"){ resetLobbyUi(); createRoom(); }
  });

  s.on("disconnect", () => {
    if(state.game && state.game.mode==="online"){
      toast("Connection to the server was lost.");
      endOnline(null, "disconnected");
    }
  });
}

async function createRoom(){
  const name=myName();
  try{
    const s=await ensureSocket();
    setLobbyStatus("Creating room…");
    s.emit("room:create", { name, labels:state.model.labels, settings }, res=>{
      if(!res || res.error) return setLobbyStatus(lobbyError(res));
      isHost=true; roomCode=res.code;
      renderCode(res.code);
      renderSettings(true);
      $("roomLink").value=location.origin+"/#join-"+res.code;
      setLobbyStatus("Share the code or link with a friend — the START button unlocks when they join.");
      s.emit("player:ready", {}, ()=>{});
    });
  }catch(e){ offlineExplain(e); }
}

async function joinRoom(code){
  const name=myName();
  try{
    const s=await ensureSocket();
    setLobbyStatus("Joining "+code+"…");
    s.emit("room:join", { code, name, labels:state.model.labels }, res=>{
      if(!res || res.error) return setLobbyStatus(lobbyError(res));
      isHost=false; roomCode=code;
      peerName=String(res.peerName||"Rival");
      if(res.settings){ settings={...settings, ...res.settings}; }
      renderCode(code);
      renderSettings(false);
      $("roomLink").value=location.origin+"/#join-"+code;
      $("rivalBadgeLobby").textContent=peerName.slice(0,12).toUpperCase();
      $("lobbyRoleNote").textContent=peerName+" is the host — they start the match.";
      $("btnStartMatch").disabled=true;
      setLobbyStatus("Joined "+peerName+"’s room — waiting for them to start.");
      setRivalPlaceholder(peerName+" connected", "video connecting…");
      openPeer(false);
      s.emit("player:ready", {}, ()=>{});
    });
  }catch(e){ offlineExplain(e); }
}

function lobbyError(res){
  const e=res && res.error;
  return {
    "no-such-room":"No room with that code — check it and try again.",
    "room-full":"That room already has two players.",
    "match-in-progress":"That match already started.",
    "rate-limited":"Slow down a little and try again.",
    "already-in-room":"You’re already in a room.",
    "server-full":"The server is full right now.",
    "bad-payload":"That didn’t look right — check the code and your name.",
  }[e] || "Something went wrong ("+e+").";
}

function beginError(e){
  return {
    "not-host":"Only the host can start the match.",
    "not-ready":"Your rival’s camera isn’t ready yet — give it a second.",
    "need-two":"Wait for a rival to join first!",
    "no-shared-words":"You two have no words in common — train the same words first.",
  }[e] || "Couldn’t start ("+e+").";
}

function offlineExplain(e){
  console.warn("online unavailable:", e);
  setLobbyStatus("Can’t reach the game server. Online play needs the app served by the Node server: run “npm start” inside server/ and open the address it prints. (You can still play PRACTICE VS ROBOT from the home screen’s Play with AI.)");
}

/* ---------------- webrtc video ---------------- */

function setRivalPlaceholder(main, small){
  const ph=$("rivalPlaceholder");
  ph.querySelector("span").textContent=main;
  ph.querySelector("small").textContent=small;
}

function openPeer(initiator){
  closePeer();
  if(!state.mediaStream){ toast("Camera isn’t ready yet."); return; }
  peer=createPeer({
    initiator,
    stream: state.mediaStream,
    sendSignal: data => socket && socket.emit("rtc:signal", { data }),
    onRemoteStream: stream => {
      const v=$("videoRemote");
      v.srcObject=stream;
      v.classList.remove("hidden");
      $("rivalPlaceholder").classList.add("hidden");
      v.play().catch(()=>{});
    },
    onConnectionChange: st => {
      if(st==="failed") toast("Video connection failed — the game still works, you just can’t see each other.");
    },
  });
}

function closePeer(){
  if(peer){ peer.close(); peer=null; }
  const v=$("videoRemote");
  if(v){ v.srcObject=null; v.classList.add("hidden"); }
  const ph=$("rivalPlaceholder");
  if(ph){ ph.classList.remove("hidden"); setRivalPlaceholder("Waiting for rival…","share the room code or link below"); }
}

/* ---------------- match flow (server-driven) ---------------- */

function resetRivalPanel(){
  $("rivalTopWord").textContent="GUESSING…";
  $("rivalTopPct").textContent="?";
  [...$("rivalMeter").children].forEach(seg=>seg.classList.remove("on"));
  $("rivalGuessList").innerHTML='<div class="grow"><span class="gname" style="white-space:normal;text-transform:none">'+
    esc(peerName)+"’s AI runs on their device — first to convince their AI wins the word!</span></div>";
}

function onMatchStart({startAt, rounds, players}={}){
  const myId=socket.id;
  const rec=(players||[]).find(p=>p.id!==myId);
  if(rec && rec.name) peerName=rec.name;

  state.game={ mode:"online", word:null, round:0, rounds:rounds||settings.rounds,
               wordEnd:0, wordStart:0, holdSince:0, score:0, rivalScore:0, streak:0,
               results:[], roundId:null, claimed:false, bestWrong:{} };
  if(!transition("countdown")){ state.game=null; return; }

  resetRivalPanel();
  $("pillScore").textContent="0";
  $("pillStreak").textContent="x1";
  $("pillRound").textContent="1 / "+state.game.rounds;
  renderDots(1, state.game.rounds);

  const cd=$("countdown");
  cd.classList.remove("hidden");
  clearInterval(countdownTimer);
  countdownTimer=setInterval(()=>{
    if(gameState()!=="countdown" && gameState()!=="playing"){ clearInterval(countdownTimer); cd.classList.add("hidden"); return; }
    const left=Math.ceil((startAt-serverNow())/1000);
    if(left>0){ if(cd.textContent!==String(left)){ cd.textContent=String(left); blip([440]); } }
    else { clearInterval(countdownTimer); cd.classList.add("hidden"); }
  },100);

  state.onlineClaim = () => {
    const g=state.game;
    if(!g || g.mode!=="online" || g.claimed || !g.roundId || !socket) return;
    g.claimed=true;
    socket.emit("round:claim", { roundId:g.roundId }, ()=>{ /* result arrives as round:result */ });
  };
}

function onRoundStart({roundId, word, roundNum, rounds, endsAt}={}){
  const game=state.game;
  if(!game || game.mode!=="online") return;
  if(gameState()!=="playing" && !transition("playing")) return;
  game.roundId=roundId;
  game.word=String(word||"");
  game.round=roundNum||game.round+1;
  game.claimed=false;
  game.holdSince=0;
  game.wordStart=performance.now();
  game.wordEnd=perfFromServer(endsAt);
  $("vsWord").textContent=game.word;
  $("pillRound").textContent=game.round+" / "+(rounds||game.rounds);
  renderDots(game.round, rounds||game.rounds);
  const vw=$("vsWordCard");
  if(vw){ vw.classList.remove("wordswap"); void vw.offsetWidth; vw.classList.add("wordswap"); }
  if(!game.timer) game.timer=setInterval(gameTick,100);
}

function onRoundResult({winnerId, word, scores}={}){
  const game=state.game;
  if(!game || game.mode!=="online") return;
  const myId=socket.id;
  applyScores(scores);
  game.roundId=null;

  if(winnerId===myId){
    game.streak++;
    game.results.push({word, ok:true});
    pointBurst("You win!", word+" · +1"+(game.streak>1?" · streak x"+game.streak:""), "good");
    flash("good"); blip([523,659,784]);
  }else if(winnerId){
    game.streak=0;
    game.results.push({word, ok:false, rival:true});
    pointBurst(peerName+" wins!", word+" · +1", "rival");
    flash("bad"); blip([330,247]);
  }else{
    game.streak=0;
    game.results.push({word, ok:false, timeout:true});
    pointBurst("Time up", "Next word coming up", "bad");
    flash("bad"); blip([220,165]);
  }
  $("pillStreak").textContent="x"+Math.max(1,game.streak);
  if(gameState()==="playing") transition("word-won");
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
}

function onMatchEnd({scores}={}){
  applyScores(scores);
  endOnline(scores, "finished");
}

/* Build the results card from what the server told us and clean up. */
function endOnline(scores, why){
  const g=state.game;
  if(!g) return;
  clearInterval(g.timer);
  clearInterval(countdownTimer);
  $("countdown").classList.add("hidden");
  state.game=null;
  state.onlineClaim=null;
  closePeer();

  const rows=g.results.map(r=>{
    const right='<span class="ok">You +1</span>';
    const rival='<span class="miss">'+esc(peerName)+' +1</span>';
    const none='<span class="miss">time up</span>';
    return '<div class="resrow"><span>'+esc(r.word)+'</span><span>'+(r.ok?right:(r.rival?rival:none))+'</span></div>';
  }).join("");
  const title='YOU '+g.score+' — '+esc(peerName.toUpperCase())+' '+g.rivalScore;
  const sub = why==="finished"
    ? (g.score>g.rivalScore ? "You won the showdown!" : g.score<g.rivalScore ? peerName+" won the showdown" : "It’s a tie!")
    : (why==="peer-left" ? peerName+" left early" : "Match ended early");
  $("rescard").innerHTML='<h2>'+title+'</h2><div class="sub">'+esc(sub)+'</div>'+rows;
  transition("results");
  state.lastMode="online";
}

/* ---------------- leaving ---------------- */

export function leaveRoom(){
  if(socket && socket.connected && roomCode) socket.emit("room:leave", {}, ()=>{});
  roomCode=null;
  closePeer();
}

/* Quit button during an online match. */
export function quitOnline(){
  if(state.game && state.game.mode==="online") endOnline(null, "quit");
  leaveRoom();
}
