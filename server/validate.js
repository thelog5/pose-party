/* Strict validation for every socket payload. Anything that fails here is
   rejected before it can touch room state. */

/* No 0/O/1/I/L — codes get read out loud between friends. */
export const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_RE = new RegExp(`^[${CODE_ALPHABET}]{6}$`);

const MAX_NAME = 16;
const MAX_LABEL = 40;
const MAX_LABELS = 64;

const STRIP_RE = /[\u0000-\u001F\u007F<>]/g;

/* Strip control characters and angle brackets; the client renders names via
   textContent anyway, this is defense in depth. */
export function cleanName(raw){
  if(typeof raw !== "string") return null;
  const s = raw.replace(STRIP_RE, "").trim().slice(0, MAX_NAME);
  return s.length ? s : null;
}

export function cleanLabels(raw){
  if(!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_LABELS) return null;
  const out = [];
  const seen = new Set();
  for(const l of raw){
    if(typeof l !== "string") return null;
    const s = l.replace(STRIP_RE, "").trim().toLowerCase().slice(0, MAX_LABEL);
    if(!s || seen.has(s)) continue;
    seen.add(s); out.push(s);
  }
  return out.length ? out : null;
}

export function cleanCode(raw){
  if(typeof raw !== "string") return null;
  const s = raw.trim().toUpperCase();
  return CODE_RE.test(s) ? s : null;
}

export function isPlainObject(x){
  return !!x && typeof x === "object" && !Array.isArray(x);
}

/* WebRTC signaling blobs are opaque to the server, but cap their size so the
   relay can't be used as a firehose. */
export function signalOk(x){
  if(!isPlainObject(x)) return false;
  try{ return JSON.stringify(x).length <= 20000; }catch{ return false; }
}

/* Host match settings for the time-based mode: total match time 10s-10min
   (UI floor is 60s; 10s floor keeps tests fast) and word time 5-60s.
   Returns server-shape {matchMs, wordMs} or null. */
export function cleanSettings(raw){
  if(raw === undefined || raw === null) return {};
  if(!isPlainObject(raw)) return null;
  const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi ? v : null;
  const matchSecs = int(raw.matchSecs, 10, 600);
  const wordSecs = int(raw.wordSecs, 5, 60);
  if(matchSecs === null || wordSecs === null) return null;
  return { matchMs: matchSecs * 1000, wordMs: wordSecs * 1000 };
}
