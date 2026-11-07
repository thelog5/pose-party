# Pose Party (formerly Pose Charades)

## Launch it correctly

Do **not** double click `index.html`. The browser blocks the app from loading `assets/data/pose-charades-data.json` when opened as a plain local file.

**Full game including online 1v1** — run the Node server (serves this folder *and* powers online rooms):

```bash
cd ../server
npm install   # first time only
npm start
```

Then open `http://localhost:3000` in Chrome.

**Offline modes only** (Play with AI, training, practice 1v1) — any static server works:

```bash
cd client
python3 -m http.server 8000
```

Then open `http://localhost:8000`.

## Updating training data

All training data lives here:

```text
assets/data/pose-charades-data.json
```

When you export newer data from the app, rename the exported file to:

```text
pose-charades-data.json
```

Then replace the file inside:

```text
assets/data/
```

Refresh `http://localhost:8000`.

## Code layout

`index.html` is markup only. Styles and scripts live in `css/` and `js/`.

The stylesheets are linked in cascade order — `theme.css` and everything after it
deliberately override the section files above them, so **do not reorder the
`<link>` tags**.

`js/` is a plain ES module graph, no build step:

| Module | Responsibility |
| --- | --- |
| `main.js` | Entry point: wires DOM events, then boots. |
| `engine.js` | MediaPipe + camera setup, per-frame render/sample loop. |
| `pose.js` | Normalizes landmarks into a hip-centered, shoulder-scaled frame. |
| `classifier.js` | Pure kNN: feature windows, cosine similarity, voting. |
| `training.js` | Fits the model, reports a holdout accuracy estimate. |
| `capture.js` | Recording clips. |
| `data.js` | Dataset import / export / bundled preload. |
| `game.js` | Round loop and scoring for the local modes. |
| `fsm.js` | The finite game-state machine (DOM-free, unit-testable). |
| `rival.js` | Simulated 1v1 opponent (practice mode). |
| `online.js` | Online 1v1: lobby, host settings, server events → FSM, point claims. |
| `webrtc.js` | Peer-to-peer video link for online 1v1. |
| `party.js` | Party lobby: roster, teams, WebRTC mesh. Hands the mesh to `partyMatch.js` at start. |
| `partyMatch.js` | Party match screen: seating, recognition claims, green borders, GOT IT stickers. |
| `scoring.js` | Point formulas, shared verbatim with the Node server (no browser deps). |
| `results.js` | Results screen: live-face stage, photo-carousel breakdown, awards, capture, rematch. |
| `screens.js` | Maps FSM states to screens; moves the camera dock between them. |
| `ui.js` | Guess list, toasts, flashes, class list. |
| `state.js` | Shared mutable state, in one object. |
| `constants.js` | Tunables and fixed tables. |
| `dom.js`, `draw.js`, `audio.js` | Small helpers. |

`pose.js` and `classifier.js` are pure and dependency-free — the easiest place to
add tests. The frame layout in `constants.js` is mirrored by `train_model.py`.

## Game states

All flow control goes through the explicit state machine in `js/fsm.js`:

```
menu ──────────► countdown ──► playing ◄──► word-won
  │  ▲              ▲             │             │
  ▼  │              │             ▼             ▼
training        results ◄─────────┴─────────────┘
  (also: menu ◄──► party — the Party waiting room, which also
   enters countdown when the host starts
   and menu ◄──► lobby — the online 1v1 room screen)
```

`screens.js` picks the screen for `countdown`/`playing`/`word-won` from
`state.game.mode`: `ai` → Solo, `party` → the Party match, anything else →
the 1v1 split.

- **countdown** — 3·2·1 overlay before the first word; backing out (gear/logo)
  cancels the game cleanly.
- **playing** — the only state that accepts score events. A word is won
  when the top prediction equals the current word, confidence is over the
  threshold (`THRESH`), and it stays valid for the stability window
  (`HOLD_MS`). Solo scoring uses the shared 300–500 time curve; the streak
  remains a run indicator and does not multiply points.
- **word-won** — entered the instant a word resolves (won, missed, or
  skipped). Because `playing → word-won` can only fire once per word, this
  transition *is* the scoring lock: no double awards even if two code paths
  race. After a short celebration pause the game returns to `playing` with
  the next word, or goes to `results` after the last round.

Illegal transitions are rejected and logged rather than crashing the game.

