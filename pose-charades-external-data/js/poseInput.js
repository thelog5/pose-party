/* Camera observations, uniform sampling, and prediction freshness. No DOM. */
import { JOINTS, WIN, SAMPLE_MS } from "./constants.js";

export const POSE_GAP_MS = 250;
export const PREDICTION_MAX_AGE_MS = 500;
export const MIN_POSE_SAMPLES = 15;
export const POSE_VISIBILITY = .35;
export const POSE_SPACE = "torso-reference-16:9-v1";
export const REFERENCE_ASPECT = 16 / 9;

const ANCHORS = [11, 12, 23, 24];
const LEGS = [25, 26, 27, 28];
const LEG_WORDS = /squat|bowling|jump|running|marching|moonwalk|kick|limbo|tight rope|griddying|flossing/i;
const visible = p => !!p && Number.isFinite(p.x) && Number.isFinite(p.y) &&
  p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1 &&
  Number.isFinite(p.visibility) && p.visibility >= POSE_VISIBILITY;

export function assessPose(landmarks){
  const mask = JOINTS.map(j => visible(landmarks?.[j]));
  const has = j => mask[JOINTS.indexOf(j)];
  const torso = ANCHORS.every(has);
  const usable = torso && mask.filter(Boolean).length >= 9;
  return { mask, torso, usable, fullBody:mask.every(Boolean), legs:LEGS.every(has) };
}

export function poseQualityMessage(quality, label = "", recording = false){
  if(!quality?.torso) return "Step back so your shoulders and hips are visible.";
  if((recording || LEG_WORDS.test(label)) && !quality.legs)
    return "Step back so your knees and feet are visible.";
  if(!quality.usable || (recording && !quality.fullBody))
    return "Keep your whole body visible and improve the lighting.";
  return "";
}

export function createPoseInput(){
  return { frames:[], masks:[], previous:null, nextAt:null, sampleAt:-Infinity,
    seenAt:-Infinity, predictionAt:-Infinity, predictedSampleAt:-Infinity,
    tracking:false, accepted:false, quality:null, predictionMask:null, predictionLabel:null, generation:0 };
}

export function resetPoseInput(input){
  input.frames.length = 0;
  input.masks.length = 0;
  input.previous = null;
  input.nextAt = null;
  input.sampleAt = input.seenAt = input.predictionAt = input.predictedSampleAt = -Infinity;
  input.tracking = input.accepted = false;
  input.quality = null;
  input.predictionMask = null;
  input.predictionLabel = null;
  input.generation++;
}

export function interpolateFrame(a, b, fraction){
  return a.map((p, j) => [p[0] + (b[j][0] - p[0]) * fraction,
    p[1] + (b[j][1] - p[1]) * fraction]);
}

/* Called on every fresh camera frame, including failed detections. Short
   gaps pause recognition; long gaps discard the old action entirely. */
export function observePose(input, frame, quality, now){
  if(now - input.seenAt > POSE_GAP_MS && input.previous) resetPoseInput(input);
  input.quality = quality;
  input.tracking = !!frame && !!quality?.usable;
  if(!input.tracking){ input.accepted = false; return false; }
  input.seenAt = now;
  const prev = input.previous;
  if(!prev) input.nextAt = now;
  let sampled = false;
  while(input.nextAt <= now + .001){
    const fraction = prev ? Math.min(1, (input.nextAt - prev.at) / (now - prev.at || 1)) : 1;
    input.frames.push(prev ? interpolateFrame(prev.frame, frame, fraction) : frame);
    input.masks.push(quality.mask.map((valid, j) => valid && (!prev || prev.mask[j])));
    if(input.frames.length > WIN){ input.frames.shift(); input.masks.shift(); }
    input.sampleAt = input.nextAt;
    input.nextAt += SAMPLE_MS;
    sampled = true;
  }
  input.previous = { frame, mask:quality.mask, at:now };
  return sampled;
}

export function windowJointMask(input){
  return JOINTS.map((_, j) => input.masks.length > 0 &&
    input.masks.every(mask => mask[j]));
}

export function canRecognize(input, label, now = performance.now()){
  return !!input?.tracking && input.accepted && input.quality?.usable &&
    (!label || input.predictionLabel===label) &&
    now - input.seenAt <= POSE_GAP_MS &&
    now - input.predictionAt <= PREDICTION_MAX_AGE_MS &&
    (!LEG_WORDS.test(label || "") || (input.quality.legs &&
      LEGS.every(j=>input.predictionMask?.[JOINTS.indexOf(j)])));
}

/* New clips retain per-camera-frame times. Never interpolate across tracking
   loss. Old exports have no timestamps; preserve their original sample grid. */
export function clipSegments(clip){
  if(!clip.timestamps) return [clip.frames];
  const parts = [];
  let input = createPoseInput(), part = [];
  for(let i = 0; i < clip.frames.length; i++){
    const at = clip.timestamps[i];
    if(!Number.isFinite(at) || (i && at <= clip.timestamps[i - 1]))
      throw new Error("Clip timestamps must be finite and increasing.");
    const quality = clip.visibility?.[i];
    const inFrame = clip.inFrame?.[i];
    const valid = !quality || JOINTS.every((_, j) =>
      quality[j] >= POSE_VISIBILITY && (!inFrame || inFrame[j]));
    if(!valid || (input.previous && at - input.seenAt > POSE_GAP_MS)){
      if(part.length) parts.push(part);
      part = []; input = createPoseInput();
    }
    if(!valid) continue;
    const prev = input.previous;
    if(!prev) input.nextAt = at;
    while(input.nextAt <= at + .001){
      const t = prev ? Math.min(1, (input.nextAt - prev.at) / (at - prev.at)) : 1;
      part.push(prev ? interpolateFrame(prev.frame, clip.frames[i], t) : clip.frames[i]);
      input.nextAt += SAMPLE_MS;
    }
    input.previous = { frame:clip.frames[i], at }; input.seenAt = at;
  }
  if(part.length) parts.push(part);
  return parts;
}

/* An old normalized frame with KNOWN image geometry can be reprojected. The
   shipped legacy clips lack this metadata, so their coordinates stay intact. */
export function canonicalClip(clip){
  if(clip.coordinateSpace === POSE_SPACE) return clip;
  if(clip.coordinateSpace && clip.coordinateSpace !== "legacy-image")
    throw new Error("Unsupported pose coordinate space.");
  const aspect = clip.camera?.width / clip.camera?.height;
  if(!Number.isFinite(aspect) || aspect <= 0) return clip;
  const factor = aspect / REFERENCE_ASPECT;
  const frames = clip.frames.map(frame => {
    const a = frame[JOINTS.indexOf(11)], b = frame[JOINTS.indexOf(12)];
    const scale = Math.hypot((a[0] + b[0]) / 2 * factor, (a[1] + b[1]) / 2);
    if(!Number.isFinite(scale) || scale < 1e-4) throw new Error("Invalid torso scale.");
    return frame.map(p => [p[0] * factor / scale, p[1] / scale]);
  });
  return { ...clip, frames, coordinateSpace:POSE_SPACE };
}
