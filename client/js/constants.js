/* Tunables and fixed tables shared across the app. */

/* Body landmarks we keep out of MediaPipe's 33-point pose. */
export const JOINTS = [0,11,12,13,14,15,16,19,20,23,24,25,26,27,28];
/* Bone pairs index into JOINTS, not into the raw landmark list. */
export const BONES = [[1,2],[1,3],[3,5],[2,4],[4,6],[5,7],[6,8],[1,9],[2,10],[9,10],[9,11],[11,13],[10,12],[12,14]];

export const HAND_LANDMARKS = 21;
export const FRAME_POINTS = JOINTS.length + HAND_LANDMARKS * 2;
/* A frame is laid out [ ...body, ...leftHand, ...rightHand ].
   train_model.py mirrors these offsets — keep the two in step. */
export const LEFT_HAND_OFFSET = JOINTS.length;
export const RIGHT_HAND_OFFSET = JOINTS.length + HAND_LANDMARKS;
export const HAND_BONES = [[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[0,9],[9,10],[10,11],[11,12],[0,13],[13,14],[14,15],[15,16],[0,17],[17,18],[18,19],[19,20],[5,9],[9,13],[13,17]];

// Hand landmarks are tracked/drawn/exported in Training, but live kNN uses
// body landmarks only. Matches skip the hand model entirely to preserve the
// pose cadence while multiple Party videos are encoding/decoding.
export const MODEL_POINTS = JOINTS.length;

export const SAMPLE_MS = 66, WIN = 30, STRIDE = 8, K = 7;
/* Every clip is also trained mirrored and at these tempos — see classifier.js
   for why. Widening the list costs model size (and therefore classify time)
   linearly, so keep it to the range a person actually performs at. */
export const TIME_SCALES = [0.8, 1, 1.25];
/* A word NEEDS ITS LEGS SEEN when at least this share of its difference from
   the average pose lies on the knees and ankles (buildModel's legLabels). Its
   upper body is then generic, so with the legs masked it matches any standing
   player. This replaced a hand-written regex of word names that was wrong both
   ways on the 2026-09-11 deck: jumping jacks, flossing, moonwalking, griddying,
   jump rope and tight rope walking lose NO accuracy with the legs hidden (the
   model knows them by their arms), so the regex only blocked small-room
   players. At .26 the deck picks kicking a soccerball (.71), bowling, limbo,
   running, froggy jump, squat, climbing a ladder and star jump (.27). The
   next word down is paddling a boat at .24; the median word is .10. Measured
   on the position features only (see legLabels in classifier.js). */
export const LEG_SHARE_MIN = .26;
/* Floor on a feature dimension's standard deviation before the kNN divides by
   it, as a fraction of the MEDIAN standard deviation of its own block.

   IT HAS TO BE RELATIVE, AND THIS IS THE WHOLE REASON. Frames are hip-centred
   and torso-scaled, so the hips sit ON the origin and the shoulders barely
   move off it: measured on the shipped deck their standard deviations are
   .009-.023 against .34-.86 for the wrists, which are the joints a charades
   pose is actually made of. An ABSOLUTE floor leaves those dimensions being
   divided by ~.012, which multiplies whatever noise the tracker put on a hip
   by eighty and makes the least informative dimensions in the vector the
   loudest ones. The clean leave-one-clip-out number cannot see this at all —
   its query is a recorded clip whose hips are exactly as noisy as the ones it
   was trained on — which is precisely how an absolute 5e-3 got shipped.

   Against simulated hip jitter of .06 torso-lengths, the absolute floor scored
   35% and this one scores 74%, with clean accuracy unchanged (88.1 -> 88.7).
   Sweep BOTH numbers before touching it: clean accuracy alone will happily
   tell you any value between .4 and 1.0 is identical. */
export const FEATURE_SD_FLOOR = 0.75;
/* Global feature weighting (classifier.js, featureWeights). A dimension's
   weight is how far the WORD means spread on it against how far the TAKES of
   one word spread on it, divided by the median of that ratio and clamped to
   [MIN, MAX]. FLOOR is added to the take spread, as a fraction of its median,
   so a dimension two takes happen to agree on cannot win a huge weight.
   Swept on the 2026-09-11 deck: every clamp from [.7,1.5] to [.25,4] and every
   floor from .25 to 1 scores 68.2-68.7% clean against 65.7% unweighted, so
   the exact numbers do not matter much. Test with scripts/pose-deck-eval.mjs. */
export const FEATURE_WEIGHT_MIN = 0.5, FEATURE_WEIGHT_MAX = 2.0, FEATURE_WEIGHT_FLOOR = 0.5;
/* OFF since the 2026-09-13 deck (190 clips, 3+ takes of every word). There the
   unweighted model wins clean AND under noise: 80.7% / 76.9% against 79.8% /
   75.2% over the whole deck, and 80.4% / 76.5% against 79.2% / 73.8% on the
   capture-v3 clips alone. With five takes per word the takes themselves carry
   the variety the weighting used to supply. */
export const FEATURE_WEIGHTING = false;

/* PER-WORD JOINT EMPHASIS, for one word only, on purpose. When the model
   compares a window with a SQUAT example, knee and ankle dimensions count x2
   and arm dimensions x.5 (a pair distance takes the mean of its two joints).
   Squat's five takes agree on the legs and put the arms in two places
   (wrists at mid-torso in three takes, at head height in two), so on the arms
   the takes look like froggy jump and ballerina twirl. Arms are the elbows,
   wrists and index fingers; legs are the knees and ankles. Measured on the v3 clips:
   squat 25% -> 100%, froggy jump 100% -> 94%, total 80.4% -> 82.8% clean and
   76.5% -> 79.0% under .02 jitter.
   The same idea FAILED for the other words it was tried on. Legs x2 for froggy
   jump, head x2 for limbo, arms x2 for bowling and volleyball spike: total
   78.0%, and 67.3% under jitter. A word that ignores its arms matches every
   pose with the same legs, so each weighted word pulls windows from the rest.
   Add a word here only with a leave-one-clip-out number. */
export const WORD_JOINT_WEIGHTS = Object.freeze({
  squat: { legs:2, arms:.5 },
});
export const HOLD_MS = 250, THRESH = 0.60, RIVAL_THRESH = 0.60;
export const ROUNDS = 5, WORD_MS = 30000;
/* Scoring (matches the on-screen copy): 100 per word, +100 fast bonus if
   guessed inside 15s, whole thing multiplied by the current streak.
   Skipping costs 500 and breaks the streak. */
export const PTS_CORRECT = 100, PTS_FAST_BONUS = 100, FAST_WINDOW_MS = 15000, PTS_SKIP = 500;

/* Solo "Play with AI" is a timed sprint. Single source of truth for the HUD
   timers and scoring — the Round Timer, Word Timer and points all read from
   here. A future solo-settings screen writes to this block. */
export const SOLO = {
  roundMs: 120000,        // Round Timer: total run; at 0 the game ends
  wordMs: 20000,          // Word Timer: per word; at 0 the word is skipped
  skipPenalty: 250,       // cost of pressing Skip (streak also resets)
};

export const STARTERS = ["idle","jumping jacks","swimming","punching","guitar","basketball shot","golf swing","sleeping","driving","rowing","climbing","disco dance","hula hoop","chicken dance","weightlifting","tennis serve","marching","bowling","t-rex","robot"];

export const BUNDLED_DATA_URL = "assets/data/pose-charades-data.json";

export const CATEGORIES = {
  "swimming":"Sports & Action","punching":"Sports & Action","basketball shot":"Sports & Action",
  "golf swing":"Sports & Action","tennis serve":"Sports & Action","bowling":"Sports & Action",
  "rowing":"Sports & Action","climbing":"Sports & Action","weightlifting":"Sports & Action","jumping jacks":"Sports & Action",
  "marching":"Sports & Action","hula hoop":"Sports & Action",
  "robot":"People & Characters","t-rex":"People & Characters","chicken dance":"People & Characters",
  "sleeping":"Everyday Life","driving":"Everyday Life","guitar":"Everyday Life","disco dance":"Everyday Life"
};

/* Keep in step with the import specifier at the top of engine.js — an import
   specifier must be a literal, so the version can't be interpolated there. */
const MEDIAPIPE_VERSION = "0.10.14";
export const WASM_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/wasm`;
/* `full`, not `lite`. Lite is roughly half the inference cost and visibly
   worse on exactly the joints this game is built on: elbows, wrists and
   anything partly out of frame, where it snaps and invents positions. The loop
   already runs off requestVideoFrameCallback (one pass per camera frame, not
   per display frame) and Party caps it at 30 Hz, so the headroom is there. */
export const POSE_MODEL_URL = "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task";
export const HAND_MODEL_URL = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";
export const FACE_MODEL_URL = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
