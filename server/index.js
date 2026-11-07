/* Pose Party game server: online 1v1 and Party rooms.

   Express serves the game itself (so localhost:PORT is the whole app) and
   Socket.IO carries signaling + authoritative game events. Video travels
   peer-to-peer over WebRTC and never touches this process; neither do
   landmarks or training data. During a match, only the already-computed
   top guess label and confidence are relayed so the rival paper can update. */

import fs from "fs";
import net from "net";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import http from "http";
import crypto from "crypto";
import express from "express";
import helmet from "helmet";
import compression from "compression";
import { Server } from "socket.io";
import proxyaddr from "proxy-addr";

import { config } from "./config.js";
import { createRoomStore } from "./rooms.js";
import { createLimiter } from "./ratelimit.js";
import { cleanName, cleanLabels, cleanSeen, cleanCode, cleanSettings, isPlainObject, signalOk } from "./validate.js";
import { COOKIE, makeTicket, ticketValid, readCookie, codeMatches } from "./accessgate.js";
import { gatePage } from "./gatepage.js";
import { createWordStats, statsPage } from "./wordstats.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GAME_DIR = path.join(__dirname, "..", "client");

const app = express();

/* Behind Render/Railway/Fly this makes `req.ip` the real client rather than
   the platform proxy. Off by default: an untrusted `X-Forwarded-For` is a
   free supply of rate-limit keys. See config.trustProxy. */
if(config.trustProxy) app.set("trust proxy", config.trustProxy === "cloudflare" ? 1 : config.trustProxy);

/* TRUST_PROXY=cloudflare: the visitor is Cloudflare's CF-Connecting-IP (see
   config.trustProxy). `req.ip` is redefined on the request so every limiter
   and log line below keys on the real visitor with no change of its own.
   A request without the header keeps the one-hop answer, and says so once. */
const cfIp = h => { const v = String(h || "").trim(); return net.isIP(v) ? v : null; };
let cfMissingLogged = false;
if(config.trustProxy === "cloudflare")
  app.use((req, res, next) => {
    const ip = cfIp(req.headers["cf-connecting-ip"]);
    if(ip) Object.defineProperty(req, "ip", { value: ip, configurable: true });
    else if(!cfMissingLogged){ cfMissingLogged = true; console.warn("TRUST_PROXY=cloudflare but a request had no CF-Connecting-IP; using the one-hop address."); }
    next();
  });

/* THE SOCKET'S OWN ORIGIN, FOR connect-src. `'self'` covers same-origin
   WebSockets in current browsers, but it did not always, and this game is
   played on phones. Naming the host explicitly works everywhere without the
   bare `ws:` / `wss:` this replaces — those matched EVERY host, which handed
   any injected script a clean exfiltration channel and made the rest of the
   policy much less worth having.
   The Host header is client-supplied, so it is filtered to the characters a
   hostname can contain: a header value is only ever used in the response to
   the request it came from, but a stray `;` would still let a caller rewrite
   their own policy. */
const selfSocket = scheme => (req) => {
  const host = String(req.headers.host || "").match(/^[A-Za-z0-9.\-]+(:\d{1,5})?$/)?.[0];
  return host ? `${scheme}://${host}` : "'self'";
};

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      /* MediaPipe: module from jsdelivr, wasm compilation, models from
         Google storage, workers from blobs. */
      scriptSrc: ["'self'", "https://cdn.jsdelivr.net", "'wasm-unsafe-eval'"],
      connectSrc: ["'self'", selfSocket("ws"), selfSocket("wss"),
                   "https://cdn.jsdelivr.net", "https://storage.googleapis.com"],
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
  /* DENY, not the SAMEORIGIN default, so the old header agrees with
     `frame-ancestors 'none'` above. Nothing here is ever meant to be framed,
     including by us: a camera game inside an iframe is the shape of a
     clickjacking attack on a permission prompt. */
  frameguard: { action: "deny" },
}));

/* WHAT THIS PAGE MAY ASK THE DEVICE FOR. The camera is the whole game, so it
   keeps it; everything else a browser would otherwise let this origin (or
   anything it embeds) request is turned off. `microphone=()` is the one that
   matters most: the privacy policy says this game records no audio, and
   `getUserMedia` is called with `audio:false` — this makes that a property the
   browser enforces rather than a promise in a document. */
app.use((req, res, next) => {
  res.set("Permissions-Policy",
    "camera=(self), microphone=(), geolocation=(), payment=(), usb=(), " +
    "magnetometer=(), gyroscope=(), accelerometer=(), display-capture=()");
  next();
});

/* GZIP THE TEXT. The pose deck alone is 8.3 MB of JSON and gzips to about
   1.8 MB, and it is the one download a first visit waits on. The markup, JS
   and CSS compress the same way. WebP art is already compressed, and the
   filter skips image types. Socket.IO attaches to the http server, not to
   this app, so it is not affected. */
app.use(compression());

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
  /* Liveness only. The live room count used to be here, which told anybody
     who asked how busy a private beta is; the owner reads it from /stats,
     which has a password. */
  res.json({ ok: true, uptimeSec: Math.round(process.uptime()) });
});

/* THE PRIVACY POLICY AND TERMS OF USE ARE PUBLIC. A player must be able to
   read them BEFORE typing the access code, and the code page links to them.
   Both pages are self-contained (inline CSS), so nothing else opens up. */
