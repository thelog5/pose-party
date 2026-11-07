# Architecture and design notes

This document explains how Pose Party works and why it is built this way.
Most decisions here were made from a measurement, and the numbers are given
with them. The scripts and probes that produced them are in `scripts/` and
`e2e/`.

## Overview

Pose Party has three parts:

- **The client** (`client/`) runs everything a player sees: the camera, pose
  tracking, the classifier, the screens and the WebRTC video.
- **The server** (`server/`) serves the client and runs online rooms. It deals
  words, owns every clock and computes every score. It never receives video or
  body landmarks.
- **The tests** (`e2e/`, `server/test/`) play real matches with real sockets
  and headless Chrome.

Recognition is local on purpose. A player's body never leaves their device,
and the server has nothing expensive to compute.

## Pose recognition

### Pipeline

1. **MediaPipe Pose** (`pose_landmarker_full`) gives 33 landmarks per frame.
   The game keeps 15 body joints.
2. **One Euro filter** (`smooth.js`). The filter cutoff depends on speed. A
   still joint gets heavy smoothing, because its movement is all jitter. A
   fast joint gets almost none, because its movement is all signal. A fixed
   moving average cannot do this: on the recorded deck it cost 7 accuracy
   points at alpha .45 and 27 points at alpha .3, because it flattens the
   velocity features. The filter runs once, so the skeleton overlay and the
   classifier read the same numbers.
3. **Normalisation** (`pose.js`). Each frame is moved so the hip centre is at
   the origin and scaled by the torso length.
4. **Windowing** (`poseInput.js`). Frames are resampled to a fixed 66 ms grid
   and grouped into 30-sample windows (about two seconds of motion).
5. **Features and kNN** (`classifier.js`). Each window becomes a vector of
   each joint's mean position, spread and speed, plus the mean and spread
   of 12 joint-to-joint distances. The vector is
   standardised and compared by cosine similarity to every training window.
   The 7 nearest neighbours vote.
6. **The charge meter** (`recognition.js`) decides when a guess counts.

### The charge meter

The kNN is decisive. A pose it knows goes from 0 to 0.9 confidence in two
samples, so a progress bar that shows raw confidence fills before the player
can react to it. The meter is a charge that the player earns over time
instead:

- Confidence above a gate adds charge. Below the gate, charge drains.
- The charge rate falls as the meter fills, so the last part takes the most
  effort.
- The gate relaxes as the word clock runs down. Early catches are strict and
  pay more. Late catches are forgiving, so a word the model is unsure of still
  resolves.
- Draining stops at a fraction of the peak, so a short wobble costs a moment,
  not the word.
- Charge needs both the latest raw guess and the smoothed top guess to be the
  target word.

The percentage on screen is a concave curve over the true charge, capped at
99 until the word locks. A bar that reads 100 while nothing happens is the
most frustrating thing a meter can do.

### Classifier measurements

All numbers are leave-one-clip-out window accuracy on the recorded deck
(`node scripts/pose-deck-eval.mjs`). This is the honest test when a word has
only a few takes: no window of a held-out clip is in the training set.

| Change | Effect |
| --- | --- |
| Mirror every clip (swap left and right joints) | +15 points. Nobody performs a mime with a fixed hand. |
| Standardise each feature dimension | +8 points. Every person has a similar average posture, so before this the whole deck sat at cosine .82 to .99 to itself. |
| Time-scale each clip (0.8x, 1x, 1.25x) | +0.5 points. Players do not perform at the recording's tempo. |
| Joint-to-joint distance features | With hip and leg jitter: 58.2% to 66.1%. A distance does not move when the hip centre does. |
| Relative standard-deviation floor | With hip jitter: 35% to 74%, clean accuracy unchanged. |

Together the first three changes took an early deck from 63.4% to 88.1%. The
current deck has 35 words and 174 clips, with at least three takes of every
word. It scores **84.6%**, and **80.4%** with simulated landmark jitter.

**The standard-deviation floor is the subtle one.** The hips sit on the
origin by construction, so their spread is about .01, against .3 to .9 for
the wrists. An absolute floor divided hip noise by .01, and the least useful
dimensions became the loudest. The floor is now relative to the median of its
own feature block. Clean accuracy cannot show this bug, because a recorded
query is exactly as noisy as the training data. Only the jitter test can.

### What did not work

These were measured and rejected:

