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
  const aStart = once(A, "match:start"), bStart = once(B, "match:start");
  await emit(A, "player:ready", {});
  await emit(B, "player:ready", {});
  const [ms] = await Promise.all([aStart, bStart]);
  ok(ms.rounds === 3, `match:start rounds=3`);
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

  console.log("abuse:");
  // disjoint labels -> no-shared-words
  const F = connect(URL, { transports: ["websocket"] });
  const G = connect(URL, { transports: ["websocket"] });
  await Promise.all([once(F, "connect"), once(G, "connect")]);
  const r3c = await emit(F, "room:create", { name: "Fred", labels: ["idle", "boxing"] });
  await emit(G, "room:join", { code: r3c.code, name: "Gia", labels: ["idle", "skiing"] });
  const errF = once(F, "room:error");
  await emit(F, "player:ready", {});
  await emit(G, "player:ready", {});
  ok((await errF).error === "no-shared-words", "disjoint word lists rejected at match start");

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
