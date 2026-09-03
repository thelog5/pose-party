/* Pose Charades online 1v1 server.

   Express serves the game itself (so localhost:PORT is the whole app) and
   Socket.IO carries signaling + authoritative game events. Video travels
   peer-to-peer over WebRTC and never touches this process; neither do
   landmarks or training data. During a match, only the already-computed
   top guess label and confidence are relayed so the rival paper can update. */

import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import http from "http";
import express from "express";
import helmet from "helmet";
import { Server } from "socket.io";

import { config } from "./config.js";
import { createRoomStore } from "./rooms.js";
import { createLimiter } from "./ratelimit.js";
import { cleanName, cleanLabels, cleanCode, cleanSettings, isPlainObject, signalOk } from "./validate.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GAME_DIR = path.join(__dirname, "..", "pose-charades-external-data");

const app = express();

/* Behind Render/Railway/Fly this makes `req.ip` the real client rather than
   the platform proxy. Off by default: an untrusted `X-Forwarded-For` is a
   free supply of rate-limit keys. See config.trustProxy. */
if(config.trustProxy) app.set("trust proxy", 1);

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      /* MediaPipe: module from jsdelivr, wasm compilation, models from
         Google storage, workers from blobs. */
      scriptSrc: ["'self'", "https://cdn.jsdelivr.net", "'wasm-unsafe-eval'"],
      connectSrc: ["'self'", "ws:", "wss:", "https://cdn.jsdelivr.net", "https://storage.googleapis.com"],
      workerSrc: ["'self'", "blob:"],
      /* Markup uses inline style attributes; fonts come from Google. */
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "blob:"],
      mediaSrc: ["'self'", "blob:", "mediastream:"],
      frameAncestors: ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false, // CDN resources carry no CORP headers
}));

/* Support log: note page loads so LAN reachability problems are visible. */
app.use((req, res, next) => {
  if(req.path === "/" || req.path === "/index.html")
    console.log(new Date().toISOString().slice(11,19), `page load from ${req.ip}`);
  next();
});

/* Liveness for the platform's health check, and a cheap way to see from
   outside whether this is a game server at all — the client's own
   `servedWithoutServer()` probe answers the same question from /socket.io/. */
app.get("/healthz", (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({ ok: true, rooms: store._rooms.size, uptimeSec: Math.round(process.uptime()) });
});

/* CACHE THE ART HARD, NEVER THE CODE. `assets/` is ~30 MB across 275 files
   and barely changes; served with the Express default (`max-age=0`) every
   one of them revalidates on every visit. Markup, JS and CSS are NOT
   content-hashed here, so caching those the same way would strand players on
   a stale build after a deploy. They keep must-revalidate instead, which is
   a few KB of conditional requests. */
app.use(express.static(GAME_DIR, {
  index: "index.html",
  setHeaders: (res, filePath) => {
    const rel = path.relative(GAME_DIR, filePath);
    const isArt = rel.split(path.sep)[0] === "assets";
    res.set("Cache-Control", isArt
      ? `public, max-age=${config.staticMaxAge}`
      : "no-cache");
  },
}));

const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: { origin: config.corsOrigins, methods: ["GET", "POST"] },
  maxHttpBufferSize: 64 * 1024, // largest legal payload is an SDP blob
});

const store = createRoomStore({
  config,
  emit: (socketId, event, payload) => io.to(socketId).emit(event, payload),
});

/* Rate limits (spec: room-creation, join and point-claim). */
const createLimit = createLimiter({ tokens: config.rateCreate, perMs: 60000 });   // per IP
const joinLimit   = createLimiter({ tokens: config.rateJoin,   perMs: 60000 });   // per IP
const claimLimit  = createLimiter({ tokens: 30,  perMs: 60000 });   // per socket
const signalLimit = createLimiter({ tokens: 200, perMs: 60000 });   // per socket
const guessLimit  = createLimiter({ tokens: 360, perMs: 60000 });   // per socket
/* A six-player mesh is five links per client, and each reports at most one
   success and one failure. 60 is far above that and far below a flood. */
const netLimit    = createLimiter({ tokens: 60,  perMs: 60000 });   // per socket

