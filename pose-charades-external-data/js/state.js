/* Shared mutable state.
   One object rather than exported `let`s so every module reads and writes the
   same slot without import cycles or stale bindings. */

import { JOINTS, FRAME_POINTS } from "./constants.js";
import { createPoseInput } from "./poseInput.js";

const poseInput = createPoseInput();

export const state = {
  /* pose engine */
  landmarker: null,
  handmarker: null,
  faceLandmarker: null,  // hidden local-only face mesh used to anchor the crown
  poseInput,
  liveBuf: poseInput.frames,
  mediaStream: null,   // local camera stream; shared with WebRTC in online 1v1

  /* online 1v1: game.js calls this instead of scoring locally when
     game.mode === "online" (set by online.js; avoids an import cycle) */
  onlineClaim: null,
  onlineGuess: null,

  /* captured clips */
  dataset: { app:"pose-charades", version:3, joints:JOINTS, hands:true, framePoints:FRAME_POINTS, fps:15, clips:[] },
  recording: null,

  /* classifier */
  model: null,
  smooth: {},
  prevRank: {},

  /* app */
  game: null,
  screen: "home",
  lastMode: "ai",
  muted: false,
};
