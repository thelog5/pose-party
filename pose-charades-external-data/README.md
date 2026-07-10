# Pose Charades

## Launch it correctly

Do **not** double click `index.html`. The browser blocks the app from loading `assets/data/pose-charades-data.json` when opened as a plain local file.

On Mac:

```bash
cd ~/Downloads
unzip pose-charades-external-data.zip
cd pose-charades-external-data
python3 -m http.server 8000
```

Then open this in Chrome:

```text
http://localhost:8000
```

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
| `game.js` | Round loop and scoring for both modes. |
| `fsm.js` | The finite game-state machine (DOM-free, unit-testable). |
| `rival.js` | Simulated 1v1 opponent. |
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

## Notes

- `index.html` has no embedded training data.
- Start Playing launches Play with AI.
- Hand markers are visual only; body pose is used for scoring.
- A point banner appears when a word is won, then the word card animates to the next word.
