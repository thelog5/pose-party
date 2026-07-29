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
import { toast, flash, pointBurst, fmtTime, fmtScore, fitMatchPaperText,
         renderRemoteMatchGuess } from "./ui.js";
import { blip } from "./audio.js";
import { gameState, transition, onTransition } from "./fsm.js";
import { gameTick } from "./game.js";
import { createPeer } from "./webrtc.js";
import { showPointsAward } from "./soloRound.js";

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
  if(from==="party" && to==="lobby") leaveRoom(); // mode hop cleans 1v1 side too
});

/* ---------------- lobby ---------------- */

export function setPendingJoin(code){ pendingJoin=code; }

export function enterLobby(mode="1v1"){
  if(!state.model || state.model.labels.filter(l=>l!=="idle").length<1){
    toast("Train the AI first — record idle plus at least one action word. Tap SETTINGS.");
    transition("training"); return;
  }
  if(!transition(mode==="party" ? "party" : "lobby")) return;
  $("lobbyStage").dataset.mode = mode;
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
  roomCode=null; isHost=false; peerReady=false;
  settings={ ...DEFAULT_SETTINGS };
  renderCode("");
  renderSettings(true);
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
    try{ await navigator.clipboard.writeText(link); toast("Invite link copied — send it to your friend!"); }
    catch(e){ toast("Copy failed — the code is "+roomCode); }
  };
  $("roomCodeText").onclick=async()=>{
    if(!roomCode) return;
    try{ await navigator.clipboard.writeText(roomCode); toast("Room code copied!"); }catch(e){}
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
  $("btnExitLobby").onclick=()=>transition("menu");   // fsm listener handles leaveRoom
  $("joinCode").addEventListener("input", e=>{ e.target.value=e.target.value.toUpperCase().replace(/[^A-Z0-9]/g,""); });
  $("lobbyName").addEventListener("input", e=>{
    const v=e.target.value.slice(0,NAME_MAX);
    e.target.value=v;
    $("lobbyYouName").textContent=v.trim()||"YOU";
    if(lobbyMode()==="party") partyBridge.rename?.(v);
    fitLobbyNames();
  });
  $("lobbyName").onchange=()=>{
    localStorage.setItem(NAME_KEY, $("lobbyName").value.trim().slice(0,NAME_MAX));
    toast("Name saved — it applies to the next room you create or join.");
  };
  addEventListener("resize", fitLobbyNames);
  document.fonts?.ready.then(fitLobbyNames);
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
  $("setMatch").textContent=fmtSecs(settings.matchSecs);
  $("setWord").textContent=settings.wordSecs+"s";
  for(const id of ["matchMinus","matchPlus","wordMinus","wordPlus"])
    $(id).disabled=!editable;
}

function renderCode(code){
  $("roomCodeText").textContent=code||"······";
}

function setLobbyStatus(text){
  const el=$("lobbyStatus");
  el.classList.toggle("compact", Boolean(text && text.length > 34));
  if(!text){
    el.innerHTML='Waiting for friend to join<i id="dotsSmall">...</i>';
    return;
  }
  el.textContent=text;
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

  s.on("match:start", payload => onMatchStart(payload));
  s.on("round:start", payload => onRoundStart(payload));
  s.on("round:guess", ({roundId,label,confidence}={}) =>
    renderRemoteMatchGuess(roundId,label,confidence));
  s.on("round:chase", payload => onRoundChase(payload));
  s.on("round:result", payload => onRoundResult(payload));
  s.on("match:sudden", payload => onMatchSudden(payload));
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
      setLobbyStatus(null); // back to waiting-with-dots
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
      if(res && res.error==="party-room"){
        // that code is a party — hop over with the same code
        $("lobbyStage").dataset.mode="party";
        transition("party");
        partyBridge.join?.(code);
        return;
      }
      if(!res || res.error) return setLobbyStatus(lobbyError(res));
      isHost=false; roomCode=code;
      peerName=String(res.peerName||"Rival");
      if(res.settings){ settings={...settings, ...res.settings}; }
      renderCode(code);
      renderSettings(false);
      onPeerHere();
      $("btnStartMatch").disabled=true;
      setLobbyStatus("Joined "+peerName+"’s room — waiting for them to start");
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
      if(st==="failed") toast("Video connection failed — the game still works, you just can’t see each other.");
    },
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

function resetRivalPanel(){
  const word=$("rivalTopWord"), pct=$("rivalTopPct");
  const meter=$("rivalMeter"), list=$("rivalGuessList");
  if(word) word.textContent="GUESSING…";
  if(pct) pct.textContent="?";
  if(meter) [...meter.children].forEach(seg=>seg.classList.remove("on"));
  if(list) list.innerHTML='<div class="grow"><span class="gname" style="white-space:normal;text-transform:none">'+
    esc(peerName)+"’s AI runs on their device — first to convince their AI wins the word!</span></div>";
}

