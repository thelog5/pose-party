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
  await page.waitForFunction(() => !document.getElementById("camGate").classList.contains("hidden"),
    { timeout: 30000, polling: 50 });
  await page.click("#cgEnable");
  await page.waitForFunction(() => document.getElementById("status").style.display === "none",
    { timeout: 60000, polling: 400 });
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
    const s = lobbySettings(); s.matchSecs = 70; s.wordSecs = 22;
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

  /* ---- recognize A ---- */
  await A.evaluate(`(async () => {
    const { partyCheck } = await import('${APP}/js/partyMatch.js');
    const { state } = await import('${APP}/js/state.js');
    const w = state.game.word;
    clearInterval(window.__rec);
    window.__rec = setInterval(() => { state.smooth[w] = .95; partyCheck(w, .95); }, 70);
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

  /* the paper is stamped on the big half first — capture it there */
  await sleep(420);
  const stamped = await board();
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