setInterval(() => {
  store.sweep();
  createLimit.sweep(); joinLimit.sweep(); claimLimit.sweep();
  signalLimit.sweep(); guessLimit.sweep(); netLimit.sweep();
}, 60000).unref();

/* Support log: connection + room events only — never landmarks or video
   (none are ever sent), and no full payload dumps. */
const log = (...a) => console.log(new Date().toISOString().slice(11,19), ...a);

io.engine.on("connection_error", err => {
  log(`handshake FAILED from ${err.req?.socket?.remoteAddress || "?"}: ${err.message} (code ${err.code})`);
});

/* THE RATE BUCKETS ARE KEYED BY THIS, so it has to be the player and not the
   platform proxy in front of them. `X-Forwarded-For` is client-writable, so
   it is only read when the operator has said there IS a proxy. */
function clientIp(socket){
  if(config.trustProxy){
    const fwd = socket.handshake.headers["x-forwarded-for"];
    if(typeof fwd === "string"){
      const first = fwd.split(",")[0].trim();
      if(first) return first;
    }
  }
  return socket.handshake.address || "unknown";
}

const TYPES = new Set(["host", "srflx", "prflx", "relay"]);

io.on("connection", socket => {
  const ip = clientIp(socket);
  const ack = cb => (typeof cb === "function" ? cb : () => {});
  log(`connect ${socket.id.slice(0,6)} from ${ip} (origin: ${socket.handshake.headers.origin || "?"})`);

  socket.on("room:create", (payload, cb) => {
    cb = ack(cb);
    if(!createLimit.allow(ip)) return cb({ error: "rate-limited" });
    if(!isPlainObject(payload)) return cb({ error: "bad-payload" });
    const name = cleanName(payload.name);
    const labels = cleanLabels(payload.labels);
    const settings = cleanSettings(payload.settings);
    if(!name || !labels || settings === null) return cb({ error: "bad-payload" });
    const res = store.createRoom(socket.id, name, labels, settings);
    log(`create by "${name}" -> ${res.code || "ERROR " + res.error}`);
    cb(res);
  });

  socket.on("room:join", (payload, cb) => {
    cb = ack(cb);
    if(!joinLimit.allow(ip)) return cb({ error: "rate-limited" });
    if(!isPlainObject(payload)) return cb({ error: "bad-payload" });
    const code = cleanCode(payload.code);
    const name = cleanName(payload.name);
    const labels = cleanLabels(payload.labels);
    if(!code || !name || !labels){
      log(`join rejected: bad payload (code=${JSON.stringify(payload.code)})`);
      return cb({ error: "bad-payload" });
    }
    const res = store.joinRoom(socket.id, code, name, labels);
    log(`join ${code} by "${name}" -> ${res.error ? "ERROR " + res.error : "ok, peer " + res.peerName}`);
    cb(res);
  });

  socket.on("player:ready", (payload, cb) => {
    cb = ack(cb);
    cb(store.ready(socket.id));
  });

  socket.on("room:settings", (payload, cb) => {
    cb = ack(cb);
    if(!claimLimit.allow(socket.id)) return cb({ error: "rate-limited" });
    if(!isPlainObject(payload)) return cb({ error: "bad-payload" });
    const settings = cleanSettings(payload.settings);
    if(settings === null || !Object.keys(settings).length) return cb({ error: "bad-payload" });
    cb(store.setSettings(socket.id, settings));
  });

  socket.on("match:begin", (payload, cb) => {
    cb = ack(cb);
    if(!claimLimit.allow(socket.id)) return cb({ error: "rate-limited" });
    const res = store.begin(socket.id);
    log(`begin by ${socket.id.slice(0,6)} -> ${res.error ? "ERROR " + res.error : "ok"}`);
    cb(res);
  });

  socket.on("match:tutorial-ready", (payload, cb) => {
    cb = ack(cb);
    if(!claimLimit.allow(socket.id)) return cb({ error: "rate-limited" });
    if(!isPlainObject(payload) || typeof payload.tutorialId !== "string")
      return cb({ error: "bad-payload" });
    cb(store.matchTutorialReady(socket.id, payload.tutorialId));
  });

  socket.on("match:rematch", (payload, cb) => {
    cb = ack(cb);
    if(!claimLimit.allow(socket.id)) return cb({ error: "rate-limited" });
    const res = store.matchRematch(socket.id);
    if(res.started) log(`1v1 rematch started by ${socket.id.slice(0,6)}`);
    cb(res);
  });

  socket.on("round:claim", (payload, cb) => {
    cb = ack(cb);
    if(!claimLimit.allow(socket.id)) return cb({ error: "rate-limited" });
    if(!isPlainObject(payload)) return cb({ error: "bad-payload" });
    cb(store.claim(socket.id, payload.roundId, payload.recognizedAt));
  });

  socket.on("round:guess", (payload, cb) => {
    cb = ack(cb);
    if(!guessLimit.allow(socket.id)) return cb({ error: "rate-limited" });
    if(!isPlainObject(payload)) return cb({ error: "bad-payload" });
    cb(store.relayGuess(socket.id,payload.roundId,payload.label,payload.confidence));
  });

  /* ---- party rooms ---- */
  socket.on("party:create", (payload, cb) => {
    cb = ack(cb);
    if(!createLimit.allow(ip)) return cb({ error: "rate-limited" });
    if(!isPlainObject(payload)) return cb({ error: "bad-payload" });
    const name = cleanName(payload.name);
    const settings = cleanSettings(payload.settings);
    const labels = cleanLabels(payload.labels);
    if(!name || settings === null || !labels) return cb({ error: "bad-payload" });
    const res = store.partyCreate(socket.id, name, settings, labels);
    log(`party create by "${name}" -> ${res.code || "ERROR " + res.error}`);
    cb(res);
  });
  socket.on("party:join", (payload, cb) => {
    cb = ack(cb);
    if(!joinLimit.allow(ip)) return cb({ error: "rate-limited" });
    if(!isPlainObject(payload)) return cb({ error: "bad-payload" });
    const code = cleanCode(payload.code);
    const name = cleanName(payload.name);
    const labels = cleanLabels(payload.labels);
    if(!code || !name || !labels) return cb({ error: "bad-payload" });
    const res = store.partyJoin(socket.id, code, name, labels);
    log(`party join ${code} by "${name}" -> ${res.error ? "ERROR " + res.error : "ok (" + res.roster.players.length + " players)"}`);
    cb(res);
  });
  socket.on("party:team", (payload, cb) => {
    cb = ack(cb);
    if(!claimLimit.allow(socket.id)) return cb({ error: "rate-limited" });
    if(!isPlainObject(payload)) return cb({ error: "bad-payload" });
    cb(store.partyTeam(socket.id, payload.team));
  });
  socket.on("party:name", (payload, cb) => {
    cb = ack(cb);
    if(!claimLimit.allow(socket.id)) return cb({ error: "rate-limited" });
    if(!isPlainObject(payload)) return cb({ error: "bad-payload" });
    const name = cleanName(payload.name);
    if(!name) return cb({ error: "bad-payload" });
    cb(store.partyName(socket.id, name));
  });
  socket.on("party:settings", (payload, cb) => {
    cb = ack(cb);
    if(!claimLimit.allow(socket.id)) return cb({ error: "rate-limited" });
    if(!isPlainObject(payload)) return cb({ error: "bad-payload" });
    const settings = cleanSettings(payload.settings);
    if(settings === null || !Object.keys(settings).length) return cb({ error: "bad-payload" });
    cb(store.partySettings(socket.id, settings));
  });
  socket.on("party:start", (payload, cb) => {
    cb = ack(cb);
    if(!claimLimit.allow(socket.id)) return cb({ error: "rate-limited" });
    const res = store.partyStart(socket.id);
    log(`party start by ${socket.id.slice(0,6)} -> ${res.error ? "ERROR " + res.error : "ok"}`);
    cb(res);
  });
  socket.on("party:tutorial-ready", (payload, cb) => {
    cb = ack(cb);
    if(!claimLimit.allow(socket.id)) return cb({ error: "rate-limited" });
    if(!isPlainObject(payload) || typeof payload.tutorialId !== "string")
      return cb({ error: "bad-payload" });
    cb(store.partyTutorialReady(socket.id, payload.tutorialId));
  });
  socket.on("party:signal", (payload, cb) => {
    cb = ack(cb);
    if(!signalLimit.allow(socket.id)) return cb({ error: "rate-limited" });
    if(!isPlainObject(payload) || typeof payload.to !== "string" || !signalOk(payload.data))
      return cb({ error: "bad-payload" });
    cb(store.partySignal(socket.id, payload.to, payload.data));
  });
  socket.on("party:guess", (payload, cb) => {
    cb = ack(cb);
    if(!guessLimit.allow(socket.id)) return cb({ error: "rate-limited" });
    if(!isPlainObject(payload)) return cb({ error: "bad-payload" });
    cb(store.relayPartyGuess(socket.id, payload.roundId, payload.label, payload.confidence));
  });
  socket.on("party:rematch", (payload, cb) => {
    cb = ack(cb);
    if(!claimLimit.allow(socket.id)) return cb({ error: "rate-limited" });
    const res = store.partyRematch(socket.id);
    if(res.started) log(`party rematch started by ${socket.id.slice(0,6)}`);
    cb(res);
  });
  socket.on("party:claim", (payload, cb) => {
    cb = ack(cb);
    if(!claimLimit.allow(socket.id)) return cb({ error: "rate-limited" });
    if(!isPlainObject(payload)) return cb({ error: "bad-payload" });
    cb(store.partyClaim(socket.id, payload.roundId, payload.recognizedAt));
  });

  socket.on("rtc:signal", (payload, cb) => {
    cb = ack(cb);
    if(!signalLimit.allow(socket.id)) return cb({ error: "rate-limited" });
    if(!isPlainObject(payload) || !signalOk(payload.data)) return cb({ error: "bad-payload" });
    cb(store.relaySignal(socket.id, payload.data));
  });

  /* Clock sync: client measures RTT around this ack. */
  socket.on("time:sync", (payload, cb) => ack(cb)({ serverNow: Date.now() }));

  /* HOW MANY LINKS ACTUALLY CONNECT. No TURN server is configured, so every
     `failed` here is a pair that STUN could not hole-punch and that a relay
     would have rescued. Counting these against the successes is the only
     honest way to decide whether TURN is worth buying, instead of applying
     an industry average to a player base nobody has measured.
     This records a route, not a person: candidate TYPES only, never an
     address, and nothing whatever about the media. */
  socket.on("net:report", payload => {
    if(!netLimit.allow(socket.id)) return;
    if(!isPlainObject(payload)) return;
    const mode = payload.mode === "party" ? "party" : "1v1";
    const result = payload.result === "failed" ? "failed" : "connected";
    const type = v => (TYPES.has(v) ? v : "?");
    const pair = result === "connected"
      ? `${type(payload.local)}/${type(payload.remote)}` : "none";
    const ms = Number.isFinite(+payload.ms) ? Math.round(+payload.ms) : -1;
    log(`net ${mode} ${result} ${pair} ${ms}ms`);
  });

  socket.on("room:leave", (payload, cb) => { store.leave(socket.id); ack(cb)({ ok: true }); });
  socket.on("disconnect", reason => {
    log(`disconnect ${socket.id.slice(0,6)} (${reason})`);
    store.leave(socket.id);
  });
});

/* THE TWO SETTINGS THAT ARE SILENTLY WRONG IN PRODUCTION. Neither breaks a
   local run, and neither announces itself when it breaks a deployed one:
   an untrusted proxy collapses every player onto one rate-limit key, and a
   localhost CORS list only bites the cross-origin case. Say so at boot. */
function warnIfMisconfigured(){
  if(process.env.NODE_ENV !== "production") return;
  if(!config.trustProxy)
    console.warn("WARNING: TRUST_PROXY is off. Behind a platform proxy every player shares one rate-limit bucket.");
  if(config.corsOrigins.every(o => /localhost|127\.0\.0\.1/.test(o)))
    console.warn("WARNING: CORS_ORIGINS still only lists localhost. Set it to your real origin.");
}

httpServer.listen(config.port, () => {
  warnIfMisconfigured();
  console.log(`Pose Charades server running.`);
  console.log(`  On this computer:   http://localhost:${config.port}`);
  for(const addrs of Object.values(os.networkInterfaces()))
    for(const a of addrs || [])
      if(a.family === "IPv4" && !a.internal)
        console.log(`  On other computers: http://${a.address}:${config.port}`);
});
