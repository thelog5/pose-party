/* All configuration comes from the environment; nothing is hardcoded in the
   game logic. Copy .env.example and `source` it, or set vars inline. */

const int = (v, d) => Number.isFinite(+v) ? +v : d;

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
  /* Multiplayer waits here for every current client to dismiss HOW TO PLAY.
     A bounded fallback keeps an abandoned/backgrounded tab from deadlocking
     the whole room; once the barrier releases, preCountMs still supplies the
     complete shared 3-2-1 before the first word is dealt. */
  tutorialTimeoutMs: int(process.env.TUTORIAL_TIMEOUT_MS, 15000),
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

  /* Housekeeping. */
  roomTtlMs: int(process.env.ROOM_TTL_MS, 30 * 60 * 1000),
  maxRooms: int(process.env.MAX_ROOMS, 500),
};