for(const name of ["privacy", "terms"]){
  app.get([`/${name}`, `/${name}.html`], (req, res) => {
    res.set("Cache-Control", "no-cache");
    res.sendFile(path.join(GAME_DIR, `${name}.html`));
  });
}

/* WORD STATS (wordstats.js). On only with STATS_TOKEN: without a way to read
   them there is no reason to collect them. The totals page sits BEFORE the
   gate with its own password (HTTP Basic, any user name), so a script on the
   owner's computer can pull it without the players' access cookie. */
function deckLabels(){
  try{
    const deck = JSON.parse(fs.readFileSync(path.join(GAME_DIR, "assets/data/pose-charades-data.json"), "utf8"));
    return [...new Set(deck.clips.map(c => c.label))];
  }catch(e){
    console.warn("word stats: could not read the deck's words, so every report will be refused.", e.message);
    return [];
  }
}
const stats = config.statsToken ? createWordStats({ labels: deckLabels() }) : null;
/* THE PASSWORD BUCKETS CHARGE FOR FAILURES ONLY (peek/spend, not allow), so
   the window can be long without ever punishing the owner for getting it
   right. Ten wrong guesses per IP per quarter hour is a hard ceiling on
   guessing the stats password; a correct one costs nothing and never runs
   out. `/stats` and `/dev` share this bucket because they share the
   password. */
const statsAuthLimit = createLimiter({ tokens: 10, perMs: 15 * 60_000 });
/* A real player sends one report per word, so even a Party of six behind
   one home connection stays far under this. */
const reportLimit = createLimiter({ tokens: 40, perMs: 60_000 });
setInterval(() => { statsAuthLimit.sweep(); reportLimit.sweep(); }, 60_000).unref();

function basicPassword(header){
  const m = /^Basic\s+(.+)$/i.exec(header || "");
  if(!m) return "";
  const pair = Buffer.from(m[1], "base64").toString("utf8");
  const i = pair.indexOf(":");
  return i < 0 ? "" : pair.slice(i + 1);
}

if(stats){
  app.get("/stats", (req, res) => {
    res.set("Cache-Control", "no-store");
    if(!statsAuthLimit.peek(req.ip)) return res.status(429).type("text").send("Too many tries. Wait a quarter of an hour.");
    const pass = basicPassword(req.headers.authorization);
    if(!pass || !codeMatches(pass, config.statsToken)){
      statsAuthLimit.spend(req.ip);
      return res.status(401).set("WWW-Authenticate", 'Basic realm="Pose Party stats"')
        .type("text").send("The stats page needs the stats password.");
    }
    const snap = stats.snapshot({ online: { sockets: io.engine.clientsCount, rooms: store._rooms.size },
      relay: relayStatus() });
    if((req.headers.accept || "").includes("text/html")) return res.type("html").send(statsPage(snap));
    res.json(snap);
  });
  setInterval(() => log(stats.summaryLine()), 60 * 60 * 1000).unref();
}

/* THE OWNER'S TOOLS (the Training gear, sound buttons, DEV bar) are for the
   owner only. /dev asks for the stats password and hands that browser a
   signed, HttpOnly cookie; the client asks /dev/check on boot and shows the
   tools only on a 204 (main.js applyDevMode). On localhost the client uses
   its own flag instead, so local work and the E2E suites need no server.
   The Training screen only ever trains a copy in that browser's own tab; the
   game's model changes only when the deck file in the repo does. */
const DEV_COOKIE = "pp_dev";
const devSecret = config.statsToken ? "dev:" + config.statsToken : null;
const isOwner = req => !!devSecret && ticketValid(devSecret, readCookie(req.headers.cookie, DEV_COOKIE));
if(devSecret){
  app.get("/dev", (req, res) => {
    res.set("Cache-Control", "no-store");
    if(!statsAuthLimit.peek(req.ip)) return res.status(429).type("text").send("Too many tries. Wait a quarter of an hour.");
    const pass = basicPassword(req.headers.authorization);
    if(!pass || !codeMatches(pass, config.statsToken)){
      statsAuthLimit.spend(req.ip);
      return res.status(401).set("WWW-Authenticate", 'Basic realm="Pose Party owner"')
        .type("text").send("Owner tools need the stats password.");
    }
    res.cookie(DEV_COOKIE, makeTicket(devSecret, 30 * 24 * 60 * 60), {
      httpOnly: true, sameSite: "strict", maxAge: 30 * 24 * 60 * 60 * 1000, secure: req.secure });
    log(`dev: owner tools turned on from ${req.ip}`);
    res.redirect(303, "/");
  });
  app.get("/dev/off", (req, res) => {
    res.clearCookie(DEV_COOKIE, { httpOnly: true, sameSite: "strict", secure: req.secure });
    res.redirect(303, "/");
  });
}
app.get("/dev/check", (req, res) => {
  res.set("Cache-Control", "no-store");
  res.status(isOwner(req) ? 204 : 404).end();
});

/* A word report must come from a page of this site. Browsers always send
   Origin on a POST, so this refuses anything typed at the endpoint from
   elsewhere; with the rate limit and the deck check, the worst a determined
   script can do is add a few numbers to a page only the owner can read. */
