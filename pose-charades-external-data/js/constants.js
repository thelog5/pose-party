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

// Hand landmarks are tracked and exported, but the live/kNN AI uses body landmarks only.
// This keeps finger dots visible without letting noisy hands tank accuracy.
export const MODEL_POINTS = JOINTS.length;

export const SAMPLE_MS = 66, WIN = 30, STRIDE = 8, K = 7;
export const HOLD_MS = 250, THRESH = 0.60, RIVAL_THRESH = 0.60;
export const ROUNDS = 5, WORD_MS = 20000;
export const PTS_CORRECT = 100, PTS_PER_SEC = 10, PTS_SKIP = 1;

export const STARTERS = ["idle","jumping jacks","swimming","boxing","guitar","archery","basketball shot","golf swing","sleeping","driving","rowing","climbing","disco dance","hula hoop","skiing","chicken dance","weightlifting","tennis serve","marching","bowling","t-rex","robot"];

export const BUNDLED_DATA_URL = "assets/data/pose-charades-data.json";

export const CATEGORIES = {
  "swimming":"Sports & Action","boxing":"Sports & Action","archery":"Sports & Action","basketball shot":"Sports & Action",
  "golf swing":"Sports & Action","tennis serve":"Sports & Action","bowling":"Sports & Action","skiing":"Sports & Action",
  "rowing":"Sports & Action","climbing":"Sports & Action","weightlifting":"Sports & Action","jumping jacks":"Sports & Action",
  "marching":"Sports & Action","hula hoop":"Sports & Action",
  "robot":"People & Characters","t-rex":"People & Characters","chicken dance":"People & Characters",
  "sleeping":"Everyday Life","driving":"Everyday Life","guitar":"Everyday Life","disco dance":"Everyday Life"
};

/* Keep in step with the import specifier at the top of engine.js — an import
   specifier must be a literal, so the version can't be interpolated there. */
const MEDIAPIPE_VERSION = "0.10.14";
export const WASM_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/wasm`;
export const POSE_MODEL_URL = "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task";
export const HAND_MODEL_URL = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";
