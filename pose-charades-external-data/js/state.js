/* Shared mutable state.
   One object rather than exported `let`s so every module reads and writes the
   same slot without import cycles or stale bindings. */

import { JOINTS, FRAME_POINTS } from "./constants.js";

export const state = {
  /* pose engine */
  landmarker: null,
  handmarker: null,
  lastSampleT: 0,
  liveBuf: [],

  /* captured clips */
  dataset: { app:"pose-charades", version:2, joints:JOINTS, hands:true, framePoints:FRAME_POINTS, fps:15, clips:[] },
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
