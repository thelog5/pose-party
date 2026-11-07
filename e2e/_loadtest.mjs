/* HOW MANY PARTY ROOMS DOES THIS SERVER HOLD? Measured, not estimated.

   The estimate this replaces came from reading the code: each player emits a
   guess every GUESS_SEND_MS (240ms) and the server fans it to the five others,
   so a party of six costs roughly 125 emits a second, and Render's starter
   plan is ONE instance on half a CPU. That is arithmetic, not evidence.

   WHY THERE ARE NO BROWSERS HERE. Every other probe in this folder drives real
   Chromes, which caps at a handful of players on one machine — useless for a
   load question. The server cannot tell a socket.io client from a browser: it
   sees party:create / party:join / party:guess and nothing else. So this opens
   N rooms of six plain socket clients and drives the REAL steady-state traffic
   at the real rate.

   WHAT IS MEASURED, and why these three:
     cpu/room/s  CPU-seconds the server burns per room per wall second. This is
                 the number that ports to another machine; the room counts
                 below are derived from it, not observed.
     ack p50/p95 client-visible latency on a cheap acked event. This is what a
                 player actually feels when the event loop is behind.
     delivered   guess events received across all clients per second, against
                 what was sent. A shortfall means the server is dropping or
                 lagging, not merely slow.

   READ THE RESULT CORRECTLY. A desktop core is much faster than the shared
   half-CPU of a Render starter instance, so the derived room count is an
   UPPER BOUND. The report applies an explicit discount and says so. It also
   refuses to run on a loaded machine, because a CPU measurement taken while
   something else is compiling is not a measurement.

     node e2e/_loadtest.mjs                 # ramp 5,10,25,50 rooms
     ROOMS=25 SECONDS=30 node e2e/_loadtest.mjs
*/
import { spawn, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
/* socket.io-client is already the SERVER's devDependency (server/test uses
   it). Resolving it from there keeps this harness's install untouched and
   pins the client to the exact version the server is tested against. */
const { io } = createRequire(new URL("../server/package.json", import.meta.url))("socket.io-client");

const PORT = Number(process.env.PORT || 3488);
const APP = `http://localhost:${PORT}`;
const SERVER_DIR = fileURLToPath(new URL("../server", import.meta.url));
const SECONDS = Number(process.env.SECONDS || 20);
const RAMP = process.env.ROOMS
  ? [Number(process.env.ROOMS)]
  : (process.env.RAMP || "5,10,25,50").split(",").map(Number);
/* The client's own cadence, so the traffic is the traffic. */
const GUESS_SEND_MS = 240;
const PER_ROOM = 6;
const WORDS = ["star jump", "zombie", "saluting", "punching", "hula hoop",
  "flossing", "moonwalking", "dribbling", "binoculars", "swinging a bat"];

const sleep = ms => new Promise(r => setTimeout(r, ms));
const pct = (a, p) => a.length ? a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))] : 0;

/* ---- a loaded machine cannot be measured ---- */
const load1 = Number(execSync("sysctl -n vm.loadavg").toString().split(/[{}\s]+/)[1]);
const cores = Number(execSync("sysctl -n hw.ncpu").toString().trim());
if (load1 > cores * 0.5) {
  console.error(`Load average is ${load1.toFixed(1)} on ${cores} cores. A CPU measurement`);
  console.error("taken now is noise. Close what is busy and re-run, or set FORCE=1.");
  if (!process.env.FORCE) process.exit(2);
}

const server = spawn("node", ["index.js"], {
  cwd: SERVER_DIR,
  env: { ...process.env, PORT: String(PORT),
    /* The buckets are per IP and every client here is localhost, so the
       defaults would refuse the second room and we would be timing errors. */
    RATE_CREATE: "100000", RATE_JOIN: "100000",
    PRECOUNT_MS: "300", FRAME_CHECK_MS: "100", TUTORIAL_GRACE_MS: "500",
    BETWEEN_ROUNDS_MS: "400", NODE_ENV: "production" },
  stdio: ["ignore", "pipe", "pipe"],
});
server.stderr.on("data", d => process.env.VERBOSE && console.error("srv:", String(d).trim()));
await new Promise((res, rej) => {
  server.stdout.on("data", d => String(d).includes("server running") && res());
  setTimeout(() => rej(new Error("server did not start")), 8000);
});

/* Cumulative CPU seconds of the server process, from the OS. */
const cpuSeconds = () => {
  const out = execSync(`ps -o time= -p ${server.pid}`).toString().trim();
  const p = out.split(/[:.]/).map(Number);           // [[hh:]mm:ss[.cc]]
  const [h, m, s, cs] = p.length === 4 ? p : [0, p[0], p[1], p[2] || 0];
  return h * 3600 + m * 60 + s + (cs || 0) / 100;
};

const connect = () => new Promise((res, rej) => {
  const s = io(APP, { transports: ["websocket"], forceNew: true, timeout: 15000 });
  s.on("connect", () => res(s));
  s.on("connect_error", rej);
});

const call = (s, ev, payload) => new Promise(res => s.emit(ev, payload, res));

