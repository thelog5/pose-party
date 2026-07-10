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
| `rival.js` | Simulated 1v1 opponent. |
| `screens.js` | Which chrome is visible per screen. |
| `ui.js` | Guess list, toasts, flashes, class list. |
| `state.js` | Shared mutable state, in one object. |
| `constants.js` | Tunables and fixed tables. |
| `dom.js`, `draw.js`, `audio.js` | Small helpers. |

`pose.js` and `classifier.js` are pure and dependency-free — the easiest place to
add tests. The frame layout in `constants.js` is mirrored by `train_model.py`.

## Notes

- `index.html` has no embedded training data.
- Start Playing launches Play with AI.
- Hand markers are visual only; body pose is used for scoring.
- A point banner appears when a word is won, then the word card animates to the next word.
