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

## Deploy on Render

`render.yaml` is a Render Blueprint. It runs ONE instance on purpose: rooms
live in memory, so a second instance cannot see the first one's rooms.

1. In Render, choose **New > Blueprint**, pick this repo, and pick the branch
   to deploy.
2. Fill in the environment values it asks for:

   | key | value |
   | --- | --- |
   | `ACCESS_CODE` | the code players type to get in. Leave it empty to open the game to everyone. |
   | `ACCESS_SECRET` | nothing to do: Render generates a long random value. It signs the access cookie, so the code cannot be guessed from a cookie. |
   | `CORS_ORIGINS` | optional. The game and the socket share one origin, so it works without it. |
   | `TURN_CF_KEY_ID`, `TURN_CF_API_TOKEN` | the Cloudflare TURN key. Copy from your local `.env`. |
   | `TURN_CF_ACCOUNT_ID`, `TURN_CF_ANALYTICS_TOKEN` | turn on the spend cap. Without them the relay stays off. |

3. Keep the **Starter** plan. The free plan sleeps after 15 minutes idle,
   takes about a minute to wake, and loses any open rooms.
4. When the deploy is live, open `https://<your-app>.onrender.com/healthz`.
   It answers `{"ok":true,...}` without the access code.
5. Check `TRUST_PROXY`: open the game once, then find the log line
   `page load from <ip>`. It must be YOUR public IP (compare with
   https://ifconfig.me). If it is a proxy address, set `TRUST_PROXY` to `2`.
   A wrong value puts every player in one rate-limit bucket.

A redeploy restarts the server and ends every room, so deploy when nobody is
playing. Every push to the branch deploys again unless you turn off
auto-deploy.

### Your own domain, with Cloudflare's free CDN in front

Cloudflare keeps copies of the art near each player, so Render sends each
file once per Cloudflare location instead of once per player. It needs a
domain whose DNS is on Cloudflare (Cloudflare Registrar puts it there).

1. Check the game works on the `onrender.com` address first.
2. Render: **Settings > Custom Domains**, add the domain. Render shows the
   record to create.
3. Cloudflare DNS: create that record with the proxy **OFF** (grey cloud,
   "DNS only"). Render must reach the domain directly to verify it and issue
   its certificate.
4. When Render shows the domain as verified, turn the proxy **ON** (orange
   cloud).
5. Cloudflare **SSL/TLS**: set the mode to **Full (strict)**. A weaker mode
   leaves part of the path unencrypted or loops redirects.
6. Leave Cloudflare's caching on its defaults. The server already says what
   may be kept: art for 30 days; the page, code and pose deck are checked
   every time (`no-cache`), so a deploy shows up at once.
7. Render: set `CORS_ORIGINS` to `https://<your-domain>`.
8. Do the `TRUST_PROXY` log check again. Cloudflare adds a proxy, so it is
   probably `2` now. The log must show YOUR IP.

After a deploy that CHANGES an existing art file, choose **Caching > Purge
Everything** in Cloudflare. New file names need nothing.

With the CDN on, art files are served without the access code (Cloudflare
sends its copies to anyone). The page and the match server still need it.

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

The player-facing versions are `privacy.html` and `terms.html` in the game
folder, served at `/privacy` and `/terms` without the access code. **Keep them
true:** a change to what the game sends or stores must change `privacy.html`.
