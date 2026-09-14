/* Integration test: boots the real server with a fast match config and runs
   two socket.io clients through a full match plus every rejection path.
   Run with: npm test  (from server/) */

import { spawn } from "child_process";
import { fileURLToPath } from "url";
import path from "path";
import { io as connect } from "socket.io-client";
import {
  calculateFirstPoints,
  calculateChaserPoints,
} from "../../pose-charades-external-data/js/scoring.js";
import { freshOrder } from "../../pose-charades-external-data/js/wordOrder.js";
import { cleanSeen } from "../validate.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3789;
const URL = `http://localhost:${PORT}`;

const ENV = {
  ...process.env,
  PORT: String(PORT),
  ROUNDS: "3",
  WORD_MS: "1200",
  PRECOUNT_MS: "250",
  /* the FULL BODY check sits in front of the pre-count; kept short for the
     same reason the pre-count is */
  FRAME_CHECK_MS: "100",
  /* HOW TO PLAY is a grace, not a barrier: long enough here that the
     deliberate one-acknowledgement-at-a-time assertions below still see the
     room held, short enough that the grace-only release is quick to prove. */
  TUTORIAL_GRACE_MS: "1500",
  BETWEEN_ROUNDS_MS: "150",
  RATE_JOIN: "50",
  RATE_CREATE: "10",
  /* word stats on, so the report endpoint and the totals page are tested */
  STATS_TOKEN: "stats-test-token",
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
  console.log("scoring:");
  ok(calculateFirstPoints(20000,20000) === 500, "first player gets 500 with the full word clock");
  ok(calculateFirstPoints(10000,20000) === 400, "first-player score reaches 400 at half time");
  ok(calculateFirstPoints(0,20000) === 300, "first-player score floors at 300");
  ok(calculateChaserPoints(500,.5) === 497, "half-second chase penalty rounds to 3 points");
  ok(calculateChaserPoints(500,3) === 374, "quadratic decay reaches 374 at three seconds");
  ok(calculateChaserPoints(500,5) === 150 && calculateChaserPoints(500,5.001) === 0,
    "five seconds earns 150; anything later earns zero");

  console.log("word order:");
  {
    const words = Array.from({ length: 12 }, (_, i) => "w" + i);
    const seen = { w0: 500, w1: 100, w2: 900, w3: 300 };
    let unseenFirst = true, oldBeforeNew = true, complete = true;
    for (let i = 0; i < 200; i++) {
      const o = freshOrder(words, seen);
      complete &&= o.length === 12 && new Set(o).size === 12;
      unseenFirst &&= o.slice(0, 8).every(w => !(w in seen));
      /* jitter moves a word at most a third of the SEEN part (4/3 places) */
      oldBeforeNew &&= o.indexOf("w1") < o.indexOf("w2");
    }
    ok(complete, "the order holds every word exactly once");
    ok(unseenFirst, "words never seen are always dealt first");
    ok(oldBeforeNew, "the oldest seen word always comes before the newest");
    const orders = new Set(Array.from({ length: 50 }, () => freshOrder(words, seen).join()));
    ok(orders.size > 10, `and the order is still random (${orders.size}/50 distinct)`);

    const labels = ["boxing", "guitar"];
    const c = cleanSeen({ BOXING: 5, guitar: "7", evil: 9, nan: NaN }, labels);
    ok(c.boxing === 5 && !("guitar" in c) && !("evil" in c) && Object.keys(c).length === 1,
      `seen times keep only the player's own labels, as numbers (${JSON.stringify(c)})`);
    ok(JSON.stringify(cleanSeen("junk", labels)) === "{}" && JSON.stringify(cleanSeen(undefined, labels)) === "{}",
      "a missing or odd seen map is empty, never an error");
    ok(cleanSeen({ boxing: Date.now() + 9e12 }, labels).boxing < Date.now() + 2 * 86400e3,
      "a seen time far in the future is clamped");
  }

  const A = connect(URL, { transports: ["websocket"] });
  const B = connect(URL, { transports: ["websocket"] });
  const C = connect(URL, { transports: ["websocket"] });
  await Promise.all([once(A, "connect"), once(B, "connect"), once(C, "connect")]);

  console.log("rooms:");
  const LABELS_A = ["idle", "boxing", "archery", "guitar", "sleeping"];
  const LABELS_B = ["idle", "boxing", "archery", "guitar", "disco dance"];
  const SHARED = ["boxing", "archery", "guitar"];

  /* guitar is unseen, archery was seen before boxing: that is the deal order */
  const NOW = Date.now();
  let r = await emit(A, "room:create", { name: "Alice", labels: LABELS_A,
    seen: { boxing: NOW - 1000, archery: NOW - 90000 } });
  ok(/^[A-Z2-9]{6}$/.test(r.code || ""), `room created with code ${r.code}`);
  const code = r.code;

  r = await emit(C, "room:create", { name: "X", labels: ["idle","x"], settings: { matchSecs: 9999, wordSecs: 10 } });
  ok(r.error === "bad-payload", `out-of-range settings rejected (${r.error})`);

  r = await emit(B, "room:join", { code: "ZZZZZZ", name: "Bob", labels: LABELS_B });
  ok(r.error === "no-such-room", `wrong code rejected (${r.error})`);

  r = await emit(B, "room:join", { code: " " + code.toLowerCase() + " ", name: "Bob<script>", labels: LABELS_B,
    seen: { archery: NOW - 60000, "disco dance": NOW } });
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

  const aPrepare = once(A, "match:prepare"), bPrepare = once(B, "match:prepare");
  r = await emit(A, "match:begin", {});
  ok(r.ok === true, "host begins the match");
  const [prepA, prepB] = await Promise.all([aPrepare, bPrepare]);
  ok(prepA.tutorialId === prepB.tutorialId &&
    prepA.tutorialStartsAt > Date.now(),
    "both clients are told the same tutorial token and the same start deadline");

  let earlyRound = false;
  const earlyRoundProbe = () => { earlyRound = true; };
  A.on("round:start", earlyRoundProbe);
  await sleep(350); // longer than PRECOUNT_MS: the old flow had dealt by now
  A.off("round:start", earlyRoundProbe);
  ok(!earlyRound, "no round is dealt during the HOW TO PLAY grace");

  const aStart = once(A, "match:start"), bStart = once(B, "match:start");
  const staleTutorial = await emit(A, "match:tutorial-ready",
    { tutorialId:"0123456789abcdef" });
  ok(staleTutorial.error === "stale-tutorial",
    "a stale tutorial token cannot release a later match");
  r = await emit(A, "match:tutorial-ready", { tutorialId: prepA.tutorialId });
  ok(r.ok === true && r.ready === 1 && !r.started,
    "one tutorial acknowledgement does not release the other player");
  const duplicateReady = await emit(A, "match:tutorial-ready",
    { tutorialId: prepA.tutorialId });
  ok(duplicateReady.ready === 1 && !duplicateReady.started,
    "duplicate tutorial acknowledgement is idempotent");
  r = await emit(B, "match:tutorial-ready", { tutorialId: prepB.tutorialId });
  ok(r.ok === true && r.started === true,
    "the final tutorial acknowledgement releases the synchronized count-in");
  const [ms] = await Promise.all([aStart, bStart]);
  ok(ms.matchEndsAt > ms.startAt, "match:start carries the match deadline");
  ok(ms.startAt - Date.now() > 140, "startAt remains a full shared grace count in the future");
  const bobName = ms.players.find(p => p.name !== "Alice")?.name;
  ok(bobName === "Bobscript", `name sanitized server-side ("${bobName}")`);

  const [r1a, r1b] = await Promise.all([once(A, "round:start"), once(B, "round:start")]);
  ok(r1a.roundId === r1b.roundId, "both clients share roundId");
  ok(r1a.word === r1b.word, `both clients share word "${r1a.word}"`);
  ok(SHARED.includes(r1a.word), "word is from the shared label intersection");
  ok(r1a.word !== "idle", "idle never dealt");
  ok(r1a.roundNum === 1, "round 1");

  const liveGuessB = once(B, "round:guess");
  r = await emit(A, "round:guess", {
    roundId:r1a.roundId, label:"BOXING", confidence:.7344,
  });
  const relayedGuess = await liveGuessB;
  ok(r.ok === true && relayedGuess.label === "boxing" &&
    relayedGuess.confidence === .734,
    "validated top guess/confidence relays ephemerally to the opponent");
  r = await emit(A, "round:guess", {
    roundId:r1a.roundId, label:"not in the model", confidence:.8,
  });
  ok(r.error === "bad-payload", "untrained live guess labels are rejected");
  r = await emit(A, "round:guess", {
    roundId:r1a.roundId, label:"boxing", confidence:4,
  });
  ok(r.error === "bad-payload", "out-of-range live guess confidence is rejected");

  // duplicate + garbage claims
  r = await emit(A, "round:claim", "not-an-object");
  ok(r.error === "bad-payload", `garbage claim payload rejected (${r.error})`);
  r = await emit(A, "round:claim", { roundId: "0123456789abcdef" });
  ok(r.error === "stale-round", `wrong roundId rejected (${r.error})`);
  r = await emit(A, "round:claim", { roundId: r1a.roundId });
  ok(r.error === "out-of-window", `claim without recognition timestamp rejected (${r.error})`);

  const chaseB = once(B, "round:chase");
  const firstAt1 = r1a.endsAt - 1200;
  r = await emit(A, "round:claim", { roundId: r1a.roundId, recognizedAt:firstAt1 });
  ok(r.ok === true && r.phase === "chase", "first recognition starts the chase");
  const chase1 = await chaseB;
  ok(chase1.firstId === A.id && chase1.firstPoints === 500, "first player immediately receives 500");
  ok(chase1.chaseEndsAt === firstAt1 + 5000, "chase cutoff is exactly five seconds after recognition");

  const resB = once(B, "round:result");
  r = await emit(B, "round:claim", { roundId:r1a.roundId, recognizedAt:firstAt1+650 });
  ok(r.ok === true && r.phase === "resolved", "chaser timestamp accepted");
  const res1 = await resB;
  const expectedChaser = calculateChaserPoints(500, .65);
  ok(res1.winnerId === A.id && res1.chaserId === B.id, "timestamp order identifies first player and chaser");
  ok(res1.chaserPoints === expectedChaser, `quadratic .65s chase score is ${expectedChaser}`);
  ok(res1.scores.find(p => p.id === A.id).score === 500, "server score A=500");
  ok(res1.scores.find(p => p.id === B.id).score === expectedChaser, `server score B=${expectedChaser}`);

  r = await emit(B, "round:claim", { roundId: r1a.roundId, recognizedAt:Date.now() });
  ok(!!r.error, `late claim on resolved round rejected (${r.error})`);

  // round 2: nobody claims -> timeout result
  const [r2] = await Promise.all([once(A, "round:start"), once(B, "round:start")]);
  ok(r2.roundNum === 2, "round 2 started automatically");
  const res2 = await once(A, "round:result", 3000);
  ok(res2.winnerId === null && res2.reason === "timeout", "unclaimed round times out with no winner");

  // round 3 mirrors round 1 but the later recognition packet arrives first:
  // timestamps must correct the order and still create the score tie.
  const [r3] = await Promise.all([once(A, "round:start"), once(B, "round:start")]);
  ok(r1a.word === "guitar" && r2.word === "archery" && r3.word === "boxing",
    `the room deals unseen first, then oldest seen by ANY player (${r1a.word}, ${r2.word}, ${r3.word})`);
  const suddenA = once(A, "match:sudden", 4000);
  const firstAt3 = r3.endsAt - 1200;
  await emit(A, "round:claim", { roundId:r3.roundId, recognizedAt:firstAt3+650 });
  const res3a = once(A, "round:result");
  r = await emit(B, "round:claim", { roundId:r3.roundId, recognizedAt:firstAt3 });
  ok(r.ok === true, "earlier synchronized timestamp accepted after the later packet");
  const result3 = await res3a;
  ok(result3.firstId===B.id && result3.chaserId===A.id,
    "recognition timestamps, not network arrival order, determine placement");
  const sudden = await suddenA;
  const tied = sudden.scores.map(p=>p.score);
  ok(tied[0] === tied[1], `equal totals trigger sudden death (${tied.join("-")})`);

  const sdA = once(A, "round:start", 4000), sdB = once(B, "round:start", 4000);
  const [sd] = await Promise.all([sdA, sdB]);
  ok(sd.suddenDeath === true, "server deals exactly one sudden-death word");
  const endA = once(A, "match:end", 4000), endB = once(B, "match:end", 4000);
  r = await emit(A, "round:claim", {
    roundId:sd.roundId,
    recognizedAt:sd.endsAt-1200,
  });
  ok(r.ok === true && r.phase === "sudden-death", "first sudden-death recognition wins immediately");
  const [endPayload] = await Promise.all([endA, endB]);
  const fin = Object.fromEntries(endPayload.scores.map(p => [p.name, p.score]));
  ok(fin["Alice"] === fin["Bobscript"], `sudden death preserves tied point totals (${JSON.stringify(fin)})`);
  ok(endPayload.winnerId === A.id && endPayload.suddenDeath === true, "match winner is the sudden-death first recognizer");

  console.log("1v1 same-room rematch:");
  ok(endPayload.rematch?.ready === 0 && endPayload.rematch?.total === 2,
    `match:end opens the shared ready tally (${JSON.stringify(endPayload.rematch)})`);
  const firstVoteSeen = once(B, "match:rematch");
  r = await emit(A, "match:rematch", {});
  const firstVote = await firstVoteSeen;
  ok(r.ok === true && r.ready === 1 && r.mine === true &&
    firstVote.ready === 1 && firstVote.voters.includes(A.id),
    "one player can ready up and both clients receive the voter state");
  r = await emit(A, "match:rematch", {});
  ok(r.ok === true && r.ready === 0 && r.mine === false,
    "the 1v1 rematch vote is an undoable toggle");

  const rematchPrepareA = once(A, "match:prepare");
  const rematchPrepareB = once(B, "match:prepare");
  await emit(A, "match:rematch", {});
  r = await emit(B, "match:rematch", {});
  const [rematchPrepA, rematchPrepB] =
    await Promise.all([rematchPrepareA, rematchPrepareB]);
  const rematchStartA = once(A, "match:start");
  const rematchStartB = once(B, "match:start");
  /* NOBODY ACKNOWLEDGES THIS ONE. The grace is the primary path: a room whose
     players are still reading — or whose tab is backgrounded, or who simply
     never find the button — must start anyway, because a game that silently
     refuses to begin and never says why is the worst outcome this screen has.
     Waiting the grace out here is the assertion. */
  const graceFrom = Date.now();
  const [rematchPayloadA, rematchPayloadB] =
    await Promise.all([rematchStartA, rematchStartB]);
  const graceWaited = Date.now() - graceFrom;
  ok(graceWaited >= 900 && graceWaited < 4000,
    `the grace starts the match with no acknowledgement at all (${graceWaited}ms)`);
  ok(rematchPrepA.tutorialStartsAt === rematchPrepB.tutorialStartsAt,
    "and both clients were told the same deadline, so their buttons agree");
  ok(r.started === true &&
    rematchPayloadA.players.every(p => p.score === 0) &&
    rematchPayloadB.players.every(p => p.score === 0),
    "2/2 ready restarts the SAME 1v1 room with clean scores");

  console.log("signaling:");
  // End the restarted room membership before the independent signaling case.
  await emit(A, "room:leave", {});
  r = await emit(B, "rtc:signal", { data: { type: "offer" } });
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

  const dRoomReady = once(D, "room:ready");
  await emit(D, "player:ready", {});
  await emit(E, "player:ready", {});
  await dRoomReady;
  const fallbackPrepare = once(D, "match:prepare");
  const fallbackStart = once(D, "match:start", 3000);
  const fallbackBeganAt = Date.now();
  await emit(D, "match:begin", {});
  await fallbackPrepare;
  const fallbackPayload = await fallbackStart;
  ok(Date.now() - fallbackBeganAt >= 900 &&
    fallbackPayload.startAt > Date.now(),
    "bounded tutorial fallback prevents a missing acknowledgement from deadlocking the room");

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
  const hPrepare = once(H, "match:prepare");
  const iPrepare = once(I, "match:prepare");
  await emit(H, "match:begin", {});
  const [hp, ip] = await Promise.all([hPrepare, iPrepare]);
  const hStart = once(H, "match:start");
  await emit(H, "match:tutorial-ready", { tutorialId:hp.tutorialId });
  await emit(I, "match:tutorial-ready", { tutorialId:ip.tutorialId });
  const hs = await hStart;
  ok(Math.abs(hs.matchEndsAt - hs.startAt - 10000) < 50, "deadline ≈ startAt + 10s");
  const lead = hs.startAt - Date.now();
  ok(lead > 150 && lead <= 350,
    `the start leaves room for the FULL BODY check plus the 3-2-1 (${lead}ms of 350)`);
  // Trigger a chase just before the 10s match deadline. It must own its full
  // five seconds, then end the match without dealing another word.
  const hr1 = await once(H, "round:start");
  const lateChaseEvent = once(H, "round:chase", 12000);
  await sleep(8850);
  r = await emit(H, "round:claim", {
    roundId:hr1.roundId,
    recognizedAt:hr1.endsAt-500,
  });
  ok(r.ok === true, "recognition before the overall deadline starts a chase");
  const lateChase = await lateChaseEvent;
  ok(lateChase.chaseEndsAt > hs.matchEndsAt,
    "chase triggered before zero continues past the overall match clock");
  const endH = await once(H, "match:end", 16000);
  const hScore = endH.scores.find(p => p.name === "Hana").score;
  ok(hScore >= 300, `match ended after the chase with scores intact (Hana=${hScore})`);
  H.disconnect(); I.disconnect();

  // ---- party rooms: 3v3 lobby ----
  console.log("party rooms:");
  const PARTY_LABELS = ["idle", "boxing", "archery", "guitar"];
  const P = [];
  for (let i = 0; i < 6; i++) P.push(connect(URL, { transports: ["websocket"] }));
  await Promise.all(P.map(s => once(s, "connect")));
  r = await emit(P[0], "party:create", { name: "Host", labels: PARTY_LABELS });
  ok(/^[A-Z2-9]{6}$/.test(r.code || ""), `party room created (${r.code})`);
  ok(r.roster.players[0].team === "blue", "creator lands on blue");
  const pcode = r.code;

  const renamedRoster = once(P[0], "party:roster");
  r = await emit(P[0], "party:name", { name: "Party Host" });
  const renamed = await renamedRoster;
  ok(r.ok === true && renamed.players[0].name === "Party Host", "party name edits broadcast through the roster");

  // cross-type hints
  r = await emit(P[1], "room:join", { code: pcode, name: "X", labels: ["idle","a"] });
  ok(r.error === "party-room", `1v1 join on a party code hints party (${r.error})`);
  r = await emit(P[1], "party:join", { code: "ZZZZZZ", name: "X", labels: PARTY_LABELS });
  ok(r.error === "no-such-room", "bad party code rejected");

  // joiners auto-balance
  for (let i = 1; i < 6; i++) {
    r = await emit(P[i], "party:join", { code: pcode, name: "P" + i, labels: PARTY_LABELS });
    ok(!r.error, `P${i} joined (${JSON.stringify(r.error || r.roster.players.length + " players")})`);
  }
  let roster = r.roster;
  const countTeam = (ros, t) => ros.players.filter(p => p.team === t).length;
  ok(countTeam(roster, "blue") === 3 && countTeam(roster, "orange") === 3, "auto-balance filled 3v3");

  const seventh = connect(URL, { transports: ["websocket"] });
  await once(seventh, "connect");
  r = await emit(seventh, "party:join", { code: pcode, name: "Late", labels: PARTY_LABELS });
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
  const preparedAll = P.map(s => once(s, "party:match"));
  r = await emit(P[0], "party:start", {});
  ok(r.ok === true, "host start accepted at 3v3");
  await Promise.all(startedAll);
  ok(true, "party:started broadcast to all six");
  const prepared = await Promise.all(preparedAll);

  // targeted signaling
  const sigTo = roster.players.find(p => p.name === "P2").id;
  const gotSig = once(P[2], "party:signal");
  r = await emit(P[0], "party:signal", { to: sigTo, data: { type: "offer", sdp: "v=0 party" } });
  ok(r.ok === true, "party signal relayed");
  const psig = await gotSig;
  ok(psig.data.sdp === "v=0 party" && !!psig.from, "peer got targeted signal with sender id");

  // A tutorial leaver is removed from the barrier as well as the roster. If
  // every survivor already accepted, their synchronized countdown releases
  // immediately instead of waiting for the bounded fallback.
  for(let i = 0; i < P.length - 1; i++)
    await emit(P[i], "party:tutorial-ready", { tutorialId:prepared[i].tutorialId });
  const survivorCountdown = once(P[0], "party:countdown");
  const rosterAfter = once(P[0], "party:roster");
  P[5].disconnect();
  const [ros2, survivorStart] = await Promise.all([rosterAfter, survivorCountdown]);
  ok(ros2.players.length === 5 && survivorStart.startAt > Date.now(),
    "tutorial disconnect shrinks the roster and releases ready survivors together");
  for (const s of P) s.disconnect();

  /* The 2v2 gate needs its own room: the six-player room above has already
     started, so its phase is no longer "lobby". Two players auto-balance to
     one per side, which is exactly one short on both teams. */
  const GATE = [connect(URL, { transports: ["websocket"] }), connect(URL, { transports: ["websocket"] })];
  await Promise.all(GATE.map(s => once(s, "connect")));
  r = await emit(GATE[0], "party:create", { name: "G0", labels: PARTY_LABELS });
  const gcode = r.code;
  await emit(GATE[1], "party:join", { code: gcode, name: "G1", labels: PARTY_LABELS });
  r = await emit(GATE[0], "party:start", {});
  ok(r.error === "need-teams", `start refused below 2v2 (${r.error})`);
  for (const s of GATE) s.disconnect();

  // The complementary tutorial-disconnect path ends safely if a side empties.
  // It must never release an unopposed countdown or wait for the fallback.
  const DISC = [];
  for(let i = 0; i < 4; i++) DISC.push(connect(URL, { transports:["websocket"] }));
  await Promise.all(DISC.map(s => once(s, "connect")));
  r = await emit(DISC[0], "party:create", { name:"D0", labels:PARTY_LABELS });
  const dcode = r.code;
  let droster = r.roster;
  for(let i = 1; i < DISC.length; i++){
    r = await emit(DISC[i], "party:join",
      { code:dcode, name:"D" + i, labels:PARTY_LABELS });
    droster = r.roster;
  }
  const discPrepared = DISC.map(s => once(s, "party:match"));
  await emit(DISC[0], "party:start", {});
  await Promise.all(discPrepared);
  const blue = DISC.filter(s =>
    droster.players.find(p => p.id === s.id)?.team === "blue");
  const orange = DISC.find(s =>
    droster.players.find(p => p.id === s.id)?.team === "orange");
  const endedOnEmpty = once(orange, "party:end");
  blue[0].disconnect();
  blue[1].disconnect();
  const emptyEnd = await endedOnEmpty;
  ok(!!emptyEnd.scores && emptyEnd.rematch?.total === 2,
    "empty team during tutorial ends safely for the surviving side");
  for(const s of DISC) s.disconnect();

  // ---- party match: simultaneous play, placement, completion bonus, chase ----
  console.log("party match:");
  const M = [];
  for (let i = 0; i < 4; i++) M.push(connect(URL, { transports: ["websocket"] }));
  await Promise.all(M.map(s => once(s, "connect")));
  r = await emit(M[0], "party:create",
    { name: "M0", labels: PARTY_LABELS, settings: { matchSecs: 10, wordSecs: 6 } });
  const mcode = r.code;
  for (let i = 1; i < 4; i++)
    await emit(M[i], "party:join", { code: mcode, name: "M" + i, labels: PARTY_LABELS });

  const matchAll = M.map(s => once(s, "party:match"));
  r = await emit(M[0], "party:start", {});
  ok(r.ok === true, "host started a 2v2 party match");
  const pm = await matchAll[0];
  await Promise.all(matchAll);
  ok(!!pm.tutorialId && pm.tutorialStartsAt > Date.now(),
    "party:match publishes a tutorial token and the grace's start deadline");
  const byId = Object.fromEntries(pm.roster.players.map(p => [p.id, p]));
  const teamOfSocket = s => byId[s.id].team;
  const blueSockets = M.filter(s => teamOfSocket(s) === "blue");
  const orangeSockets = M.filter(s => teamOfSocket(s) === "orange");
  ok(blueSockets.length === 2 && orangeSockets.length === 2, "2v2 teams formed");

  let earlyPartyRound = false;
  const earlyPartyProbe = () => { earlyPartyRound = true; };
  M[0].on("party:round", earlyPartyProbe);
  await sleep(350);
  M[0].off("party:round", earlyPartyProbe);
  ok(!earlyPartyRound, "Party deals no word during the HOW TO PLAY grace");

  const partyCountdowns = M.map(s => once(s, "party:countdown"));
  for(let i = 0; i < M.length - 1; i++){
    r = await emit(M[i], "party:tutorial-ready", { tutorialId:pm.tutorialId });
    ok(r.ok === true && !r.started,
      `Party acknowledgement ${i + 1}/4 does not release the room on its own`);
  }
  const dupPartyReady = await emit(M[0], "party:tutorial-ready",
    { tutorialId:pm.tutorialId });
  ok(dupPartyReady.ready === 3 && !dupPartyReady.started,
    "duplicate Party acknowledgement is idempotent");
  r = await emit(M[3], "party:tutorial-ready", { tutorialId:pm.tutorialId });
  ok(r.started === true,
    "everybody ready releases immediately, without waiting out the grace");
  const partyCountdown = await partyCountdowns[0];
  await Promise.all(partyCountdowns);
  ok(partyCountdown.matchEndsAt > partyCountdown.startAt &&
    partyCountdown.startAt - Date.now() > 140,
    "Party countdown carries one future shared start and match deadline");

  const round = await once(M[0], "party:round", 8000);
  ok(!!round.roundId && !!round.word, `party round dealt "${round.word}"`);
  ok(PARTY_LABELS.includes(round.word), "dealt word is shared by every player");

  /* Team score is the sum of the current members' scores, so a mid-match
     switch would carry a player's points to the other side. */
  r = await emit(blueSockets[0], "party:team", { team: "orange" });
  ok(r.error === "match-in-progress", `no team switch during a match (${r.error})`);
  r = await emit(M[0], "party:settings", { settings: { matchSecs: 600, wordSecs: 60 } });
  ok(r.error === "match-in-progress", `the host cannot change settings during a match (${r.error})`);

  // first blue player is recognized
  const gotFirst = once(M[1], "party:got");
  r = await emit(blueSockets[0], "party:claim",
    { roundId: round.roundId, recognizedAt: Date.now() });
  ok(r.ok === true && r.place === 0, `first recognition placed 1st (place=${r.place})`);
  const gotEvt = await gotFirst;
  ok(gotEvt.id === blueSockets[0].id && gotEvt.place === 0,
    "party:got broadcast so every client can green-border that player");
  r = await emit(blueSockets[0], "party:claim",
    { roundId: round.roundId, recognizedAt: Date.now() });
  ok(r.error === "already-claimed", `a second claim cannot score twice (${r.error})`);

  // second blue completes the team -> bonus + five-second chase for orange
  const chaseAll = M.map(s => once(s, "party:chase"));
  await emit(blueSockets[1], "party:claim",
    { roundId: round.roundId, recognizedAt: Date.now() });
  const chase = await chaseAll[0];
  await Promise.all(chaseAll);
  ok(chase.team === "blue" && chase.bonus === 150,
    `blue completed first: +${chase.bonus} team bonus`);
  ok(chase.chaseEndsAt - Date.now() > 3500 && chase.chaseEndsAt - Date.now() <= 5200,
    "a five-second final chase opened for the other team");

  // one orange player lands inside the window, the other never does
  await emit(orangeSockets[0], "party:claim",
    { roundId: round.roundId, recognizedAt: Date.now() });
  const result = await once(M[0], "party:result", 9000);
  ok(result.completedTeam === "blue", "result names the completing team");
  ok(result.results.length === 3, `three of four finished (${result.results.length})`);
  const places = result.results.map(x => x.place);
  ok(places.join() === "0,1,2", `placement is dense and timestamp-ordered (${places.join()})`);
  const pts = result.results.map(x => x.points);
  ok(pts[0] > pts[1] && pts[1] > pts[2], `placement points descend (${pts.join(" > ")})`);
  ok(pts[0] >= 100, `1st place scored placement + time bonus (${pts[0]})`);
  ok(result.roundTeam.blue === pts[0] + pts[1] + 150,
    `blue round score includes the completion bonus (${result.roundTeam.blue})`);
  ok(result.winner === "blue", `higher team score won the round (${result.winner})`);
  ok(result.scores.teams.blue > result.scores.teams.orange, "match totals track the round");

  const ended = await once(M[0], "party:end", 15000);
  ok(ended.winner === "blue", `match decided on total score, not rounds (${ended.winner})`);

  /* Rematch used to be impossible: the room was destroyed at match end, so a
     rerun meant a new code re-shared with everyone in the room. */
  ok(ended.rematch && ended.rematch.total === 4,
    `results screen is told the rematch tally (${JSON.stringify(ended.rematch)})`);
  const voteSeen = once(M[1], "party:rematch");
  r = await emit(M[0], "party:rematch", {});
  ok(r.ok === true && r.ready === 1, `a rematch vote registers (${r.ready}/4)`);
  const vote = await voteSeen;
  ok(vote.ready === 1 && vote.voters.includes(M[0].id),
    "the vote and who cast it reach every client");
  r = await emit(M[0], "party:rematch", {});
  ok(r.ok === true && r.ready === 0, "voting again takes it back (a misclick is undoable)");

  const restarted = M.map(s => once(s, "party:match", 9000));
  for (const s of M) await emit(s, "party:rematch", {});
  await Promise.all(restarted);
  ok(true, "everyone ready restarts the match in the SAME room — no new code");
  for (const s of M) s.disconnect();


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

  // rate limit: creates share one IP (localhost), so the earlier creates count
  // too. RATE_CREATE is pinned to 10 at the top of this file PURELY so the
  // limiter can be provoked in a few round trips — the shipped default is 30
  // and must stay well clear of real play, because walking into a lobby
  // creates a room and everyone behind one NAT shares this key. Do not "align"
  // config.js down to the number below.
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

  console.log("word stats and legal pages:");
  const deckRes = await fetch(`${URL}/assets/data/pose-charades-data.json`);
  ok(deckRes.headers.get("x-word-stats") === "on", "the deck tells the client to send word reports");
  const deckWords = [...new Set((await deckRes.json()).clips.map(c => c.label))];
  const [w1, w2] = deckWords;
  const report = body => fetch(`${URL}/stats/word`, { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  ok((await report({ word: w1, mode: "ai", result: "got", ms: 4200, peak: .91, wrong: null })).status === 204,
    "a good report is accepted");
  ok((await report({ word: w1, mode: "party", result: "miss", ms: null, peak: .3, wrong: w2 })).status === 204,
    "a miss with its wrong guess is accepted");
  ok((await report({ word: "not a deck word", mode: "ai", result: "got", ms: 1, peak: .5 })).status === 400,
    "a word that is not in the deck is refused");
  ok((await report({ word: w1, mode: "ai", result: "won", ms: 1, peak: .5 })).status === 400,
    "an unknown result is refused");
  ok((await report({ word: w1, mode: "ai", result: "miss", ms: null, peak: 7 })).status === 400,
    "a peak outside 0..1 is refused");
  const auth = t => ({ authorization: "Basic " + Buffer.from("x:" + t).toString("base64") });
  ok((await fetch(`${URL}/stats`)).status === 401, "the totals page needs its password");
  ok((await fetch(`${URL}/stats`, { headers: auth("wrong") })).status === 401, "a wrong stats password is refused");
  const snap = await (await fetch(`${URL}/stats`, { headers: { ...auth("stats-test-token"), accept: "application/json" } })).json();
  const tw = snap.words[w1];
  ok(snap.bootId && snap.reports === 2, `the totals count only the good reports (${snap.reports})`);
  ok(tw?.played === 2 && tw.got === 1 && tw.miss === 1 && tw.msN === 1 && tw.wrong[w2] === 1,
    "per-word totals: played, got, missed, time and the wrong guess");
  ok(tw?.modes.ai?.got === 1 && tw?.modes.party?.played === 1, "totals split by mode");
  ok(!JSON.stringify(snap).includes("127.0.0.1") && !JSON.stringify(snap).includes("::1"),
    "no IP address is stored with the stats");

  /* video links: the clients' own net:report, counted by mode and path */
  const N = connect(URL, { transports: ["websocket"] });
  await once(N, "connect");
  N.emit("net:report", { mode: "1v1", result: "connected", local: "srflx", remote: "host", ms: 400 });
  N.emit("net:report", { mode: "1v1", result: "connected", local: "relay", remote: "srflx", ms: 900 });
  N.emit("net:report", { mode: "party", result: "failed", ms: 15000 });
  await sleep(200);
  N.disconnect();
  const netSnap = await (await fetch(`${URL}/stats`, { headers: { ...auth("stats-test-token"), accept: "application/json" } })).json();
  ok(netSnap.net?.["1v1"]?.connected === 2 && netSnap.net["1v1"].relayed === 1 && netSnap.net.party?.failed === 1,
    "video links are counted: direct, through the relay, and failed");
  ok(netSnap.relay && netSnap.relay.configured === false, "with no TURN configured, the page says the relay is not set up");
  const html = await fetch(`${URL}/stats`, { headers: { ...auth("stats-test-token"), accept: "text/html" } });
  ok(html.status === 200 && (await html.text()).includes("<table>"), "the totals page renders for a browser");
  for (const page of ["/privacy", "/terms"]) {
    const res = await fetch(URL + page);
    ok(res.status === 200 && /<h1/.test(await res.text()), `${page} is served`);
  }
} catch (e) {
  fails++;
  console.log("  FAIL (exception):", e.message);
} finally {
  server.kill();
}

console.log(fails ? `\n${fails} FAILURES` : "\nALL SERVER INTEGRATION TESTS PASSED");
process.exit(fails ? 1 : 0);