- **Per-word joint weighting.** The idea: a squat is legs, so weight the
  squat toward the legs. Measured, it did the opposite. Down-weighting the
  arms cut squat from 46% to 31%. Down-weighting the legs raised it to 62%,
  because in those takes the leg landmarks were noise. The camera knows what a
  take looked like. A hand-written weighting only knows what it should look
  like. More takes, recorded with varied arm positions, fixed it instead.
- **Scaling by shoulder width** instead of torso length. It is immune to hip
  noise but cost 15 points of clean accuracy, because shoulder width shrinks
  when a player turns.
- **Trajectory features, net displacement, 1-NN, one vote per take, a
  shorter window, and every K other than 7.** All scored lower.

### Framing

The **MOVE BACK** warning reads raw landmark coordinates, not MediaPipe's
visibility score. MediaPipe marks a joint that has left the frame as low
visibility, so a visibility test hides exactly the signal it looks for. The
warning has hysteresis: it goes up when the head, a knee, a shoulder or a hip
is cut off, and comes down only when the whole body is clearly inside the
frame.

## Multiplayer server

### Authority

Clients never report scores. When a player's local AI recognises the word,
the client sends a claim with a recognition time on the synchronised server
clock. The server checks the round id and the time window, rejects
duplicates, and computes the points. In Party mode it sorts finishes by
timestamp when the round resolves, so a late packet with an earlier time
still places correctly. Network delay never changes a result.

Scoring formulas live in `client/js/scoring.js`, which has no browser
dependencies. The server imports the same file, so the client's preview of a
score and the server's real score cannot drift apart.

### Rooms

- Rooms live in memory in one process. The deployment runs exactly one
  instance for this reason (`render.yaml`).
- Rate limits are per-IP token buckets. Entering a lobby creates a room, so
  the create limit is a gameplay setting, not only abuse protection. At the
  old limit of 5 per minute, six trips into a lobby locked a household out
  of online play. The defaults are now 30 and 60.
- The deal order puts never-seen words first, then the oldest seen words,
  merged across every player in the room (`wordOrder.js`). In simulation this
  cut words repeated from the previous match from 24% to 0%, and the longest
  wait for a word from 437 deals to 54.

### Reconnects

Phones drop their socket often: a network change, a lock screen, a
notification shade. The server used to treat the first `disconnect` as a
departure and destroy the room. Now:

- A dropped player keeps their seat for 30 seconds (`REJOIN_GRACE_MS`). An
  explicit exit still leaves at once.
- Socket.IO connection-state recovery restores the same socket id, so every
  room, seat and peer keyed by that id still works.
- The server sends `net:hello` on every connect. Recovery needs the id of the
  last event a client received, and acknowledgements do not carry one. A
  player sitting alone in a lobby had received no events, so they could never
  be recovered until this was added.

### Capacity

`e2e/_loadtest.mjs` drives rooms of six plain Socket.IO clients at the real
guess rate. On an 8-core Apple M-series machine, 200 rooms (1,200 players) used 32% of one
core, with a p95 acknowledgement time of 23 ms.

The largest cost was the guess relay. Each player's live guess went to all
five other players, and each client displays only one rival. Clients now tell
the server which rival they show (`party:watch`). At 50 rooms this cut
delivered messages from 6,150 to 1,243 per second and CPU from 15% to 7%.
Older cached clients never send `party:watch`, so they keep the old broadcast
until they reload.

## Video

- **Peer to peer.** 1v1 is one WebRTC link. Party is a full mesh. The server
  relays only the signaling messages.
- **TURN is optional and off by default.** A relay forwards encrypted packets
  it cannot decrypt, so it does not change who can see the video. An SFU would
  decrypt the media, so the game does not use one. TURN adds reach for players
  behind strict NATs; it does not reduce anyone's upload.
- **Credentials are short-lived.** Cloudflare credentials are minted by the
  server and cached. Shared-secret TURN uses signed usernames that expire. A
  TURN URL with no credentials serves no relay, because an open relay is found
  and abused quickly.
- **The spend cap fails closed.** The server reads its own relay usage from
  Cloudflare's analytics API. With no reading, or a stale one, it serves
  STUN only.
- **Remote feed watchdog.** A video with no new frame for 3 seconds gets its
  stream attached again, which starts a new decoder. A second freeze asks the
  link for an ICE restart. Each remote player has one `<video>` element for
  the whole match, and seat changes move it instead of creating a new one,
  because a new element stays black until the next key frame.

## Performance and resilience

