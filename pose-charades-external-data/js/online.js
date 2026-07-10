/* Online private-room 1v1.

   The server is authoritative: it deals words, times rounds, validates
   point claims, and keeps scores. This module mirrors its events into the
   local FSM/UI. Classification stays 100% local — the only things sent are
   the player's name, word labels, point claims, and opaque WebRTC blobs.

   The socket.io client script is loaded lazily from the game server itself
   (/socket.io/socket.io.js), so the app still runs fine from any static
   host for the offline modes. */

import { $, esc } from "./dom.js";
import { state } from "./state.js";
import { CATEGORIES } from "./constants.js";
import { toast, flash, pointBurst } from "./ui.js";
import { blip } from "./audio.js";
import { gameState, transition, onTransition } from "./fsm.js";
import { startGame, gameTick } from "./game.js";
import { createPeer } from "./webrtc.js";

const NAME_KEY = "poseCharadesName";

let socket = null;
let peer = null;
let peerName = "Rival";
let clockOffset = 0;          // serverNow ≈ Date.now() + clockOffset
let countdownTimer = null;
let wired = false;

const serverNow = () => Date.now() + clockOffset;
const perfFromServer = tServer => performance.now() + (tServer - serverNow());

/* If the player escapes an online match through the gear/logo (any exit that
   isn't the results screen), tell the server and drop the peer link. This
   listener registers at import time, before game.js's lifecycle listener,
   so state.game is still set when it runs. */
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

export function enterLobby(){
  if(!state.model || state.model.labels.filter(l=>l!=="idle").length<1){
    toast("Train the AI first — record idle plus at least one action word. Tap the gear.");
    transition("training"); return;
  }
  if(!transition("lobby")) return;
  wireLobby();
  $("lobbyName").value = localStorage.getItem(NAME_KEY) || "";
  setLobbyStatus("Create a room and share the code, or join a friend’s room.");
}

function wireLobby(){
  if(wired) return;
  wired = true;
  $("btnCreateRoom").onclick = createRoom;
  $("btnJoinRoom").onclick = joinRoom;
  $("btnPractice").onclick = () => startGame("vs");
  $("btnLobbyBack").onclick = () => { leaveRoom(); transition("menu"); };
}

function setLobbyStatus(text, code){
  const el = $("lobbyStatus");
  el.style.display = "block";
  el.textContent = "";
  if(code){
    const b = document.createElement("b");
    b.style.fontSize = "22px"; b.style.letterSpacing = "4px";
    b.textContent = code;
    el.append("Room code: ", b, document.createElement("br"));
  }
  el.append(text);
}

function myName(){
  const raw = $("lobbyName").value.trim().slice(0,16) || "Player";
  localStorage.setItem(NAME_KEY, raw);
  return raw;
}

/* Back to a clean lobby after a pre-match failure (only ever fires while
   the FSM is already in "lobby" — see wireSocket callers). */
function abandonToLobby(){
  closePeer();
  transition("lobby");
  setLobbyStatus("Create a room and share the code, or join a friend’s room.");
}

/* ---------------- socket ---------------- */

function loadSocketScript(){
  if(window.io) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "/socket.io/socket.io.js";
    s.onload = resolve;
    s.onerror = () => reject(new Error("socket.io script failed to load"));
    document.head.appendChild(s);
    setTimeout(() => reject(new Error("socket.io script timed out")), 5000);
  });
}

async function ensureSocket(){
  if(socket && socket.connected) return socket;
  await loadSocketScript();
  if(socket){ socket.disconnect(); }
  /* Polling first, then upgrade: plain-HTTP polling works anywhere the page
     itself loads, while a websocket-first connect dies on machines whose
     antivirus/filters block unencrypted ws:// to LAN addresses. */
  socket = window.io({ transports: ["polling", "websocket"] });
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("connect_error", e => reject(new Error("cannot reach server: "+e.message)));
    setTimeout(() => reject(new Error("server connection timed out")), 8000);
  });
  await syncClock();
  wireSocket(socket);
  return socket;
}

function syncClock(){
  return new Promise(resolve => {
    const t0 = Date.now();
    socket.emit("time:sync", {}, res => {
      const t1 = Date.now();
      if(res && Number.isFinite(res.serverNow)) clockOffset = res.serverNow - (t0+t1)/2;
      resolve();
    });
    setTimeout(resolve, 2000);
  });
}

function wireSocket(s){
  s.on("room:peer", ({name}={}) => {          // we are the host; a friend arrived
    peerName = String(name||"Rival");
    setLobbyStatus(peerName + " joined! Starting…");
    openPeer(true);
    s.emit("player:ready", {});
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
    abandonToLobby();
  });

  s.on("peer:left", () => {
    toast(peerName + " left the game.");
    if(state.game && state.game.mode==="online") endOnline(null, "peer-left");
    else abandonToLobby();
  });

  s.on("disconnect", () => {
    if(state.game && state.game.mode==="online"){
      toast("Connection to the server was lost.");
      endOnline(null, "disconnected");
    }
  });
}

async function createRoom(){
  const name = myName();
  try{
    const s = await ensureSocket();
    setLobbyStatus("Creating room…");
    s.emit("room:create", { name, labels: state.model.labels }, res => {
      if(!res || res.error) return setLobbyStatus(lobbyError(res));
      setLobbyStatus("Share this code with a friend, then keep this page open — the match starts the moment they join.", res.code);
    });
  }catch(e){ offlineExplain(e); }
}

