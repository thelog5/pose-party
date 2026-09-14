/* The gameplay robot's copybook.

   Edit the quoted lines below to change what he says. Each key is a reaction
   beat used by robot.js; add, remove, or rewrite lines inside a list without
   changing the key. The speech-bubble fitter measures every chosen line at
   runtime, so longer copy shrinks and wraps inside the Figma paper instead of
   spilling out of it. Short, punchy lines still read best during play. */

export const ROBOT_DIALOGUE = Object.freeze({
  read:    ["I SEE IT!", "OOH! HOLD ON", "SOMETHING'S THERE", "KEEP GOING!"],
  close:   ["HOLD IT!", "ALMOST!", "DON'T MOVE!", "THAT'S THE ONE!"],
  got:     ["YOU DID IT!", "NAILED IT!", "YES!! GOT IT", "THAT'S IT!"],
  streak:  ["ON FIRE!", "AGAIN?! WOW", "UNSTOPPABLE", "YOU DID IT AGAIN!"],
  timeout: ["SO CLOSE…", "NEXT ONE!", "I'LL GET IT", "MY FAULT, MY FAULT"],
  skip:    ["FINE, NEXT!", "NO SHAME", "MOVING ON"],
  nudge:   ["SHOW ME SOMETHING!", "STRIKE A POSE", "I'M WATCHING…",
            "ANY TIME NOW", "GIVE ME A HINT"],
  /* He can see the camera, so this one is not a reaction — it is the only
     thing on the board that knows you have walked out of frame, and the fix
     ("step back into shot") is the single most useful thing anyone can be
     told in a game played with your whole body. */
  missing: ["HELLO? WHERE'D YOU GO?", "I LOST YOU!", "STEP BACK IN!",
            "I CAN'T SEE YOU…"],
  /* This word is read from the legs, and he cannot see yours. The meter
     waits for knees and ankles on these words, so this is the reason it is
     not moving. It replaced a dark caption box under the paper HUD. */
  feet:    ["SHOW ME YOUR FEET!", "I NEED YOUR LEGS!", "STEP BACK A BIT!",
            "WHERE ARE YOUR FEET?"],
  /* You are moving, and he still has nothing. NOTHING in this list is a note
     on your performance: the meter being empty while you work is the model's
     failure, and a character who blames you for it is a character nobody
     wants in the room. */
  struggling: ["THAT'S ON ME…", "MY CIRCUITS ARE SLOW TODAY",
               "BIGGER? MAYBE BIGGER", "I ALMOST HAVE IT", "HOLD THAT! LET ME LOOK"],
});
