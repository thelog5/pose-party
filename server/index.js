/* Pose Charades online 1v1 server.

   Express serves the game itself (so localhost:PORT is the whole app) and
   Socket.IO carries signaling + authoritative game events. Video travels
   peer-to-peer over WebRTC and never touches this process; neither do
   landmarks or training data. During a match, only the already-computed
   top guess label and confidence are relayed so the rival paper can update. */

import fs from "fs";
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
const GAME_DIR = path.join(__dirname, "..", "pose-charades-external-data");

const app = express();

/* Behind Render/Railway/Fly this makes `req.ip` the real client rather than
   the platform proxy. Off by default: an untrusted `X-Forwarded-For` is a
   free supply of rate-limit keys. See config.trustProxy. */
if(config.trustProxy) app.set("trust proxy", config.trustProxy);

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
  res.json({ ok: true, rooms: store._rooms.size, uptimeSec: Math.round(process.uptime()) });
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
const statsAuthLimit = createLimiter({ tokens: 10, perMs: 60_000 });
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
    if(!statsAuthLimit.allow(req.ip)) return res.status(429).type("text").send("Too many tries. Wait a minute.");
    const pass = basicPassword(req.headers.authorization);
    if(!pass || !codeMatches(pass, config.statsToken))
      return res.status(401).set("WWW-Authenticate", 'Basic realm="Pose Party stats"')
        .type("text").send("The stats page needs the stats password.");
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
    if(!statsAuthLimit.allow(req.ip)) return res.status(429).type("text").send("Too many tries. Wait a minute.");
    const pass = basicPassword(req.headers.authorization);
    if(!pass || !codeMatches(pass, config.statsToken))
      return res.status(401).set("WWW-Authenticate", 'Basic realm="Pose Party owner"')
        .type("text").send("Owner tools need the stats password.");
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
  try{
    const host = new URL(o).host;
    return host === req.headers.host || config.corsOrigins.some(c => { try{ return new URL(c).host === host; }catch{ return false; } });
  }catch{ return false; }
}

/* THE PRIVATE-BETA LOCK -----------------------------------------------------
   Sits AFTER /healthz, because the platform's health check must never need a
   password, and BEFORE express.static, because everything it protects is
   underneath that. Unset ACCESS_CODE leaves the game wide open exactly as it
   shipped, which is what local dev and every test suite expect. */
const gateOn = !!config.accessCode;
const gateSecret = config.accessSecret || config.accessCode;
/* A shared code is guessable at speed, so attempts are capped per IP. The
   bucket is on the SUBMIT path only: rate-limiting page views would lock out
   somebody who simply reloaded. */
const gateLimit = createLimiter({ tokens: 10, perMs: 60_000 });
setInterval(() => gateLimit.sweep(), 60_000).unref();

function gateOk(req){
  return !gateOn || ticketValid(gateSecret, readCookie(req.headers.cookie, COOKIE));
}

if(gateOn){
  app.use(express.urlencoded({ extended: false, limit: "1kb" }));

  app.post("/__gate", (req, res) => {
    if(!gateLimit.allow(req.ip)){
      log(`gate: too many attempts from ${req.ip}`);
      return res.status(429).type("html")
        .send(gatePage({ error: "Too many tries. Wait a minute." }));
    }
    if(!codeMatches(String(req.body?.code || "").trim(), config.accessCode)){
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

app.use(express.static(GAME_DIR, {
  index: "index.html",
  setHeaders: (res, filePath) => {
    const rel = path.relative(GAME_DIR, filePath).split(path.sep);
    const isArt = rel[0] === "assets" && rel[1] !== "data";
    /* tells the client to send word reports (js/wordStats.js) */
    if(stats && rel[0] === "assets" && rel[1] === "data") res.set("X-Word-Stats", "on");
    res.set("Cache-Control", isArt
      ? `public, max-age=${config.staticMaxAge}`
      : "no-cache");
  },
}));

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
  maxHttpBufferSize: 64 * 1024, // largest legal payload is an SDP blob
});

/* THE SAME LOCK ON THE SOCKET. Gating only the HTML would leave the whole
   game API reachable by anyone who skips the page and opens a socket
   directly, which is the entire thing worth protecting. */
if(gateOn)
  io.use((socket, next) => {
    if(ticketValid(gateSecret, readCookie(socket.handshake.headers.cookie, COOKIE)))
      return next();
    log(`gate: socket refused from ${socket.handshake.address}`);
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

setInterval(() => {
  store.sweep();
  createLimit.sweep(); joinLimit.sweep(); claimLimit.sweep();
  signalLimit.sweep(); guessLimit.sweep(); netLimit.sweep();
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
      `https://rtc.live.cloudflare.com/v1/turn/keys/${config.cfTurnKeyId}/credentials/generate-ice-servers`,
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
  console.log(`Pose Charades server running.`);
  console.log(`  On this computer:   http://localhost:${config.port}`);
  for(const addrs of Object.values(os.networkInterfaces()))
    for(const a of addrs || [])
      if(a.family === "IPv4" && !a.internal)
        console.log(`  On other computers: http://${a.address}:${config.port}`);
});