async function openRoom(i, sockets, rounds) {
  const host = await connect();
  sockets.push(host);
  const made = await call(host, "party:create", {
    name: `H${i}`, labels: WORDS,
    settings: { matchSecs: 600, wordSecs: 60 },
  });
  if (made?.error) throw new Error("create: " + made.error);
  const room = [host];
  for (let j = 1; j < PER_ROOM; j++) {
    const s = await connect();
    sockets.push(s);
    const j2 = await call(s, "party:join", { code: made.code, name: `P${i}_${j}`, labels: WORDS });
    if (j2?.error) throw new Error("join: " + j2.error);
    room.push(s);
  }
  /* Every socket tracks the live roundId; a guess with a stale one is
     refused, which would measure the reject path instead of the real one. */
  for (const s of room) {
    s.on("party:round", ({ roundId, word }) => { s._round = roundId; s._word = word; });
    s.on("party:guess", () => { rounds.delivered++; });
  }
  /* WATCH=0 leaves these clients looking like a build cached from before
     party:watch existed, which is the path the server still has to serve.
     WATCH=1 (the default) is what a current client does: each one names the
     single rival whose read it displays, so the relay writes six messages a
     tick instead of thirty. Run both to see the difference in delivered/s. */
  if (process.env.WATCH !== "0")
    for (let k = 0; k < room.length; k++)
      await call(room[k], "party:watch", { id: room[(k + 1) % room.length].id });
  const started = await call(host, "party:start", {});
  if (started?.error) throw new Error("start: " + started.error);
  return room;
}

async function run(nRooms) {
  const sockets = [], rooms = [], counters = { delivered: 0, sent: 0 };
  for (let i = 0; i < nRooms; i++) rooms.push(await openRoom(i, sockets, counters));
  /* tutorial grace + frame check + 3.2.1, then the first word is dealt */
  await sleep(2500);
  const live = rooms.flat().filter(s => s._round);
  if (!live.length) { console.log(`  ${nRooms} rooms: no round was dealt, skipping`); }

  const acks = [];
  const cpu0 = cpuSeconds(), t0 = Date.now();
  counters.delivered = 0;

  const tickers = rooms.flat().map(s => setInterval(() => {
    if (!s._round) return;
    counters.sent++;
    s.emit("party:guess", { roundId: s._round, label: s._word, confidence: 0.8 });
  }, GUESS_SEND_MS));
  /* One probe socket measures what a player feels: an acked call, timed. */
  const probe = rooms[0][0];
  const pinger = setInterval(async () => {
    const at = Date.now();
    await call(probe, "party:name", { name: "probe" });
    acks.push(Date.now() - at);
  }, 250);

  await sleep(SECONDS * 1000);
  for (const t of tickers) clearInterval(t);
  clearInterval(pinger);
  const wall = (Date.now() - t0) / 1000, cpu = cpuSeconds() - cpu0;

  for (const s of sockets) s.close();
  await sleep(700);
  return { nRooms, wall, cpu, acks, ...counters,
    cpuPerRoomSec: cpu / wall / nRooms };
}

console.log(`Party load: ${PER_ROOM} players a room, a guess every ${GUESS_SEND_MS}ms each, ` +
  `${SECONDS}s per step.\nMachine: ${cores} cores, load ${load1.toFixed(2)}.\n`);
console.log("rooms  players   cpu%   cpu/room/s   ack p50   ack p95   ack max   delivered/s   sent/s");
const results = [];
for (const n of RAMP) {
  try {
    const r = await run(n);
    results.push(r);
    console.log(
      `${String(r.nRooms).padStart(5)} ${String(r.nRooms * PER_ROOM).padStart(8)} ` +
      `${(100 * r.cpu / r.wall).toFixed(0).padStart(6)} ${(r.cpuPerRoomSec * 1000).toFixed(1).padStart(11)}ms ` +
      `${String(pct(r.acks, .5)).padStart(8)}ms ${String(pct(r.acks, .95)).padStart(8)}ms ` +
      `${String(Math.max(0, ...r.acks)).padStart(8)}ms ` +
      `${(r.delivered / r.wall).toFixed(0).padStart(12)} ${(r.sent / r.wall).toFixed(0).padStart(8)}`);
  } catch (e) { console.log(`${String(n).padStart(5)}  FAILED: ${e.message}`); break; }
}

/* ---- what it means on the box this actually runs on ---- */
const best = results[results.length - 1];
if (best) {
  const perRoom = Math.min(...results.map(r => r.cpuPerRoomSec));
  const RENDER_CPU = 0.5;
  const raw = RENDER_CPU / perRoom;
  console.log(`\nCost per room: ${(perRoom * 1000).toFixed(1)}ms of CPU per wall second.`);
  console.log(`A Render starter instance is ${RENDER_CPU} CPU and ONE instance (rooms are a Map`);
  console.log(`in server/rooms.js, so it cannot scale out).`);
  console.log(`\n  ceiling at 100% CPU, this machine's core speed : ${raw.toFixed(0)} rooms (${(raw * PER_ROOM).toFixed(0)} players)`);
  console.log(`  at 60% CPU, leaving headroom for bursts         : ${(raw * .6).toFixed(0)} rooms (${(raw * .6 * PER_ROOM).toFixed(0)} players)`);
  console.log(`  and a Render vCPU at ~1/2.5 this core's speed   : ${(raw * .6 / 2.5).toFixed(0)} rooms (${(raw * .6 / 2.5 * PER_ROOM).toFixed(0)} players)`);
  console.log(`\nThe last line is the one to plan with. It is still an extrapolation from a`);
  console.log(`cost measured here, not a measurement taken on Render.`);
}

server.kill("SIGTERM");
await sleep(400);
server.kill("SIGKILL");
process.exit(0);
