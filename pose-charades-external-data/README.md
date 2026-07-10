# Pose Charades

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
cd pose-charades-external-data
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
| `online.js` | Online 1v1: lobby, server events → FSM, point claims. |
| `webrtc.js` | Peer-to-peer video link for online 1v1. |
| `screens.js` | Maps FSM states to visible chrome. |
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
```

- **countdown** — 3·2·1 overlay before the first word; backing out (gear/logo)
  cancels the game cleanly.
- **playing** — the only state that accepts score events. A point is awarded
  when the top prediction equals the current word, confidence is over the
  threshold (`THRESH`), and it stays valid for the stability window
  (`HOLD_MS`).
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

## Online 1v1

Pick **1v1 Showdown** → create a room and read your friend the 6-letter code
(or join with theirs). Works only when the game is served by the Node server
in `../server`.

How it fits together:

- The **server is authoritative**: it deals a shared word from the
  intersection of both players' trained word lists, times each round, and
  awards exactly **one point per word to the first valid claim**. Stale
  round ids, duplicate claims, and out-of-window claims are rejected;
  client-reported scores are never trusted.
- **Classification never leaves your device.** Each browser runs MediaPipe
  and the kNN on its own player and submits only a claim ("my AI passed the
  threshold"). Landmarks, training data, and classifier output are never
  sent anywhere — which is also why the rival's guess panel shows a note
  instead of live guesses.
- **Video is peer-to-peer WebRTC** (the server only relays the opaque
  connection handshake). Nothing is recorded or stored. Without a TURN
  server, some strict NATs may fail to connect video — the match still
  works, you just can't see each other.
- Round timing is synced with a clock-offset ping, so both players see the
  same countdown and timer.

## Testing

- `cd ../server && npm test` — 34-assertion server integration test
  (full match with two real socket clients + every rejection path).
- `cd ../e2e && npm install` then:
  - `npm run offline` — 30 checks against a static host on port 8123
    (`python3 -m http.server 8123` in this folder first).
  - `npm run online` — 20 checks: spawns the real server and two isolated
    headless-Chrome players who play a full match over Socket.IO + WebRTC.

Both suites use Chrome's fake camera; the only simulated part is the vision
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
