/* AGE CHECK before online play (1v1 and Party).

   Online play sends your live video to other players, and US law (COPPA)
   counts a child's video as personal information. So before the first
   online game the player is asked when they were born, and players under 13
   are kept to Solo, where nothing personal leaves the device.

   It follows the FTC's COPPA FAQ for a NEUTRAL age screen (H.3 / D.7):
   - month and year, with EVERY year listed, not only the ones that pass;
   - nothing before the answer says which answer gets in;
   - the result is remembered, so a child cannot go back and try again.
   Only the RESULT is stored ("ok" or "young"), never the birth date.

   requireOnlineAge(go, { solo }) runs `go` when the player may play online,
   and otherwise shows the card; `solo` is what PLAY SOLO does. */

import { $ } from "./dom.js";

const KEY = "posePartyOnlineAge";
const MONTHS = ["JANUARY","FEBRUARY","MARCH","APRIL","MAY","JUNE","JULY",
  "AUGUST","SEPTEMBER","OCTOBER","NOVEMBER","DECEMBER"];
const OLDEST = 1920;
const ONLINE_MIN_AGE = 13;

let memory = null;             // when localStorage is unavailable
let pending = null;            // { go, solo } for the open card
let built = false;

/* `memory` stands in ONLY where storage throws (a blocked or private
   window). Where storage works it is the single source of truth, so
   clearing site data really does forget the answer. */
function read(){
  try{ return localStorage.getItem(KEY); }catch(e){ return memory; }
}
function write(v){
  memory = v;
  try{ localStorage.setItem(KEY, v); }catch(e){ /* memory keeps it for this visit */ }
}

/* Whole years, counted conservatively: without the day, a birthday in the
   current month is treated as not reached yet. */
export function ageFrom(month, year, now = new Date()){
  let age = now.getFullYear() - year;
  if(now.getMonth() + 1 <= month) age--;
  return age;
}

function build(){
  if(built) return;
  built = true;
  const m = $("agMonth"), y = $("agYear");
  MONTHS.forEach((name, i) => m.add(new Option(name, String(i + 1))));
  for(let yr = new Date().getFullYear(); yr >= OLDEST; yr--) y.add(new Option(String(yr), String(yr)));
  const sync = () => { $("agGo").disabled = !(m.value && y.value); };
  m.addEventListener("change", sync);
  y.addEventListener("change", sync);
  $("agGo").addEventListener("click", onGo);
  $("agBack").addEventListener("click", close);
  $("ageGate").addEventListener("keydown", e => {
    if(e.key === "Escape"){ e.preventDefault(); e.stopPropagation(); close(); }
  });
}

function show(view){
  build();
  const panel = $("agPanel");
  panel.dataset.view = view;
  $("agGo").disabled = view === "ask" && !($("agMonth").value && $("agYear").value);
  $("ageGate").classList.remove("hidden");
  /* restart the drop, as HOW TO PLAY does, so a second opening lands too */
  panel.style.animation = "none"; void panel.offsetWidth; panel.style.animation = "";
  (view === "ask" ? $("agMonth") : $("agGo")).focus({ preventScroll: true });
}

function close(){
  $("ageGate")?.classList.add("hidden");
  pending = null;
}

function onGo(){
  const p = pending;
  if($("agPanel").dataset.view === "young"){
    close();
    p?.solo?.();
    return;
  }
  const month = Number($("agMonth").value), year = Number($("agYear").value);
  if(!month || !year) return;
  if(ageFrom(month, year) >= ONLINE_MIN_AGE){
    write("ok");
    close();
    p?.go?.();
  }else{
    write("young");
    show("young");
  }
}

export function isAgeGateOpen(){
  return !!$("ageGate") && !$("ageGate").classList.contains("hidden");
}

export function requireOnlineAge(go, { solo } = {}){
  const known = read();
  if(known === "ok"){ go(); return; }
  pending = { go, solo };
  show(known === "young" ? "young" : "ask");
}
