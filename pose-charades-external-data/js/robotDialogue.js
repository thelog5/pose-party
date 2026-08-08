/* The gameplay robot's copybook.

   Edit the quoted lines below to change what he says. Each key is a reaction
   beat used by robot.js; add, remove, or rewrite lines inside a list without
   changing the key. The speech-bubble fitter measures every chosen line at
   runtime, so longer copy shrinks and wraps inside the Figma paper instead of
   spilling out of it. Short, punchy lines still read best during play. */

export const ROBOT_DIALOGUE = Object.freeze({
  read:    ["I SEE IT!", "OOH — HOLD ON", "SOMETHING'S THERE", "KEEP GOING!"],
  close:   ["HOLD IT!", "ALMOST!", "DON'T MOVE!", "THAT'S THE ONE!"],
  got:     ["YOU DID IT!", "NAILED IT!", "YES!! GOT IT", "THAT'S IT!"],
  streak:  ["ON FIRE!", "AGAIN?! WOW", "UNSTOPPABLE", "YOU DID IT AGAIN!"],
  timeout: ["SO CLOSE…", "NEXT ONE!", "I'LL GET IT", "MY FAULT, MY FAULT"],
  skip:    ["FINE, NEXT!", "NO SHAME", "MOVING ON"],
  nudge:   ["SHOW ME SOMETHING!", "STRIKE A POSE", "I'M WATCHING…",
            "ANY TIME NOW", "GIVE ME A HINT"],
});
