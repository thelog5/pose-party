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
  matchMs: int(process.env.MATCH_MS, 180000),
  wordMs: int(process.env.WORD_MS, 20000),
  preCountMs: int(process.env.PRECOUNT_MS, 3000),
  betweenRoundsMs: int(process.env.BETWEEN_ROUNDS_MS, 1800),

  /* Housekeeping. */
  roomTtlMs: int(process.env.ROOM_TTL_MS, 30 * 60 * 1000),
  maxRooms: int(process.env.MAX_ROOMS, 500),
};