function fromThisSite(req){
  const o = req.headers.origin;
  if(!o) return false;
  return originAllowed(o, req.headers.host);
}

/* The same question with the "no Origin at all" case left to the caller,
   because the two callers want opposite answers to it. A browser ALWAYS
   sends Origin on a POST and on a WebSocket handshake, so a missing one means
   a script rather than a page — which is a reason to refuse a word report and
   not a reason to refuse a socket (`scripts/`, the test suites and any native
   client have no origin, and the access gate is what authenticates them). */
function originAllowed(origin, host){
  try{
    const o = new URL(origin).host;
    return o === host || config.corsOrigins.some(c => { try{ return new URL(c).host === o; }catch{ return false; } });
  }catch{ return false; }
}

/* THE PRIVATE-BETA LOCK -----------------------------------------------------
   Sits AFTER /healthz, because the platform's health check must never need a
   password, and BEFORE express.static, because everything it protects is
   underneath that. Unset ACCESS_CODE leaves the game wide open exactly as it
   shipped, which is what local dev and every test suite expect. */
const gateOn = !!config.accessCode;
/* NEVER `config.accessCode`. See config.gateSecret: a cookie signed with the
   code lets anyone holding a cookie guess the code offline. */
const gateSecret = config.gateSecret;
if(gateOn && !config.accessSecret){
  console.warn("WARNING: ACCESS_CODE is set but ACCESS_SECRET is not. A random signing key is used, so every player types the code again after a restart.");
}
/* A shared code is guessable at speed, so attempts are capped per IP. The
   bucket is on the SUBMIT path only: rate-limiting page views would lock out
   somebody who simply reloaded. It charges for WRONG codes only, which is why
   the window can be a quarter of an hour rather than a minute — a party of
   six behind one NAT all typing the right code spends nothing, while a
   guesser gets ten tries and then waits. */
const gateLimit = createLimiter({ tokens: 10, perMs: 15 * 60_000 });
setInterval(() => gateLimit.sweep(), 60_000).unref();

function gateOk(req){
  return !gateOn || ticketValid(gateSecret, readCookie(req.headers.cookie, COOKIE));
}

if(gateOn){
  app.use(express.urlencoded({ extended: false, limit: "1kb" }));

  app.post("/__gate", (req, res) => {
    /* LOGIN CSRF. The cookie is SameSite=Lax, so a cross-site form POST does
       not carry one — but it can still MINT one, which would silently put a
       visitor into the beta under somebody else's code. A browser always
       sends Origin on a form POST; a request with none is a script, which can
       set its own cookies anyway and gains nothing here. */
    if(req.headers.origin && !fromThisSite(req))
      return res.status(403).type("text").send("Bad request.");
    if(!gateLimit.peek(req.ip)){
      log(`gate: too many attempts from ${req.ip}`);
      return res.status(429).type("html")
        .send(gatePage({ error: "Too many tries. Wait a quarter of an hour." }));
    }
    if(!codeMatches(String(req.body?.code || "").trim(), config.accessCode)){
      gateLimit.spend(req.ip);
      log(`gate: wrong code from ${req.ip}`);
      return res.status(401).type("html")
        .send(gatePage({ error: "That code is not right." }));
    }
    /* `secure` follows the request that set it. An always-on flag would make
       the cookie undeliverable over plain http, which is how this runs on a
       LAN and in the test suites. Tying it to TRUST_PROXY left it OFF behind
       a tunnel that does serve https. With trust proxy on, `req.secure`
       reads the proxy's X-Forwarded-Proto. */
    res.cookie(COOKIE, makeTicket(gateSecret, config.accessTtlSec), {
      httpOnly: true, sameSite: "lax", maxAge: config.accessTtlSec * 1000,
      secure: req.secure,
    });
    log(`gate: admitted ${req.ip}`);
    res.redirect(303, "/");
  });

  app.use((req, res, next) => {
    if(gateOk(req)) return next();
    res.status(401).type("html").set("Cache-Control", "no-store").send(gatePage());
  });
}

/* A word report. AFTER the gate, so only a player who got in can send one.
   Nothing about the sender is kept; the IP is only a rate-limit key. */
if(stats){
  app.post("/stats/word", express.json({ limit: "1kb" }), (req, res) => {
    if(!fromThisSite(req)) return res.status(403).end();
    if(!reportLimit.allow(req.ip)) return res.status(429).end();
    res.status(stats.record(req.body).ok ? 204 : 400).end();
  });
}

/* CACHE THE ART HARD, NEVER THE CODE. `assets/` is ~30 MB across 275 files
   and barely changes; served with the Express default (`max-age=0`) every
   one of them revalidates on every visit. Markup, JS and CSS are NOT
   content-hashed here, so caching those the same way would strand players on
   a stale build after a deploy. They keep must-revalidate instead, which is
   a few KB of conditional requests.
   `assets/data/` (the pose deck) is NOT art: it changes whenever the deck
   does, and a CDN in front (Cloudflare) would otherwise keep the old deck
   at its edge for the whole max-age. no-cache still lets a browser or a CDN
   keep a copy; it only has to ask first, and an unchanged deck is a 304. */
/* The game folder also holds notes and the training script (README.md,
   train_model.py). The repo is private and the players need none of it. */
