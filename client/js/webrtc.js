/* Thin RTCPeerConnection wrapper for the 1v1 video link.
   Signaling blobs are opaque {sdp}/{candidate} objects relayed by the
   server; the video itself flows peer-to-peer.

   The server supplies the ICE servers (`ice:servers`, fetched once per lobby
   visit by online.js) so that a TURN relay can be turned on by configuration
   without a code change. Where no TURN is configured this is the same
   STUN-only list it has always been, and even where one is, ICE reaches for
   the relay only after the direct routes fail.
   A TURN relay carries DTLS-SRTP packets it holds no key for, so it cannot
   see the video. That is the line between a relay and an SFU, and it is why
   this can exist here at all. */

import { isSlowComputer, onSlowComputer } from "./speed.js";

const ICE_FALLBACK = [{ urls: "stun:stun.l.google.com:19302" }];

/* A SLOW COMPUTER GETS LIGHTER VIDEO, IN BOTH DIRECTIONS. Its own camera is
   encoded smaller (less work for its processor), and it sends
   `{ lightVideo:true }` down the signaling channel so every peer encodes the
   link TO it smaller too (less to decode). Each link has its own sender, so
   in Party only the links that touch the slow computer change; everyone
   else keeps their normal video. Older clients ignore the message. The
   pose model never reads these streams, only people do. */
const LIGHT_VIDEO = { width:640, maxFramerate:15, maxBitrate:350_000 };
const ENCODING_KEYS = ["maxBitrate", "maxFramerate", "scaleResolutionDownBy"];