function onMatchStart({startAt, matchEndsAt, players}={}){
  const myId=socket.id;
  const rec=(players||[]).find(p=>p.id!==myId);
  if(rec && rec.name) peerName=rec.name;

  state.game={ mode:"online", word:null, round:0, rounds:0,
               matchEndsAt:perfFromServer(matchEndsAt),
               wordEnd:0, wordStart:0, wordLimitMs:settings.wordSecs*1000,
               holdSince:0, score:0, rivalScore:0, streak:0,
               results:[], roundId:null, claimed:false, bestWrong:{},
               roundPhase:"waiting", firstId:null, firstPoints:0,
               suddenDeath:false };
  if(!transition("countdown")){ state.game=null; return; }

  resetRivalPanel();
  $("pillScore").textContent="0";
  $("pillStreak").textContent="x1";
  /* time-based mode: the round pill becomes the match clock */
  document.querySelector(".statpill.round .lab").textContent="Match";
  $("pillRound").textContent=fmtTime(state.game.matchEndsAt-performance.now());
  if($("v1YouName")) $("v1YouName").textContent=myName();
  if($("v1RivalName")) $("v1RivalName").textContent=peerName;
  requestAnimationFrame(fitMatchPaperText);
  applyScores(players);

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

function onRoundStart({roundId, word, roundNum, endsAt, suddenDeath=false}={}){
  const game=state.game;
  if(!game || game.mode!=="online") return;
  if(gameState()!=="playing" && !transition("playing")) return;
  game.roundId=roundId;
  game.word=String(word||"");
  game.round=roundNum||game.round+1;
  game.claimed=false;
  game.holdSince=0;
  lastGuessSentAt=0;
  lastGuessLabel="";
  lastGuessConfidence=-1;
  game.roundPhase=suddenDeath?"sudden":"word";
  game.suddenDeath=!!suddenDeath;
  game.firstId=null;
  game.firstPoints=0;
  game.chaseSecond=null;
  game.wordStart=performance.now();
  game.wordEnd=perfFromServer(endsAt);
  if(state.smooth) state.smooth[game.word]=0;
  if($("v1WordFill")) $("v1WordFill").style.width="0%";
  $("vsWord").textContent=game.word;
  requestAnimationFrame(fitMatchPaperText);
  if($("v1WordTimerLabel")) $("v1WordTimerLabel").textContent=suddenDeath?"SUDDEN DEATH":"WORD TIMER";
  const stage=$("matchStage");
  if(stage){
    stage.dataset.phase=suddenDeath?"sudden":"word";
    stage.classList.remove("you-locked","rival-locked","chase-urgent","chase-final");
    delete stage.dataset.chaseSecond;
  }
  const vw=$("vsWordCard");
  if(vw){
    vw.classList.remove("tracking","warm","hot","critical","wordswap");
    void vw.offsetWidth; vw.classList.add("wordswap");
  }
  resetRivalPanel();
  if(!game.timer) game.timer=setInterval(gameTick,100);
}

/* Both halves use Solo's existing award paper. Only the latest recognition
   stays on screen, so a quick chase reads as a clean handoff from the first
   player to the chaser instead of two overlapping papers. */
function showMatchAward(side, points){
  const rival=side==="rival";
  const awardId=rival?"v1RivalAward":"v1Award";
  const pointsId=rival?"v1RivalAwardPts":"v1AwardPts";
  const other=$(rival?"v1Award":"v1RivalAward");
  if(other){
    clearTimeout(other._awardTimer);
    other.classList.remove("show");
  }
  if(rival && $("v1RivalAwardTitle"))
    $("v1RivalAwardTitle").textContent=peerName.toUpperCase()+" GOT IT!";
  showPointsAward(awardId, pointsId, points);
}

function onRoundChase({firstId, firstPoints, chaseEndsAt, scores}={}){
  const game=state.game;
  if(!game || game.mode!=="online") return;
  const mine=firstId===socket.id;
  applyScores(scores);
  game.firstId=firstId;
  game.firstPoints=firstPoints|0;
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
  const prefix=mine?"my":"rival";
  const topWord=$(prefix+"TopWord"), topPct=$(prefix+"TopPct"), topBox=$(prefix+"GuessTop");
  if(topWord) topWord.textContent=String(game.word||"").toUpperCase();
  if(topPct) topPct.textContent="100%";
  if(topBox){ topBox.classList.remove("pop"); void topBox.offsetWidth; topBox.classList.add("pop"); }
  if(mine && $("v1WordFill")) $("v1WordFill").style.width="95%";
  if(mine){
    showMatchAward("you", firstPoints);
    flash("good"); blip([523,659,784]);
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
  applyScores(scores);
  game.roundId=null;
  game.roundPhase="between";

  const iWasFirst=firstId===myId;
  const iWasChaser=chaserId===myId;
  const caught=reason==="chase-success";
  if(caught){
    for(const id of [firstId,chaserId]){
      if(!id) continue;
      const prefix=id===myId?"my":"rival";
      if($(prefix+"TopWord")) $(prefix+"TopWord").textContent=String(word||"").toUpperCase();
      if($(prefix+"TopPct")) $(prefix+"TopPct").textContent="100%";
    }
  }
  if(iWasFirst){
    game.streak++;
    game.results.push({word, ok:true, pts:firstPoints, rivalPts:chaserPoints, first:true});
    if(caught) showMatchAward("rival", chaserPoints);
    blip(caught?[523,659]:[523,659,784]);
  }else if(iWasChaser && caught){
    game.streak++;
    game.results.push({word, ok:true, pts:chaserPoints, rivalPts:firstPoints, chaser:true});
    showMatchAward("you", chaserPoints);
    flash("good"); blip([523,659,784]);
  }else if(winnerId){
    game.streak=0;
    game.results.push({word, ok:false, rival:true, pts:0, rivalPts:firstPoints});
    pointBurst("Chase missed", peerName+" +"+fmtScore(firstPoints)+" · you 0", "rival");
    flash("bad"); blip([330,247]);
  }else{
    game.streak=0;
    game.results.push({word, ok:false, timeout:true});
    pointBurst("Time up", "Next word coming up", "bad");
    flash("bad"); blip([220,165]);
  }
  $("pillStreak").textContent="x"+Math.max(1,game.streak);
  const stage=$("matchStage");
  if(stage){
    stage.dataset.phase="between";
    stage.classList.remove("chase-urgent","chase-final");
    delete stage.dataset.chaseSecond;
    /* Both successful players keep their word paper and local meter full
       through the between-word beat, including a successful chaser. */
    const youSucceeded=iWasFirst || (caught&&iWasChaser);
    const rivalSucceeded=(!!firstId&&firstId!==myId) ||
      (caught&&!!chaserId&&chaserId!==myId);
    stage.classList.toggle("you-locked",youSucceeded);
    stage.classList.toggle("rival-locked",rivalSucceeded);
  }
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
  if($("v1YouScore")) $("v1YouScore").textContent=fmtScore(game.score);
  if($("v1RivalScore")) $("v1RivalScore").textContent=fmtScore(game.rivalScore);
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
  pointBurst("SUDDEN DEATH", "First player recognized wins the match", "rival");
  blip([392,523,659,784]);
}

function onMatchEnd({scores, winnerId, suddenDeath=false}={}){
  applyScores(scores);
  endOnline(scores, "finished", {winnerId, suddenDeath});
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
  closePeer();

  const rows=g.results.map(r=>{
    const right='<span class="ok">You +'+fmtScore(r.pts||0)+'</span>'+
      (r.rivalPts?'<span class="thought">'+esc(peerName)+' +'+fmtScore(r.rivalPts)+'</span>':'');
    const rival='<span class="miss">'+esc(peerName)+' +'+fmtScore(r.rivalPts||0)+'</span>';
    const none='<span class="miss">time up</span>';
    return '<div class="resrow"><span>'+esc(r.word)+'</span><span>'+(r.ok?right:(r.rival?rival:none))+'</span></div>';
  }).join("");
  const title='YOU '+g.score+' — '+esc(peerName.toUpperCase())+' '+g.rivalScore;
  const sub = why==="finished"
    ? (outcome.winnerId===socket?.id || (!outcome.winnerId && g.score>g.rivalScore)
      ? (outcome.suddenDeath?"You won sudden death!":"You won the showdown!")
      : outcome.winnerId ? peerName+(outcome.suddenDeath?" won sudden death":" won the showdown")
      : "It’s a tie!")
    : (why==="peer-left" ? peerName+" left early" : "Match ended early");
  $("rescard").innerHTML='<h2>'+title+'</h2><div class="sub">'+esc(sub)+'</div>'+rows;
  transition("results");
  state.lastMode="online";
}

/* ---------------- leaving ---------------- */

export function leaveRoom(){
  if(socket && socket.connected && roomCode) socket.emit("room:leave", {}, ()=>{});
  roomCode=null;
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
