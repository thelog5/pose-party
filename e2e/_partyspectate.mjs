/* Party match probe: the YOU chip, where the GOT IT paper lands, and the
   featured-seat handover. Four real headless players through a real 2v2, so
   what is measured is the live board rather than a mock of it.

   The award question is geometric: a party half is a PORTRAIT crop of a
   landscape camera, so the player's face sits high and centred in it. This
   reports the paper's overlap with that band, plus its clearance from every
   other piece of HUD in the same half. */
import puppeteer from "puppeteer-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { mkdir } from "node:fs/promises";
import { passCameraGate } from "./_gate.mjs";
import { installVisionFixture } from "./vision-fixture.mjs";

const PORT = 3477;
const APP = `http://localhost:${PORT}`;
const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const SERVER_DIR = fileURLToPath(new URL("../server", import.meta.url));
const OUT = process.env.OUT || "./shots";
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0;
const ok = (cond, msg) => { console.log((cond ? "  ok  " : "  FAIL") + " " + msg); if (!cond) fails++; };
await mkdir(OUT, { recursive: true });

const server = spawn("node", ["index.js"], {
  cwd: SERVER_DIR,
  env: { ...process.env, PORT: String(PORT), PRECOUNT_MS: "1200",
         TUTORIAL_GRACE_MS: "3000", BETWEEN_ROUNDS_MS: "900",
         RATE_CREATE: "40", RATE_JOIN: "80" },
  stdio: "pipe",
});
await new Promise((res, rej) => {
  server.stdout.on("data", d => String(d).includes("server running") && res());
  setTimeout(() => rej(new Error("server failed to start")), 5000);
});

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: "new",
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--no-first-run"],
});

const TAGS = ["A", "B", "C", "D"];
const errors = Object.fromEntries(TAGS.map(t => [t, []]));
const readyUp = async page => {
  const open = await page.evaluate(() => !document.getElementById("howToPlay").classList.contains("hidden"));
  if (open) await page.click("#htpReady");
};
async function player(tag, name) {
  const c = await browser.createBrowserContext();
  const page = await c.newPage();
  await page.setViewport({ width: 1440, height: 810, deviceScaleFactor: 2 });
  /* MediaPipe logs its XNNPACK delegate at console.error level on the client
     that runs the face model — which is only ever the one wearing the crown.
     It is an INFO line from the wasm runtime, not a page fault. */
  const benign = t => /XNNPACK delegate|^INFO:/.test(t);
  page.on("console", m => { if (m.type() === "error" && !benign(m.text())) errors[tag].push(m.text()); });
  page.on("pageerror", e => errors[tag].push("PAGEERROR: " + e.message));
  await page.evaluateOnNewDocument(n => localStorage.setItem("poseCharadesName", n), name);
  await page.goto(APP, { waitUntil: "networkidle2", timeout: 60000 });
  await passCameraGate(page);
  await page.waitForFunction(() => document.getElementById("status").style.display === "none",
    { timeout: 60000, polling: 400 });
  /* the charge rule wants a fresh raw guess too, so recognition is injected
     through the same fixture party.test.mjs uses */
  await installVisionFixture(page);
  return page;
}
const txt = (p, sel) => p.evaluate(s => document.querySelector(s)?.textContent ?? null, sel);