function applyVideoEncoding(sender, limits){
  if(!sender || !limits) return;
  try{
    const params = sender.getParameters();
    if(!params.encodings?.length) params.encodings = [{}];
    const encoding = params.encodings[0];
    /* A key the limits leave out goes back to the browser default, so a link
       that stops being light gets its full video back. */
    for(const key of ENCODING_KEYS){
      if(!Number.isFinite(limits[key])) delete encoding[key];
      else encoding[key] = key === "scaleResolutionDownBy" ? Math.max(1, limits[key]) : limits[key];
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
  onIceReport, videoEncoding, iceServers,
}){
  const pc = new RTCPeerConnection({
    iceServers: iceServers?.length ? iceServers : ICE_FALLBACK,
  });
  const pendingCandidates = [];
  const videoSenders = [];
  let closed = false;
  const startedAt = Date.now();
  /* One report of each outcome. A link that connects and later drops is a
     different phenomenon from one that never connects, and both are worth
     seeing, but neither is worth repeating. */
  const reported = new Set();
  let peerSlow = false, lightened = false;

  /* This link's limits: the mode's own, made lighter while either end is a
     slow computer. Undefined means "never touched", which 1v1 relies on to
     keep the browser's defaults. */
  function linkEncoding(track){
    if(!isSlowComputer() && !peerSlow) return lightened ? (videoEncoding || {}) : videoEncoding;
    lightened = true;
    const width = track?.getSettings?.().width || 1280;
    return {
      maxBitrate: Math.min(videoEncoding?.maxBitrate ?? Infinity, LIGHT_VIDEO.maxBitrate),
      maxFramerate: Math.min(videoEncoding?.maxFramerate ?? Infinity, LIGHT_VIDEO.maxFramerate),
      scaleResolutionDownBy: Math.max(videoEncoding?.scaleResolutionDownBy ?? 1, width / LIGHT_VIDEO.width),
    };
  }
  const encodeAll = () => {
    for(const sender of videoSenders) applyVideoEncoding(sender, linkEncoding(sender.track));
  };
  const stopSpeedWatch = onSlowComputer(slow => {
    if(closed) return;
    encodeAll();
    if(pc.connectionState === "connected") sendSignal({ lightVideo: slow });
  });

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
      applyVideoEncoding(sender, linkEncoding(track));
    }
  }

  pc.onicecandidate = e => {
    if(e.candidate) sendSignal({ candidate: e.candidate.toJSON() });
  };
  pc.ontrack = e => {
    if(e.streams && e.streams[0]) onRemoteStream(e.streams[0]);
  };

  /* A LINK THAT DROPS IS RECONNECTED, NOT LEFT DEAD. A phone that changes
     network, or a route that stops, puts the link in `disconnected` and then
     `failed`, and nothing brought it back: the feed froze or went black for
     the rest of the match on this screen only. An ICE restart looks for a new
     route on the same link, so the video comes back without a new call.
     Only the initiator sends offers, so the other side asks it to restart
     (`restartIce`). Restarts are spaced out and back off, because each one
     costs a burst of signaling messages and the server rate-limits those. */
  const RESTART_AFTER_MS = 2500;       // `disconnected` often fixes itself
  const RESTART_MIN_GAP_MS = 8000;
  const RESTART_MAX_GAP_MS = 60000;
  let restartGap = RESTART_MIN_GAP_MS;
  let lastRestartAt = 0;
  let restartTimer = 0;

  function restart(){
    if(closed) return;
    clearTimeout(restartTimer);
    restartTimer = 0;
    /* the gap only grows while restarts are failing */
    if(pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed")
      restartGap = RESTART_MIN_GAP_MS;
    const wait = lastRestartAt + restartGap - Date.now();
    if(wait > 0){ restartTimer = setTimeout(restart, wait); return; }
    /* an offer may replace an unanswered one, but never cross the peer's */
    if(initiator && pc.signalingState === "have-remote-offer"){
      restartTimer = setTimeout(restart, 1000);
      return;
    }
    lastRestartAt = Date.now();
    restartGap = Math.min(RESTART_MAX_GAP_MS, restartGap * 2);
    if(!initiator){ sendSignal({ restartIce: true }); return; }
    pc.createOffer({ iceRestart: true })
      .then(offer => pc.setLocalDescription(offer))
      .then(() => { encodeAll(); sendSignal({ sdp: pc.localDescription.toJSON() }); })
      .catch(e => console.warn("webrtc restart failed", e));
  }

  pc.oniceconnectionstatechange = () => {
    const st = pc.iceConnectionState;
    if(st === "failed") restart();
    else if(st === "disconnected"){
      clearTimeout(restartTimer);
      restartTimer = setTimeout(() => {
        if(pc.iceConnectionState === "disconnected" || pc.iceConnectionState === "failed") restart();
      }, RESTART_AFTER_MS);
    }else if(st === "connected" || st === "completed"){
      clearTimeout(restartTimer);
      restartTimer = 0;
      restartGap = RESTART_MIN_GAP_MS;
    }
  };
  pc.onconnectionstatechange = () => {
    if(pc.connectionState === "connected"){
      encodeAll();
      if(isSlowComputer()) sendSignal({ lightVideo: true });
      reportIce("connected");
    }
    if(pc.connectionState === "failed") reportIce("failed");
    if(onConnectionChange) onConnectionChange(pc.connectionState);
  };

  if(initiator){
    pc.onnegotiationneeded = async () => {
      try{
        await pc.setLocalDescription(await pc.createOffer());
        encodeAll();
        sendSignal({ sdp: pc.localDescription.toJSON() });
      }catch(e){ console.warn("webrtc offer failed", e); }
    };
  }

  async function handleSignal(data){
    if(closed || !data) return;
    if(typeof data.lightVideo === "boolean"){
      peerSlow = data.lightVideo;
      encodeAll();
      return;
    }
    if(data.restartIce === true){
      if(initiator) restart();
      return;
    }
    try{
      if(data.sdp){
        await pc.setRemoteDescription(data.sdp);
        while(pendingCandidates.length) await pc.addIceCandidate(pendingCandidates.shift());
        if(data.sdp.type==="offer"){
          await pc.setLocalDescription(await pc.createAnswer());
          encodeAll();
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
    clearTimeout(restartTimer);
    stopSpeedWatch();
    /* Only close the connection — the local camera stream belongs to the
       whole app (pose engine keeps using it), so its tracks stay live. */
    try{ pc.close(); }catch(e){}
  }

  return { handleSignal, close, restart, pc };
}
