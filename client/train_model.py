"""
Pose Charades — production model training (Phase 2)
====================================================
Trains a GRU sequence classifier on datasets exported from the Pose Charades app.

The current app records:
  - 15 normalized body landmarks from MediaPipe Pose
  - 21 normalized left-hand landmarks from MediaPipe Hands
  - 21 normalized right-hand landmarks from MediaPipe Hands

For accuracy, this trainer uses BODY ONLY by default. Hands are kept in the
exported dataset for visuals/future experiments, but ignored by the classifier
because noisy finger tracking can hurt broad charades actions.

Run in Google Colab:
  pip install tensorflow tensorflowjs numpy scikit-learn
  python train_model.py data1.json data2.json ...
"""

import json, sys, glob
import numpy as np

# ---- config (must match the app) -------------------------------------------
BODY_JOINTS = [0,11,12,13,14,15,16,19,20,23,24,25,26,27,28]
HAND_LANDMARKS = 21
TOTAL_POINTS = len(BODY_JOINTS) + HAND_LANDMARKS * 2
MODEL_POINTS = len(BODY_JOINTS)
T = 48
D = MODEL_POINTS * 2
SEED = 7

# Left/right body joint pairs *as positions within BODY_JOINTS*.
BODY_MIRROR_PAIRS = [(1,2),(3,4),(5,6),(7,8),(9,10),(11,12),(13,14)]
LEFT_HAND_OFFSET = len(BODY_JOINTS)
RIGHT_HAND_OFFSET = len(BODY_JOINTS) + HAND_LANDMARKS
POSE_SPACE = "torso-reference-16:9-v1"
SAMPLE_MS = 66


def prepared_segments(clip):
    """Same camera-space migration and timed quality sections as poseInput.js."""
    a = np.asarray([pad_frame(fr) for fr in clip["frames"]], dtype=np.float32)
    space = clip.get("coordinateSpace", "legacy-image")
    if space not in ("legacy-image", POSE_SPACE):
        raise ValueError("Unsupported pose coordinate space")
    camera = clip.get("camera", {})
    if space == "legacy-image" and camera.get("width") and camera.get("height"):
        factor = (camera["width"] / camera["height"]) / (16 / 9)
        a[:, :, 0] *= factor
        scale = np.linalg.norm((a[:, 1, :] + a[:, 2, :]) / 2, axis=1)
        if np.any(scale < 1e-4):
            raise ValueError("Invalid torso scale")
        a /= scale[:, None, None]
    if "timestamps" not in clip:
        return [a.tolist()]
    times = np.asarray(clip["timestamps"], dtype=float)
    if len(times) != len(a) or not np.all(np.isfinite(times)) or np.any(np.diff(times) <= 0):
        raise ValueError("Invalid pose timestamps")
    valid = np.ones(len(a), dtype=bool)
    if "visibility" in clip:
        valid &= np.all(np.asarray(clip["visibility"]) >= .35, axis=1)
    if "inFrame" in clip:
        valid &= np.all(np.asarray(clip["inFrame"]), axis=1)
    sections, current = [], []
    for i in range(len(a)):
        if not valid[i] or (current and times[i] - times[current[-1]] > 250):
            if current:
                sections.append(current)
            current = []
        if valid[i]:
            current.append(i)
    if current:
        sections.append(current)
    out = []
    for indices in sections:
        ts, points = times[indices], a[indices]
        grid = np.arange(ts[0], ts[-1] + .001, SAMPLE_MS)
        if len(grid) < 15:
            continue
        flat = points.reshape(len(points), -1)
        sample = np.stack([np.interp(grid, ts, flat[:, d]) for d in range(flat.shape[1])], axis=1)
        out.append(sample.reshape(len(grid), TOTAL_POINTS, 2).tolist())
    return out

# ---- load -------------------------------------------------------------------
def pad_frame(frame):
    """Pad legacy body-only frames to body+hands frame length."""
    pts = list(frame[:TOTAL_POINTS])
    while len(pts) < TOTAL_POINTS:
        pts.append([0.0, 0.0])
    return pts

def load(paths):
    clips = []
    for p in paths:
        with open(p) as f:
            d = json.load(f)
        assert d.get("joints") == BODY_JOINTS, f"{p}: body joint set mismatch — re-export from the current app"
        for c in d["clips"]:
            for frames in prepared_segments(c):
                clips.append({**c, "frames": frames})
    print(f"Loaded {len(clips)} clips, "
          f"{len(set(c['label'] for c in clips))} classes, "
          f"{len(set(c.get('person','?') for c in clips))} people")
    return clips

def resample(frames, t=T):
    """Linear-interpolate a clip to exactly t frames, then keep body points only."""
    a = np.asarray([pad_frame(fr)[:MODEL_POINTS] for fr in frames], dtype=np.float32)
    n = len(a)
    idx = np.linspace(0, n-1, t)
    lo = np.floor(idx).astype(int)
    hi = np.ceil(idx).astype(int)
    w = (idx - lo)[:, None, None]
    return (a[lo]*(1-w) + a[hi]*w).reshape(t, -1)