try {
  const [A, B, C, D] = await Promise.all(TAGS.map((t, i) =>
    player(t, ["Alice", "Bob", "Cara", "Dan"][i])));

  await A.click("#modeParty");
  await A.waitForFunction(() => /^[A-Z2-9]{6}$/.test(document.getElementById("roomCodeText").textContent),
    { timeout: 15000, polling: 300 });
  const code = await txt(A, "#roomCodeText");
  await A.evaluate(async () => {
    const { lobbySettings, partyBridge } = await import("/js/online.js");
    /* THREE handovers are now read inside ONE word — mine, the rival's (with
       its SPECTATE_DELAY_MS beat) and my team-mate's — so the word has to
       outlast all of them or the later assertions measure the NEXT word's
       fresh board. The word is the server's maximum because the budget is
       spent on SCREENSHOTS, not on the game: one `#pmStage` shot of four live
       feeds is milliseconds on an idle machine and has been measured at 24
       SECONDS on a loaded one. Reads come before pictures everywhere below
       for the same reason. */
    const s = lobbySettings(); s.matchSecs = 240; s.wordSecs = 60;
    partyBridge.settings(s);
  });
  for (const p of [B, C, D]) {
    await p.click("#modeParty");
    await p.waitForFunction(() => /^[A-Z2-9]{6}$/.test(document.getElementById("roomCodeText").textContent),
      { timeout: 15000, polling: 300 });
    await p.evaluate(() => { document.getElementById("joinCode").value = ""; });
    await p.type("#joinCode", code);
    await p.click("#btnJoinRoom");
    await p.waitForFunction(c => document.getElementById("roomCodeText").textContent === c,
      { timeout: 15000, polling: 300 }, code);
  }
  await A.waitForFunction(() => !document.getElementById("btnStartMatch").disabled,
    { timeout: 15000, polling: 300 });

  /* the party lobby's own 2x2, with three real players on blue */
  const lobbyStage = await A.$(".lobbystage");
  await lobbyStage.screenshot({ path: `${OUT}/party-lobby-live.png` });

  await A.click("#btnStartMatch");
  for (const p of [A, B, C, D])
    await p.waitForFunction(() => document.body.dataset.screen === "pmatch",
      { timeout: 15000, polling: 200 });
  await sleep(1200);
  await Promise.all([A, B, C, D].map(readyUp));
  await Promise.all([A, B, C, D].map(p => p.waitForFunction(() =>
    document.body.dataset.state === "playing", { timeout: 20000, polling: 60 })));
  await sleep(400);

  /* ---- where everything on A's board is, in stage percentages ---- */
  const board = () => A.evaluate(() => {
    const st = document.getElementById("pmStage").getBoundingClientRect();
    const pct = r => ({
      L: +((r.left - st.left) / st.width * 100).toFixed(2),
      T: +((r.top - st.top) / st.height * 100).toFixed(2),
      R: +((r.right - st.left) / st.width * 100).toFixed(2),
      B: +((r.bottom - st.top) / st.height * 100).toFixed(2),
    });
    const seat = k => document.querySelector(`#pmStage [data-seat="${k}"]`);
    const out = { seats: {}, hud: {}, award: null };
    for (const k of ["blue0", "blue1", "blue2", "orange0", "orange1", "orange2"]) {
      const el = seat(k);
      if (!el || !el.offsetParent) continue;
      out.seats[k] = {
        ...pct(el.getBoundingClientRect()),
        mine: el.classList.contains("mine"),
        got: el.classList.contains("got"),
        tag: el.querySelector(".pm-nametag b")?.textContent || "",
        tagW: +(el.querySelector(".pm-nametag")?.getBoundingClientRect().width || 0).toFixed(1),
      };
    }
    for (const [name, sel] of [
      ["matchTimer", "#pmMatchTimerCard"], ["wordTimer", "#pmWordTimerCard"],
      ["scoreBlue", "#pmScoreBlue"], ["myGuess", "#pmMyTop"], ["myPast", "#pmMyPast"],
      ["word", "#pmWordCard"], ["robot", "#pmRobotMine"], ["myTopTape", "#pmMyTopTape"],
    ]) {
      const el = document.querySelector(sel);
      if (el && el.offsetParent) out.hud[name] = pct(el.getBoundingClientRect());
    }
    const paper = document.querySelector(".pp-award.show");
    if (paper) out.award = { ...pct(paper.getBoundingClientRect()), seat: paper.dataset.seat };
    return out;
  });

  const before = await board();
  const mineKey = Object.entries(before.seats).find(([, s]) => s.mine)?.[0];
  ok(mineKey === "blue0", `A starts featured on their own half (${mineKey})`);
  ok(before.seats[mineKey]?.tag === "YOU",
    `the local chip reads YOU (got "${before.seats[mineKey]?.tag}")`);
  const mateKey = Object.entries(before.seats).find(([k, s]) => k.startsWith("blue") && !s.mine)?.[0];
  ok(before.seats[mateKey]?.tag && before.seats[mateKey].tag !== "YOU",
    `the team-mate's chip still carries their name ("${before.seats[mateKey]?.tag}")`);
  ok(before.seats[mineKey].tagW > before.seats[mateKey].tagW * 1.15,
    `the YOU chip is meaningfully bigger (${before.seats[mineKey].tagW}px vs ${before.seats[mateKey].tagW}px)`);
  await (await A.$("#pmStage")).screenshot({ path: `${OUT}/party-match-before.png` });

  /* Mark the team-mate's <video> so the handover can prove it MOVED the
     element rather than making a new one (a new one starts black). */
  await A.evaluate(k => {
    const v = document.querySelector(`#pmStage [data-seat="${k}"] .slot > video`);
    if (v) v.__probeMark = true;
    const f = document.getElementById("pmFlash");
    window.__flash = false;
    new MutationObserver(() => {
      if (f.classList.contains("fire") && !f.classList.contains("miss")) window.__flash = true;
    }).observe(f, { attributes: true, attributeFilter: ["class"] });
  }, mateKey);

  /* ---- recognize A ---- */
  await A.evaluate(`(async () => {
    const { partyCheck } = await import('${APP}/js/partyMatch.js');
    const { state } = await import('${APP}/js/state.js');
    const w = state.game.word;
    clearInterval(window.__rec);
    window.__rec = setInterval(() => { window.__visionTick(w); state.smooth[w] = .95; partyCheck(w, .95); }, 70);
  })()`);
  await A.waitForFunction(() => document.querySelector('#pmStage [data-seat].mine.got'),
    { timeout: 10000, polling: 60 });
  await A.evaluate(() => clearInterval(window.__rec));

  /* The handover and the award both belong to ONE word, so everything below
     has to be read inside it. A 22-second word is long enough that a rollover
     cannot quietly reset `got` and re-seat the board between two reads and
     make the assertions measure the NEXT word's fresh state instead. */
  const wordId = await A.evaluate(`(async () => (await import('${APP}/js/state.js')).state.game.roundId)()`);
  const sameWord = async () => await A.evaluate(
    `(async () => (await import('${APP}/js/state.js')).state.game?.roundId)()`) === wordId;

  /* the flash is on at full strength for ~0.5s: shoot it inside that */
  await A.waitForFunction(() => window.__flash, { timeout: 2000, polling: 25 }).catch(() => {});
  ok(await A.evaluate(() => window.__flash), "your own catch fires the whole-stage green flash");
  /* the paper is stamped on the big half first — capture it there, before
     the slow screenshot can run into the 1.1s handover */
  await sleep(200);
  const stamped = await board();
  await (await A.$("#pmStage")).screenshot({ path: `${OUT}/party-match-flash.png` });
  ok(await sameWord(), "the stamp is read inside the word that earned it");
  await (await A.$("#pmStage")).screenshot({ path: `${OUT}/party-match-stamped.png` });

  /* THE FACE BAND. A 4:3 camera covering a 50.28%x100% portrait half shows
     its middle ~67%, so a player standing to pose reads at roughly the middle
     40% of the half, head high. In stage terms for the blue half that is
     x 15-35%, y 8-38%. The paper must not sit in it. */
  const FACE = { L: 15, R: 35, T: 8, B: 38 };
  const overlap = a => Math.max(0, Math.min(a.R, FACE.R) - Math.max(a.L, FACE.L)) *
                       Math.max(0, Math.min(a.B, FACE.B) - Math.max(a.T, FACE.T));
  ok(!!stamped.award, "the GOT IT paper is on the board");
  if (stamped.award) {
    const a = stamped.award;
    console.log(`      award  L${a.L} T${a.T} R${a.R} B${a.B}   (seat ${a.seat})`);
    ok(overlap(a) === 0,
      `the award clears the face band x${FACE.L}-${FACE.R} y${FACE.T}-${FACE.B} (overlap ${overlap(a).toFixed(1)})`);
    const clashes = Object.entries(stamped.hud).filter(([, r]) =>
      Math.min(a.R, r.R) > Math.max(a.L, r.L) && Math.min(a.B, r.B) > Math.max(a.T, r.T));
    ok(!clashes.length, `the award clears every HUD paper in its half${clashes.length ? " (hits " + clashes.map(c => c[0]).join(", ") + ")" : ""}`);
  }

  /* ---- the handover ---- */
  await sleep(1400);
  const after = await board();
  ok(await sameWord(), "the handover is read inside the word that earned it");
  const nowMine = Object.entries(after.seats).find(([, s]) => s.mine)?.[0];
  const nowBig = after.seats.blue0;
  ok(nowMine !== "blue0", `the big half was handed over (A is now in ${nowMine})`);
  ok(nowBig && !nowBig.got, `the featured seat shows a player who has NOT got it (${nowBig?.tag}, got=${nowBig?.got})`);
  ok(after.seats[nowMine]?.tag === "YOU", "the YOU chip followed A into the tile");
  const movedAward = after.award;
  ok(movedAward?.seat === nowMine,
    `A's award paper followed them to ${nowMine} (paper says ${movedAward?.seat})`);
  await (await A.$("#pmStage")).screenshot({ path: `${OUT}/party-match-spectating.png` });

  const feed = await A.evaluate(async () => {
    const v = document.querySelector('#pmStage [data-seat="blue0"] .slot > video');
    if (!v) return null;
    const count = () => v.getVideoPlaybackQuality?.().totalVideoFrames ?? 0;
    const a = count();
    await new Promise(r => setTimeout(r, 700));
    return { same: !!v.__probeMark, frames: count() - a, paused: v.paused,
             videos: document.querySelectorAll('#pmStage [data-seat="blue0"] .slot > video').length };
  });
  ok(feed?.same, "the handover MOVED the team-mate's own <video> (no new, black element)");
  ok(feed && feed.frames > 3 && !feed.paused,
    `the moved feed keeps showing new frames (${feed?.frames} in 0.7s)`);
  ok(feed?.videos === 1, `the big half holds exactly one feed (${feed?.videos})`);

  const names = { A: "ALICE", B: "BOB", C: "CARA", D: "DAN" };

  /* ---- THE OTHER TEAM'S HALF RE-RANKS TOO ----
     It used to be local-team only, so the opposing half sat on an opponent
     who had finished while their team-mate was still hunting in a postcard.
     The rival guess paper has to move WITH the seat, or it reads a player
     who is no longer above it. */
  const foeTag = after.seats.orange0?.tag;
  const foePage = [B, C, D].find((p, i) => names[["B", "C", "D"][i]] === foeTag);
  ok(!!foePage, `found the featured rival's page (${foeTag})`);
  const foePaper = () => A.evaluate(() => ({
    word: document.getElementById("pmFoeTopWord")?.textContent || "",
    lit: !!document.getElementById("pmFoeTop")?.classList.contains("recognized"),
  }));
  if (foePage) {
    /* THE RELAY ITSELF, which nothing covered before. The server no longer
       broadcasts every guess to the whole room; it writes only to the clients
       that asked for that player (party:watch), because each one displays
       exactly one rival and dropped the other four. So the featured rival's
       live read reaching this paper is now a thing that can break.
       A confidence under the party gate keeps them guessing without claiming,
       so this measures the relay and not a catch. */
    await foePage.evaluate(`(async () => {
      const { partyCheck } = await import('${APP}/js/partyMatch.js');
      const { state } = await import('${APP}/js/state.js');
      clearInterval(window.__rec);
      window.__rec = setInterval(() => { const w = state.game?.word; if (!w) return;
        partyCheck(w, .30); }, 120);
    })()`);
    const relayed = await A.waitForFunction(
      () => (document.getElementById("pmFoeTopWord")?.textContent || "").trim().length > 0 &&
            document.getElementById("pmFoeTopWord").textContent.trim() !== "GUESSING…",
      { timeout: 6000, polling: 60 }).then(() => true).catch(() => false);
    ok(relayed, `the featured rival's live guess reaches this client (${(await foePaper()).word})`);
    await foePage.evaluate(() => clearInterval(window.__rec));

    await foePage.evaluate(`(async () => {
      const { partyCheck } = await import('${APP}/js/partyMatch.js');
      const { state } = await import('${APP}/js/state.js');
      clearInterval(window.__rec);
      window.__rec = setInterval(() => { const w = state.game?.word; if (!w) return;
        window.__visionTick(w); state.smooth[w] = .95; partyCheck(w, .95); }, 70);
    })()`);
    await A.waitForFunction(() => document.querySelector('#pmStage [data-seat="orange0"], #pmStage [data-seat="orange1"]')
      && document.querySelector('#pmStage [data-seat^="orange"].got'),
      { timeout: 10000, polling: 60 });
    /* The winning rival's OWN catch must be drawn on their paper before the
       paper can belong to anybody else: hand over first and it never shows. */
    const won = await foePaper();
    await foePage.evaluate(() => clearInterval(window.__rec));
    ok(won.lit, `the rival's catch lights their own guess paper first (${won.word})`);

    /* past SPECTATE_DELAY_MS: the beat that lets that win be read */
    await sleep(1500);
    const foeAfter = await board();
    ok(await sameWord(), "the rival handover is read inside the same word");
    ok(foeAfter.seats.orange0 && foeAfter.seats.orange0.tag !== foeTag,
      `the other team's half handed over as well (${foeTag} -> ${foeAfter.seats.orange0?.tag})`);
    ok(foeAfter.seats.orange0 && !foeAfter.seats.orange0.got,
      `it shows a rival who has NOT got it (got=${foeAfter.seats.orange0?.got})`);
    const moved = await foePaper();
    ok(!moved.lit,
      `the rival guess paper moved with the seat, back to hunting (${moved.word})`);
    await (await A.$("#pmStage")).screenshot({ path: `${OUT}/party-match-foe-handover.png` });
  }

  /* ---- the team-mate gets it too: the big half STAYS on them ---- */
  const mateTag = after.seats.blue0?.tag;
  const matePage = [B, C, D].find((p, i) => names[["B", "C", "D"][i]] === mateTag);
  await A.evaluate(() => {
    window.__bonus = null;
    const paper = document.getElementById("pmTeamAward");
    const st = document.getElementById("pmStage").getBoundingClientRect();
    new MutationObserver(() => {
      if (window.__bonus || !paper.classList.contains("show")) return;
      const r = paper.getBoundingClientRect();
      window.__bonus = { title: paper.querySelector(".aw-got").textContent,
        pts: paper.querySelector(".aw-pts").textContent,
        L: (r.left - st.left) / st.width * 100, R: (r.right - st.left) / st.width * 100,
        T: (r.top - st.top) / st.height * 100, B: (r.bottom - st.top) / st.height * 100 };
    }).observe(paper, { attributes: true, attributeFilter: ["class"] });
  });
  ok(!!matePage, `found the team-mate's page (${mateTag})`);
  if (matePage) {
    await matePage.evaluate(`(async () => {
      const { partyCheck } = await import('${APP}/js/partyMatch.js');
      const { state } = await import('${APP}/js/state.js');
      clearInterval(window.__rec);
      window.__rec = setInterval(() => { const w = state.game?.word; if (!w) return;
        window.__visionTick(w); state.smooth[w] = .95; partyCheck(w, .95); }, 70);
    })()`);
    await A.waitForFunction(() => document.querySelector('#pmStage [data-seat="blue0"].got'),
      { timeout: 10000, polling: 60 });
    await matePage.evaluate(() => clearInterval(window.__rec));
    await A.waitForFunction(() => window.__bonus, { timeout: 3000, polling: 25 }).catch(() => {});
    await sleep(1200);
    /* EVERY READ FIRST, THE PICTURE AFTER. This word ends five seconds after
       the chase opens, and on a loaded machine one `#pmStage` screenshot of
       four live feeds has been measured at 24 SECONDS — so a screenshot taken
       between the catch and the assertions silently moved them onto the NEXT
       word and failed two of them for a reason that had nothing to do with
       the board. The bonus paper's own geometry comes from the
       MutationObserver above, so nothing here needs the image. */
    const stay = await board();
    const inWord = await sameWord();
    const bonus = await A.evaluate(() => window.__bonus);
    await (await A.$("#pmStage")).screenshot({ path: `${OUT}/party-match-team-bonus.png` });
    ok(inWord, "the team-mate's catch is read inside the same word");
    ok(stay.seats.blue0?.tag === mateTag && !stay.seats.blue0?.mine,
      `after the team-mate gets it too, the big half STAYS on them (${stay.seats.blue0?.tag})`);
    ok(bonus?.title === "TEAM BONUS!" && bonus?.pts === "+150",
      `the team bonus is the points paper (${bonus?.title} ${bonus?.pts})`);
    if (bonus) console.log(`      bonus  L${bonus.L.toFixed(1)} T${bonus.T.toFixed(1)} R${bonus.R.toFixed(1)} B${bonus.B.toFixed(1)}`);
    ok(bonus && bonus.R <= 50.5 && bonus.L >= 0,
      "it lands inside the blue team's half");
  }

  /* The watchdog: a REMOTE feed that loses its stream, or is paused, comes
     back (checkRemoteVideos). The seat must be found rather than assumed, and
     `:not(.mine)` is load-bearing twice over. This used to read blue0, which
     holds a remote player only while the handover is in force; once the word
     rolls over you are featured there again, and for the local player
     mountSeatVideo calls mountCamera(slot), which REPARENTS the shared #video
     into that slot. So a bare `[data-seat] .slot > video` first returned null
     (probe threw) and then picked the LOCAL CAMERA — which checkRemoteVideos
     ignores by design, so it never healed and the assertion failed on a quiet
     machine as readily as a loaded one. */
  const healed = await A.evaluate(async () => {
    const v = document.querySelector('#pmStage [data-seat]:not(.mine) .slot > video');
    if (!v) return { missing: true };
    const count = () => v.getVideoPlaybackQuality?.().totalVideoFrames ?? 0;
    v.srcObject = null;
    await new Promise(r => setTimeout(r, 1600));
    const back = !!v.srcObject && !v.paused;
    v.pause();
    await new Promise(r => setTimeout(r, 2200));
    /* COUNT OVER TWO SECONDS, NOT ONE. Re-attaching a stream starts a NEW
       decoder, which shows nothing until the next key frame — so the first
       second after a heal is exactly the second with the fewest frames in it,
       and a threshold measured there reports the healthy case as broken (3
       frames one run, 8 the next, against a `> 3` bar). The question this
       asks is "is it decoding again", and two seconds answers it without
       being a stopwatch on WebRTC's key-frame interval. */
    const a = count();
    await new Promise(r => setTimeout(r, 2000));
    return { back, playing: !v.paused, frames: count() - a };
  });
  ok(!healed.missing, "a remote seat feed was found to test the watchdog on");
  ok(healed.back, "a feed that lost its stream is attached again within ~1s");
  ok(healed.playing && healed.frames > 3,
    `a paused feed is played again and shows frames (${healed.frames} in 2s)`);


  /* ---- and it must not outlast the word ----
     Wait for a NEW roundId, not for `data-phase === "round"`: this word is
     already in that phase, so the phase test passes on the spot and proves
     nothing. */
  const roundId = await A.evaluate(`(async () => (await import('${APP}/js/state.js')).state.game.roundId)()`);
  await A.evaluate(`(async () => {
    const { state } = await import('${APP}/js/state.js');
    const was = ${JSON.stringify(roundId)};
    await new Promise(res => {
      const t = setInterval(() => {
        if (state.game?.roundId && state.game.roundId !== was) { clearInterval(t); res(); }
      }, 80);
      setTimeout(() => { clearInterval(t); res(); }, 30000);
    });
  })()`);
  await sleep(600);
  const next = await board();
  const restored = Object.entries(next.seats).find(([, s]) => s.mine)?.[0];
  ok(restored === "blue0", `the next word starts with A featured again (${restored})`);
  await (await A.$("#pmStage")).screenshot({ path: `${OUT}/party-match-restored.png` });

  for (const t of TAGS) ok(!errors[t].length, `player ${t}: no console errors (${errors[t].length})${errors[t].length ? " :: " + errors[t][0] : ""}`);
} catch (e) {
  console.error("PROBE ERROR", e);
  fails++;
} finally {
  await browser.close();
  server.kill();
}
console.log(fails ? `\n${fails} FAILED` : "\nall spectate checks passed");
process.exit(fails ? 1 : 0);
