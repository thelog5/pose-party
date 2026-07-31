/* Shared gameplay feedback primitives.

   Recognition is the same visual event in Solo, 1v1 and Party even though
   each mode has different scoring/network authority. This module owns the
   presentation contract: guess-paper stability, time-correct meter easing,
   word tracking/impact/lock states, and text fitting inside fixed Figma art.

   Mode controllers still decide when a claim is valid and when points are
   awarded. Nothing here can score a word or acknowledge a network claim. */

export const GUESS_LABEL_DEBOUNCE_MS = 420;
export const RECOGNITION_FILL_LERP_60FPS = 0.16;
export const RECOGNITION_IMPACT_MS = 180;
export const RECOGNITION_FILL_MIN = 0;
export const RECOGNITION_FILL_MAX = 95;

export const WARM_AT = 0.01;
export const HOT_AT = 0.42;
export const CRITICAL_AT = 0.78;

const FRAME_MS = 1000 / 60;

/* Make the old 0.16-per-frame ease independent of inference/display rate.
   Party and Solo update on RAF; 1v1 updates when inference paints. Using
   elapsed time gives all three the same perceived meter speed. */
export function advanceRecognitionFill(current, target, lastAt=0, now=performance.now()){
  const from = Math.max(0, Math.min(1, Number(current) || 0));
  const to = Math.max(0, Math.min(1, Number(target) || 0));
  const elapsed = lastAt
    ? Math.max(0, Math.min(120, now - lastAt))
    : FRAME_MS;
  const alpha = 1 - Math.pow(1 - RECOGNITION_FILL_LERP_60FPS,
    elapsed / FRAME_MS);
  const value = Math.abs(to - from) < .0005 ? to : from + (to - from) * alpha;
  return { value, at: now };
}

/* A mode can render two or three papers, but label admission is identical:
   the first useful read appears immediately; a later read must remain on top
   for one short stability beat so the papers do not flicker every frame. */
export function createGuessHistory(limit=2){
  return {
    limit: Math.max(1, limit | 0),
    items: [],
    candidate: null,
    candidateSince: 0,
  };
}

export function resetGuessHistory(history){
  if(!history) return;
  history.items = [];
  history.candidate = null;
  history.candidateSince = 0;
}

export function updateGuessHistory(history, label, confidence, options={}){
  if(!history || typeof label !== "string" || !label) {
    return { committed:false, changed:false, current:history?.items?.[0] || null };
  }
  const now = Number.isFinite(options.now) ? options.now : performance.now();
  const pct = Math.max(0, Math.min(1, Number(confidence) || 0));
  const locked = !!options.locked;
  const force = !!options.force || locked;
  const current = history.items[0];

  if(current?.label === label){
    current.pct = pct;
    current.locked = locked || current.locked;
    history.candidate = null;
    history.candidateSince = 0;
    return { committed:true, changed:false, current };
  }

  if(label !== history.candidate){
    history.candidate = label;
    history.candidateSince = now;
  }

  const first = !current;
  const stable = now - history.candidateSince >= GUESS_LABEL_DEBOUNCE_MS;
  if(!first && !force && !stable){
    return { committed:false, changed:false, pending:true, current };
  }

  const entry = { label, pct, locked };
  history.items.unshift(entry);
  history.items = history.items.slice(0, history.limit);
  history.candidate = null;
  history.candidateSince = 0;
  return { committed:true, changed:true, first, current:entry };
}

export function restartFeedbackAnimation(node, className){
  if(!node) return;
  node.classList.remove(className);
  void node.offsetWidth;
  node.classList.add(className);
}

export function markGuessRecognized(node, active=true){
  if(!node) return;
  if(active){
    if(!node.classList.contains("recognized"))
      restartFeedbackAnimation(node, "recognized");
  }else{
    node.classList.remove("recognized");
  }
}

/* One continuous confidence-to-motion curve for every gameplay word card.
   The threshold remains mode-owned; only the visible progression is shared. */