app.use((req, res, next) => /\.(md|py)$/i.test(req.path) ? res.status(404).end() : next());

/* THE DECK IS THE ONE EXPENSIVE THING THIS SERVER SERVES: 8.7 MB of JSON,
   1.8 MB gzipped, and it is deliberately `no-cache`, so a CDN in front has to
   revalidate and a request with no validator gets the whole body from here.
   A real client fetches it once per page load and thereafter gets a 304, so a
   household of six is nowhere near this; a script asking for it in a loop is
   the only thing that reaches it. A conditional request is cheap and is not
   counted, so nobody playing normally can trip it. */
/* THE EDGE MAY HOLD THE DECK BRIEFLY; THE BROWSER STILL REVALIDATES EVERY
   LOAD. `no-cache` kept a CDN out of the path entirely, so every first visit
   pulled the whole 1.57 MB from this process — fine for a household, and the
   first thing to give at a launch spike, which is by definition all first
   visits (450 of them is ~700 MB off the origin).

     max-age=0, must-revalidate   the browser behaves exactly as it did under
                                  `no-cache`: it asks every page load and gets
                                  a 304. Nothing about a returning player
                                  changes.
     s-maxage                     a SHARED cache may serve it for this long
                                  without asking. Each Cloudflare PoP then
                                  revalidates a few times an hour instead of
                                  every visitor reaching Render, and because
                                  the validator matches, those are 304s: the
                                  body crosses only when the deck changes.

   THE PRICE IS A STALENESS WINDOW, and the deck is exactly the file where
   that matters: a stale one means players running the previous MODEL. Five
   minutes is deliberately far below the hour a longer TTL would buy, because
   the benefit is nearly identical (a spike lasts hours; a 5-minute edge TTL
   still absorbs almost all of it) and a deck install is a thing somebody is
   watching. This is the same hazard as CHANGED ART NEEDS A NEW FILE NAME —
   there the answer is a new name because art is cached for 30 days; here the
   window is short enough to wait out.

   NEVER WITH THE BETA LOCK ON. The access gate sits ABOVE express.static, so
   everything under it is gated content; letting a shared cache hold the deck
   would serve it to anyone who asked, with no cookie. Gate on, `no-cache`. */
const deckCacheControl = () => gateOn
  ? "no-cache"
  : `public, max-age=0, must-revalidate, s-maxage=${config.deckEdgeMaxAge}`;

const deckLimit = createLimiter({ tokens: 30, perMs: 60_000 });
setInterval(() => deckLimit.sweep(), 60_000).unref();
app.use("/assets/data", (req, res, next) => {
  if(req.headers["if-none-match"] || req.headers["if-modified-since"]) return next();
  if(!deckLimit.allow(req.ip)) return res.status(429).type("text").send("Too many requests.");
  next();
});

app.use(express.static(GAME_DIR, {
  index: "index.html",
  setHeaders: (res, filePath) => {
    const rel = path.relative(GAME_DIR, filePath).split(path.sep);
    const isData = rel[0] === "assets" && rel[1] === "data";
    const isArt = rel[0] === "assets" && !isData;
    /* tells the client to send word reports (js/wordStats.js) */
    if(stats && isData) res.set("X-Word-Stats", "on");
    res.set("Cache-Control", isArt
      ? `public, max-age=${config.staticMaxAge}`
      : isData ? deckCacheControl()
      : "no-cache");
  },
}));

/* A PLAIN 404, NOT EXPRESS'S OWN. Nothing matched, so finalhandler would
   answer with its `<title>Error</title><pre>Cannot GET /whatever</pre>` page:
   it escapes the path, so it is not an injection, but it names the framework
   and echoes the request back, and neither tells a player anything. This
   catches only unmatched routes; thrown errors fall through to the handler
   below. */
app.use((req, res) => {
  res.status(404).set("Cache-Control", "no-store").type("text").send("Not found.");
});

/* NO STACK TRACES TO THE PUBLIC. Without this, Express's own handler answers
   a malformed request (bad JSON to /stats/word, say) with the error and this
   server's file paths whenever NODE_ENV is not "production". Status only. */
app.use((err, req, res, next) => {
  const status = Number.isInteger(err?.status) && err.status >= 400 && err.status < 600 ? err.status : 500;
  if(status >= 500) log(`error ${req.method} ${req.path}: ${err?.message || err}`);
  if(res.headersSent) return next(err);
  res.status(status).type("text").send(status === 413 ? "Too large." : status < 500 ? "Bad request." : "Something went wrong.");
});