def to_arrays(clips):
    labels = sorted(set(c["label"] for c in clips))
    lab2i = {l: i for i, l in enumerate(labels)}
    X = np.stack([resample(c["frames"]) for c in clips])
    y = np.array([lab2i[c["label"]] for c in clips])
    groups = np.array([c.get("person", "?") for c in clips])
    return X, y, groups, labels

# ---- augmentation -----------------------------------------------------------
def mirror(X):
    Xm = X.reshape(len(X), T, MODEL_POINTS, 2).copy()

    # Swap left/right body joints.
    for a, b in BODY_MIRROR_PAIRS:
        Xm[:, :, [a, b]] = Xm[:, :, [b, a]]

    # Hands are visual/exported only, not part of the model input.

    # Flip normalized x around the hip center.
    Xm[..., 0] *= -1
    return Xm.reshape(len(X), T, D)

def jitter(X, sigma=0.02):
    return X + np.random.normal(0, sigma, X.shape).astype(np.float32)

def time_warp(X):
    out = np.empty_like(X)
    for i, x in enumerate(X):
        s = np.random.uniform(0.85, 1.15)
        idx = np.clip(np.linspace(0, (T-1)*s, T), 0, T-1)
        lo = np.floor(idx).astype(int)
        hi = np.ceil(idx).astype(int)
        w = (idx - lo)[:, None]
        out[i] = x[lo]*(1-w) + x[hi]*w
    return out

def augment(X, y):
    Xa = np.concatenate([X, mirror(X), jitter(X), time_warp(X)])
    ya = np.concatenate([y]*4)
    return Xa, ya

# ---- train ------------------------------------------------------------------
def main(paths):
    np.random.seed(SEED)
    import tensorflow as tf
    from sklearn.model_selection import GroupShuffleSplit
    from sklearn.metrics import confusion_matrix, classification_report
    tf.random.set_seed(SEED)

    clips = load(paths)
    X, y, groups, labels = to_arrays(clips)

    if len(set(groups)) >= 3:
        tr, te = next(GroupShuffleSplit(test_size=0.25, random_state=SEED).split(X, y, groups))
        print(f"Held-out people: {sorted(set(groups[te]))}")
    else:
        print("WARNING: <3 people in dataset — falling back to random clip split. "
              "Accuracy will look better than reality. Recruit more friends.")
        idx = np.random.permutation(len(X))
        cut = int(len(X)*0.8)
        tr, te = idx[:cut], idx[cut:]

    Xtr, ytr = augment(X[tr], y[tr])
    Xte, yte = X[te], y[te]

    model = tf.keras.Sequential([
        tf.keras.layers.Input((T, D)),
        tf.keras.layers.GRU(128, return_sequences=True),
        tf.keras.layers.GRU(72),
        tf.keras.layers.Dropout(0.3),
        tf.keras.layers.Dense(72, activation="relu"),
        tf.keras.layers.Dense(len(labels), activation="softmax"),
    ])
    model.compile("adam", "sparse_categorical_crossentropy", metrics=["accuracy"])
    model.summary()
    model.fit(Xtr, ytr, validation_data=(Xte, yte), epochs=70, batch_size=32,
              callbacks=[tf.keras.callbacks.EarlyStopping(patience=9, restore_best_weights=True)])

    probs = model.predict(Xte, verbose=0)
    pred = probs.argmax(1)
    top3 = np.any(np.argsort(-probs, axis=1)[:, :3] == yte[:, None], axis=1).mean()
    print(f"\nTop-1: {(pred == yte).mean():.1%}   Top-3: {top3:.1%}  (target: top-3 >= 80% on held-out people)")
    print(classification_report(yte, pred, target_names=labels, zero_division=0))
    cm = confusion_matrix(yte, pred)
    print("Most confused pairs (cut or re-record these):")
    pairs = [(labels[i], labels[j], cm[i, j]) for i in range(len(labels))
             for j in range(len(labels)) if i != j and cm[i, j] > 0]
    for a, b, n in sorted(pairs, key=lambda p: -p[2])[:5]:
        print(f"  {a} -> guessed as {b}: {n}x")

    model.save("pose_charades.keras")
    with open("labels.json", "w") as f:
        json.dump(labels, f)
    try:
        import tensorflowjs as tfjs
        tfjs.converters.save_keras_model(model, "pose_charades_tfjs")
        print("\nExported pose_charades_tfjs/ — ship this folder with index.html.")
    except ImportError:
        print("\nInstall tensorflowjs then run:\n"
              "  tensorflowjs_converter --input_format keras pose_charades.keras pose_charades_tfjs")

    print(f"""
SWAP-IN NOTES (index.html):
  1. Load TF.js:  import * as tf from 'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4/+esm'
  2. model = await tf.loadLayersModel('pose_charades_tfjs/model.json')
  3. Replace classifyLive()'s kNN call: keep the last ~3-4s of normalized frames,
     resample body landmarks to 48 frames, tensor shape [1, 48, {D}], model.predict() -> softmax
     scores per label (order = labels.json). Smoothing / hold / scoring stays the same.
""")

if __name__ == "__main__":
    paths = sys.argv[1:] or glob.glob("*.json")
    assert paths, "Usage: python train_model.py data1.json [data2.json ...]"
    main(paths)
