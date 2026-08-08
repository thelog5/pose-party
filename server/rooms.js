/* Room store and the authoritative match loop.

   The server owns: room membership, the shared word deck, round timing,
   claim validation, and scores. Clients only ever send synchronized
   recognition timestamps. No landmarks, video, or training data ever reach
   this process. The server sees each player's word list to deal shared words,
   and relays the current top label/confidence so the opponent's guess paper
   can update; that ephemeral guess is never stored.

   All notifications go through the `emit(socketId, event, payload)`
   callback injected at construction, so this module has no socket.io
   dependency and the whole match loop is unit-testable with fake clocks. */

import crypto from "crypto";
import { CODE_ALPHABET, cleanLabels } from "./validate.js";
import {
  CHASE_WINDOW_MS,
  calculateFirstPoints,
  calculateChaserPoints,
  PARTY_TEAM_BONUS,
  PARTY_CHASE_WINDOW_MS,
  calculatePartyPlayerPoints,
} from "../pose-charades-external-data/js/scoring.js";

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

  function createRoom(socketId, name, labels, settings){
    if(socketRoom.has(socketId)) return { error: "already-in-room" };
    if(rooms.size >= config.maxRooms) return { error: "server-full" };
    const code = randomCode();
    const room = {
      code,
      kind: "1v1",
      createdAt: Date.now(),
      players: [{ id: socketId, name, labels, score: 0, ready: false }],
      /* host-picked, validated in index.js; falls back to server config */
      settings: {
        matchMs: settings?.matchMs ?? config.matchMs,
        wordMs: settings?.wordMs ?? config.wordMs,
      },
      phase: "lobby",              // lobby | tutorial | starting | round | chase | sudden | between | done
      roundNum: 0,
      roundId: null,
      word: null,
      roundStart: 0,
      roundEnd: 0,
      matchEndsAt: 0,
      matchExpired: false,
      suddenDeath: false,
      firstClaim: null,
      deck: [],
      timer: null,
      matchTimer: null,
    };
    rooms.set(code, room);
    socketRoom.set(socketId, code);
    return { code };
  }

  function joinRoom(socketId, code, name, labels){
    if(socketRoom.has(socketId)) return { error: "already-in-room" };
    const room = rooms.get(code);
    if(!room) return { error: "no-such-room" };
    if(room.kind === "party") return { error: "party-room" }; // client retries as party
    if(room.players.length >= 2) return { error: "room-full" };
    if(room.phase !== "lobby") return { error: "match-in-progress" };
    room.players.push({ id: socketId, name, labels, score: 0, ready: false });
    socketRoom.set(socketId, code);
    const host = room.players[0];
    emit(host.id, "room:peer", { name });
    return { code, peerName: host.name, settings: publicSettings(room) };
  }

  function publicSettings(room){
    const s = room.settings;
    return { matchSecs: Math.round(s.matchMs/1000), wordSecs: Math.round(s.wordMs/1000) };
  }

  /* Host tweaks settings while the room is still in the lobby. */
  function setSettings(socketId, s){
    const room = roomOf(socketId);
    if(!room) return { error: "not-in-room" };
    if(room.players[0].id !== socketId) return { error: "not-host" };
    if(room.phase !== "lobby") return { error: "match-in-progress" };
    room.settings = { matchMs: s.matchMs, wordMs: s.wordMs };
    const peer = peerOf(room, socketId);
    if(peer) emit(peer.id, "room:settings", { settings: publicSettings(room) });
    return { ok: true };
  }

  /* Both players must flag ready (camera up, dataset trained). When both
     are, each client hears room:ready — the host's START button unlocks. */
  function ready(socketId){
    const room = roomOf(socketId);
    if(!room) return { error: "not-in-room" };
    if(room.phase !== "lobby") return { error: "match-in-progress" };
    const me = playerOf(room, socketId);
    me.ready = true;
    if(room.players.length === 2 && room.players.every(p => p.ready))
      for(const p of room.players) emit(p.id, "room:ready", {});
    return { ok: true };
  }

  /* Host presses START MATCH. The server, not the client, decides whether
     the match can begin. */
  function begin(socketId){
    const room = roomOf(socketId);
    if(!room) return { error: "not-in-room" };
    if(room.phase !== "lobby") return { error: "match-in-progress" };
    if(room.players[0].id !== socketId) return { error: "not-host" };
    if(room.players.length < 2) return { error: "need-two" };
    if(!room.players.every(p => p.ready)) return { error: "not-ready" };
    const shared = room.players[0].labels.filter(l =>
      l !== "idle" && room.players[1].labels.includes(l));
    if(!shared.length){
      for(const p of room.players) emit(p.id, "room:error", { error: "no-shared-words" });
      return { error: "no-shared-words" };
    }
    room.sharedWords = shared;
    startMatch(room);
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
    clearTimeout(room.timer);
    clearTimeout(room.matchTimer);
    room.createdAt = Date.now();
    room.roundNum = 0;
    room.roundId = null;
    room.word = null;
    room.roundStart = 0;
    room.roundEnd = 0;
    room.chaseEndsAt = 0;
    for(const p of room.players){
      p.score = 0;
      p.ready = false;
    }
    room.phase = "tutorial";
    room.deck = shuffledDeck(room);
    room.matchExpired = false;
    room.suddenDeath = false;
    room.firstClaim = null;
    room.tutorialId = crypto.randomBytes(8).toString("hex");
    room.tutorialReady = new Set();
    room.tutorialTimeoutAt = Date.now() + config.tutorialTimeoutMs;
    for(const p of room.players)
      emit(p.id, "match:prepare", {
        tutorialId: room.tutorialId,
        tutorialTimeoutAt: room.tutorialTimeoutAt,
        matchMs: room.settings.matchMs,
        players: scoresPayload(room),
      });
    /* The normal path is every client acknowledging the tutorial. This is a
       safety release only: a crashed/backgrounded tab cannot hold the other
       player forever, and the full synchronized count-in still follows. */
    room.timer = setTimeout(() => releaseMatchCountdown(room),
      config.tutorialTimeoutMs);
  }

  function releaseMatchCountdown(room){
    if(!rooms.has(room.code) || room.phase !== "tutorial") return false;
    clearTimeout(room.timer);
    room.phase = "starting";
    const startAt = Date.now() + config.preCountMs;
    /* time-based mode: the match clock starts when round 1 does */
    room.matchEndsAt = startAt + room.settings.matchMs;
    for(const p of room.players)
      emit(p.id, "match:start", {
        tutorialId: room.tutorialId,
        startAt,
        matchEndsAt: room.matchEndsAt,
        players: scoresPayload(room),
      });
    room.timer = setTimeout(() => startRound(room), config.preCountMs);
    room.matchTimer = setTimeout(() => onMatchDeadline(room),
      Math.max(0, room.matchEndsAt - Date.now()));
    return true;
  }

  function matchTutorialReady(socketId, tutorialId){
    const room = roomOf(socketId);
    if(!room || room.kind !== "1v1") return { error: "not-in-room" };
    if(typeof tutorialId !== "string" || tutorialId !== room.tutorialId)
      return { error: "stale-tutorial" };
    if(room.phase !== "tutorial"){
      /* A duplicate can cross the release broadcast. Treat it as the same
         idempotent acknowledgement instead of surfacing a false failure. */
      if(room.tutorialReady?.has(socketId) &&
         ["starting", "round", "chase", "sudden", "between"].includes(room.phase))
        return { ok: true, started: true,
          ready: room.tutorialReady.size, total: room.players.length };
      return { error: "match-in-progress" };
    }
    room.tutorialReady.add(socketId);
    const ready = room.players.filter(p => room.tutorialReady.has(p.id)).length;
    const total = room.players.length;
    const started = ready === total && releaseMatchCountdown(room);
    return { ok: true, ready, total, started: !!started };
  }

  function startRound(room){
    if(!rooms.has(room.code)) return;
    if(room.matchExpired && !room.suddenDeath) return finishMatchOrSuddenDeath(room);
    room.roundNum++;
    /* rounds is only a safety cap; the two-minute match clock is decisive */
    if(!room.suddenDeath && (Date.now() >= room.matchEndsAt || room.roundNum > config.rounds)){
      room.matchExpired = true;
      return finishMatchOrSuddenDeath(room);
    }
    if(!room.deck.length) room.deck = shuffledDeck(room);
    room.phase = room.suddenDeath ? "sudden" : "round";
    room.word = room.deck.pop();
    room.roundId = crypto.randomBytes(8).toString("hex");
    room.roundStart = Date.now();
    room.roundEnd = room.suddenDeath
      ? room.roundStart + room.settings.wordMs
      : Math.min(room.roundStart + room.settings.wordMs, room.matchEndsAt);
    room.firstClaim = null;
    for(const p of room.players)
      emit(p.id, "round:start", {
        roundId: room.roundId, word: room.word,
        roundNum: room.roundNum,
        endsAt: room.roundEnd, scores: scoresPayload(room),
        suddenDeath: room.suddenDeath,
      });
    room.timer = setTimeout(() => resolveNoClaim(room),
      Math.max(0, room.roundEnd - Date.now()) + config.claimGraceMs);
  }

  function validRecognitionTime(room, at, cutoff){
    if(!Number.isFinite(at)) return false;
    if(at < room.roundStart || at > cutoff) return false;
    /* A client clock is synchronized to server time. A little future skew is
       tolerated, but a fabricated timestamp well ahead of the server is not. */
    return at <= Date.now() + config.claimFutureSkewMs;
  }

  /* The heart of the authority: accept or reject a timestamped recognition.
     Scores are calculated from `recognizedAt`; packet arrival never enters
     either formula. */
  function claim(socketId, roundId, recognizedAt){
    const room = roomOf(socketId);
    if(!room) return { error: "not-in-room" };
    if(!["round", "chase", "sudden"].includes(room.phase))
      return { error: "no-active-round" };
    if(typeof roundId !== "string" || roundId !== room.roundId)
      return { error: "stale-round" };
    const me = playerOf(room, socketId);
    if(!me) return { error: "not-in-room" };
    const at = Number(recognizedAt);

    if(room.phase === "sudden"){
      if(!validRecognitionTime(room, at, room.roundEnd))
        return { error: "out-of-window" };
      endMatch(room, me.id, true);
      return { ok: true, phase: "sudden-death" };
    }

    if(room.phase === "round"){
      if(!validRecognitionTime(room, at, room.roundEnd))
        return { error: "out-of-window" };
      const points = calculateFirstPoints(room.roundEnd - at, room.settings.wordMs);
      me.score += points;
      room.firstClaim = { id: me.id, at, points };
      room.phase = "chase";
      room.chaseEndsAt = at + CHASE_WINDOW_MS;
      clearTimeout(room.timer);
      for(const p of room.players)
        emit(p.id, "round:chase", {
          roundId: room.roundId,
          firstId: me.id,
          firstAt: at,
          firstPoints: points,
          chaseEndsAt: room.chaseEndsAt,
          scores: scoresPayload(room),
        });
      room.timer = setTimeout(() => resolveChaseTimeout(room),
        Math.max(0, room.chaseEndsAt - Date.now()) + config.claimGraceMs);
      return { ok: true, phase: "chase", points };
    }

    /* Chase phase. The first player's repeat claim cannot score twice. */
    if(room.firstClaim?.id === me.id) return { error: "already-claimed" };
    if(!room.firstClaim || !validRecognitionTime(room, at, room.chaseEndsAt))
      return { error: "out-of-window" };
    resolveChaser(room, me, at);
    return { ok: true, phase: "resolved" };
  }

  function resolveChaser(room, claimant, at){
    if(room.phase !== "chase" || !room.firstClaim) return;
    clearTimeout(room.timer);
    let first = room.firstClaim;
    let chaserId = claimant.id;
    let chaserPoints;
    let delaySeconds;

    /* Timestamp ordering, rather than message ordering, determines who was
       actually first. This also makes near-simultaneous packets fair when
       they take different network paths. */
    if(at < first.at){
      const provisional = playerOf(room, first.id);
      provisional.score -= first.points;

      const correctedFirstPoints =
        calculateFirstPoints(room.roundEnd - at, room.settings.wordMs);
      claimant.score += correctedFirstPoints;
      delaySeconds = (first.at - at) / 1000;
      chaserPoints = calculateChaserPoints(correctedFirstPoints, delaySeconds);
      provisional.score += chaserPoints;

      chaserId = first.id;
      first = { id: claimant.id, at, points: correctedFirstPoints };
    }else{
      delaySeconds = (at - first.at) / 1000;
      chaserPoints = calculateChaserPoints(first.points, delaySeconds);
      claimant.score += chaserPoints;
    }

    finishRound(room, {
      reason: "chase-success",
      winnerId: first.id,
      firstId: first.id,
      chaserId,
      firstPoints: first.points,
      chaserPoints,
      delaySeconds,
    });
  }

  function resolveChaseTimeout(room){
    if(room.phase !== "chase" || !room.firstClaim) return;
    const chaser = room.players.find(p => p.id !== room.firstClaim.id);
    finishRound(room, {
      reason: "chase-timeout",
      winnerId: room.firstClaim.id,
      firstId: room.firstClaim.id,
      chaserId: chaser?.id || null,
      firstPoints: room.firstClaim.points,
      chaserPoints: 0,
      delaySeconds: CHASE_WINDOW_MS / 1000,
    });
  }

  function resolveNoClaim(room){
    if(room.phase === "sudden"){
      for(const p of room.players)
        emit(p.id, "round:result", {
          roundId: room.roundId, word: room.word,
          winnerId: null, reason: "sudden-timeout",
          suddenDeath: true, scores: scoresPayload(room),
        });
      return endMatch(room, null, true);
    }
    if(room.phase !== "round") return;
    finishRound(room, {
      reason: room.matchExpired ? "match-timeout" : "timeout",
      winnerId: null,
      firstId: null,
      chaserId: null,
      firstPoints: 0,
      chaserPoints: 0,
      delaySeconds: null,
    });
  }

  function finishRound(room, result){
    if(!["round", "chase"].includes(room.phase)) return;
    clearTimeout(room.timer);
    room.phase = "between";
    for(const p of room.players)
      emit(p.id, "round:result", {
        roundId: room.roundId,
        word: room.word,
        ...result,
        scores: scoresPayload(room),
      });
    room.roundId = null;
    room.firstClaim = null;

    if(room.matchExpired || Date.now() >= room.matchEndsAt){
      room.matchExpired = true;
      return finishMatchOrSuddenDeath(room);
    }
    room.timer = setTimeout(() => startRound(room), config.betweenRoundsMs);
  }

  function onMatchDeadline(room){
    if(!rooms.has(room.code) || room.phase === "done" || room.suddenDeath) return;
    room.matchExpired = true;
    room.matchTimer = null;
    /* A chase that began before zero owns its full five seconds. A live word
       owns only the tiny network-arrival grace already on its round timer. */
    if(room.phase === "chase" || room.phase === "round") return;
    finishMatchOrSuddenDeath(room);
  }

  function finishMatchOrSuddenDeath(room){
    if(!rooms.has(room.code) || room.phase === "done") return;
    clearTimeout(room.timer);
    clearTimeout(room.matchTimer);
    room.matchTimer = null;
    const [a, b] = room.players;
    if(!a || !b) return endMatch(room);
    if(a.score === b.score && !room.suddenDeath) return startSuddenDeath(room);
    const winnerId = a.score === b.score ? null : (a.score > b.score ? a.id : b.id);
    endMatch(room, winnerId, room.suddenDeath);
  }

  function startSuddenDeath(room){
    room.suddenDeath = true;
    room.matchExpired = true;
    room.phase = "between";
    for(const p of room.players)
      emit(p.id, "match:sudden", { scores: scoresPayload(room) });
    room.timer = setTimeout(() => startRound(room), config.betweenRoundsMs);
  }

  function endMatch(room, winnerId=null, suddenDeath=false){
    room.phase = "done";
    clearTimeout(room.timer);
    clearTimeout(room.matchTimer);
    room.timer = null;
    room.matchTimer = null;
    room.rematch = new Set();
    for(const p of room.players)
      emit(p.id, "match:end", {
        scores: scoresPayload(room),
        winnerId,
        suddenDeath,
        rematch: matchRematchState(room),
      });
    /* Keep the two-player room alive through results. Both players can undo
       or confirm a rematch vote without exchanging a fresh invite code. */
  }

  const matchRematchState = room => ({
    ready: room.rematch ? room.rematch.size : 0,
    total: room.players.length,
  });

  function broadcastMatchRematch(room){
    for(const p of room.players)
      emit(p.id, "match:rematch", {
        ...matchRematchState(room),
        mine: room.rematch?.has(p.id) || false,
        voters: [...(room.rematch || [])],
      });
  }

  /* The 1v1 results paper is a real ready toggle, not a disguised "new
     lobby" button. The second vote resets scores and starts the same room. */
  function matchRematch(socketId){
    const room = roomOf(socketId);
    if(!room || room.kind !== "1v1") return { error: "not-in-room" };
    if(room.phase !== "done") return { error: "match-in-progress" };
    if(room.players.length !== 2) return { error: "need-two" };
    if(!room.rematch) room.rematch = new Set();
    if(room.rematch.has(socketId)) room.rematch.delete(socketId);
    else room.rematch.add(socketId);
    const state = matchRematchState(room);
    broadcastMatchRematch(room);

    if(state.ready === state.total){
      room.rematch.clear();
      startMatch(room);
      return { ok: true, started: true, ...state, mine: true };
    }
    return {
      ok: true,
      ...state,
      mine: room.rematch.has(socketId),
    };
  }

  /* ---------------- party rooms (3v3 lobby) ----------------
     Same store, kind:"party". Up to TEAM_CAP per side; players are
     auto-balanced on join and may switch while the target team has room.
     The host may start once both teams have at least MIN_PER_TEAM. The
     party game itself ships later — the lobby is fully live. */
  const TEAM_CAP = 3, MIN_PER_TEAM = 2, PARTY_CAP = TEAM_CAP * 2;

  function partyRoster(room){
    return {
      hostId: room.players[0] ? room.players[0].id : null,
      players: room.players.map(p => ({ id: p.id, name: p.name, team: p.team })),
      settings: publicSettings(room),
    };
  }
  function broadcastRoster(room){
    for(const p of room.players) emit(p.id, "party:roster", partyRoster(room));
  }
  const teamCount = (room, team) => room.players.filter(p => p.team === team).length;

  function partyCreate(socketId, name, settings, labels){
    if(socketRoom.has(socketId)) return { error: "already-in-room" };
    if(rooms.size >= config.maxRooms) return { error: "server-full" };
    const code = randomCode();
    const room = {
      code, kind: "party", createdAt: Date.now(),
      players: [{ id: socketId, name, team: "blue", labels: labels || [], score: 0 }],
      settings: {
        matchMs: settings?.matchMs ?? config.matchMs,
        wordMs: settings?.wordMs ?? config.wordMs,
      },
      phase: "lobby", timer: null,
    };
    rooms.set(code, room);
    socketRoom.set(socketId, code);
    return { code, roster: partyRoster(room) };
  }

  function partyJoin(socketId, code, name, labels){
    if(socketRoom.has(socketId)) return { error: "already-in-room" };
    const room = rooms.get(code);
    if(!room) return { error: "no-such-room" };
    if(room.kind !== "party") return { error: "1v1-room" }; // client retries as 1v1
    if(room.players.length >= PARTY_CAP) return { error: "room-full" };
    if(room.phase !== "lobby") return { error: "match-in-progress" };
    const blue = teamCount(room, "blue"), orange = teamCount(room, "orange");
    const team = orange < blue ? "orange" : (blue < orange ? "blue" : (blue < TEAM_CAP ? "blue" : "orange"));
    room.players.push({ id: socketId, name, team, labels: labels || [], score: 0 });
    socketRoom.set(socketId, code);
    broadcastRoster(room);
    return { code, roster: partyRoster(room) };
  }

  function partyTeam(socketId, team){
    const room = roomOf(socketId);
    if(!room || room.kind !== "party") return { error: "not-in-room" };
    if(team !== "blue" && team !== "orange") return { error: "bad-payload" };
    const me = playerOf(room, socketId);
    if(me.team === team) return { ok: true };
    if(teamCount(room, team) >= TEAM_CAP) return { error: "team-full" };
    me.team = team;
    broadcastRoster(room);
    return { ok: true };
  }

  function partyName(socketId, name){
    const room = roomOf(socketId);
    if(!room || room.kind !== "party") return { error: "not-in-room" };
    if(room.phase !== "lobby") return { error: "match-in-progress" };
    const me = playerOf(room, socketId);
    if(!me) return { error: "not-in-room" };
    if(me.name !== name){
      me.name = name;
      broadcastRoster(room);
    }
    return { ok: true };
  }

  function partySettings(socketId, s){
    const room = roomOf(socketId);
    if(!room || room.kind !== "party") return { error: "not-in-room" };
    if(room.players[0].id !== socketId) return { error: "not-host" };
    room.settings = { matchMs: s.matchMs, wordMs: s.wordMs };
    broadcastRoster(room);
    return { ok: true };
  }

  function partyStart(socketId){
    const room = roomOf(socketId);
    if(!room || room.kind !== "party") return { error: "not-in-room" };
    if(room.players[0].id !== socketId) return { error: "not-host" };
    if(room.phase !== "lobby") return { error: "match-in-progress" };
    if(teamCount(room, "blue") < MIN_PER_TEAM || teamCount(room, "orange") < MIN_PER_TEAM)
      return { error: "need-teams" };

    /* Every player must be able to perform every dealt word, so the deck is
       the intersection across all six lists — not just the host's. */
    const lists = room.players.map(p => p.labels || []);
    const shared = (lists[0] || []).filter(l =>
      l !== "idle" && lists.every(list => list.includes(l)));
    if(!shared.length){
      for(const p of room.players) emit(p.id, "party:error", { error: "no-shared-words" });
      return { error: "no-shared-words" };
    }
    room.sharedWords = shared;
    for(const p of room.players) emit(p.id, "party:started", { roster: partyRoster(room) });
    startPartyMatch(room);
    return { ok: true };
  }

  /* ---------------- party match (authoritative) ----------------
     Everyone performs the same word simultaneously. Placement is decided by
     synchronized recognition timestamps across BOTH teams; the first team to
     get all of its members recognized banks a completion bonus and opens a
     short final window for the other team's stragglers. The match itself is
     decided on total score when the match clock expires — round wins are
     reported for feedback but never end the match. */

  function partyTeamScore(room, team){
    return room.players
      .filter(p => p.team === team)
      .reduce((sum, p) => sum + (p.score || 0), 0) + (room.teamBonus?.[team] || 0);
  }

  function partyScores(room){
    return {
      players: room.players.map(p =>
        ({ id: p.id, name: p.name, team: p.team, score: p.score || 0 })),
      teams: { blue: partyTeamScore(room, "blue"), orange: partyTeamScore(room, "orange") },
      roundWins: { ...(room.roundWins || { blue: 0, orange: 0 }) },
    };
  }

  function startPartyMatch(room){
    clearTimeout(room.timer);
    clearTimeout(room.matchTimer);
    room.phase = "tutorial";
    room.deck = shuffledDeck(room);
    room.roundNum = 0;
    room.matchExpired = false;
    room.teamBonus = { blue: 0, orange: 0 };
    room.roundWins = { blue: 0, orange: 0 };
    for(const p of room.players) p.score = 0;
    room.tutorialId = crypto.randomBytes(8).toString("hex");
    room.tutorialReady = new Set();
    room.tutorialTimeoutAt = Date.now() + config.tutorialTimeoutMs;
    for(const p of room.players)
      emit(p.id, "party:match", {
        tutorialId: room.tutorialId,
        tutorialTimeoutAt: room.tutorialTimeoutAt,
        matchMs: room.settings.matchMs,
        wordMs: room.settings.wordMs,
        roster: partyRoster(room), scores: partyScores(room),
      });
    room.timer = setTimeout(() => releasePartyCountdown(room),
      config.tutorialTimeoutMs);
  }

  function releasePartyCountdown(room){
    if(!rooms.has(room.code) || room.phase !== "tutorial") return false;
    clearTimeout(room.timer);
    room.phase = "starting";
    const startAt = Date.now() + config.preCountMs;
    room.matchEndsAt = startAt + room.settings.matchMs;
    for(const p of room.players)
      emit(p.id, "party:countdown", {
        tutorialId: room.tutorialId,
        startAt,
        matchEndsAt: room.matchEndsAt,
      });
    room.timer = setTimeout(() => startPartyRound(room), config.preCountMs);
    room.matchTimer = setTimeout(() => {
      room.matchExpired = true;
      room.matchTimer = null;
      /* a live word (or its chase) owns its remaining time; the deadline is
         applied when that round resolves */
      if(room.phase === "round" || room.phase === "chase") return;
      endPartyMatch(room);
    }, Math.max(0, room.matchEndsAt - Date.now()));
    return true;
  }

  function partyTutorialReady(socketId, tutorialId){
    const room = roomOf(socketId);
    if(!room || room.kind !== "party") return { error: "not-in-room" };
    if(typeof tutorialId !== "string" || tutorialId !== room.tutorialId)
      return { error: "stale-tutorial" };
    if(room.phase !== "tutorial"){
      if(room.tutorialReady?.has(socketId) &&
         ["starting", "round", "chase", "between"].includes(room.phase))
        return { ok: true, started: true,
          ready: room.tutorialReady.size, total: room.players.length };
      return { error: "match-in-progress" };
    }
    room.tutorialReady.add(socketId);
    const ready = room.players.filter(p => room.tutorialReady.has(p.id)).length;
    const total = room.players.length;
    const started = ready === total && releasePartyCountdown(room);
    return { ok: true, ready, total, started: !!started };
  }

  function startPartyRound(room){
    if(!rooms.has(room.code) || room.phase === "done") return;
    if(room.matchExpired || Date.now() >= room.matchEndsAt) return endPartyMatch(room);
    if(!room.deck.length) room.deck = shuffledDeck(room);
    room.roundNum++;
    room.phase = "round";
    room.word = room.deck.pop();
    room.roundId = crypto.randomBytes(8).toString("hex");
    room.roundStart = Date.now();
    room.roundEnd = Math.min(room.roundStart + room.settings.wordMs, room.matchEndsAt);
    room.finishes = [];            // [{id, at}] in arrival order; sorted at resolve
    room.completedTeam = null;
    room.chaseEndsAt = 0;
    for(const p of room.players)
      emit(p.id, "party:round", {
        roundId: room.roundId, word: room.word, roundNum: room.roundNum,
        endsAt: room.roundEnd, scores: partyScores(room),
      });
    room.timer = setTimeout(() => resolvePartyRound(room, "timeout"),
      Math.max(0, room.roundEnd - Date.now()) + config.claimGraceMs);
  }

  const partyFinished = (room, id) => (room.finishes || []).some(f => f.id === id);

  function partyClaim(socketId, roundId, recognizedAt){
    const room = roomOf(socketId);
    if(!room || room.kind !== "party") return { error: "not-in-room" };
    if(room.phase !== "round" && room.phase !== "chase")
      return { error: "no-active-round" };
    if(typeof roundId !== "string" || roundId !== room.roundId)
      return { error: "stale-round" };
    const me = playerOf(room, socketId);
    if(!me) return { error: "not-in-room" };
    if(partyFinished(room, me.id)) return { error: "already-claimed" };

    const at = Number(recognizedAt);
    const cutoff = room.phase === "chase" ? room.chaseEndsAt : room.roundEnd;
    if(!validRecognitionTime(room, at, cutoff)) return { error: "out-of-window" };

    room.finishes.push({ id: me.id, at });
    /* provisional placement for instant feedback; resolvePartyRound re-sorts
       by timestamp so a late packet with an earlier stamp still scores right */
    const place = room.finishes.filter(f => f.at < at).length;
    for(const p of room.players)
      emit(p.id, "party:got", {
        roundId: room.roundId, id: me.id, team: me.team, place,
      });

    /* first team to have every current member recognized banks the bonus and
       starts the final chase for the other side */
    const mates = room.players.filter(p => p.team === me.team);
    if(!room.completedTeam && mates.every(p => partyFinished(room, p.id))){
      room.completedTeam = me.team;
      room.teamBonus[me.team] += PARTY_TEAM_BONUS;
      room.phase = "chase";
      room.chaseEndsAt = at + PARTY_CHASE_WINDOW_MS;
      clearTimeout(room.timer);
      for(const p of room.players)
        emit(p.id, "party:chase", {
          roundId: room.roundId, team: me.team,
          chaseEndsAt: room.chaseEndsAt, bonus: PARTY_TEAM_BONUS,
        });
      room.timer = setTimeout(() => resolvePartyRound(room, "chase-timeout"),
        Math.max(0, room.chaseEndsAt - Date.now()) + config.claimGraceMs);
    }

    if(room.players.every(p => partyFinished(room, p.id)))
      resolvePartyRound(room, "all-in");

    return { ok: true, place };
  }

  function resolvePartyRound(room, reason){
    if(room.phase !== "round" && room.phase !== "chase") return;
    clearTimeout(room.timer);
    room.phase = "between";

    /* Authoritative placement: timestamp order, never arrival order. */
    const ordered = (room.finishes || []).slice().sort((a, b) => a.at - b.at);
    const roundTeam = { blue: 0, orange: 0 };
    const results = ordered.map((f, place) => {
      const player = playerOf(room, f.id);
      const points = calculatePartyPlayerPoints(place, room.roundEnd - f.at);
      if(player){
        player.score += points;
        roundTeam[player.team] += points;
      }
      return { id: f.id, place, points, at: f.at };
    });
    if(room.completedTeam) roundTeam[room.completedTeam] += PARTY_TEAM_BONUS;

    const winner = roundTeam.blue === roundTeam.orange
      ? null : (roundTeam.blue > roundTeam.orange ? "blue" : "orange");
    if(winner) room.roundWins[winner]++;

    for(const p of room.players)
      emit(p.id, "party:result", {
        roundId: room.roundId, word: room.word, reason,
        results, completedTeam: room.completedTeam,
        roundTeam, winner, scores: partyScores(room),
      });
    room.roundId = null;

    if(room.matchExpired || Date.now() >= room.matchEndsAt) return endPartyMatch(room);
    room.timer = setTimeout(() => startPartyRound(room), config.betweenRoundsMs);
  }

  /* Same ephemeral relay as 1v1, fanned out to the rest of the party so any
     client can render any player's live read. Nothing is stored. */
  function relayPartyGuess(socketId, roundId, label, confidence){
    const room = roomOf(socketId);
    if(!room || room.kind !== "party") return { error: "not-in-room" };
    if(room.phase !== "round" && room.phase !== "chase")
      return { error: "no-active-round" };
    if(typeof roundId !== "string" || roundId !== room.roundId)
      return { error: "stale-round" };
    const me = playerOf(room, socketId);
    const cleanLabel = cleanLabels([label])?.[0];
    if(!me || !cleanLabel || !me.labels.includes(cleanLabel))
      return { error: "bad-payload" };
    if(!Number.isFinite(confidence) || confidence < 0 || confidence > 1)
      return { error: "bad-payload" };
    if(partyFinished(room, socketId)) return { ok: true };
    for(const p of room.players){
      if(p.id === socketId) continue;
      emit(p.id, "party:guess", {
        roundId, id: socketId, label: cleanLabel,
        confidence: Math.round(confidence * 1000) / 1000,
      });
    }
    return { ok: true };
  }

  function endPartyMatch(room){
    if(!rooms.has(room.code) || room.phase === "done") return;
    room.phase = "done";
    clearTimeout(room.timer);
    clearTimeout(room.matchTimer);
    const scores = partyScores(room);
    const winner = scores.teams.blue === scores.teams.orange
      ? null : (scores.teams.blue > scores.teams.orange ? "blue" : "orange");
    /* The room used to be destroyed here, which meant a rematch needed a new
       code re-shared with everyone standing in the room. It now survives on
       the normal TTL so the results screen can collect ready votes. */
    room.rematch = new Set();
    for(const p of room.players)
      emit(p.id, "party:end", { scores, winner, rematch: rematchState(room) });
  }

  const rematchState = room => ({
    ready: room.rematch ? room.rematch.size : 0,
    total: room.players.length,
  });

  function broadcastRematch(room){
    for(const p of room.players)
      emit(p.id, "party:rematch", {
        ...rematchState(room),
        voters: [...(room.rematch || [])],
      });
  }

  /* Toggling is deliberate: a misclick must be undoable, and seeing the count
     drop is honest feedback. */
  function partyRematch(socketId){
    const room = roomOf(socketId);
    if(!room || room.kind !== "party") return { error: "not-in-room" };
    if(room.phase !== "done") return { error: "match-in-progress" };
    if(!room.rematch) room.rematch = new Set();
    if(room.rematch.has(socketId)) room.rematch.delete(socketId);
    else room.rematch.add(socketId);
    broadcastRematch(room);

    if(room.rematch.size >= room.players.length && room.players.length >= 2){
      if(teamCount(room, "blue") < MIN_PER_TEAM || teamCount(room, "orange") < MIN_PER_TEAM)
        return { ok: true, waiting: "need-teams" };
      room.rematch.clear();
      room.phase = "lobby";
      startPartyMatch(room);
      return { ok: true, started: true };
    }
    return { ok: true, ...rematchState(room) };
  }

  /* Targeted mesh signaling: every pair of party members holds its own
     WebRTC link, so blobs are relayed to one member, not broadcast. */
  function partySignal(socketId, to, data){
    const room = roomOf(socketId);
    if(!room || room.kind !== "party") return { error: "not-in-room" };
    const dest = room.players.find(p => p.id === to);
    if(!dest) return { error: "no-such-peer" };
    emit(dest.id, "party:signal", { from: socketId, data });
    return { ok: true };
  }

  function partyLeave(socketId){
    const room = roomOf(socketId);
    if(!room || room.kind !== "party") return;
    room.players = room.players.filter(p => p.id !== socketId);
    socketRoom.delete(socketId);
    if(!room.players.length){ destroyRoom(room.code); return; }
    for(const p of room.players) emit(p.id, "party:left", { id: socketId });

    if(room.phase === "done"){
      room.rematch?.delete(socketId);
      broadcastRoster(room);
      broadcastRematch(room);
      return;
    }
    if(room.phase === "lobby"){ broadcastRoster(room); return; }

    if(room.phase === "tutorial"){
      room.tutorialReady?.delete(socketId);
      /* Re-evaluate the barrier against the CURRENT roster. A player who
         disconnects after everyone else accepted must not leave a phantom
         acknowledgement behind and deadlock the survivors until fallback. */
      if(!teamCount(room, "blue") || !teamCount(room, "orange"))
        return endPartyMatch(room);
      broadcastRoster(room);
      if(room.players.every(p => room.tutorialReady?.has(p.id)))
        releasePartyCountdown(room);
      return;
    }

    /* Mid-match: a side that empties ends the match. Otherwise the leaver may
       have been the only one holding up a team, so re-test completion —
       without this the round would stall until the word timer expired. */
    if(!teamCount(room, "blue") || !teamCount(room, "orange")) return endPartyMatch(room);
    broadcastRoster(room);
    if(room.phase !== "round" && room.phase !== "chase") return;
    if(room.finishes) room.finishes = room.finishes.filter(f => f.id !== socketId);
    if(room.players.every(p => partyFinished(room, p.id)))
      return resolvePartyRound(room, "all-in");
    if(!room.completedTeam){
      for(const team of ["blue", "orange"]){
        const mates = room.players.filter(p => p.team === team);
        if(mates.length && mates.every(p => partyFinished(room, p.id))){
          room.completedTeam = team;
          room.teamBonus[team] += PARTY_TEAM_BONUS;
          room.phase = "chase";
          room.chaseEndsAt = Date.now() + PARTY_CHASE_WINDOW_MS;
          clearTimeout(room.timer);
          for(const p of room.players)
            emit(p.id, "party:chase", {
              roundId: room.roundId, team,
              chaseEndsAt: room.chaseEndsAt, bonus: PARTY_TEAM_BONUS,
            });
          room.timer = setTimeout(() => resolvePartyRound(room, "chase-timeout"),
            PARTY_CHASE_WINDOW_MS + config.claimGraceMs);
          break;
        }
      }
    }
  }

  /* ---------------- teardown ---------------- */

  function destroyRoom(code){
    const room = rooms.get(code);
    if(!room) return;
    clearTimeout(room.timer);
    clearTimeout(room.matchTimer);
    for(const p of room.players) socketRoom.delete(p.id);
    rooms.delete(code);
  }

  function leave(socketId){
    const room = roomOf(socketId);
    if(!room) return;
    if(room.kind === "party"){ partyLeave(socketId); return; }
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

  /* Ephemeral UI-only classifier relay. Labels must come from the sender's
     validated training list and match the active round; no pose/face data is
     accepted, persisted, or broadcast beyond the one opponent. */
  function relayGuess(socketId,roundId,label,confidence){
    const room=roomOf(socketId);
    if(!room || room.kind!=="1v1") return { error:"not-in-room" };
    if(!["round","chase","sudden"].includes(room.phase))
      return { error:"no-active-round" };
    if(typeof roundId!=="string" || roundId!==room.roundId)
      return { error:"stale-round" };
    const me=playerOf(room,socketId);
    const cleanLabel=cleanLabels([label])?.[0];
    if(!me || !cleanLabel || !me.labels.includes(cleanLabel))
      return { error:"bad-payload" };
    if(!Number.isFinite(confidence) || confidence<0 || confidence>1)
      return { error:"bad-payload" };
    if(room.firstClaim?.id===socketId) return { ok:true };
    const peer=peerOf(room,socketId);
    if(!peer) return { error:"no-peer" };
    emit(peer.id,"round:guess",{
      roundId,
      label:cleanLabel,
      confidence:Math.round(confidence*1000)/1000,
    });
    return { ok:true };
  }

  return { createRoom, joinRoom, ready, begin, setSettings, claim,
           matchTutorialReady, matchRematch, leave,
           relaySignal, relayGuess, sweep,
           partyCreate, partyJoin, partyTeam, partyName, partySettings, partyStart,
           partyTutorialReady, partySignal, partyClaim, relayPartyGuess, partyRematch,
           _rooms: rooms };
}