const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: { origin: config.corsOrigins, methods: ["GET", "POST"] },
  /* THE `cors` OPTION ABOVE IS NOT A LOCK, AND THAT IS NOT A SOCKET.IO BUG.
     It writes Access-Control-Allow-Origin on the POLLING transport, which a
     browser then enforces — but a WebSocket handshake is exempt from CORS by
     design, so a page on any origin can open one and the allowlist never
     comes into it. Measured: with CORS_ORIGINS set to one host, a client
     presenting `Origin: https://evil.example` connected over websocket.
     This is the actual check. A browser always sends Origin on a handshake,
     so a cross-site page is refused here; a client with no Origin is a script
     rather than a page, and the access gate (io.use, below) is what decides
     whether it may play. */
  allowRequest: (req, done) => {
    const origin = req.headers.origin;
    if(!origin || originAllowed(origin, req.headers.host)) return done(null, true);
    log(`socket refused: origin ${origin}`);
    done("origin-not-allowed", false);
  },
  maxHttpBufferSize: 64 * 1024, // largest legal payload is an SDP blob
  /* THE RETURNING PLAYER KEEPS THEIR SOCKET ID. Every room, peer, seat, mesh
     entry and video element in this game is keyed by `socket.id`, so an
     ordinary socket.io reconnect — which issues a NEW id — is indistinguishable
     from a stranger arriving, and the player who blinked is gone for good.
     Connection-state recovery restores the id, the socket's rooms and the
     packets missed in between, which is the whole reason a rejoin can be a
     hiccup rather than a re-entry. `skipMiddlewares:false` keeps the access
     gate in front of a restored socket as well as a fresh one. */
  connectionStateRecovery: {
    maxDisconnectionDuration: config.rejoinGraceMs,
    skipMiddlewares: false,
  },
});

/* THE SAME LOCK ON THE SOCKET. Gating only the HTML would leave the whole
   game API reachable by anyone who skips the page and opens a socket
   directly, which is the entire thing worth protecting. */