- **Software WebGL.** On a computer with no usable GPU, Chrome runs WebGL in
  software, and MediaPipe's GPU delegate takes about 190 ms per call against
  14 ms on the CPU delegate. The game detects this at boot and picks the CPU
  path: 6.6 to 19.8 pose frames per second, and 5 to 55 page frames per
  second. A GPU delegate that is merely slow is timed against the CPU
  delegate once on the live camera, and the faster one is kept.
- **Slow computer mode.** When model calls are slow, the model runs at the
  classifier's own rate, the face model turns off, and video is lighter in
  both directions.
- **Stalls are not lost players.** A slow computer often stalls for 250 ms.
  The motion window used to reset on every stall. It now survives a stall of
  up to one second. In a simulation, resets in ten seconds fell from 4 to 0,
  and a held pose could charge over 93% of the time instead of about 38%.
- **The vision loop has a watchdog.** The loop is driven by video frame
  callbacks, so a paused camera (common on phones) stopped it for good. A
  timer now checks for new frames every second and restarts the stream and
  the loop. A model call that throws is caught, and five throws in a row
  rebuild the model with backoff.

## UI system

- **Figma is the source of layout.** Every screen is a 16:9 stage that
  letterboxes. Each element is placed at its Figma frame percentage.
- **Type scales with its container.** Each card sets
  `container-type:inline-size`, and its type is in `cqw` (the Figma pixel size
  divided by the card's Figma width). Text is fixed relative to its card at
  any viewport, as it is in Figma.
- **Aspect ratios come from the Figma rectangle, not the image.** Figma
  stretches its papers. One asset appears at three different aspect ratios on
  three screens.
- **Text that varies gets a measured fit.** Deck words like "spiking a
  volleyball" do not fit a box designed for "JUMPING". Fitting uses layout
  metrics (`scrollWidth`), never `getBoundingClientRect`, which includes any
  running transform.
- **The robot is a jointed puppet.** Each part is a separate layer on a shared
  canvas, with pivots and a parent chain. A chain of rotations about different
  pivots reduces to one rotation plus one translation, so a hand four joints
  deep still costs one CSS transform. Each joint has a limit measured by
  sweeping it against the art: past it, the cut paper stops reading as a
  joint. The rig also follows the player, with separate time constants
  (80, 300 and 500 ms): the eyes lead and the body follows. The lag
  between them is what reads as intent.
- **Hit areas follow the art.** Paper images have transparent corners.
  `alphaHit.js` turns pointer events off while the pointer is over a
  transparent pixel.

## Privacy and safety

- Video goes peer to peer. Landmarks and training data stay in the browser.
  During a match the server relays only the current top guess label and its
  confidence, so a rival's guess paper can update.
- Word stats are anonymous totals per word. No names, ids or body data, and
  they are off unless the server has a stats token.
- Online play asks for a birth month and year first. The question is neutral:
  every year is listed and nothing on the screen says which answer gets in,
  as the FTC's COPPA guidance asks. Under-13 players are kept to Solo mode. Only the
  result is stored, not the birthday.
- The optional access gate is a signed cookie, not HTTP Basic auth, because
  browsers do not reliably send Basic credentials on a WebSocket upgrade. The
  signing key is separate from the access code, so a cookie cannot be used to
  guess the code offline.
- The server has a final error handler that never shows a stack trace, caps
  request and socket message sizes, refuses to serve `.md` and `.py` files,
  and escapes every remote string before it reaches the DOM.

## Testing

| Suite | What it does |
| --- | --- |
| `server/test/integration.test.js` | Full 1v1 and Party matches with real Socket.IO clients: scoring, chases, sudden death, reconnects, rate limits and bad payloads. |
| `e2e/offline.test.mjs` | Solo mode and UI behaviour in headless Chrome. |
| `e2e/online.test.mjs` | Two headless players play a full online 1v1 over Socket.IO and WebRTC. |
| `e2e/party.test.mjs` | Four headless players play a 2v2 Party round, including the team bonus and the final chase. |
| `e2e/pose.test.mjs` | Pose input checks against the vision fixture. |
| `scripts/pose-reliability.test.mjs` | Unit tests for normalisation, sampling, the classifier and the charge meter. |
| `e2e/_*.mjs` | Probes that measure one behaviour each: layout at phone sizes, recovery from a stalled camera, ICE restarts, load. |

The browser suites use Chrome's fake camera. The only simulated part is the
classifier output; scoring, networking and rendering are real.