## Data flow

```
webcam ──► MediaPipe Pose (+Hand, visual only) ──► normalize (pose.js)
   ──► 30-frame sliding window ──► features (classifier.js) ──► kNN vs
       labeled windows from assets/data/pose-charades-data.json
   ──► smoothed guesses ──► ui.js (guess list) + game.js (scoring)
```

Hand landmarks are drawn and exported in clips, but the classifier uses only
the 15 normalized body landmarks (`MODEL_POINTS`) — fingers were too noisy.

Recognition now checks fresh observations in Solo, 1v1 and Party. Missing or
unreliable torso landmarks pause charge immediately; a gap over 250 ms clears
the motion window (the charge meter keeps its ratchet). Predictions expire
after 500 ms and can only charge their current accepted label. Reacquiring a
player requires 15 new uniform samples. A joint that is low-visibility or out
of frame in more than 20% of the window is omitted from live similarity
comparisons. Words whose difference lies mostly in the legs (`legLabels`,
learned by `buildModel`) also require reliable knees and ankles.
The live classifier says “unsure” unless the nearest example has cosine at
least .66 and beats the nearest competing word by .005. `classify()` retains
closed-set scores for historical deck comparisons; `classifyDetailed()` applies
the live rejection check by default.

New exports use dataset version 3. Each new clip includes `captureVersion:3`,
camera width/height, per-frame millisecond `timestamps`, body `visibility` and
`inFrame` arrays, and `coordinateSpace:"torso-reference-16:9-v1"`. Coordinates
are projected into a common 16:9 reference before torso normalization, so camera
aspect ratio no longer changes the pose. The reference preserves the existing
16:9 feature scale. Training and live input resample to `SAMPLE_MS=66`; training
splits at tracking gaps or unreliable frames and uses only clear continuous
sections. A new take needs at least one clear second. Framing guidance uses
actual visibility and image bounds, so bending the legs is not treated as cropping.

Legacy clips without camera dimensions/timestamps retain their original
coordinates and nominal sample grid; their original aspect ratio cannot be
recovered. Clips with known legacy geometry are migrated on import. Exporting
a mixed deck preserves which clips are legacy. The bundled recordings have
not been changed. `train_model.py` uses the same timing/quality preprocessing
for version 3 exports.

Pose reliability checks:

```bash
node --test scripts/pose-reliability.test.mjs       # from repository root
node scripts/pose-deck-eval.mjs                    # weighting + live rejection
node scripts/pose-deck-eval.mjs --modes global --quick --open-set
cd e2e && npm run pose                            # static host on port 8123
```

At checkpoint `9945afa` the 87-clip/38-word deck scored 76.0% on 570 held-out
windows (58.2% with .02 landmark jitter). The same closed-set baseline is
preserved. Live rejection accepts 493 windows: 412 correct and 81 wrong; it
rejects 56 previously wrong guesses and 21 previously correct ones. This is
a precision/coverage tradeoff, not a new-player accuracy claim. Leave-one-word-out
diagnostics reject 172/558 unseen-action windows; 386 still resemble a known
word. Held-out idle has 0/12 false action guesses and 6 abstentions. Synthetic
transitions reject 8/45 windows. Real varied negative recordings and live play
are still needed to validate or improve rejection beyond this baseline.

The feature vector now also carries the mean and spread of 12 joint-to-joint
distances (wrist to nose, wrist to wrist, wrist to hip, ankle to ankle, and
others). A distance does not move when the hip centre moves, so hip and leg
jitter hurts much less. The similarity threshold moved from .55 to .66 with
it, because the same number rejected less in the larger space. Same deck:

| Weighting | Clean | Jitter .02 |
| --- | ---: | ---: |
| None | 73.7% | 63.3% |
| Global (shipped) | 76.1% | 66.1% |
| Per-word | 73.3% | 52.6% |
| Hybrid | 61.1% | 39.6% |
| Mixed | 69.6% | 62.8% |

Live rejection now accepts 490 windows (411 correct), rejects 57 wrong
guesses and 23 correct ones, and rejects 183/558 unseen-action windows.
Held-out idle has 1/12 false action guesses and 5 abstentions.

## Party mode (2v2–3v3)

