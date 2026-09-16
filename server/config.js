/* All configuration comes from the environment; nothing is hardcoded in the
   game logic. Copy .env.example and `source` it, or set vars inline. */

import crypto from "node:crypto";

const int = (v, d) => Number.isFinite(+v) ? +v : d;
/* Same coercion, but the value is genuinely fractional (GB budgets). */
const num = (v, d) => Number.isFinite(+v) && String(v).trim() !== "" ? +v : d;
const bool = (v, d) => (v == null || v === "") ? d : /^(1|true|yes|on)$/i.test(String(v).trim());
/* Express's own "trust proxy" value: false, a hop count, or `loopback`.
   `true`/`1` is one hop. A bigger number is that many proxies in front (for
   a platform that puts a CDN before its load balancer): set it to the count
   that makes the server log YOUR public IP, and no higher. */
const proxyTrust = v => {
  const s = String(v ?? "").trim().toLowerCase();
  if(s === "loopback") return "loopback";
  if(s === "cloudflare") return "cloudflare";
  if(/^[1-9]$/.test(s)) return Number(s);
  return bool(s, false) ? 1 : false;
};

export const config = {
  port: int(process.env.PORT, 3000),

  /* Comma-separated list of allowed browser origins for cross-origin
     Socket.IO connections. Same-origin (the server serving the game itself)
     always works. */
  corsOrigins: (process.env.CORS_ORIGINS || "http://localhost:3000,http://127.0.0.1:3000")
    .split(",").map(s => s.trim()).filter(Boolean),

  /* Match shape. rounds is a safety cap; matchMs governs time-based play. */
  rounds: int(process.env.ROUNDS, 999),
  matchMs: int(process.env.MATCH_MS, 120000),
  wordMs: int(process.env.WORD_MS, 20000),
  preCountMs: int(process.env.PRECOUNT_MS, 3000),
  /* The FULL BODY warning plays before the 3-2-1, on every client at once,
     so the server owns its length: it is added in front of preCountMs. The
     client shows the warning for as long as more than three seconds remain
     and the numerals for the last three, so it needs no copy of this number
     and a client that arrives late simply sees less of the warning. */
  frameCheckMs: int(process.env.FRAME_CHECK_MS, 2000),
  /* HOW TO PLAY IS A GRACE, NOT A BARRIER. Multiplayer used to hold the match
     until every current client had dismissed the card, with a 15s fallback
     for a crashed tab. In practice that meant a room of six sat on a screen
     that gave no reason it was not starting, for as long as the slowest
     person took to find the button — and the one thing a player must never
     have to wonder is why the game has not begun.
     So this is now the PRIMARY path: everybody gets a few seconds to read
     three short lines, and then the match starts whether or not they pressed
     anything. Readying up early still releases immediately (see
     matchTutorialReady / partyTutorialReady), so the card never costs time to
     anyone who has read it before. `preCountMs` still supplies the complete
     shared 3-2-1 after the release, so nobody is dropped straight into a
     live word. */
  tutorialGraceMs: int(process.env.TUTORIAL_GRACE_MS,
    int(process.env.TUTORIAL_TIMEOUT_MS, 6000)),
  betweenRoundsMs: int(process.env.BETWEEN_ROUNDS_MS, 1800),
  /* A claim is scored from its synchronized recognition timestamp, not its
     arrival time. This short grace only lets an in-flight claim arrive; it
     never extends the timestamp cutoff shown to players. */
  claimGraceMs: int(process.env.CLAIM_GRACE_MS, 600),
  claimFutureSkewMs: int(process.env.CLAIM_FUTURE_SKEW_MS, 900),

  /* Rate limits (per minute). Both buckets are keyed by IP, and that is the
     whole reason these numbers cannot be small: walking into the 1v1 or party
     lobby AUTO-CREATES a room, two tabs on one machine share one bucket, and
     a party of six behind one household NAT is a single key. At the old 5/10
     you ran out after six trips into a lobby — the code paper stayed at
     `------`, "Slow down a little" appeared in the corner waitline, and for
     the rest of that minute the game genuinely could not be played online.
     30/60 still bounds a script spraying rooms; it never fires during play,
     which is why both E2E suites already had to override it. */
  rateCreate: int(process.env.RATE_CREATE, 30),
  rateJoin: int(process.env.RATE_JOIN, 60),

  /* BEHIND A PLATFORM PROXY, EVERY PLAYER SHARES ONE IP. Render, Railway and
     Fly all terminate TLS in front of this process, so `req.ip` and
     `socket.handshake.address` become the proxy's address for everybody. Both
     rate buckets are keyed by IP, so the whole player base would then share a
     single bucket of `rateCreate` rooms per minute — and walking into a lobby
     CREATES a room. The symptom is the one already documented above: the
     invite paper stuck at `------` for everyone at once.
     The forwarded header is only trusted when this is on, because a client
     can write whatever it likes into `X-Forwarded-For`. Trusting it on a
     directly-exposed server would hand every abuser an unlimited supply of
     fresh rate-limit keys. Off locally, on in production.
     `true` trusts ONE hop (a platform proxy). `loopback` trusts the header
     only when the connection comes from this machine: that is the right
     value for a tunnel such as cloudflared on the same computer, because a
     LAN client connecting to the port directly cannot then spoof it.
     `cloudflare` reads the visitor from Cloudflare's CF-Connecting-IP header.
     It is the right value on Render with a proxied Cloudflare domain: Render's
     own edge is Cloudflare too, so there are two Cloudflare layers and no hop
     count lands on the visitor (TRUST_PROXY=1 logged Cloudflare addresses for
     every player). Cloudflare overwrites that header, so a visitor cannot set
     it, and every request to a Render service passes through Cloudflare. */
  trustProxy: proxyTrust(process.env.TRUST_PROXY),

  /* Static cache lifetime for `assets/`, in seconds. The art is the bulk of
     the payload (about 30 MB over 275 files) and it is stable between
     deploys, so it is worth caching hard. Markup, JS and CSS are deliberately
     NOT covered by this: they are not content-hashed, so a long cache there
     would leave players running a stale build after a deploy with no way to
     know. See the static handler in index.js. */
  staticMaxAge: int(process.env.STATIC_MAX_AGE, 30 * 24 * 60 * 60),

  /* TURN. A RELAY IS NOT AN SFU, AND THE DIFFERENCE IS THE WHOLE DESIGN.
     WebRTC media is DTLS-SRTP encrypted end to end and the keys are derived
     between the two browsers, so a TURN server forwards packets it holds no
     key for and cannot open. An SFU terminates the encryption and can see
     the video, which is why this game will never have one.
     What TURN buys is REACH, and nothing else: it does not reduce a client's
     upload one bit, because a mesh allocates one relay per link. It rescues
     the pairs that STUN cannot hole-punch — symmetric NAT, carrier-grade NAT
     on mobile, corporate and campus firewalls, UDP blocked outright.
     Unset by default, in which case the client is STUN-only exactly as
     before. `net:report` in index.js is how you find out whether you need
     this: every `failed` it logs is a pair a relay would have rescued.

     Two standard credential schemes, no provider-specific code:
       TURN_SECRET   the TURN REST API (coturn `use-auth-secret`, and the
                     several managed providers that implement it). The server
                     signs a short-lived username here and the password never
                     exists in the client for longer than TURN_TTL_SEC.
       TURN_USERNAME + TURN_PASSWORD  a fixed pair, for providers that only
                     issue those. Weaker: it is handed to every client as-is,
                     so prefer the secret where the provider supports it. */
  /* Cloudflare does NOT implement the shared-secret scheme below. It mints
     credentials from its own API, so it needs a key id and an API token
     rather than TURN_URLS: the endpoint returns the urls too. Setting both
     of these selects it; nothing else is provider-specific. */
  cfTurnKeyId: process.env.TURN_CF_KEY_ID || "",
  cfTurnApiToken: process.env.TURN_CF_API_TOKEN || "",

  /* THE SPEND CAP. Cloudflare bills TURN egress at $0.05/GB once the 1000 GB
     allowance is gone, and a TURN key has no stop of its own: it relays until
     somebody notices the invoice. So the server reads its OWN usage back out
     of Cloudflare's analytics API and stops handing out relay credentials
     before the allowance runs out.

     IT FAILS CLOSED, which is the entire point. No analytics credentials, a
     query that has never succeeded, or a reading that has gone stale all
     serve STUN only. A relay is worth having; a bill nobody authorised is
     not. Set TURN_CF_BUDGET_GB=0 to lift the cap and accept the charges.

     900 rather than 1000 is deliberate headroom: the analytics feed lags
     real traffic by minutes, and the free allowance is shared with the
     Realtime SFU, so the last 100 GB pays for the lag. */
  cfTurnBudgetGb: num(process.env.TURN_CF_BUDGET_GB, 900),
  cfAccountId: process.env.TURN_CF_ACCOUNT_ID || "",
  cfAnalyticsToken: process.env.TURN_CF_ANALYTICS_TOKEN || "",
  /* Counted from this YYYY-MM-DD. Unset means the start of the current UTC
     month, which is how Cloudflare bills everything else. Pin a fixed date
     here to treat the 1000 GB as a once-ever allowance instead. */
  cfBudgetSince: (process.env.TURN_CF_BUDGET_SINCE || "").trim(),
  /* Overridable so the cap can be driven against a mock in tests. There is
     no reason to set this in production. */
  cfAnalyticsUrl: process.env.TURN_CF_ANALYTICS_URL
    || "https://api.cloudflare.com/client/v4/graphql",
  cfBudgetPollMs: int(process.env.TURN_CF_BUDGET_POLL_MS, 5 * 60 * 1000),
  /* A reading older than this is not evidence of anything, so the relay goes
     off until a fresh one arrives. */
  cfBudgetStaleMs: int(process.env.TURN_CF_BUDGET_STALE_MS, 30 * 60 * 1000),

  turnUrls: (process.env.TURN_URLS || "").split(",").map(s => s.trim()).filter(Boolean),
  turnSecret: process.env.TURN_SECRET || "",
  turnUsername: process.env.TURN_USERNAME || "",
  turnPassword: process.env.TURN_PASSWORD || "",
  turnTtlSec: int(process.env.TURN_TTL_SEC, 12 * 60 * 60),

  /* The STUN server the client falls back on, and still tries first even
     when TURN is configured — ICE only reaches for the relay if the cheap
     routes fail, which is what keeps the relay bill to the links that
     actually need it. */
  stunUrls: (process.env.STUN_URLS || "stun:stun.l.google.com:19302")
    .split(",").map(s => s.trim()).filter(Boolean),

  /* THE PRIVATE-BETA LOCK. Unset means the game is open exactly as it
     shipped; set it and nothing behind /healthz is reachable without the
     code. It gates the page AND the socket, so the game API is not left
     open to anyone who skips the page.
     ACCESS_SECRET only needs setting if you want to invalidate everyone's
     cookie without changing the code they type (or the reverse). */
  accessCode: (process.env.ACCESS_CODE || "").trim(),
  accessSecret: (process.env.ACCESS_SECRET || "").trim(),
  accessTtlSec: int(process.env.ACCESS_TTL_SEC, 30 * 24 * 60 * 60),

  /* THE CODE IS NEVER THE SIGNING KEY. The cookie is `<exp>.<HMAC(secret,
     exp)>`, and it is handed to every admitted player — so if the secret were
     the code, anyone holding one cookie could run the HMAC against a word
     list offline, with no rate limit, and recover a short shared code. A
     random secret makes the cookie say nothing about the code at all.
     Unset ACCESS_SECRET therefore means a NEW secret each boot: everyone
     types the code again after a restart. Set it (Render generates one) to
     keep them signed in. */
  gateSecret: (process.env.ACCESS_SECRET || "").trim()
    || crypto.randomBytes(32).toString("hex"),

  /* WORD STATS. Set it and the game collects anonymous per-word results;
     /stats shows the totals to anyone who has this password (HTTP Basic,
     any user name), and scripts/pull-stats.mjs downloads them. Unset, the
     game sends no reports at all. */
  statsToken: (process.env.STATS_TOKEN || "").trim(),

  /* A PHONE DROPS ITS SOCKET ALL THE TIME, AND THAT MUST NOT END THE MATCH.
     Switching from wifi to cellular, a lock screen, a notification pulled
     down over the page, a lift ride: every one of them closes the transport
     or freezes the tab long enough for the server to notice. Until now the
     first `disconnect` tore the room down on the spot, so a two-second blip
     on one phone ended everybody's game. A seat is now HELD for this long
     and socket.io's own connection-state recovery hands the returning player
     back the SAME socket id, which is what every room, peer and seat in this
     app is keyed by. Long enough to cross a network handoff or a glance at a
     notification; short enough that a tab somebody closed for good does not
     sit in a party of six as a frozen chair for a whole minute. An explicit
     exit (Esc, the lobby's own leave) is immediate and unaffected — this only
     covers the drops nobody chose. */
  rejoinGraceMs: int(process.env.REJOIN_GRACE_MS, 30 * 1000),

  /* Housekeeping. */
  roomTtlMs: int(process.env.ROOM_TTL_MS, 30 * 60 * 1000),
  maxRooms: int(process.env.MAX_ROOMS, 500),
};
