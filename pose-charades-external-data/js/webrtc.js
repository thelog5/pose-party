/* Thin RTCPeerConnection wrapper for the 1v1 video link.
   Signaling blobs are opaque {sdp}/{candidate} objects relayed by the
   server; video itself flows peer-to-peer and never touches it. */

const ICE = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };

function applyVideoEncoding(sender, limits){
  if(!sender || !limits) return;
  try{
    const params = sender.getParameters();
    if(!params.encodings?.length) params.encodings = [{}];
    const encoding = params.encodings[0];
    if(Number.isFinite(limits.maxBitrate)) encoding.maxBitrate = limits.maxBitrate;
    if(Number.isFinite(limits.maxFramerate)) encoding.maxFramerate = limits.maxFramerate;
    if(Number.isFinite(limits.scaleResolutionDownBy)){
      encoding.scaleResolutionDownBy = Math.max(1, limits.scaleResolutionDownBy);
    }
    params.degradationPreference = "maintain-framerate";
    sender.setParameters(params).catch(() => {});
  }catch(_error){
    /* Older WebRTC implementations simply keep their browser defaults. */
  }
}

/* WHICH ROUTE DID THIS LINK ACTUALLY TAKE? Without an answer, the question
   "how many of my players cannot connect, and would TURN be worth paying
   for" can only be settled with an industry average applied to a player base
   nobody has observed. The candidate types are the whole answer:

     host   both peers on the same network; no traversal needed
     srflx  hole-punched through NAT using STUN. The common success case.
     prflx  peer-reflexive; learned from an inbound packet
     relay  a TURN server carried it. Impossible here, since none is
            configured, which is exactly why `failed` is the number to watch.

   So a `failed` report is a link that would have needed TURN. Count those
   against the total and the decision makes itself. */
async function selectedPairTypes(pc){
  try{
    const stats = await pc.getStats();
    let pair = null;
    /* The transport names the winner outright where it is available. */
    for(const s of stats.values())
      if(s.type === "transport" && s.selectedCandidatePairId)
        pair = stats.get(s.selectedCandidatePairId) || pair;
    if(!pair)
      for(const s of stats.values())
        if(s.type === "candidate-pair" && s.state === "succeeded" && s.nominated !== false)
          pair = s;
    if(!pair) return null;
    return {
      local: stats.get(pair.localCandidateId)?.candidateType || "?",
      remote: stats.get(pair.remoteCandidateId)?.candidateType || "?",
    };
  }catch(_error){
    return null;   // a browser without full stats support tells us nothing
  }
}

export function createPeer({
  initiator, stream, sendSignal, onRemoteStream, onConnectionChange,
  onIceReport, videoEncoding,
}){
  const pc = new RTCPeerConnection(ICE);
  const pendingCandidates = [];
  const videoSenders = [];
  let closed = false;
  const startedAt = Date.now();
  /* One report of each outcome. A link that connects and later drops is a
     different phenomenon from one that never connects, and both are worth
     seeing, but neither is worth repeating. */
  const reported = new Set();

  async function reportIce(result){
    if(!onIceReport || reported.has(result)) return;
    reported.add(result);
    const types = result === "connected" ? await selectedPairTypes(pc) : null;
    if(closed && result === "connected") return;
    onIceReport({
      result,
      local: types?.local || "",
      remote: types?.remote || "",
      ms: Date.now() - startedAt,
    });
  }

  for(const track of stream.getTracks()){
    const sender = pc.addTrack(track, stream);
    if(track.kind === "video"){
      videoSenders.push(sender);
      applyVideoEncoding(sender, videoEncoding);
    }
  }

  pc.onicecandidate = e => {
    if(e.candidate) sendSignal({ candidate: e.candidate.toJSON() });
  };
  pc.ontrack = e => {
    if(e.streams && e.streams[0]) onRemoteStream(e.streams[0]);
  };
  pc.onconnectionstatechange = () => {
    if(pc.connectionState === "connected"){
      for(const sender of videoSenders) applyVideoEncoding(sender, videoEncoding);
      reportIce("connected");
    }
    if(pc.connectionState === "failed") reportIce("failed");
    if(onConnectionChange) onConnectionChange(pc.connectionState);
  };

  if(initiator){
    pc.onnegotiationneeded = async () => {
      try{
        await pc.setLocalDescription(await pc.createOffer());
        for(const sender of videoSenders) applyVideoEncoding(sender, videoEncoding);
        sendSignal({ sdp: pc.localDescription.toJSON() });
      }catch(e){ console.warn("webrtc offer failed", e); }
    };
  }

  async function handleSignal(data){
    if(closed || !data) return;
    try{
      if(data.sdp){
        await pc.setRemoteDescription(data.sdp);
        while(pendingCandidates.length) await pc.addIceCandidate(pendingCandidates.shift());
        if(data.sdp.type==="offer"){
          await pc.setLocalDescription(await pc.createAnswer());
          for(const sender of videoSenders) applyVideoEncoding(sender, videoEncoding);
          sendSignal({ sdp: pc.localDescription.toJSON() });
        }
      }else if(data.candidate){
        // candidates can arrive before the remote description
        if(pc.remoteDescription) await pc.addIceCandidate(data.candidate);
        else pendingCandidates.push(data.candidate);
      }
    }catch(e){ console.warn("webrtc signal failed", e); }
  }

  function close(){
    if(closed) return;
    closed = true;
    /* Only close the connection — the local camera stream belongs to the
       whole app (pose engine keeps using it), so its tracks stay live. */
    try{ pc.close(); }catch(e){}
  }

  return { handleSignal, close, pc };
}