async function joinRoom(){
  const name = myName();
  const code = $("lobbyCode").value.trim().toUpperCase();
  if(code.length!==6) return setLobbyStatus("Codes are 6 letters/numbers, like ABC234.");
  try{
    const s = await ensureSocket();
    setLobbyStatus("Joining "+code+"…");
    s.emit("room:join", { code, name, labels: state.model.labels }, res => {
      if(!res || res.error) return setLobbyStatus(lobbyError(res));
      peerName = String(res.peerName||"Rival");
      setLobbyStatus("Joined "+peerName+"’s room — starting…");
      openPeer(false);
      s.emit("player:ready", {});
    });
  }catch(e){ offlineExplain(e); }
}

function lobbyError(res){
  const e = res && res.error;
  return {
    "no-such-room": "No room with that code — check it and try again.",
    "room-full": "That room already has two players.",
    "match-in-progress": "That match already started.",
    "rate-limited": "Slow down a little and try again.",
    "already-in-room": "You’re already in a room.",
    "server-full": "The server is full right now.",
  }[e] || "Something went wrong ("+e+").";
}

function offlineExplain(e){
  console.warn("online unavailable:", e);
  setLobbyStatus("Can’t reach the game server. Online play needs the app served by the Node server: run “npm start” inside server/ and open the address it prints.");
}

/* ---------------- webrtc video ---------------- */

function openPeer(initiator){
  closePeer();
  if(!state.mediaStream){ toast("Camera isn’t ready yet."); return; }
  peer = createPeer({
    initiator,
    stream: state.mediaStream,
    sendSignal: data => socket && socket.emit("rtc:signal", { data }),
    onRemoteStream: stream => {
      const v = $("videoRemote");
      v.srcObject = stream;
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
  if(peer){ peer.close(); peer = null; }
  const v = $("videoRemote");
  if(v){ v.srcObject = null; v.classList.add("hidden"); }
  const ph = $("rivalPlaceholder");
  if(ph) ph.classList.remove("hidden");
}

/* ---------------- match flow (server-driven) ---------------- */

function setRivalNote(text){
  const el = $("guessListVsRival");
  el.innerHTML = "";
  const row = document.createElement("div");
  row.className = "grow";
  const name = document.createElement("span");
  name.className = "gname";
  name.style.whiteSpace = "normal";
  name.textContent = text;
  row.appendChild(name);
  el.appendChild(row);
}

function onMatchStart({startAt, rounds, players}={}){
  const myId = socket.id;
  const rec = (players||[]).find(p => p.id!==myId);
  if(rec && rec.name) peerName = rec.name;

  state.game = { mode:"online", word:null, round:0, rounds: rounds||5, wordEnd:0,
                 holdSince:0, score:0, rivalScore:0, results:[],
                 roundId:null, claimed:false, bestWrong:{} };
  if(!transition("countdown")) { state.game=null; return; }

  $("rivalRibbon").textContent = peerName.slice(0,12);
  setRivalNote("The rival’s AI runs on their device — first to convince their AI wins the word!");
  $("pillScore").textContent="0";
  $("pillRivalScore").textContent="0";
  $("pillRound").textContent="1/"+(rounds||5);

  const cd=$("countdown");
  cd.classList.remove("hidden");
  clearInterval(countdownTimer);
  countdownTimer=setInterval(()=>{
    if(gameState()!=="countdown" && gameState()!=="playing"){ clearInterval(countdownTimer); cd.classList.add("hidden"); return; }
    const left=Math.ceil((startAt-serverNow())/1000);
    if(left>0){ if(cd.textContent!==String(left)){ cd.textContent=String(left); blip([440]); } }
    else { clearInterval(countdownTimer); cd.classList.add("hidden"); }
  },100);

  state.onlineClaim = confidence => {
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
  game.wordEnd=perfFromServer(endsAt);
  if($("vsWord")) $("vsWord").textContent=game.word;
  if($("vsCat")) $("vsCat").textContent=CATEGORIES[game.word]||"Your Words";
  $("pillRound").textContent=game.round+"/"+(rounds||game.rounds);
  const vw=$("vsWordCard");
  if(vw){ vw.classList.remove("wordswap"); void vw.offsetWidth; vw.classList.add("wordswap"); }
  if(!game.timer) game.timer=setInterval(gameTick,100);
}

function onRoundResult({winnerId, word, scores, reason}={}){
  const game=state.game;
  if(!game || game.mode!=="online") return;
  const myId=socket.id;
  applyScores(scores);
  game.roundId=null;

  if(winnerId===myId){
    game.results.push({word, ok:true});
    toast("You won the word! +1");
    pointBurst("You win!", word+" · +1", "good");
    flash("good"); blip([523,659,784]);
  }else if(winnerId){
    game.results.push({word, ok:false, rival:true});
    toast(peerName+" won the word!");
    pointBurst(peerName+" wins!", word+" · +1", "rival");
    flash("bad"); blip([330,247]);
  }else{
    game.results.push({word, ok:false, timeout:true});
    toast("Time up — next word");
    pointBurst("Time up", "Next word coming up", "bad");
    flash("bad"); blip([220,165]);
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
  $("pillScore").textContent=game.score;
  $("pillRivalScore").textContent=game.rivalScore;
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
  if(socket && socket.connected) socket.emit("room:leave", {}, ()=>{});
  closePeer();
}

/* Quit button during an online match. */
export function quitOnline(){
  leaveRoom();
  if(state.game && state.game.mode==="online") endOnline(null, "quit");
}