export function setWordRecognitionMotion(card, confidence, threshold, enabled=true){
  if(!card) return 0;
  const limit = Math.max(.01, Number(threshold) || 1);
  const value = Math.max(0, Math.min(limit, Number(confidence) || 0));
  const start = Math.min(.28, limit * .45);
  const intensity = enabled
    ? Math.max(0, Math.min(1, (value - start) / Math.max(.01, limit - start)))
    : 0;
  const active = intensity > 0;

  card.classList.toggle("tracking", active);
  card.classList.toggle("warm", active && intensity >= WARM_AT && intensity < HOT_AT);
  card.classList.toggle("hot", active && intensity >= HOT_AT && intensity < CRITICAL_AT);
  card.classList.toggle("critical", active && intensity >= CRITICAL_AT);

  if(active){
    const x = .20 + 1.35 * intensity;
    const y = .10 + .50 * intensity;
    const r = .16 + 1.12 * intensity;
    card.style.setProperty("--shake-x", x.toFixed(3) + "%");
    card.style.setProperty("--shake-x-neg", (-x).toFixed(3) + "%");
    card.style.setProperty("--shake-y", (y * .72).toFixed(3) + "%");
    card.style.setProperty("--shake-y-neg", (-y).toFixed(3) + "%");
    card.style.setProperty("--shake-r", r.toFixed(3) + "deg");
    card.style.setProperty("--shake-r-neg", (-r).toFixed(3) + "deg");
    card.style.setProperty("--shake-scale", (1 + .014 * intensity).toFixed(4));
    card.style.setProperty("--shake-speed", Math.round(240 - 160 * intensity) + "ms");
  }
  return intensity;
}

