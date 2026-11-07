# Client

The game itself. Plain ES modules, HTML and CSS, with no build step and no
framework. The browser loads `index.html`, which loads `js/main.js`.

## Running it

The Node server in `../server` serves this folder and runs the online rooms:

```bash
cd ../server && npm ci && npm start     # http://localhost:3000
```

Solo mode also works from any static host, because it needs no server:

```bash
python3 -m http.server 8000             # from this folder
```

Do not open `index.html` as a file. The browser blocks the pose deck from
loading over `file://`.

The art (`assets/ui/`) and the pose deck (`assets/data/pose-charades-data.json`)
are not in the public repository, so a fresh clone does not show a playable
game.

## Stylesheets

`index.html` is markup only. The stylesheets are linked in cascade order.
`theme.css` and every file after it deliberately override the files above
them, so do not reorder the `<link>` tags.

## Modules

**Vision and recognition**

| Module | Responsibility |
| --- | --- |
| `engine.js` | Camera, MediaPipe setup, the per-frame vision loop and its watchdog. |
| `smooth.js` | One Euro filter over each landmark set. |
| `pose.js` | Normalises landmarks into a hip-centred, torso-scaled frame. |
| `poseInput.js` | Uniform sampling, the motion window and prediction freshness. No DOM. |
| `poseData.js` | Validates and migrates deck exports. |
| `classifier.js` | Pure kNN: features, standardisation, cosine similarity, voting. |
| `recognition.js` | The charge meter that turns guesses into a recognised word. |
| `presence.js` | Where the player is and whether they are too close. |
| `speed.js` | Detects a slow computer and lightens the work. |
| `training.js`, `capture.js`, `data.js` | Training studio: record takes, fit the model, import and export decks. |

**Game flow**

| Module | Responsibility |
| --- | --- |
| `main.js` | Entry point: wires DOM events, then boots. |
| `fsm.js` | The game state machine. DOM-free. |
| `screens.js` | Maps states to screens and moves the camera dock between them. |
| `state.js`, `constants.js` | Shared state and tunables. |
| `game.js`, `soloRound.js` | Solo and practice 1v1 round loops, scoring and the award sequence. |
| `rival.js` | Simulated opponent for practice 1v1. |
| `scoring.js`, `wordOrder.js` | Point formulas and deal order. Shared with the server, so no browser APIs. |
| `wordStats.js` | Anonymous per-word results, sent only when the server turns them on. |

**Online play**

| Module | Responsibility |
| --- | --- |
| `online.js` | Online 1v1: lobby, server events, recognition claims, reconnect handling. |
| `webrtc.js` | Peer connection wrapper: ICE restart and light-video mode. |
| `party.js` | Party lobby: roster, teams and the WebRTC mesh. |
| `partyMatch.js` | Party match: seating, handovers, remote-feed watchdog. |
| `seatAward.js` | Points papers stamped on the player who earned them. |

**Screens and characters**

| Module | Responsibility |
| --- | --- |
| `cameraGate.js`, `ageGate.js`, `howToPlay.js` | Boot camera screen, age check before online play, tutorial card. |
| `homeAlive.js`, `lobbyAlive.js` | Home and lobby entrances and idle motion. |
| `robot.js`, `robotDialogue.js` | The gameplay robot: a jointed puppet that reacts to the meter and lip-syncs its lines. |
| `paperRig.js` | The menu robot that follows the cursor. |
| `results.js`, `photoStrips.js` | Results screens, awards and the photo-strip board. |
| `ui.js`, `gameplayFeedback.js`, `textFit.js`, `alphaHit.js` | Toasts, flashes, text fitting and hit testing on irregular art. |
| `support.js` | The optional donation link. |
| `dom.js`, `draw.js`, `audio.js` | Small helpers. |

## Game states

All flow control goes through the state machine in `js/fsm.js`:

```
menu ──────────► countdown ──► playing ◄──► word-won
  │  ▲              ▲             │             │
  ▼  │              │             ▼             ▼
training        results ◄─────────┴─────────────┘
  (also menu ◄──► lobby for online 1v1,
   and  menu ◄──► party for the Party lobby)
```

- **countdown**: the full-body check and the 3·2·1. Leaving it cancels the
  game cleanly.
- **playing**: the only state that accepts score events.
- **word-won**: entered once per word, when it resolves. Because
  `playing → word-won` can fire only once per word, this transition is the
  scoring lock. Two code paths cannot both award the same word.

Illegal transitions are rejected and logged instead of crashing the game.

## Data flow

```
webcam ─► MediaPipe Pose ─► One Euro filter ─► normalise (pose.js)
       ─► 30-sample window at 66 ms (poseInput.js)
       ─► features ─► kNN against the deck (classifier.js)
       ─► charge meter (recognition.js) ─► score (game.js / server)
```

The classifier reads 15 body landmarks. Hand landmarks are tracked only in the
training studio.
