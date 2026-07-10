/* Thin RTCPeerConnection wrapper for the 1v1 video link.
   Signaling blobs are opaque {sdp}/{candidate} objects relayed by the
   server; video itself flows peer-to-peer and never touches it. */

const ICE = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };

export function createPeer({ initiator, stream, sendSignal, onRemoteStream, onConnectionChange }){
  const pc = new RTCPeerConnection(ICE);
  const pendingCandidates = [];
  let closed = false;

  for(const track of stream.getTracks()) pc.addTrack(track, stream);

  pc.onicecandidate = e => {
    if(e.candidate) sendSignal({ candidate: e.candidate.toJSON() });
  };
  pc.ontrack = e => {
    if(e.streams && e.streams[0]) onRemoteStream(e.streams[0]);
  };
  pc.onconnectionstatechange = () => {
    if(onConnectionChange) onConnectionChange(pc.connectionState);
  };

  if(initiator){
    pc.onnegotiationneeded = async () => {
      try{
        await pc.setLocalDescription(await pc.createOffer());
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