export function prefersReducedMotion(){
  return typeof matchMedia === "function" &&
    matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function prepareWordFeedback(card, fill, threshold, animate=true){
  if(card){
    clearTimeout(card._recognitionImpactTimer);
    card._recognitionImpactTimer = null;
    setWordRecognitionMotion(card, 0, threshold, false);
    card.classList.remove("hit", "locked", "miss", "wordswap");
  }
  if(fill) fill.style.width = RECOGNITION_FILL_MIN + "%";
  if(card && animate) restartFeedbackAnimation(card, "wordswap");
}

/* Visual lock sequence only. The caller has already received/validated the
   gameplay event, so the impact delay never changes score or network state. */
export function playWordLockFeedback({
  card, fill, threshold, onImpact, impactMs=RECOGNITION_IMPACT_MS,
}={}){
  if(!card) {
    onImpact?.();
    return;
  }
  clearTimeout(card._recognitionImpactTimer);
  setWordRecognitionMotion(card, 0, threshold, false);
  card.classList.remove("wordswap", "miss", "locked");
  restartFeedbackAnimation(card, "hit");
  if(fill) fill.style.width = RECOGNITION_FILL_MAX + "%";

  const commit = () => {
    card._recognitionImpactTimer = null;
    card.classList.remove("hit");
    restartFeedbackAnimation(card, "locked");
    onImpact?.();
  };
  const delay = prefersReducedMotion() ? 0 : Math.max(0, impactMs | 0);
  if(delay) card._recognitionImpactTimer = setTimeout(commit, delay);
  else commit();
}

export function playWordMissFeedback(card, threshold){
  if(!card) return;
  clearTimeout(card._recognitionImpactTimer);
  setWordRecognitionMotion(card, 0, threshold, false);
  card.classList.remove("hit", "locked", "wordswap");
  restartFeedbackAnimation(card, "miss");
  setTimeout(() => card.classList.remove("miss"),
    prefersReducedMotion() ? 0 : 500);
}

/* ---------------- fixed-paper text guardrails ---------------- */

const TEXT_PROFILES = Object.freeze({
  word:      { base:14.69, min:6.4, maxLines:2, wrapBelow:9.4, safety:.94 },
  guess:     { base:17.21, min:7.2, maxLines:2, wrapBelow:10.1, safety:.92 },
  roundTime: { base:24.63, min:13.5, maxLines:1, safety:.91 },
  wordTime:  { base:22.06, min:12.5, maxLines:1, safety:.92 },
  chaseWordTime:{ base:23.50, min:12.5, maxLines:1, safety:.92 },
  wordTimerLabel:{ base:11.87, min:6.2, maxLines:1, safety:.90 },
  chaseTimerLabel:{ base:9.70, min:5.4, maxLines:1, safety:.90 },
  player:    { base:17.15, min:7.2, maxLines:1, safety:.91 },
  soloScore: { base:31.97, min:10.5, maxLines:1, safety:.88 },
  streak:    { base:27.96, min:11.5, maxLines:1, safety:.88 },
  matchScore:{ base:31.70, min:10.5, maxLines:1, safety:.88 },
  awardText: { base:7.80, min:4.2, maxLines:1, safety:.88 },
  rivalAwardText:{ base:6.80, min:3.9, maxLines:1, safety:.88 },
  awardPoint:{ base:18.93, min:6.5, maxLines:1, safety:.86 },
});

const PROFILE_IDS = Object.freeze({
  soloWord:"word", vsWord:"word", pmWord:"word",
  spGuessTopLabel:"guess", spGuessMidLabel:"guess", spGuessBotLabel:"guess",
  myTopWord:"guess", myPastWord:"guess",
  rivalTopWord:"guess", rivalPastWord:"guess",
  pmMyTopWord:"guess", pmMyPastWord:"guess",
  pmFoeTopWord:"guess", pmFoePastWord:"guess",
  soloRoundTime:"roundTime", v1MatchTime:"roundTime", pmMatchTime:"roundTime",
  soloWordTime:"wordTime", v1WordTime:"wordTime", pmWordTime:"wordTime",
  v1WordTimerLabel:"wordTimerLabel", pmWordTimerLabel:"wordTimerLabel",
  v1YouName:"player", v1RivalName:"player",
  soloScoreVal:"soloScore", soloStreakVal:"streak",
  v1YouScore:"matchScore", v1RivalScore:"matchScore",
  pmBlueScore:"matchScore", pmOrangeScore:"matchScore",
  soloAwardPts:"awardPoint", v1AwardPts:"awardPoint",
  v1RivalAwardPts:"awardPoint", pmAwardPts:"awardPoint",
  v1RivalAwardTitle:"rivalAwardText", pmAwardTitle:"awardText",
  pmAwardLabel:"awardText",
});

/* Roster-driven labels do not have stable IDs. They still follow the same
   contract, but read their authored component size from computed CSS so a
   normal short name/value remains exactly at its Figma size. */
const REPEATED_TEXT_SELECTOR =
  ".pm-nametag b,.pm-gotit b,.rs-nametag b,.rs-scorechip span,.rs-stat b,#rsHeadline";

let measureCanvas = null;
let fitFrame = 0;
let installed = false;
const pendingFits = new Set();

function measuredTextWidth(node){
  if(!measureCanvas) measureCanvas = document.createElement("canvas");
  const context = measureCanvas.getContext("2d");
  if(!context) return node.scrollWidth;
  const style = getComputedStyle(node);
  context.font = [
    style.fontStyle,
    style.fontVariant,
    style.fontWeight,
    style.fontSize,
    style.fontFamily,
  ].join(" ");
  let text = (node.textContent || "").trim();
  /* Canvas measures source text, while the browser paints the transformed
     glyphs. Normalizing first prevents lowercase dataset labels from being
     fitted against narrower shapes and then clipping once CSS uppercases
     them on the paper. */
  if(style.textTransform === "uppercase") text = text.toLocaleUpperCase();
  else if(style.textTransform === "lowercase") text = text.toLocaleLowerCase();
  else if(style.textTransform === "capitalize")
    text = text.replace(/(^|[\s-])(\S)/gu,
      (_, lead, glyph) => lead + glyph.toLocaleUpperCase());
  const spacing = parseFloat(style.letterSpacing) || 0;
  const wordSpacing = parseFloat(style.wordSpacing) || 0;
  const spaces = (text.match(/\s/g) || []).length;
  return context.measureText(text).width +
    Math.max(0, text.length - 1) * spacing + spaces * wordSpacing;
}

function innerBox(node){
  const style = getComputedStyle(node);
  return {
    width: node.clientWidth - (parseFloat(style.paddingLeft) || 0) -
      (parseFloat(style.paddingRight) || 0),
    height: node.clientHeight - (parseFloat(style.paddingTop) || 0) -
      (parseFloat(style.paddingBottom) || 0),
  };
}

export function fitSingleLinePaperText(nodeOrSelector, options={}){
  const node = typeof nodeOrSelector === "string"
    ? document.querySelector(nodeOrSelector)
    : nodeOrSelector;
  if(!node) return false;

  /* Always reveal the authored cqw rule before measuring. An earlier fit is
     in px by necessity; clearing it here lets viewport/container changes
     recompute from the design value instead of shrinking cumulatively. */
  node.style.removeProperty("font-size");
  const style = getComputedStyle(node);
  const base = parseFloat(style.fontSize);
  const box = innerBox(node);
  if(!Number.isFinite(base) || base <= 0 || box.width <= 0) return false;

  const safety = Number(options.safety) || .88;
  const widthOnly = !!options.widthOnly;
  const available = box.width * safety;
  const wanted = measuredTextWidth(node);
  if(!wanted || wanted <= available){
    node.dataset.fitLines = "1";
    return true;
  }

  const preferredFloor = Math.max(5, base * (Number(options.minScale) || .44));
  let size = base * available / wanted * .985;
  /* The named gameplay surfaces are capped at ten characters, but score
     totals can still be unusually wide. Paper wins over a preferred floor:
     keep shrinking to a legible 3.8px rather than silently clipping. */
  size = Math.max(3.8, Math.min(base, size));
  if(size < preferredFloor && base * available / wanted >= preferredFloor)
    size = preferredFloor;
  node.style.fontSize = size + "px";

  for(let pass=0; pass<8; pass++){
    const current = measuredTextWidth(node);
    if(current <= available + .5 &&
        (widthOnly || node.scrollHeight <= node.clientHeight + .75)) break;
    size = Math.max(3.8, size * .93);
    node.style.fontSize = size + "px";
  }
  node.dataset.fitLines = "1";
  return true;
}

function fitRepeatedPaperText(node){
  if(!node?.matches?.(REPEATED_TEXT_SELECTOR)) return false;
  if(node.matches(".rs-scorechip span"))
    return fitSingleLinePaperText(node, {
      safety:.995, minScale:.38, widthOnly:true,
    });
  if(node.matches(".rs-stat b"))
    return fitSingleLinePaperText(node, { safety:.88, minScale:.40 });
  if(node.matches("#rsHeadline"))
    return fitSingleLinePaperText(node, { safety:.91, minScale:.38 });
  if(node.matches(".pm-gotit b"))
    return fitSingleLinePaperText(node, { safety:.86, minScale:.42 });
  return fitSingleLinePaperText(node, { safety:.86, minScale:.44 });
}

export function gameplayTextProfile(nodeOrId){
  const node = typeof nodeOrId === "string"
    ? document.getElementById(nodeOrId)
    : nodeOrId;
  if((node?.id === "v1WordTime" || node?.id === "pmWordTime") &&
      node.closest(".matchstage,.pmstage")?.dataset.phase === "chase")
    return TEXT_PROFILES.chaseWordTime;
  if((node?.id === "v1WordTimerLabel" ||
      node?.id === "pmWordTimerLabel") &&
      node.closest(".matchstage,.pmstage")?.dataset.phase === "chase")
    return TEXT_PROFILES.chaseTimerLabel;
  const key = node?.id ? PROFILE_IDS[node.id] : null;
  return key ? TEXT_PROFILES[key] : null;
}

export function fitGameplayText(nodeOrId, explicitProfile=null){
  const node = typeof nodeOrId === "string"
    ? document.getElementById(nodeOrId)
    : nodeOrId;
  if(!node) return false;
  const profile = typeof explicitProfile === "string"
    ? TEXT_PROFILES[explicitProfile]
    : explicitProfile || gameplayTextProfile(node);
  if(!profile) return false;

  node.classList.remove("fit-wrap");
  node.style.removeProperty("scale");
  node.style.fontSize = profile.base + "cqw";
  const box = innerBox(node);
  if(box.width <= 0) return false;

  const available = box.width * (profile.safety || .94);
  const wanted = measuredTextWidth(node);
  const oneLine = wanted > 0
    ? Math.min(profile.base, profile.base * available / wanted * .985)
    : profile.base;
  const shouldWrap = profile.maxLines > 1 &&
    oneLine < (profile.wrapBelow || profile.min);

  if(!shouldWrap){
    /* Single-line controls (especially clocks) may go below their preferred
       floor as a final guardrail. Fixed paper must never crop live copy. */
    node.style.fontSize = Math.max(3.8,
      oneLine >= profile.min ? oneLine : Math.min(profile.min, oneLine)) + "cqw";
    node.dataset.fitLines = "1";
    return true;
  }

  node.classList.add("fit-wrap");
  let size = profile.base;
  node.style.fontSize = size + "cqw";
  for(let pass=0; pass<24; pass++){
    const bounds = innerBox(node);
    const fits = node.scrollWidth <= bounds.width + .75 &&
      node.scrollHeight <= bounds.height + .75;
    if(fits) break;
    size *= .92;
    if(size < 3.8){ size = 3.8; break; }
    node.style.fontSize = size + "cqw";
  }
  node.style.fontSize = size + "cqw";
  node.dataset.fitLines = String(profile.maxLines);
  return true;
}

export function scheduleGameplayTextFit(nodeOrId){
  const node = typeof nodeOrId === "string"
    ? document.getElementById(nodeOrId)
    : nodeOrId;
  if(node) pendingFits.add(node);
  if(fitFrame) return;
  fitFrame = requestAnimationFrame(() => {
    fitFrame = 0;
    const nodes = [...pendingFits];
    pendingFits.clear();
    nodes.forEach(node => {
      if(!fitGameplayText(node)) fitRepeatedPaperText(node);
    });
  });
}

export function fitAllGameplayText(){
  for(const id of Object.keys(PROFILE_IDS)){
    const node = document.getElementById(id);
    if(node) fitGameplayText(node);
  }
  document.querySelectorAll(REPEATED_TEXT_SELECTOR)
    .forEach(node => fitRepeatedPaperText(node));
}

function installGameplayTextGuardrails(){
  if(installed || typeof document === "undefined") return;
  installed = true;
  const begin = () => {
    const queueTextNode = target => {
      const element = target?.nodeType === Node.ELEMENT_NODE
        ? target
        : target?.parentElement;
      if(!element) return;
      const fixed = element.id && PROFILE_IDS[element.id]
        ? element
        : element.closest?.("[id]");
      if(fixed?.id && PROFILE_IDS[fixed.id]){
        scheduleGameplayTextFit(fixed);
        return;
      }
      const repeated = element.matches?.(REPEATED_TEXT_SELECTOR)
        ? element
        : element.closest?.(REPEATED_TEXT_SELECTOR);
      if(repeated) scheduleGameplayTextFit(repeated);
    };
    const textObserver = new MutationObserver(records => {
      for(const record of records){
        queueTextNode(record.target);
        for(const added of record.addedNodes){
          queueTextNode(added);
          if(added.nodeType === Node.ELEMENT_NODE)
            added.querySelectorAll?.(REPEATED_TEXT_SELECTOR)
              .forEach(scheduleGameplayTextFit);
        }
      }
    });
    textObserver.observe(document.body, {
      subtree:true, childList:true, characterData:true,
    });
    const screenObserver = new MutationObserver(() => fitAllGameplayText());
    screenObserver.observe(document.body, {
      attributes:true, attributeFilter:["data-screen"],
    });
    addEventListener("resize", fitAllGameplayText, { passive:true });
    document.fonts?.ready?.then(fitAllGameplayText);
    requestAnimationFrame(fitAllGameplayText);
  };
  if(document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", begin, { once:true });
  else begin();
}

installGameplayTextGuardrails();
