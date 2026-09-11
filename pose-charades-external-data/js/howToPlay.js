/* HOW TO PLAY — three Figma components sharing one DOM, one per mode:
   Solo (268:596), 1V1 (312:642), Party (312:641). `data-mode` on #howToPlay
   picks which column content is visible (see [data-htp-for] in overlays.css) —
   the chrome (backing, title, three torn-paper squares, READY button) is
   pixel-identical across all three, only the per-column art and copy differ.

   Solo used to drop you straight into a server-less 3·2·1 with no explanation
   of the rules and, more practically, no chance to get yourself inside the
   frame first. The popup sits over the live Solo board: your camera and the
   whole HUD are already up behind it, so reading the three beats and framing
   yourself are the same moment. I'M READY starts the count-in, and it is the
   only paper on the card: the BACK paper was a second exit competing with the
   one decision this screen asks for, on a card the player reaches by choosing
   Solo. Esc still backs out, the same way it leaves every other stage.

   1v1 and Party keep the server authoritative without starting underneath
   the card, but the card is a GRACE, not a barrier. The server sends a
   tutorial token and the timestamp at which it will start the match anyway;
   I'M READY (or Esc) acknowledges that exact token, and if EVERY current
   player acknowledges it releases on the spot. Otherwise it releases when the
   grace runs out. The complete synchronized 3·2·1 follows the release either
   way, so no client-only pause can desynchronize the room.
   The two modes then part ways. PARTY passes `startsAt`: the button counts
   the grace down and the card closes itself at zero. 1V1 passes nothing:
   there is no count, the card stays until its player presses I'M READY, and
   a grace that runs out starts the match BEHIND it (see online.js).
   main.js's Esc-to-leave self-suppresses while this card is open; a second
   Esc, after the acknowledgement closes it, leaves like normal.

   The card answers to the keyboard as well as the mouse — Enter/Space on the
   focused button natively, Esc to back out — and focus is trapped inside it
   while it is up, because everything behind it is mid-entrance. */

import { $ } from "./dom.js";
import { blip } from "./audio.js";

let onReady = null;
let onBack = null;
let restoreFocus = null;
let graceTimer = 0;

const panel = () => $("htpPanel");
/* I'M READY is the only paper on the card now — the BACK paper is gone, so
   Esc is the whole way out (see wireHowToPlay). Still a list, because the
   trap below has to keep focus off the board mid-entrance either way. */
const focusable = () => [$("htpReady")].filter(Boolean);

export function isHowToPlayOpen(){
  return !$("howToPlay")?.classList.contains("hidden");
}

/* `startsAt` is a performance.now()-domain deadline (the callers convert the
   server stamp), and it is the moment the match starts with or without this
   button. Solo passes nothing and the count never appears. */
export function showHowToPlay({ ready, back, mode = "ai", startsAt = 0 } = {}){
  const card = $("howToPlay");
  if(!card){ ready?.(); return; }
  onReady = ready || null;
  onBack = back || null;
  restoreFocus = document.activeElement;
  card.dataset.mode = mode;
  card.classList.remove("hidden");
  startGraceCount(startsAt);
  /* replay the drop every time — a state selector alone would only animate
     the first open, the same trap the results papers hit */
  const p = panel();
  if(p){ p.style.animation = "none"; void p.offsetWidth; p.style.animation = ""; }
  blip([392, 523], .05);
  requestAnimationFrame(() => $("htpReady")?.focus({ preventScroll:true }));
}

/* Ticks the count on the button down to the release. At zero it fires the
   READY path itself rather than waiting to be told: the server releases on
   the same deadline, so acknowledging here means the client is never sitting
   on a card the room has already left — and the acknowledgement is idempotent
   on both sides, so the two crossing costs nothing. */
function startGraceCount(startsAt){
  clearInterval(graceTimer);
  graceTimer = 0;
  const pip = $("htpCount");
  if(pip) pip.textContent = "";
  if(!(startsAt > 0)) return;

  const paint = () => {
    if(!isHowToPlayOpen()){ clearInterval(graceTimer); graceTimer = 0; return; }
    const left = Math.max(0, Math.ceil((startsAt - performance.now()) / 1000));
    if(left <= 0){
      clearInterval(graceTimer);
      graceTimer = 0;
      /* Same path as the click, so nothing downstream has to know the
         difference between a player who pressed and a player who read. */
      fire("ready");
      return;
    }
    if(pip && pip.textContent !== String(left)){
      pip.textContent = String(left);
      pip.classList.remove("beat"); void pip.offsetWidth; pip.classList.add("beat");
    }
  };
  paint();
  graceTimer = setInterval(paint, 120);
}

export function hideHowToPlay(){
  const card = $("howToPlay");
  if(!card || card.classList.contains("hidden")) return;
  clearInterval(graceTimer);
  graceTimer = 0;
  const pip = $("htpCount");
  if(pip){ pip.textContent = ""; pip.classList.remove("beat"); }
  card.classList.add("hidden");
  onReady = null;
  onBack = null;
  /* Never hand focus back to a button that is now behind a live round. */
  if(restoreFocus?.isConnected && !panel()?.contains(restoreFocus))
    restoreFocus.focus?.({ preventScroll:true });
  restoreFocus = null;
}

function fire(which){
  const callback = which === "ready" ? onReady : onBack;
  hideHowToPlay();
  callback?.();
}

export function wireHowToPlay(){
  $("htpReady").onclick = () => { blip([523, 784], .06); fire("ready"); };

  addEventListener("keydown", event => {
    if(!isHowToPlayOpen()) return;
    if(event.key === "Escape"){
      event.preventDefault();
      /* Solo's back callback leaves; multiplayer's acknowledges the same
         readiness decision as the button. In neither case can Esc start a
         client-only countdown. */
      fire("back");
      return;
    }
    if(event.key !== "Tab") return;
    const stops = focusable();
    if(!stops.length) return;
    /* The board behind is mid count-in entrance and its controls are dead;
       tabbing into them would strand focus somewhere invisible. */
    const at = stops.indexOf(document.activeElement);
    const next = event.shiftKey
      ? (at <= 0 ? stops.length - 1 : at - 1)
      : (at === stops.length - 1 ? 0 : at + 1);
    event.preventDefault();
    stops[next].focus({ preventScroll:true });
  });
}
