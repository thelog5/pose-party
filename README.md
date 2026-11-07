# Pose Party

A browser charades game played with your whole body. You act out a word in
front of your webcam, and an AI that runs in your browser tries to guess it.
You can play alone against the AI, 1v1 against a friend, or in teams of up to
six in Party mode, with live video between all players.

**Play it:** [poseparty.ca](https://poseparty.ca)

This repository holds the source code. The art, the trained pose data and the
name are not included (see [What is not in this repo](#what-is-not-in-this-repo)).

## Highlights

- **Pose recognition in the browser.** MediaPipe finds 33 body landmarks per
  frame. A One Euro filter removes jitter. A k-nearest-neighbour classifier
  compares two-second motion windows against recorded takes of each word.
  No video and no landmarks leave the device.
- **Measured model work.** Every classifier change was tested with
  leave-one-clip-out evaluation on the recorded deck
  (`scripts/pose-deck-eval.mjs`). Mirroring every clip, standardising the
  feature space and time-scaling took held-out accuracy from 63% to 88% on
  an early deck. The current deck (35 words, 174 clips) scores 84.6%.
- **Authoritative multiplayer server.** Node, Express and Socket.IO. The
  server deals words, owns every clock and computes every score. Clients send
  a synchronised recognition timestamp, so network delay never changes a
  result. A dropped phone connection keeps its seat for 30 seconds.
- **Peer-to-peer video.** WebRTC, a full mesh in Party mode. The server only
  relays the connection handshake. An optional TURN relay uses short-lived
  credentials and a spend cap that fails closed.
- **Load tested.** A headless harness drove 200 rooms (1,200 simulated
  players) on one process at 32% of one CPU core, with a p95 ack time of
  23 ms. A later change cut the guess relay from five recipients to one.
- **Works on slow hardware.** The game times the pose model at boot. On a
  computer without a usable GPU it switches to the CPU path, which raised
  pose tracking from 6.6 to 19.8 frames per second in testing. A watchdog
  restarts the vision loop when a phone pauses the camera.
- **No build step.** The client is plain ES modules, HTML and CSS. The UI is
  built from Figma frames: every position is a frame percentage, and type
  scales with container query units, so layouts hold at any aspect ratio.
- **Tested end to end.** A server integration suite plays full matches with
  real socket clients. Four headless-Chrome suites play Solo, 1v1 and a 2v2
  Party round with a fake camera. More than 50 probe scripts measure layout,
  timing and recovery behaviour.

## Architecture

```
            browser (each player)                         server (Node)
 ┌──────────────────────────────────────────┐     ┌──────────────────────────┐
 │ webcam ─► MediaPipe Pose ─► One Euro     │     │ Express: game files,     │
 │        ─► normalise ─► 1 s window        │     │   access gate, stats     │
 │        ─► features ─► kNN ─► charge meter│     │ Socket.IO: rooms, clocks,│
 │                                          │◄───►│   scoring, signaling     │
 │ game state machine (fsm.js) ─► screens   │     │ (rooms live in memory)   │
 └──────────────┬───────────────────────────┘     └──────────────────────────┘
                │ WebRTC video, peer to peer (the server never sees it)
                ▼
         other players' browsers
```

The full design notes, with the measurements behind each decision, are in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Repository layout

| Path | Contents |
| --- | --- |
| `client/` | The game: `index.html`, `css/`, and 46 ES modules in `js/`. See [client/README.md](client/README.md) for the module map. |
| `server/` | The game server and its integration test. |
| `e2e/` | Headless-Chrome suites (`*.test.mjs`) and measurement probes (`_*.mjs`). |
| `scripts/` | Model evaluation, deck tools and the art pipeline. |
| `docs/` | Architecture and design notes. |
| `render.yaml` | Deployment blueprint for Render. |

## Running it

Requirements: Node 22.9 or later, and Chrome for the browser tests.

```bash
cd server
npm ci
npm start            # http://localhost:3000
```

The game needs its art and pose deck in `client/assets/` to run. They are not
in this repo, so a fresh clone starts the server but does not show a playable
game.

## Tests

```bash
node --test scripts/pose-reliability.test.mjs   # pose and classifier unit tests
(cd server && npm test)                         # full matches with real socket clients
cd e2e && npm ci
npm run online                 # two headless players, a full 1v1 match
npm run party                  # four headless players, a 2v2 round
npm run offline                # Solo and UI checks (static host on 8123)
```

The server tests and the unit tests run on a fresh clone. Checks that need
the private pose deck are skipped. The browser suites need the art and the
deck, like the game itself.

## What is not in this repo

- **Art.** All images, the robot rig layers and the Figma sources.
- **Pose data.** The recorded training deck
  (`client/assets/data/pose-charades-data.json`). It contains body motion
  recorded by real people.
- **Private notes and tooling.** Working notes, the security audit and
  editor configuration.

## License

The source code is under the [MIT License](LICENSE). The license does not
cover the art, the pose data or the "Pose Party" name, none of which are in
this repository.

## Author

Made by Logan Li. [LinkedIn](https://www.linkedin.com/in/logan-li-9089b7216/)
