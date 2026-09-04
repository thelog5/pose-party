# Pose Charades

A browser charades game: act out a word in front of your webcam and a local
AI (MediaPipe pose landmarks + a kNN motion classifier) guesses it. Includes
Play-with-AI, a practice 1v1 against a robot rival, an AI-training studio,
online private-room 1v1, and 2v2–3v3 Party mode — both with peer-to-peer
video.

| Directory | What it is |
| --- | --- |
| `pose-charades-external-data/` | The game (static ES modules, no build step). Its README covers architecture, game states, and data flow. |
| `server/` | Node/Express/Socket.IO server: serves the game and runs authoritative 1v1 and Party rooms. `npm start`, config via env (`.env.example`). |
| `e2e/` | Headless-Chrome end-to-end suites (offline, online 1v1, party) using a fake camera. |

## Quick start

```bash
cd server
npm install
npm start          # http://localhost:3000 — full game incl. online 1v1
```

## Tests

```bash
cd server && npm test        # server integration (full match + abuse cases)
cd e2e && npm install
npm run online               # spawns server + two headless players
npm run party                # spawns server + four headless players (2v2 round)
# offline suite needs a static host first:
#   (cd pose-charades-external-data && python3 -m http.server 8123) &
npm run offline
```

## Privacy

Video is WebRTC peer-to-peer (a full mesh in Party) and never recorded.
If a TURN relay is configured (off by default, see `server/.env.example`),
links that cannot connect directly are carried by it. WebRTC media is
DTLS-SRTP encrypted between the two browsers, so a relay forwards packets it
holds no key for and cannot see the video. That is the difference between a
relay and an SFU, and it is why this project will never have an SFU.
Pose/face landmarks and training data never leave the browser — including the
head tracking that places the 1v1 crown and the Party "GOT IT" sticker, which
only ever runs on your own camera. During 1v1 and Party the server relays the
current top guess label and confidence so opponents' papers can update; it also
sees names, trained word labels, synchronized recognition timestamps, and
opaque connection handshakes. Live guesses are not stored.
