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

  /* Housekeeping. */
  roomTtlMs: int(process.env.ROOM_TTL_MS, 30 * 60 * 1000),
  maxRooms: int(process.env.MAX_ROOMS, 500),
};
