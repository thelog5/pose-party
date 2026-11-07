/* Shared Pose Party scoring.
   This module deliberately has no browser dependencies so the authoritative
   Node server and the Solo client execute the exact same point formula. */

export const FIRST_POINTS_MIN = 300;
export const FIRST_POINTS_RANGE = 200;
export const CHASE_WINDOW_MS = 5000;

const clamp01 = value => Math.max(0, Math.min(1, value));

export function calculateFirstPoints(wordTimeRemainingMs, wordTimeLimitMs){
  const limit = Number(wordTimeLimitMs);
  const remaining = Number(wordTimeRemainingMs);
  const fraction = limit > 0 && Number.isFinite(remaining)
    ? clamp01(remaining / limit)
    : 0;
  return Math.round(FIRST_POINTS_MIN + FIRST_POINTS_RANGE * fraction);
}

export function calculateChaserPoints(firstPoints, delaySeconds){
  const delay = Number(delaySeconds);
  if(!Number.isFinite(delay) || delay < 0 || delay > CHASE_WINDOW_MS / 1000)
    return 0;

  const normalizedDelay = delay / (CHASE_WINDOW_MS / 1000);
  const multiplier = 1 - 0.70 * normalizedDelay * normalizedDelay;
  return Math.round(Math.max(0, Number(firstPoints) || 0) * multiplier);
}

/* ---------------- party (team) scoring ----------------
   Everyone performs the same word at once and is ranked by recognition
   time across BOTH teams. Unlike 1v1 there is no quadratic chase decay:
   a player who lands inside the five-second window scores exactly what
   their placement and remaining word time say they scored. */

export const PARTY_PLACEMENT = [100, 80, 60, 50, 40, 30];
export const PARTY_TIME_POINTS_PER_SEC = 2;
export const PARTY_TEAM_BONUS = 150;
export const PARTY_CHASE_WINDOW_MS = 5000;

/* Nth finisher overall (0-based). Past the table everyone ties on its tail,
   so an unexpectedly large room still scores rather than throwing. */
export function calculatePartyPlacementPoints(place){
  const index = Number(place);
  if(!Number.isInteger(index) || index < 0) return 0;
  return PARTY_PLACEMENT[Math.min(index, PARTY_PLACEMENT.length - 1)];
}

/* Whole seconds only — a visible clock reading "4" must be worth 8. */
export function calculatePartyTimePoints(wordTimeRemainingMs){
  const remaining = Number(wordTimeRemainingMs);
  if(!Number.isFinite(remaining) || remaining <= 0) return 0;
  return Math.floor(remaining / 1000) * PARTY_TIME_POINTS_PER_SEC;
}

export function calculatePartyPlayerPoints(place, wordTimeRemainingMs){
  return calculatePartyPlacementPoints(place)
       + calculatePartyTimePoints(wordTimeRemainingMs);
}
