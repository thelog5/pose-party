# Pose Party

**Charades in the browser, where an AI watches your webcam and guesses the word you act out.**

<!-- DEMO VIDEO: on github.com, edit this file and drag Poseparty-Demo-30s-github.mp4 onto this line. -->

**[Play it at poseparty.ca](https://poseparty.ca)** · Built by [Logan Li](https://www.linkedin.com/in/logan-li-9089b7216/)

## What it is

You get a word, like *guitar* or *froggy jump*, and you act it out in front of
your camera. The AI tracks your body and guesses live. When it is sure, you
score. The faster it gets it, the more points you get.

- **Solo:** race the clock against the AI.
- **1v1:** play a friend over live video. Whoever the AI recognises first gets the most points.
- **Party:** two teams of two or three. Everyone acts out the same word at once.

Everything that looks at your body runs in your browser. Your video goes only
to the other players in your game, and the game server never sees it.

## How it works

<!-- ARCHITECTURE DIAGRAM: drag the architecture image onto this line. -->

1. **MediaPipe** finds 33 body points in each camera frame. A One Euro filter
   removes the jitter.
2. The game turns about two seconds of movement into a feature vector.
3. A **k-nearest-neighbour classifier** compares that vector with recorded
   examples of every word.
4. A **charge meter** fills while the AI keeps guessing the right word, so a
   one-frame lucky guess never scores.
5. In online games, the **server** checks each claim and keeps the score. The
   players' video goes **peer to peer** with WebRTC.

The full design notes, with the measurements behind each decision, are in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Engineering highlights

- **Accuracy that was measured.** I tested every classifier change with
  leave-one-clip-out evaluation. Two changes did most of the work: mirroring
  every clip, and standardising the features. Together with time-scaling, they
  raised accuracy from 63% to 88% on an early word list. The current list of
  35 words scores 84.6%.
- **Fair online play.** Clients never send scores. They send the moment the
  AI recognised them, on a clock shared with the server. Lag never changes
  who wins.
- **Built for phones.** A dropped connection keeps its seat for 30 seconds.
  A watchdog restarts the camera loop when a phone pauses the camera.
- **One small server holds a lot.** A load test ran 200 rooms (1,200
  simulated players) on one process at 32% of one CPU core.
- **Works on weak computers.** The game times the pose model at startup and
  switches to the faster path. On a computer with no graphics acceleration,
  tracking went from 6.6 to 19.8 frames per second.
- **Tested like a real match.** Headless Chrome plays full 1v1 and Party
  matches against the real server, with a fake camera.

## Built with

JavaScript (ES modules, no framework, no build step) · HTML and CSS ·
MediaPipe · WebRTC · Node.js · Express · Socket.IO · Puppeteer · Python for
the art pipeline · Render and Cloudflare for hosting

## Status

Live and playable at [poseparty.ca](https://poseparty.ca).

This repository has the source code only. The art and the recorded pose data
are private, so a fresh clone runs the server and the tests but not the full
game.

## Run it locally

Requires Node 22.9 or later.

Start the server:

```bash
cd server && npm ci && npm start     # http://localhost:3000
```

Run the tests, from the repository root:

```bash
node --test scripts/pose-reliability.test.mjs     # pose and classifier unit tests
(cd server && npm test)                           # server tests with real sockets
```

The browser test suites in `e2e/` need the private art and pose data.

## Repository layout

| Path | Contents |
| --- | --- |
| [`client/`](client/) | The game: HTML, CSS and 46 JavaScript modules. [Module map](client/README.md). |
| [`server/`](server/) | Game server and its integration tests. |
| [`e2e/`](e2e/) | Headless-Chrome test suites and measurement scripts. |
| [`scripts/`](scripts/) | Classifier evaluation and asset tools. |
| [`docs/`](docs/) | Architecture and design notes. |

## License

The code is under the [MIT License](LICENSE). The art, the pose data and the
Pose Party name are not included and are not covered by the license.
