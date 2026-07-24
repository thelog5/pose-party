/* Integration test: boots the real server with a fast match config and runs
   two socket.io clients through a full match plus every rejection path.
   Run with: npm test  (from server/) */

import { spawn } from "child_process";
import { fileURLToPath } from "url";
import path from "path";
import { io as connect } from "socket.io-client";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3789;
const URL = `http://localhost:${PORT}`;

const ENV = {
  ...process.env,
  PORT: String(PORT),
  ROUNDS: "3",
  WORD_MS: "1200",
  PRECOUNT_MS: "250",
  BETWEEN_ROUNDS_MS: "150",
  RATE_JOIN: "50",
  RATE_CREATE: "8",
};

let fails = 0;
const ok = (cond, msg) => { console.log((cond ? "  ok  " : "  FAIL") + " " + msg); if (!cond) fails++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* promise wrappers */
const emit = (sock, ev, payload) => new Promise(r => sock.emit(ev, payload, r));
const once = (sock, ev, timeoutMs = 4000) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`timeout waiting for ${ev}`)), timeoutMs);
  sock.once(ev, p => { clearTimeout(t); resolve(p); });
});

const server = spawn("node", [path.join(__dirname, "..", "index.js")], { env: ENV, stdio: "pipe" });
await new Promise((resolve, reject) => {
  server.stdout.on("data", d => { if (String(d).includes("server running")) resolve(); });
  server.on("error", reject);
  setTimeout(() => reject(new Error("server did not start")), 5000);
});

