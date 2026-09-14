/* WORD STATS: per-word totals from the players' own reports.

   The client (js/wordStats.js) sends one anonymous report per word it
   attempted: { word, mode, result, ms, peak, wrong }. This keeps TOTALS only,
   in memory: no report is stored as it arrived, and nothing identifies who
   sent it. A restart starts a new `bootId` with empty totals, which is how
   scripts/pull-stats.mjs merges pulls without counting anything twice.

   Every field is checked against the deck the server is serving, so a
   report can only ever add to a word that exists. */

import crypto from "crypto";

const MODES = new Set(["ai", "vs", "online", "party"]);
const RESULTS = new Set(["got", "miss", "skip"]);
const MAX_MS = 10 * 60 * 1000;

export function createWordStats({ labels }){
  const known = new Set(labels);
  const bootId = crypto.randomUUID();
  const since = new Date().toISOString();
  const words = new Map();
  let reports = 0;
  /* Video links, from the clients' own net:report (one per side of each link,
     so a link that both players report counts twice; the SHARES are still
     right). Relayed = either end used the TURN relay. Counts only. */
  const net = {};

  function record(p){
    if(!p || typeof p !== "object") return { error: "bad-payload" };
    const { word, mode, result } = p;
    if(!known.has(word) || !MODES.has(mode) || !RESULTS.has(result))
      return { error: "bad-payload" };
    const ms = p.ms == null ? null : Number(p.ms);
    if(ms !== null && !(Number.isFinite(ms) && ms >= 0 && ms <= MAX_MS)) return { error: "bad-payload" };
    const peak = Number(p.peak);
    if(!(Number.isFinite(peak) && peak >= 0 && peak <= 1)) return { error: "bad-payload" };
    const wrong = p.wrong == null ? null : p.wrong;
    if(wrong !== null && (!known.has(wrong) || wrong === word)) return { error: "bad-payload" };

    let w = words.get(word);
    if(!w){
      w = { played:0, got:0, miss:0, skip:0, msSum:0, msN:0, peakSum:0, wrong:{}, modes:{} };
      words.set(word, w);
    }
    w.played++; w[result]++;
    if(result === "got" && ms !== null){ w.msSum += ms; w.msN++; }
    w.peakSum += peak;
    if(wrong && result !== "got") w.wrong[wrong] = (w.wrong[wrong] || 0) + 1;
    const m = w.modes[mode] ??= { played:0, got:0 };
    m.played++; if(result === "got") m.got++;
    reports++;
    return { ok: true };
  }

  function recordNet(mode, result, relayed){
    const n = net[mode] ??= { connected:0, relayed:0, failed:0 };
    if(result === "failed") n.failed++;
    else { n.connected++; if(relayed) n.relayed++; }
  }

  const snapshot = (extra = {}) => ({
    bootId, since, now: new Date().toISOString(), reports, ...extra,
    net, words: Object.fromEntries(words),
  });

  /* One line for the log, so the hourly history survives in the host's logs
     even if nobody pulls before a restart. */
  function summaryLine(){
    const rows = [...words].filter(([, w]) => w.played >= 5)
      .map(([word, w]) => [word, w.got / w.played]).sort((a, b) => a[1] - b[1]).slice(0, 3);
    return `stats: ${reports} word reports since ${since}` +
      (rows.length ? `; weakest ${rows.map(([w, r]) => `${w} ${Math.round(r * 100)}%`).join(", ")}` : "");
  }

  return { record, recordNet, snapshot, summaryLine };
}

/* Video links and the relay's monthly use, above the word table. */
function netSection(snap){
  const pct = (a, b) => b ? Math.round(100 * a / b) + "%" : "-";
  const rows = Object.entries(snap.net || {}).map(([mode, n]) => {
    const all = n.connected + n.failed;
    return `<tr><td>${mode}</td><td>${all}</td><td>${pct(n.connected - n.relayed, all)}</td>` +
      `<td>${pct(n.relayed, all)}</td><td>${pct(n.failed, all)}</td></tr>`;
  }).join("");
  const r = snap.relay;
  const relayLine = !r ? "" : !r.configured
    ? "<p>Relay: not configured on this server, so links that cannot connect directly fail.</p>"
    : r.usedGb == null
      ? `<p>Relay: ${r.on ? "on" : "off"}. No usage reading from Cloudflare yet.</p>`
      : `<p>Relay use since ${r.since}: <b>${r.usedGb.toFixed(2)} GB of ${r.capGb} GB</b> ` +
        `(${Math.round(100 * r.usedGb / r.capGb)}%). The relay is <b>${r.on ? "on" : "OFF"}</b>. ` +
        `Read ${r.readAgoMin} min ago.</p>`;
  return `<h2>Video connections</h2>${relayLine}
<table><tr><th>mode</th><th>links</th><th>direct</th><th>relay</th><th>failed</th></tr>
${rows || '<tr><td colspan="5">No video links yet.</td></tr>'}</table>
<p class="hint">Each player reports their own side of a link. "failed" links would need the relay.</p>`;
}

/* The admin page: the same snapshot as a table, worst word first. */
export function statsPage(snap){
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;" })[c]);
  const pct = (a, b) => b ? Math.round(100 * a / b) + "%" : "";
  const rows = Object.entries(snap.words)
    .sort((a, b) => a[1].got / a[1].played - b[1].got / b[1].played)
    .map(([word, w]) => {
      const wrong = Object.entries(w.wrong).sort((a, b) => b[1] - a[1]).slice(0, 3)
        .map(([l, n]) => `${esc(l)} (${n})`).join(", ");
      return `<tr><td>${esc(word)}</td><td>${w.played}</td><td>${pct(w.got, w.played)}</td>` +
        `<td>${pct(w.skip, w.played)}</td><td>${w.msN ? (w.msSum / w.msN / 1000).toFixed(1) + "s" : ""}</td>` +
        `<td>${Math.round(100 * w.peakSum / w.played)}%</td><td>${wrong}</td></tr>`;
    }).join("");
  return `<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex">
<title>Pose Party stats</title>
<style>body{font:15px/1.4 system-ui,sans-serif;margin:24px;color:#123477;background:#fbf6ea}
table{border-collapse:collapse;width:100%}th,td{padding:6px 10px;border-bottom:1px solid #d9cfb6;text-align:left}
th{background:#123477;color:#fff}td:nth-child(n+2):nth-child(-n+6){text-align:right}
h2{margin:28px 0 8px}.hint{opacity:.7;font-size:13px}</style>
<h1>Pose Party stats</h1>
<p>Since this server started: ${esc(snap.since)} &middot; ${snap.reports} reports &middot;
${snap.online?.sockets ?? 0} connected now &middot; ${snap.online?.rooms ?? 0} rooms.
Pull these to your computer with <code>node scripts/pull-stats.mjs</code>; a restart starts over.</p>
${netSection(snap)}
<h2>Words</h2>
<table><tr><th>word</th><th>played</th><th>got</th><th>skipped</th><th>avg time</th><th>AI got to</th><th>guessed instead</th></tr>
${rows || '<tr><td colspan="7">No reports yet.</td></tr>'}</table>`;
}
