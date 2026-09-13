/* Validate and migrate exports before they can enter the training deck. */
import { JOINTS, FRAME_POINTS } from "./constants.js";
import { canonicalClip, POSE_SPACE } from "./poseInput.js";

export function decodePoseDataset(data){
  if(!data || !Array.isArray(data.clips) || JSON.stringify(data.joints)!==JSON.stringify(JOINTS) ||
     ![1,2,3].includes(data.version ?? 1)) throw new Error("Unsupported pose dataset.");
  return data.clips.map(clip=>{
    if(typeof clip.label!=="string" || !clip.label.trim() || !Array.isArray(clip.frames) || !clip.frames.length)
      throw new Error("Invalid pose clip.");
    const frames=clip.frames.map(frame=>{
      if(!Array.isArray(frame) || frame.length<JOINTS.length ||
         frame.some(p=>!Array.isArray(p) || p.length!==2 || !p.every(Number.isFinite)))
        throw new Error("Invalid pose coordinates.");
      return frame.slice(0,FRAME_POINTS).concat(Array.from({length:Math.max(0,FRAME_POINTS-frame.length)},()=>[0,0]));
    });
    for(const field of ["timestamps","visibility","inFrame"]){
      if(clip[field] && (!Array.isArray(clip[field]) || clip[field].length!==frames.length))
        throw new Error("Pose metadata does not match the frames.");
    }
    if(clip.timestamps?.some((t,i)=>!Number.isFinite(t) || t<0 || (i>0 && t<=clip.timestamps[i-1])))
      throw new Error("Invalid pose timestamps.");
    if(clip.visibility?.some(row=>!Array.isArray(row) || row.length!==JOINTS.length ||
       row.some(v=>!Number.isFinite(v) || v<0 || v>1))) throw new Error("Invalid landmark visibility.");
    if(clip.inFrame?.some(row=>!Array.isArray(row) || row.length!==JOINTS.length ||
       row.some(v=>typeof v!=="boolean"))) throw new Error("Invalid landmark bounds.");
    if(clip.captureVersion===3 && (clip.coordinateSpace!==POSE_SPACE || !clip.timestamps || !clip.visibility || !clip.inFrame ||
       !Number.isFinite(clip.camera?.width) || !Number.isFinite(clip.camera?.height) ||
       clip.camera.width<=0 || clip.camera.height<=0)) throw new Error("Incomplete camera metadata.");
    return canonicalClip({...clip, frames, coordinateSpace:clip.coordinateSpace || "legacy-image"});
  });
}
