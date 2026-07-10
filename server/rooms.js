/* Room store and the authoritative match loop.

   The server owns: room membership, the shared word deck, round timing,
   claim validation, and scores. Clients only ever send *claims*; the first
   valid claim per round wins the word. No landmarks, video, or training
   data ever reach this process — the only classifier-adjacent thing the
   server sees is each player's word list, which it needs to deal words
   both sides can actually play.

   All notifications go through the `emit(socketId, event, payload)`
   callback injected at construction, so this module has no socket.io
   dependency and the whole match loop is unit-testable with fake clocks. */

import crypto from "crypto";
import { CODE_ALPHABET } from "./validate.js";

export function createRoomStore({ config, emit }){
  const rooms = new Map();          // code -> room
  const socketRoom = new Map();     // socketId -> code

  function randomCode(){
    let code;
    do{
      code = Array.from({length:6}, () =>
        CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]).join("");
    }while(rooms.has(code));
    return code;
  }

  const roomOf = socketId => rooms.get(socketRoom.get(socketId));
  const peerOf = (room, socketId) => room.players.find(p => p.id !== socketId);
  const playerOf = (room, socketId) => room.players.find(p => p.id === socketId);

  function scoresPayload(room){
    return room.players.map(p => ({ id: p.id, name: p.name, score: p.score }));
  }

  /* ---------------- lifecycle ---------------- */

  function createRoom(socketId, name, labels){
    if(socketRoom.has(socketId)) return { error: "already-in-room" };
    if(rooms.size >= config.maxRooms) return { error: "server-full" };
    const code = randomCode();
    const room = {
      code,
      createdAt: Date.now(),
      players: [{ id: socketId, name, labels, score: 0, ready: false }],
      phase: "lobby",              // lobby | starting | round | between | done
      roundNum: 0,
      roundId: null,
      word: null,
      roundStart: 0,
      roundEnd: 0,
      deck: [],
      timer: null,
    };
    rooms.set(code, room);
    socketRoom.set(socketId, code);
    return { code };
  }

  function joinRoom(socketId, code, name, labels){
    if(socketRoom.has(socketId)) return { error: "already-in-room" };
    const room = rooms.get(code);
    if(!room) return { error: "no-such-room" };
    if(room.players.length >= 2) return { error: "room-full" };
    if(room.phase !== "lobby") return { error: "match-in-progress" };
    room.players.push({ id: socketId, name, labels, score: 0, ready: false });
    socketRoom.set(socketId, code);
    const host = room.players[0];
    emit(host.id, "room:peer", { name });
    return { code, peerName: host.name };
  }

  /* Both players must flag ready (camera up, dataset trained). */
  function ready(socketId){
    const room = roomOf(socketId);
    if(!room) return { error: "not-in-room" };
    if(room.phase !== "lobby") return { error: "match-in-progress" };
    const me = playerOf(room, socketId);
    me.ready = true;
    if(room.players.length === 2 && room.players.every(p => p.ready)){
      const shared = room.players[0].labels.filter(l =>
        l !== "idle" && room.players[1].labels.includes(l));
      if(!shared.length){
        for(const p of room.players) emit(p.id, "room:error", { error: "no-shared-words" });
        return { error: "no-shared-words" };
      }
      room.sharedWords = shared;
      startMatch(room);
    }
    return { ok: true };
  }

  function shuffledDeck(room){
    const words = room.sharedWords.slice();
    for(let i = words.length - 1; i > 0; i--){
      const j = crypto.randomInt(i + 1);
      [words[i], words[j]] = [words[j], words[i]];
    }
    return words;
  }

  function startMatch(room){
    room.phase = "starting";
    room.deck = shuffledDeck(room);
    const startAt = Date.now() + config.preCountMs;
    for(const p of room.players)
      emit(p.id, "match:start", { startAt, rounds: config.rounds, players: scoresPayload(room) });
    room.timer = setTimeout(() => startRound(room), config.preCountMs);
  }

  function startRound(room){
    if(!rooms.has(room.code)) return;
    room.roundNum++;
    if(room.roundNum > config.rounds){ return endMatch(room); }
    if(!room.deck.length) room.deck = shuffledDeck(room);
    room.phase = "round";
    room.word = room.deck.pop();
    room.roundId = crypto.randomBytes(8).toString("hex");
    room.roundStart = Date.now();
    room.roundEnd = room.roundStart + config.wordMs;
    for(const p of room.players)
      emit(p.id, "round:start", {
        roundId: room.roundId, word: room.word,
        roundNum: room.roundNum, rounds: config.rounds,
        endsAt: room.roundEnd, scores: scoresPayload(room),
      });
    room.timer = setTimeout(() => resolveRound(room, null, "timeout"), config.wordMs);
  }

  /* The heart of the authority: accept or reject a point claim. */
  function claim(socketId, roundId){
    const room = roomOf(socketId);
    if(!room) return { error: "not-in-room" };
    if(room.phase !== "round") return { error: "no-active-round" };
    if(typeof roundId !== "string" || roundId !== room.roundId)
      return { error: "stale-round" };
    const now = Date.now();
    if(now < room.roundStart || now > room.roundEnd) return { error: "out-of-window" };
    const me = playerOf(room, socketId);
    if(!me) return { error: "not-in-room" };
    resolveRound(room, me, "claim");
    return { ok: true };
  }

  function resolveRound(room, winner, reason){
    if(room.phase !== "round") return;   // already resolved — duplicate/late
    clearTimeout(room.timer);
    room.phase = "between";
    if(winner) winner.score += 1;        // exactly one point per word, spec'd
    for(const p of room.players)
      emit(p.id, "round:result", {
        roundId: room.roundId,
        word: room.word,
        winnerId: winner ? winner.id : null,
        reason,
        scores: scoresPayload(room),
      });
    room.roundId = null;
    room.timer = setTimeout(() => startRound(room), config.betweenRoundsMs);
  }

  function endMatch(room){
    room.phase = "done";
    clearTimeout(room.timer);
    for(const p of room.players)
      emit(p.id, "match:end", { scores: scoresPayload(room) });
    destroyRoom(room.code); // players re-lobby with a fresh code for a rematch
  }

  /* ---------------- teardown ---------------- */

  function destroyRoom(code){
    const room = rooms.get(code);
    if(!room) return;
    clearTimeout(room.timer);
    for(const p of room.players) socketRoom.delete(p.id);
    rooms.delete(code);
  }

  function leave(socketId){
    const room = roomOf(socketId);
    if(!room) return;
    const peer = peerOf(room, socketId);
    if(peer) emit(peer.id, "peer:left", {});
    destroyRoom(room.code);
  }

  function sweep(){
    const now = Date.now();
    for(const [code, room] of rooms)
      if(now - room.createdAt > config.roomTtlMs) destroyRoom(code);
  }

  /* Relay opaque WebRTC signaling to the peer, nothing else. */
  function relaySignal(socketId, data){
    const room = roomOf(socketId);
    if(!room) return { error: "not-in-room" };
    const peer = peerOf(room, socketId);
    if(!peer) return { error: "no-peer" };
    emit(peer.id, "rtc:signal", { data });
    return { ok: true };
  }

  return { createRoom, joinRoom, ready, claim, leave, relaySignal, sweep,
           _rooms: rooms };
}
