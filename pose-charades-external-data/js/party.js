/* Party-mode waiting room. Deliberately lobby-only: the party game itself
   is not built yet, so this screen is a fully rendered waiting room —
   your live camera tile, a robot teammate, join/switch between teams,
   a shareable room code — with START GAME locked until real multiplayer
   party rooms exist. */

import { $, esc } from "./dom.js";
import { state } from "./state.js";
import { toast } from "./ui.js";
import { transition } from "./fsm.js";
import { mountCamera } from "./screens.js";

const CODE_ALPHABET="ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const TEAM_CAP=4, ROOM_CAP=8;

let myTeam="blue";
let code=null;

function randomCode(){
  let s="";
  const a=new Uint32Array(6); crypto.getRandomValues(a);
  for(const n of a) s+=CODE_ALPHABET[n%CODE_ALPHABET.length];
  return s;
}

export function enterParty(){
  if(!transition("party")) return;
  if(!code) code=randomCode();
  myTeam="blue";
  $("partyCode").textContent=code;
  $("partyName").value=(localStorage.getItem("poseCharadesName")||"You").slice(0,12);
  $("partyWordCount").textContent=(state.model?state.model.labels.length:0)+" words";
  renderTeams();
}

function tile(html, cls=""){
  const d=document.createElement("div");
  d.className="ptile "+cls;
  d.innerHTML=html;
  return d;
}

function renderTeams(){
  const myName=(localStorage.getItem("poseCharadesName")||"You").slice(0,12);
  const blue=$("blueGrid"), orange=$("orangeGrid");
  /* the camera dock lives inside a tile — park it before wiping the grids,
     or innerHTML="" destroys the live <video> element */
  const dock=$("cameraDock");
  if(dock && (blue.contains(dock)||orange.contains(dock))) document.body.appendChild(dock);
  blue.innerHTML=""; orange.innerHTML="";

  const mine = myTeam==="blue" ? blue : orange;
  const other = myTeam==="blue" ? orange : blue;

  /* your live tile (camera dock mounts into it) */
  const you=tile('<span class="hostchip">HOST</span><span class="livechip">LIVE</span>'+
    '<div class="slot" id="partySlot" style="position:absolute;inset:0"></div>'+
    '<span class="pname" style="z-index:2">'+esc(myName)+'<span class="mini">👑</span></span>');
  mine.appendChild(you);

  /* the resident robot keeps you company */
  const bot=tile('<img class="botasset" src="assets/ui/robot-wave.png" alt="">'+
    '<span class="pname">PoseMaster99<span class="mini">✌️</span></span>');
  mine.appendChild(bot);

  /* empty waiting slots */
  const emptyTile=()=>tile('<svg width="30" height="30" style="color:var(--line-soft)"><use href="#icoUsers"/></svg><span>Waiting for<br>players…</span>','empty');
  mine.appendChild(emptyTile());
  mine.appendChild(emptyTile());
  other.appendChild(emptyTile());
  other.appendChild(emptyTile());
  other.appendChild(emptyTile());

  /* join/switch tile on the other team */
  const sw=tile('<svg><use href="#icoSwitch"/></svg><span>JOIN / SWITCH<br>TO THIS TEAM!</span>','join');
  sw.onclick=()=>switchTeam(myTeam==="blue"?"orange":"blue");
  other.appendChild(sw);

  const blueN = myTeam==="blue" ? 2 : 0;
  const orangeN = myTeam==="orange" ? 2 : 0;
  $("blueCnt").textContent=blueN+" / "+TEAM_CAP;
  $("orangeCnt").textContent=orangeN+" / "+TEAM_CAP;
  $("partyCount").textContent="2 / "+ROOM_CAP;

  mountCamera($("partySlot"));
}

function switchTeam(team){
  if(team===myTeam) return;
  myTeam=team;
  renderTeams();
  toast("You joined the "+team+" team!");
}

export function wireParty(){
  $("btnPartyBack").onclick=()=>transition("menu");
  $("btnJoinBlue").onclick=()=>switchTeam("blue");
  $("btnJoinOrange").onclick=()=>switchTeam("orange");
  $("partyName").addEventListener("change",()=>{
    const name=$("partyName").value.trim().slice(0,12)||"You";
    $("partyName").value=name;
    localStorage.setItem("poseCharadesName",name);
    if(document.body.dataset.screen==="party") renderTeams();
    toast("Name updated!");
  });
  $("partyName").addEventListener("keydown",e=>{ if(e.key==="Enter") e.currentTarget.blur(); });
  $("btnPartyCopy").onclick=async()=>{
    try{ await navigator.clipboard.writeText(code); toast("Room code copied!"); }
    catch(e){ toast("Copy failed — the code is "+code); }
  };
  document.querySelectorAll("[data-invite]").forEach(b=>b.onclick=()=>toast("Party invites are coming soon — share the room code for now!"));
  $("btnPartyGuide").onclick=()=>toast("Strike the pose, your team guesses, outguess the other team!");
  $("btnPartyStart").onclick=()=>toast("Party matches unlock once more players can join!");
}
