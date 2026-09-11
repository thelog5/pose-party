/* Which word comes next, in EVERY mode. Pure, and imported by the server too
   (server/rooms.js), so Solo, practice 1v1, online 1v1 and Party all deal by
   the same rule.

   The rule: words you have not seen come first, and then the words you saw
   longest ago. The old deal was a fresh shuffle at the start of every match.
   Inside one match that already dealt every word once before any word twice,
   but a two-minute match deals about ten of 37 words, and the next match
   shuffled all 37 again: some words came back match after match while others
   did not show up for a long time.

   So the browser remembers WHEN it last showed each word (`wordsSeen`), in
   every mode, and the next deck is built from that:

   1. Words never seen come first, in random order.
   2. Then the seen words, oldest first. Each one moves up to a third of the
      deck at random (JITTER), so the order is not the same every time. With
      no jitter, once every word has been seen, each cycle deals the words in
      the same order as the cycle before.

   Online, the server takes, for each word, the LATEST time ANY player in the
   room saw it, and adds the words it dealt in this room itself. A word that
   one player has just seen is recent for the whole room. */

const JITTER = 1 / 3;
const STORE_KEY = "posePartyWordsSeen";
const STORE_MAX = 200;

function shuffle(list, rand){
  for(let i = list.length - 1; i > 0; i--){
    const j = Math.floor(rand() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

/* `seen` maps word -> the time it was last shown (any number that grows with
   time; 0 or missing means never). Returns a NEW array in deal order: the
   first element is the next word. */
export function freshOrder(words, seen = {}, rand = Math.random){
  const at = w => {
    const t = seen && Number(seen[w]);
    return Number.isFinite(t) && t > 0 ? t : 0;
  };
  const fresh = shuffle(words.filter(w => !at(w)), rand);
  /* shuffle BEFORE the sort: the sort is stable, so equal times stay random */
  const old = shuffle(words.filter(w => at(w)), rand).sort((a, b) => at(a) - at(b));
  const span = old.length * JITTER;
  const jittered = old.map((w, i) => ({ w, k: i + rand() * span }))
    .sort((a, b) => a.k - b.k).map(x => x.w);
  return fresh.concat(jittered);
}

/* ---- the browser's memory (no-ops where there is no localStorage) ---- */

export function wordsSeen(){
  try{
    const raw = JSON.parse(globalThis.localStorage?.getItem(STORE_KEY) || "{}");
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  }catch{ return {}; }
}

export function markWordSeen(word, now = Date.now()){
  if(!word) return;
  try{
    const seen = wordsSeen();
    seen[word] = now;
    let keys = Object.keys(seen);
    /* keep the newest STORE_MAX, so words from old decks cannot pile up */
    if(keys.length > STORE_MAX){
      keys.sort((a, b) => seen[b] - seen[a]);
      for(const k of keys.slice(STORE_MAX)) delete seen[k];
    }
    globalThis.localStorage?.setItem(STORE_KEY, JSON.stringify(seen));
  }catch{}
}

/* What a room needs to hear from this browser: the seen times for the words
   this player can perform, and nothing else. */
export function seenFor(labels){
  const seen = wordsSeen(), out = {};
  for(const l of labels || []) if(Number.isFinite(seen[l])) out[l] = seen[l];
  return out;
}