Everyone performs the **same word at once**. Each team's featured player fills
their half of the split; team-mates ride the centre tiles. Placement across
both teams pays `100/80/60/50/40/30`, plus `+2` per whole second left on the
word clock. The first team with every member recognized banks `+150` and opens
a **five-second final chase** for the other side — chasers score their normal
placement and time points, with none of the quadratic decay 1v1 applies. The
match is decided on **total score when the match clock expires**; round wins
are reported for feedback only.

The server is authoritative: `party:claim` carries a synchronized recognition
timestamp, and finishes are sorted by timestamp when the round resolves, so a
late packet with an earlier stamp still places correctly. A provisional
placement broadcasts immediately (`party:got`) so borders and stickers land
without waiting for the round to end. Party rooms collect every player's word
list, because the deck is the intersection across all of them.

Video is a WebRTC mesh (one link per pair) built in the lobby and handed
straight to the match — nothing is renegotiated at start.
Party sender feeds are capped at 24 fps and pose inference processes only
fresh camera frames (about 30 Hz maximum). The classifier still receives its
normal ~15 body samples per second; hand inference remains available in
Training but is skipped during matches because it is not part of kNN features.

## Online 1v1

Pick **1v1 Showdown** → create a room and read your friend the 6-letter code
(or join with theirs). Works only when the game is served by the Node server
in `../server`.

How it fits together:

- The **server is authoritative**: it deals a shared word from the
  intersection of both players' trained word lists and owns the two-minute
  match clock, 20-second word clocks, score totals, five-second chase
  windows, and sudden death. The first recognition earns 300–500 based on
  time remaining; a successful chaser receives the same base award with
  continuous quadratic decay. Stale round ids, duplicate claims, and
  out-of-window claims are rejected; client-reported scores are never
  trusted.
- **Classification remains local.** Each browser runs MediaPipe and the kNN
  on its own player. Pose/face landmarks and training data are never sent.
  During 1v1, only the current top label/confidence is relayed ephemerally so
  the opponent's paper can update; recognition submits a synchronized
  timestamp ("my AI passed the threshold at this server-clock time").
- **Video is peer-to-peer WebRTC** (the server only relays the opaque
  connection handshake). Nothing is recorded or stored. Without a TURN
  server, some strict NATs may fail to connect video — the match still
  works, you just can't see each other.
- Round timing is synced with a clock-offset ping, so both players see the
  same countdown and timer and network arrival latency never changes score.

## Testing

- `cd ../server && npm test` — server integration test (full match with two
  real socket clients, chase scoring, sudden death, and rejection paths).
- `cd ../e2e && npm install` then:
  - `npm run offline` — browser checks against a static host on port 8123
    (`python3 -m http.server 8123` in this folder first).
  - `npm run online` — spawns the real server and two isolated
    headless-Chrome players who play a full match over Socket.IO + WebRTC.
  - `npm run party` — spawns the real server and four isolated players who
    fill a party lobby, start a 2v2, and play a round through the completion
    bonus and the final chase. `PARTY_DEBUG=1` tees the server log.

All three suites use Chrome's fake camera; the only simulated part is the vision
input (classifier output is seeded, then real `gameCheck()` scoring runs).
Manual browser testing is still needed for anything involving a real body in
front of a real camera — see "Manual test checklist" below.

## Manual test checklist

- Camera permission prompt, then skeleton overlay tracks you.
- Train two words + idle, watch live guesses, play a round for real.
- Online: two machines (or two browser profiles), create/join, confirm you
  see each other's video and the same word, and that acting the word out
  scores for the right player.

## Notes

- `index.html` has no embedded training data.
- Start Playing launches Play with AI.
- Hand markers are visual only; body pose is used for scoring.
- A point banner appears when a word is won, then the word card animates to the next word.

## UI (POSE PARTY overhaul)

The interface was rebuilt to the POSE PARTY mockups: home (mode cards +
how-to strip), solo play (word card, AI top-guess meter), 1v1 lobby (room
code boxes, share link, host match settings), 1v1 match (full split video,
Figma paper HUD, live chase state, and leader crown), and the party-mode
waiting room. There is exactly one
local camera `<video>` — a "camera dock" that gets reparented into whichever
screen is active — so MediaPipe never re-initializes. Paper art is stored in
`assets/ui/figma/`; the HUD remains HTML so names, timers, and scores stay live.

Party mode is a waiting room only (join/switch teams, room code, locked
start) — the team game itself is not built yet.
