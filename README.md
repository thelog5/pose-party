# Pose Charades

A browser charades game: act out a word in front of your webcam and a local
AI (MediaPipe pose landmarks + a kNN motion classifier) guesses it. Includes
Play-with-AI, a practice 1v1 against a robot rival, an AI-training studio,
and online private-room 1v1 with peer-to-peer video.

| Directory | What it is |
| --- | --- |
| `pose-charades-external-data/` | The game (static ES modules, no build step). Its README covers architecture, game states, and data flow. |
| `server/` | Node/Express/Socket.IO server: serves the game and runs authoritative online 1v1 rooms. `npm start`, config via env (`.env.example`). |
| `e2e/` | Headless-Chrome end-to-end suites (offline + online) using a fake camera. |

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
# offline suite needs a static host first:
#   (cd pose-charades-external-data && python3 -m http.server 8123) &
npm run offline
```

## Privacy

Video is WebRTC peer-to-peer and never recorded. Pose landmarks, training
data, and classifier output never leave the browser; the server sees only
names, word labels, point claims, and opaque connection handshakes.
