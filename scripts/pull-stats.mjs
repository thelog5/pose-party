#!/usr/bin/env node
/* Download the game's word stats to this computer, and print them.

   node scripts/pull-stats.mjs              pull, save, print
   node scripts/pull-stats.mjs --offline    print what is saved, no network

   Reads STATS_URL (the game's address, e.g. https://pose-party.onrender.com)
   and STATS_TOKEN (the stats password, from Render's Environment tab) from
   the environment, or from the root .env.

   The server keeps totals in memory and starts over when it restarts, with a
   new `bootId`. So stats/word-stats.json keeps the LATEST pull of each boot,
   and the report is the sum over boots. Pulling twice replaces, never adds.
   Pull before you deploy: a restart loses whatever was not pulled. */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STORE = path.join(ROOT, "stats", "word-stats.json");

function env(name){
  if(process.env[name]) return process.env[name].trim();
  try{
    for(const line of fs.readFileSync(path.join(ROOT, ".env"), "utf8").split(/\r?\n/)){
      const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if(m && m[1] === name) return m[2].replace(/^(['"])(.*)\1$/, "$2").trim();
    }
  }catch(e){ /* no .env */ }
  return "";
}

const store = fs.existsSync(STORE) ? JSON.parse(fs.readFileSync(STORE, "utf8")) : { boots: {} };

if(!process.argv.includes("--offline")){
  const url = env("STATS_URL").replace(/\/+$/, ""), token = env("STATS_TOKEN");
  if(!url || !token){
    console.error("Set STATS_URL and STATS_TOKEN (environment or the root .env). Add --offline to print saved stats.");
    process.exit(2);
  }
  const res = await fetch(url + "/stats", { headers: {
    accept: "application/json",
    authorization: "Basic " + Buffer.from("stats:" + token).toString("base64") } });
  if(!res.ok){ console.error(`The server answered ${res.status}. Check STATS_URL and STATS_TOKEN.`); process.exit(1); }
  const snap = await res.json();
  store.boots[snap.bootId] = snap;
  fs.mkdirSync(path.dirname(STORE), { recursive: true });
  fs.writeFileSync(STORE, JSON.stringify(store, null, 1));
  console.log(`Pulled ${snap.reports} reports from the server started ${snap.since}. ` +
    `Connected now: ${snap.online?.sockets ?? 0}, rooms: ${snap.online?.rooms ?? 0}.`);
}

/* ---- the sum over every boot ---- */
const total = {};
for(const snap of Object.values(store.boots))
  for(const [word, w] of Object.entries(snap.words || {})){
    const t = total[word] ??= { played:0, got:0, miss:0, skip:0, msSum:0, msN:0, peakSum:0, wrong:{}, modes:{} };
    for(const k of ["played", "got", "miss", "skip", "msSum", "msN", "peakSum"]) t[k] += w[k] || 0;
    for(const [l, n] of Object.entries(w.wrong || {})) t.wrong[l] = (t.wrong[l] || 0) + n;
    for(const [m, v] of Object.entries(w.modes || {})){
      const tm = t.modes[m] ??= { played:0, got:0 }; tm.played += v.played; tm.got += v.got;
    }
  }

const rows = Object.entries(total).sort((a, b) => a[1].got / a[1].played - b[1].got / b[1].played);
const boots = Object.keys(store.boots).length;
const reports = rows.reduce((s, [, w]) => s + w.played, 0);
console.log(`\n${reports} word attempts over ${boots} server start${boots === 1 ? "" : "s"}, worst word first.`);
console.log("(\"AI got to\" is how close the AI came on average: its best score for the word.)\n");
const pct = (a, b) => b ? `${Math.round(100 * a / b)}%` : "-";
console.log(`${"word".padEnd(27)} played    got  skipped  avg time  AI got to  guessed instead`);
for(const [word, w] of rows){
  const wrong = Object.entries(w.wrong).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([l, n]) => `${l} (${n})`).join(", ");
  console.log(`${word.padEnd(27)} ${String(w.played).padStart(6)} ${pct(w.got, w.played).padStart(6)} ` +
    `${pct(w.skip, w.played).padStart(8)} ${(w.msN ? (w.msSum / w.msN / 1000).toFixed(1) + "s" : "-").padStart(9)} ` +
    `${pct(w.peakSum, w.played).padStart(10)}  ${wrong}`);
}
if(!rows.length) console.log("No reports yet.");

/* ---- video links, summed over boots; the relay reading from the newest ---- */
const net = {};
for(const snap of Object.values(store.boots))
  for(const [mode, n] of Object.entries(snap.net || {})){
    const t = net[mode] ??= { connected:0, relayed:0, failed:0 };
    for(const k of ["connected", "relayed", "failed"]) t[k] += n[k] || 0;
  }
console.log("\nVideo links (each player reports their own side):");
for(const [mode, n] of Object.entries(net)){
  const all = n.connected + n.failed;
  console.log(`  ${mode.padEnd(6)} ${String(all).padStart(5)} links   direct ${pct(n.connected - n.relayed, all)}   ` +
    `relay ${pct(n.relayed, all)}   failed ${pct(n.failed, all)}`);
}
if(!Object.keys(net).length) console.log("  none yet");
const newest = Object.values(store.boots).sort((a, b) => String(b.now).localeCompare(String(a.now)))[0];
const r = newest?.relay;
if(r?.usedGb != null)
  console.log(`Relay use since ${r.since}: ${r.usedGb.toFixed(2)} GB of ${r.capGb} GB. Relay is ${r.on ? "on" : "OFF"}.`);
else if(r) console.log(`Relay: ${r.configured ? "configured, no usage reading yet" : "not configured"}.`);