try {
  const A = connect(URL, { transports: ["websocket"] });
  const B = connect(URL, { transports: ["websocket"] });
  const C = connect(URL, { transports: ["websocket"] });
  await Promise.all([once(A, "connect"), once(B, "connect"), once(C, "connect")]);

  console.log("rooms:");
  const LABELS_A = ["idle", "boxing", "archery", "guitar", "sleeping"];
  const LABELS_B = ["idle", "boxing", "archery", "guitar", "disco dance"];
  const SHARED = ["boxing", "archery", "guitar"];

  let r = await emit(A, "room:create", { name: "Alice", labels: LABELS_A });
  ok(/^[A-Z2-9]{6}$/.test(r.code || ""), `room created with code ${r.code}`);
  const code = r.code;

  r = await emit(C, "room:create", { name: "X", labels: ["idle","x"], settings: { matchSecs: 9999, wordSecs: 10 } });
  ok(r.error === "bad-payload", `out-of-range settings rejected (${r.error})`);

  r = await emit(B, "room:join", { code: "ZZZZZZ", name: "Bob", labels: LABELS_B });
  ok(r.error === "no-such-room", `wrong code rejected (${r.error})`);

  r = await emit(B, "room:join", { code: " " + code.toLowerCase() + " ", name: "Bob<script>", labels: LABELS_B });
  ok(r.code === code, "join tolerates case/whitespace in code");
  ok(r.peerName === "Alice", `joiner told host name (${r.peerName})`);

  r = await emit(C, "room:join", { code, name: "Eve", labels: LABELS_B });
  ok(r.error === "room-full", `third player rejected (${r.error})`);

  r = await emit(A, "round:claim", { roundId: "nope" });
  ok(r.error === "no-active-round", `claim before match rejected (${r.error})`);

  console.log("match:");
  const aReady = once(A, "room:ready"), bReady = once(B, "room:ready");
  r = await emit(B, "match:begin", {});
  ok(r.error === "not-host", `non-host cannot begin (${r.error})`);
  await emit(A, "player:ready", {});
  r = await emit(A, "match:begin", {});
  ok(r.error === "not-ready", `begin before both ready rejected (${r.error})`);
  await emit(B, "player:ready", {});
  await Promise.all([aReady, bReady]);
  ok(true, "both clients told room:ready");

  r = await emit(B, "room:settings", { settings: { matchSecs: 120, wordSecs: 15 } });
  ok(r.error === "not-host", `non-host cannot change settings (${r.error})`);

  const aStart = once(A, "match:start"), bStart = once(B, "match:start");
  r = await emit(A, "match:begin", {});
  ok(r.ok === true, "host begins the match");
  const [ms] = await Promise.all([aStart, bStart]);
  ok(ms.matchEndsAt > ms.startAt, "match:start carries the match deadline");
  ok(ms.startAt > Date.now() - 100, "startAt in the future");
  const bobName = ms.players.find(p => p.name !== "Alice")?.name;
  ok(bobName === "Bobscript", `name sanitized server-side ("${bobName}")`);

  const [r1a, r1b] = await Promise.all([once(A, "round:start"), once(B, "round:start")]);
  ok(r1a.roundId === r1b.roundId, "both clients share roundId");
  ok(r1a.word === r1b.word, `both clients share word "${r1a.word}"`);
  ok(SHARED.includes(r1a.word), "word is from the shared label intersection");
  ok(r1a.word !== "idle", "idle never dealt");
  ok(r1a.roundNum === 1, "round 1");

  // duplicate + garbage claims
  r = await emit(A, "round:claim", "not-an-object");
  ok(r.error === "bad-payload", `garbage claim payload rejected (${r.error})`);
  r = await emit(A, "round:claim", { roundId: "0123456789abcdef" });
  ok(r.error === "stale-round", `wrong roundId rejected (${r.error})`);

  const resB = once(B, "round:result");
  r = await emit(A, "round:claim", { roundId: r1a.roundId });
  ok(r.ok === true, "valid claim accepted");
  const res1 = await resB;
  ok(res1.winnerId === A.id, "A won the word");
  ok(res1.scores.find(p => p.id === A.id).score === 1, "server score A=1");
  ok(res1.scores.find(p => p.id === B.id).score === 0, "server score B=0");

  r = await emit(B, "round:claim", { roundId: r1a.roundId });
  ok(!!r.error, `late claim on resolved round rejected (${r.error})`);

  // round 2: nobody claims -> timeout result
  const [r2] = await Promise.all([once(A, "round:start"), once(B, "round:start")]);
  ok(r2.roundNum === 2, "round 2 started automatically");
  const res2 = await once(A, "round:result", 3000);
  ok(res2.winnerId === null && res2.reason === "timeout", "unclaimed round times out with no winner");

  // round 3: B wins, then match ends
  const [r3] = await Promise.all([once(A, "round:start"), once(B, "round:start")]);
  const endA = once(A, "match:end", 4000), endB = once(B, "match:end", 4000);
  const res3a = once(A, "round:result"); // attach before claiming — events don't buffer
  r = await emit(B, "round:claim", { roundId: r3.roundId });
  ok(r.ok === true, "B claim accepted in round 3");
  await res3a;
  const [endPayload] = await Promise.all([endA, endB]);
  const fin = Object.fromEntries(endPayload.scores.map(p => [p.name, p.score]));
  ok(fin["Alice"] === 1 && fin["Bobscript"] === 1, `final scores 1-1 (${JSON.stringify(fin)})`);

  console.log("signaling:");
  // room is destroyed after match end — signaling should fail now
  r = await emit(A, "rtc:signal", { data: { type: "offer" } });
  ok(!!r.error, `signal outside room rejected (${r.error})`);

  // fresh room for signaling + disconnect tests
  const D = connect(URL, { transports: ["websocket"] });
  const E = connect(URL, { transports: ["websocket"] });
  await Promise.all([once(D, "connect"), once(E, "connect")]);
  const r2c = await emit(D, "room:create", { name: "Dana", labels: SHARED });
  await emit(E, "room:join", { code: r2c.code, name: "Eli", labels: SHARED });
  const sigE = once(E, "rtc:signal");
  r = await emit(D, "rtc:signal", { data: { type: "offer", sdp: "v=0 fake" } });
  ok(r.ok === true, "signal relayed");
  const sig = await sigE;
  ok(sig.data.sdp === "v=0 fake", "peer received the signal verbatim");
  r = await emit(D, "rtc:signal", { data: { blob: "x".repeat(30000) } });
  ok(r.error === "bad-payload", `oversized signal rejected (${r.error})`);

  const peerLeft = once(E, "peer:left");
  D.disconnect();
  await peerLeft;
  ok(true, "peer notified on disconnect");

  // settings broadcast + the match clock ends the match
  console.log("settings + match time:");
  const H = connect(URL, { transports: ["websocket"] });
  const I = connect(URL, { transports: ["websocket"] });
  await Promise.all([once(H, "connect"), once(I, "connect")]);
  const r4c = await emit(H, "room:create", { name: "Hana", labels: SHARED, settings: { matchSecs: 10, wordSecs: 5 } });
  ok(!!r4c.code, "room with custom settings created");
  const rj = await emit(I, "room:join", { code: r4c.code, name: "Ivy", labels: SHARED });
  ok(rj.settings && rj.settings.matchSecs === 10 && rj.settings.wordSecs === 5, `joiner got settings in ack (${JSON.stringify(rj.settings)})`);
  const iSettings = once(I, "room:settings");
  r = await emit(H, "room:settings", { settings: { matchSecs: 10, wordSecs: 10 } });
  ok(r.ok === true, "host settings update accepted");
  const sPayload = await iSettings;
  ok(sPayload.settings.wordSecs === 10, "joiner received settings broadcast");
  const hReady = once(H, "room:ready");
  await emit(H, "player:ready", {}); await emit(I, "player:ready", {});
  await hReady;
  const hStart = once(H, "match:start");
  await emit(H, "match:begin", {});
  const hs = await hStart;
  ok(hs.matchEndsAt - Date.now() <= 10500, "deadline ≈ startAt + 10s");
  // claim the first word, then let rounds run; the 10s clock must end it
  const hr1 = await once(H, "round:start");
  await emit(H, "round:claim", { roundId: hr1.roundId });
  const endH = await once(H, "match:end", 16000);
  const hScore = endH.scores.find(p => p.name === "Hana").score;
  ok(hScore >= 1, `match ended by the clock with scores intact (Hana=${hScore})`);
  H.disconnect(); I.disconnect();

  // ---- party rooms: 3v3 lobby ----
  console.log("party rooms:");
  const P = [];
  for (let i = 0; i < 6; i++) P.push(connect(URL, { transports: ["websocket"] }));
  await Promise.all(P.map(s => once(s, "connect")));
  r = await emit(P[0], "party:create", { name: "Host" });
  ok(/^[A-Z2-9]{6}$/.test(r.code || ""), `party room created (${r.code})`);
  ok(r.roster.players[0].team === "blue", "creator lands on blue");
  const pcode = r.code;

  // cross-type hints
  r = await emit(P[1], "room:join", { code: pcode, name: "X", labels: ["idle","a"] });
  ok(r.error === "party-room", `1v1 join on a party code hints party (${r.error})`);
  r = await emit(P[1], "party:join", { code: "ZZZZZZ", name: "X" });
  ok(r.error === "no-such-room", "bad party code rejected");

  // joiners auto-balance
  for (let i = 1; i < 6; i++) {
    r = await emit(P[i], "party:join", { code: pcode, name: "P" + i });
    ok(!r.error, `P${i} joined (${JSON.stringify(r.error || r.roster.players.length + " players")})`);
  }
  let roster = r.roster;
  const countTeam = (ros, t) => ros.players.filter(p => p.team === t).length;
  ok(countTeam(roster, "blue") === 3 && countTeam(roster, "orange") === 3, "auto-balance filled 3v3");

  const seventh = connect(URL, { transports: ["websocket"] });
  await once(seventh, "connect");
  r = await emit(seventh, "party:join", { code: pcode, name: "Late" });
  ok(r.error === "room-full", `7th player rejected (${r.error})`);
  seventh.disconnect();

  // switching into a full team is refused
  r = await emit(P[1], "party:team", { team: P[1].team === "blue" ? "orange" : "orange" });
  // find P1's team from roster
  const p1 = roster.players.find(p => p.name === "P1");
  const otherTeam = p1.team === "blue" ? "orange" : "blue";
  r = await emit(P[1], "party:team", { team: otherTeam });
  ok(r.error === "team-full", `switch into a full team refused (${r.error})`);

  // start gate: host only + needs 2v2
  r = await emit(P[1], "party:start", {});
  ok(r.error === "not-host", `non-host start refused (${r.error})`);
  const startedAll = P.map(s => once(s, "party:started"));
  r = await emit(P[0], "party:start", {});
  ok(r.ok === true, "host start accepted at 3v3");
  await Promise.all(startedAll);
  ok(true, "party:started broadcast to all six");

  // targeted signaling
  const sigTo = roster.players.find(p => p.name === "P2").id;
  const gotSig = once(P[2], "party:signal");
  r = await emit(P[0], "party:signal", { to: sigTo, data: { type: "offer", sdp: "v=0 party" } });
  ok(r.ok === true, "party signal relayed");
  const psig = await gotSig;
  ok(psig.data.sdp === "v=0 party" && !!psig.from, "peer got targeted signal with sender id");

  // leave updates roster; below 2v2 the gate closes
  const rosterAfter = once(P[0], "party:roster");
  P[5].disconnect();
  const ros2 = await rosterAfter;
  ok(ros2.players.length === 5, "roster shrank on disconnect");
  // drop one team to 1 member: move players until orange has 1
  // (simplest: everyone on orange except one leaves)
  const orangeIds = ros2.players.filter(p => p.team === "orange").map(p => p.id);
  for (const s of P.slice(1)) {
    if (orangeIds.includes(s.id) && ros2.players.filter(p => p.team === "orange").length > 1) {
      const upd = once(P[0], "party:roster");
      s.disconnect();
      const now = await upd;
      ros2.players = now.players;
    }
  }
  if (ros2.players.filter(p => p.team === "orange").length < 2) {
    r = await emit(P[0], "party:start", {});
    ok(r.error === "need-teams", `start refused below 2v2 (${r.error})`);
  } else {
    ok(false, "could not thin orange team for gate test");
  }
  for (const s of P) s.disconnect();


  console.log("abuse:");
  // disjoint labels -> no-shared-words
  const F = connect(URL, { transports: ["websocket"] });
  const G = connect(URL, { transports: ["websocket"] });
  await Promise.all([once(F, "connect"), once(G, "connect")]);
  const r3c = await emit(F, "room:create", { name: "Fred", labels: ["idle", "boxing"] });
  await emit(G, "room:join", { code: r3c.code, name: "Gia", labels: ["idle", "skiing"] });
  const fReady = once(F, "room:ready");
  await emit(F, "player:ready", {});
  await emit(G, "player:ready", {});
  await fReady;
  const errF = once(F, "room:error");
  const rBegin = await emit(F, "match:begin", {});
  ok(rBegin.error === "no-shared-words", `begin with disjoint word lists rejected (${rBegin.error})`);
  ok((await errF).error === "no-shared-words", "both players told no-shared-words");

  // rate limit: creates share one IP (localhost), so the earlier creates count too
  let limited = false;
  for (let i = 0; i < 8; i++) {
    const rr = await emit(C, "room:create", { name: "Spam", labels: ["idle", "x"] });
    if (rr.error === "rate-limited") { limited = true; break; }
    if (rr.code) await emit(C, "room:leave", {});
  }
  ok(limited, "room creation rate-limited");

  r = await emit(C, "room:join", 42);
  ok(r.error === "bad-payload", "non-object join payload rejected");
  r = await emit(C, "room:join", { code: "ABC234", name: { evil: 1 }, labels: SHARED });
  ok(r.error === "bad-payload", "object name rejected");

  for (const s of [A, B, C, E, F, G]) s.disconnect();
} catch (e) {
  fails++;
  console.log("  FAIL (exception):", e.message);
} finally {
  server.kill();
}

console.log(fails ? `\n${fails} FAILURES` : "\nALL SERVER INTEGRATION TESTS PASSED");
process.exit(fails ? 1 : 0);