if(gateOn)
  io.use((socket, next) => {
    if(ticketValid(gateSecret, readCookie(socket.handshake.headers.cookie, COOKIE)))
      return next();
    log(`gate: socket refused from ${clientIp(socket)}`);
    next(new Error("forbidden"));
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
const watchLimit  = createLimiter({ tokens: 240, perMs: 60000 });   // per socket

setInterval(() => {
  store.sweep();
  createLimit.sweep(); joinLimit.sweep(); claimLimit.sweep();
  signalLimit.sweep(); guessLimit.sweep(); netLimit.sweep(); watchLimit.sweep();
}, 60000).unref();

/* Support log: connection + room events only — never landmarks or video
   (none are ever sent), and no full payload dumps. */
const log = (...a) => console.log(new Date().toISOString().slice(11,19), ...a);

/* A GAME SERVER MUST NOT DIE OF ONE ODD PACKET. Node ends the process on an
   unhandled promise rejection, and socket handlers are per-message — some of
   them async now — so a single malformed payload reaching an uncaught throw
   would take down every match in progress, not just that request. Room state
   lives in memory, so that is not one dropped request, it is everybody.
   `uncaughtException` is deliberately NOT caught: a process in a genuinely
   unknown state should restart under the platform rather than keep scoring
   matches, and rooms are short-lived by design. */
process.on("unhandledRejection", err => {
  log(`unhandled rejection: ${err?.stack || err}`);
});

io.engine.on("connection_error", err => {
  log(`handshake FAILED from ${err.req?.socket?.remoteAddress || "?"}: ${err.message} (code ${err.code})`);
});

/* THE RATE BUCKETS ARE KEYED BY THIS, so it has to be the player and not the
   platform proxy in front of them. It is the SAME answer Express gives for
   `req.ip`, from the same trust setting. It used to take the FIRST entry of
   `X-Forwarded-For`, which is the one the CLIENT writes: a proxy appends the
   address it saw, it does not replace the header. So every socket could
   name its own rate-limit key, and the create and join limits did nothing.
   `socket.request` is the handshake's own http request. */
function clientIp(socket){
  if(config.trustProxy === "cloudflare"){
    const ip = cfIp(socket.handshake.headers["cf-connecting-ip"]);
    if(ip) return ip;
  }
  if(config.trustProxy)
    return proxyaddr(socket.request, app.get("trust proxy fn")) || "unknown";
  return socket.handshake.address || "unknown";
}

const TYPES = new Set(["host", "srflx", "prflx", "relay"]);

/* THE CLIENT NEVER HOLDS A LASTING TURN CREDENTIAL. With TURN_SECRET the
   username is an expiry stamp and the password is its HMAC, so what a
   browser receives is worthless after turnTtlSec and a leaked page source
   costs nothing. This is the TURN REST API, which coturn implements as
   `use-auth-secret`.
   An open relay is found by scanners within days and used as a free proxy,
   so a deployment that sets TURN_URLS without either credential scheme gets
   no TURN at all rather than an unauthenticated one. */
/* CLOUDFLARE MINTS ITS OWN, so this is the one provider-specific path. The
   answer is CACHED rather than fetched per client: minting inside the lobby
   path would put a third-party API call, and its failure modes, between a
   player and the room they are walking into. The credential is short-lived
   either way, and it is refreshed at 75% of its life so nobody is ever
   handed one that expires mid-match.
   A mint that fails serves STUN only. A relay is worth having; a lobby that
   will not open because someone else's API is down is not. */
/* THE SPEND CAP ------------------------------------------------------------
   Cloudflare bills TURN egress at $0.05/GB once the 1000 GB allowance is
   gone. Nothing in a TURN key stops itself, so this reads our own usage back
   out of Cloudflare's analytics API (`callsTurnUsageAdaptiveGroups`;
   egressBytes is the billed direction, ingress is free) and stops serving
   relay credentials before the allowance runs out.

   IT FAILS CLOSED. Every path that leaves us unsure how much has been spent
   serves STUN only: no analytics credentials, a query that has never
   succeeded, a reading gone stale. Being wrong in the safe direction costs
   some players a relay for a few minutes; being wrong in the other direction
   costs money nobody agreed to spend.

   It is a CAP, not a kill switch. The poll keeps running while the relay is
   off, so a new billing month turns it back on with no restart. */
const GB = 1024 ** 3;

const budget = {
  bytes: 0,        // last known billed egress inside the window
  readAt: 0,       // when that reading arrived; 0 means we have never had one
  blocked: null,   // last reason we refused, so the log fires on change only
};

const budgetEnforced = () =>
  !!(config.cfTurnKeyId && config.cfTurnApiToken && config.cfTurnBudgetGb > 0);

/* Cloudflare's own billing boundary, unless the operator pinned a date. */
function budgetWindowStart(){
  if(config.cfBudgetSince) return config.cfBudgetSince;
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

const USAGE_QUERY = `query($accountId:String!,$from:Date!,$to:Date!){
  viewer{accounts(filter:{accountTag:$accountId}){
    callsTurnUsageAdaptiveGroups(limit:1,filter:{date_geq:$from,date_leq:$to}){
      sum{egressBytes}
    }}}}`;

async function readTurnUsage(){
  const today = new Date().toISOString().slice(0, 10);
  const r = await fetch(config.cfAnalyticsUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.cfAnalyticsToken}`,
               "Content-Type": "application/json" },
    body: JSON.stringify({ query: USAGE_QUERY, variables: {
      accountId: config.cfAccountId, from: budgetWindowStart(), to: today } }),
    signal: AbortSignal.timeout(8000),
  });
  if(!r.ok) throw new Error("HTTP " + r.status);
  const body = await r.json();
  /* GraphQL reports failure in the body with HTTP 200, so this is the real
     error path, not the one above. */
  if(body.errors?.length) throw new Error(body.errors[0]?.message || "graphql error");
  const groups = body.data?.viewer?.accounts?.[0]?.callsTurnUsageAdaptiveGroups;
  if(!Array.isArray(groups)) throw new Error("no usage in response");
  /* An account that has never relayed a byte returns no rows. That is a
     real, successful reading of zero, not a missing one. */
  return groups.reduce((n, g) => n + (+g?.sum?.egressBytes || 0), 0);
}

async function pollTurnBudget(){
  if(!budgetEnforced() || !config.cfAccountId || !config.cfAnalyticsToken) return;
  try{
    const bytes = await readTurnUsage();
    const wasOver = budget.readAt && budget.bytes >= config.cfTurnBudgetGb * GB;
    budget.bytes = bytes;
    budget.readAt = Date.now();
    const gb = bytes / GB;
    const isOver = gb >= config.cfTurnBudgetGb;
    if(isOver && !wasOver)
      log(`TURN: BUDGET REACHED, relay OFF (${gb.toFixed(2)} of ${config.cfTurnBudgetGb} GB since ${budgetWindowStart()})`);
    else if(!isOver && wasOver)
      log(`TURN: budget window reset, relay back ON (${gb.toFixed(2)} GB)`);
  }catch(e){
    log(`TURN: usage check failed (${e.message})`);
  }
}

/* One line per state change, never per client: this is asked on every lobby
   visit and a log entry each time would bury everything else. */
function refuse(reason){
  if(budget.blocked !== reason){
    budget.blocked = reason;
    log(`TURN: relay withheld, serving STUN only (${reason})`);
  }
  return false;
}

function relayAllowed(){
  if(!budgetEnforced()){
    budget.blocked = null;
    return true;                       // cap lifted on purpose
  }
  if(!config.cfAccountId || !config.cfAnalyticsToken)
    return refuse("TURN_CF_BUDGET_GB is set but TURN_CF_ACCOUNT_ID / TURN_CF_ANALYTICS_TOKEN are not, so spend cannot be measured");
  if(!budget.readAt)
    return refuse("no usage reading yet");
  if(Date.now() - budget.readAt > config.cfBudgetStaleMs)
    return refuse(`usage reading is stale (older than ${Math.round(config.cfBudgetStaleMs / 1000)}s)`);
  if(budget.bytes >= config.cfTurnBudgetGb * GB)
    return refuse(`${(budget.bytes / GB).toFixed(2)} of ${config.cfTurnBudgetGb} GB used since ${budgetWindowStart()}`);
  if(budget.blocked !== null){
    budget.blocked = null;
    log(`TURN: relay available (${(budget.bytes / GB).toFixed(2)} of ${config.cfTurnBudgetGb} GB used)`);
  }
  return true;
}

/* For the /stats page: the same facts relayAllowed() decides on, without its
   logging side effect. */
function relayStatus(){
  const configured = !!(config.cfTurnKeyId && config.cfTurnApiToken) || config.turnUrls.length > 0;
  if(!budgetEnforced()) return { configured, on: configured, capGb: null, usedGb: null, since: null };
  const fresh = budget.readAt && Date.now() - budget.readAt <= config.cfBudgetStaleMs;
  return {
    configured, capGb: config.cfTurnBudgetGb, since: budgetWindowStart(),
    usedGb: budget.readAt ? budget.bytes / GB : null,
    readAgoMin: budget.readAt ? Math.round((Date.now() - budget.readAt) / 60000) : null,
    on: !!(config.cfAccountId && config.cfAnalyticsToken && fresh && budget.bytes < config.cfTurnBudgetGb * GB),
  };
}

let cfCache = { servers: null, expiresAt: 0 };

async function cloudflareIceServers(){
  const now = Date.now();
  if(cfCache.servers && now < cfCache.expiresAt) return cfCache.servers;
  const ttl = config.turnTtlSec;
  try{
    const r = await fetch(
      /* The key id is operator-supplied, never request-supplied, but it is
         the one value interpolated into a URL path here: encode it so a
         stray character in an env var cannot reshape the request. */
      `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(config.cfTurnKeyId)}/credentials/generate-ice-servers`,
      { method: "POST",
        headers: { Authorization: `Bearer ${config.cfTurnApiToken}`,
                   "Content-Type": "application/json" },
        body: JSON.stringify({ ttl }),
        signal: AbortSignal.timeout(4000) });
    if(!r.ok) throw new Error("HTTP " + r.status);
    const body = await r.json();
    /* the endpoint has shipped iceServers as both an object and an array */
    const servers = Array.isArray(body.iceServers) ? body.iceServers
                  : body.iceServers ? [body.iceServers] : [];
    if(!servers.length) throw new Error("no iceServers in response");
    cfCache = { servers, expiresAt: now + ttl * 750 };
    log(`TURN: minted Cloudflare credentials, ttl ${ttl}s`);
    return servers;
  }catch(e){
    log(`TURN: Cloudflare mint failed (${e.message}); serving STUN only`);
    return null;
  }
}

async function iceServers(){
  const list = [{ urls: config.stunUrls }];
  if(config.cfTurnKeyId && config.cfTurnApiToken){
    if(!relayAllowed()) return list;
    const cf = await cloudflareIceServers();
    if(cf) list.push(...cf);
    return list;
  }
  if(!config.turnUrls.length) return list;
  if(config.turnSecret){
    const username = `${Math.floor(Date.now() / 1000) + config.turnTtlSec}`;
    const credential = crypto.createHmac("sha1", config.turnSecret)
      .update(username).digest("base64");
    list.push({ urls: config.turnUrls, username, credential });
  }else if(config.turnUsername && config.turnPassword){
    list.push({ urls: config.turnUrls,
      username: config.turnUsername, credential: config.turnPassword });
  }
  return list;
}

/* THE SEAT OUTLIVES THE SOCKET, for `config.rejoinGraceMs`. A disconnect used
   to call `store.leave` on the spot, and in 1v1 that DESTROYS THE ROOM — so
   one phone crossing from wifi to cellular ended a match for both players,
   with nothing to come back to even though socket.io was already reconnecting
   underneath. The leave is now a pending timer that a recovered connection
   cancels. A player who really left still goes, one grace later, by the same
   path as before; the room's own TTL sweep is unchanged and still the
   backstop. Keyed by socket id, which recovery preserves. */
const pendingLeave = new Map();

function holdSeat(socketId){
  clearTimeout(pendingLeave.get(socketId));
  const timer = setTimeout(() => {
    pendingLeave.delete(socketId);
    store.leave(socketId);
  }, config.rejoinGraceMs);
  timer.unref?.();
  pendingLeave.set(socketId, timer);
}

function releaseSeatHold(socketId){
  const timer = pendingLeave.get(socketId);
  if(!timer) return false;
  clearTimeout(timer);
  pendingLeave.delete(socketId);
  return true;
}

io.on("connection", socket => {
  const ip = clientIp(socket);
  const ack = cb => (typeof cb === "function" ? cb : () => {});
  /* `socket.recovered` means this is the same player on the same id, not a
     new arrival: their seat is still being held, so take it off the clock. */
  const resumed = socket.recovered && releaseSeatHold(socket.id);
  log(`${resumed ? "resume" : "connect"} ${socket.id.slice(0,6)} from ${ip} (origin: ${socket.handshake.headers.origin || "?"})`);

  /* ONE GREETING, AND IT IS LOAD-BEARING. A client can only be recovered if it
     can tell the server where it got to, and that marker is the id of the last
     EVENT it received — an ack does not carry one. A player sitting alone in a
     lobby has been sent no events at all, so without this the one case where a
     phone is most likely to be idle and drop is the one case that could not
     come back. It also carries the grace itself, so the client's give-up timer
     is this server's number rather than a second copy of it. */
  socket.emit("net:hello", { rejoinGraceMs: config.rejoinGraceMs });

  socket.on("room:create", (payload, cb) => {
    cb = ack(cb);
    if(!createLimit.allow(ip)) return cb({ error: "rate-limited" });
    if(!isPlainObject(payload)) return cb({ error: "bad-payload" });
    const name = cleanName(payload.name);
    const labels = cleanLabels(payload.labels);
    const settings = cleanSettings(payload.settings);
    if(!name || !labels || settings === null) return cb({ error: "bad-payload" });
    const res = store.createRoom(socket.id, name, labels, settings, cleanSeen(payload.seen, labels));
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
    const res = store.joinRoom(socket.id, code, name, labels, cleanSeen(payload.seen, labels));
    log(`join ${code} by "${name}" -> ${res.error ? "ERROR " + res.error : "ok, peer " + res.peerName}`);
    cb(res);
  });

  socket.on("player:ready", (payload, cb) => {
    cb = ack(cb);
    /* Cheap and idempotent, but it walks the roster and can emit to both
       players, so it gets a bucket like every other state-changing event. */
    if(!claimLimit.allow(socket.id)) return cb({ error: "rate-limited" });
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
    const res = store.partyCreate(socket.id, name, settings, labels, cleanSeen(payload.seen, labels));
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
    const res = store.partyJoin(socket.id, code, name, labels, cleanSeen(payload.seen, labels));
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
  /* Names the one rival whose live read this client is showing, so the guess
     relay writes to the players who display it instead of to the whole room.
     Its own bucket: a featured seat changes on a handover, several times a
     word in a busy round, which would eat the claim bucket it would otherwise
     share. It is still far below the guess rate it saves. */
  socket.on("party:watch", (payload, cb) => {
    cb = ack(cb);
    if(!watchLimit.allow(socket.id)) return cb({ error: "rate-limited" });
    if(!isPlainObject(payload)) return cb({ error: "bad-payload" });
    const id = payload.id;
    if(id !== null && typeof id !== "string") return cb({ error: "bad-payload" });
    cb(store.partyWatch(socket.id, id));
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

  /* HOW MANY LINKS ACTUALLY CONNECT. With no TURN configured every `failed`
     here is a pair that STUN could not hole-punch and that a relay would have
     rescued; with TURN on, a `relay` pair is one it did. Counting these against the successes is the only
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
    stats?.recordNet(mode, result, payload.local === "relay" || payload.remote === "relay");
  });

  /* Asked for once per lobby visit, before the first peer is built. Costs a
     fresh signature each time, which is the point: see iceServers(). */
  socket.on("ice:servers", async (payload, cb) => {
    cb = ack(cb);
    if(!netLimit.allow(socket.id)) return cb({ error: "rate-limited" });
    cb({ iceServers: await iceServers() });
  });

  /* Pressing Esc or walking out of a lobby is a DECISION, not a blip: it
     leaves at once and cancels any hold left over from an earlier drop. */
  socket.on("room:leave", (payload, cb) => {
    cb = ack(cb);
    /* Still answers the callback when limited: a client waiting on an ack
       that never arrives is worse than a refused leave. */
    if(!claimLimit.allow(socket.id)) return cb({ error: "rate-limited" });
    releaseSeatHold(socket.id);
    store.leave(socket.id);
    cb({ ok: true });
  });
  socket.on("disconnect", reason => {
    log(`disconnect ${socket.id.slice(0,6)} (${reason}) — seat held ${config.rejoinGraceMs}ms`);
    holdSeat(socket.id);
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
  /* EVERY RATE LIMIT KEYS ON CF-Connecting-IP UNDER THIS SETTING, and that
     header is only trustworthy because Cloudflare overwrites whatever the
     client sent. Reach this process WITHOUT going through Cloudflare and a
     caller writes the header themselves, which is an unlimited supply of
     fresh rate-limit keys. Render's own edge is Cloudflare, so the deployed
     path is covered; anywhere else, the origin must not be directly
     reachable. */
  if(config.trustProxy === "cloudflare")
    console.warn("NOTE: TRUST_PROXY=cloudflare trusts CF-Connecting-IP. Make sure this process cannot be reached except through Cloudflare, or the rate limits can be bypassed.");
  if(config.corsOrigins.every(o => /localhost|127\.0\.0\.1/.test(o)))
    console.warn("WARNING: CORS_ORIGINS still only lists localhost. Set it to your real origin.");
  if(config.turnUrls.length && !config.cfTurnKeyId
     && !config.turnSecret && !(config.turnUsername && config.turnPassword))
    console.warn("WARNING: TURN_URLS is set but no credentials are. TURN is disabled rather than left open.");
}

/* The first reading has to arrive before anybody asks for a relay, so this
   runs at boot rather than one interval later. `unref` keeps a stopped server
   from being held open by a timer nobody is waiting on. */
function startTurnBudgetWatch(){
  if(!budgetEnforced()) return;
  if(!config.cfAccountId || !config.cfAnalyticsToken){
    console.warn("WARNING: TURN spend cap is ON but TURN_CF_ACCOUNT_ID / TURN_CF_ANALYTICS_TOKEN are unset.");
    console.warn("         Relay stays OFF until they are set. TURN_CF_BUDGET_GB=0 lifts the cap and accepts the charges.");
    return;
  }
  pollTurnBudget();
  setInterval(pollTurnBudget, config.cfBudgetPollMs).unref();
  log(`TURN: spend cap ${config.cfTurnBudgetGb} GB, counted from ${budgetWindowStart()}, checked every ${Math.round(config.cfBudgetPollMs / 1000)}s`);
}

httpServer.listen(config.port, () => {
  warnIfMisconfigured();
  startTurnBudgetWatch();
  console.log(`Pose Party server running.`);
  console.log(`  On this computer:   http://localhost:${config.port}`);
  for(const addrs of Object.values(os.networkInterfaces()))
    for(const a of addrs || [])
      if(a.family === "IPv4" && !a.internal)
        console.log(`  On other computers: http://${a.address}:${config.port}`);
});
