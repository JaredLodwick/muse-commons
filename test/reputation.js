// Reputation + highlights tests (social-layer PR-6).
//
// Unit: buildReputation (board stats, connections, standout threads,
// pins), applyPinHighlight/applyUnpinHighlight (host gate, validation).
// Integration: real lobby — reputation appears on /api/muse/<name>,
// non-host pin_highlight gets HOST_ONLY.
//   node test/reputation.js
// Exit 0 = all pass, 1 = any failure.
const http = require("http");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { spawn } = require("child_process");
const WebSocket = require("ws");

const threads = require("../server/threads");
const reputation = require("../server/reputation");

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
}

const NOW = 1_700_000_000_000;
function fakeRoom(id) {
  return { id, tseq: 0, transcript: [], agents: new Map(), visibility: "public", persistent: true, topic: id };
}
function say(room, from, text, t, extra = {}) {
  const e = { ev_id: "e-" + Math.random().toString(36).slice(2), tseq: ++room.tseq, t, from, text, ...extra };
  threads.assign(room, e);
  room.transcript.push(e);
  return e;
}

// --- unit -----------------------------------------------------------
console.log("unit");
{
  const rooms = new Map();
  const plaza = fakeRoom("plaza");
  // thread 1: Aria + Bex chatting (3 msgs)
  say(plaza, "Aria", "hi bex", NOW - 3000);
  say(plaza, "Bex", "hi aria", NOW - 2900, { to: "Aria" });
  say(plaza, "Aria", "how goes", NOW - 2800, { to: "Bex" });
  // thread 2 (well after the 10-min broadcast gap): Aria + Cara, directed
  const T2 = NOW - 15 * 60 * 1000;
  say(plaza, "Aria", "hey cara", T2, { to: "Cara" });
  say(plaza, "Cara", "hey aria", T2 + 100, { to: "Aria" });
  // thread 3: a guest prompt always starts its own thread
  say(plaza, "Guest", "a guest asks", T2 + 200, { guest: true, thread_new: true });
  rooms.set("plaza", plaza);

  const posts = [
    { from: "Aria", kind: "offer", status: "active" },
    { from: "Aria", kind: "want", status: "active", deal_room: "deal-1" },
    { from: "Aria", kind: "offer", status: "closed", deal_room: "deal-2" },
    { from: "Bex", kind: "offer", status: "active" },
  ];
  const highlights = [
    { id: "hl-1", muse: "Aria", thread_id: "th-plaza-1", room_id: "plaza", ev_id: null, note: "great moment", t: NOW - 50 },
    { id: "hl-2", muse: "Bex", thread_id: "th-plaza-1", room_id: "plaza", ev_id: null, note: "bex moment", t: NOW - 40 },
  ];
  const ctx = { rooms, threads, posts, highlights };

  const r = reputation.buildReputation(ctx, "Aria");
  check("board posts counted", r.board.posts === 3, JSON.stringify(r.board));
  check("board kinds", r.board.offers === 2 && r.board.wants === 1 && r.board.intros === 0);
  check("matches counted", r.board.matches === 2, String(r.board.matches));
  check("completed counted", r.board.completed === 1, String(r.board.completed));
  check("connections found", r.connections.length === 2, JSON.stringify(r.connections));
  check("top connection is Bex", r.connections[0].name === "Bex", JSON.stringify(r.connections[0]));
  check("guest excluded from graph", !r.connections.some((c) => /^guest/i.test(c.name)));
  check("self excluded from graph", !r.connections.some((c) => c.name === "Aria"));
  check("standout threads ranked", r.standout_threads.length === 2 && r.standout_threads[0].count === 3);
  check("pins attached", r.pinned.length === 1 && r.pinned[0].note === "great moment");
  check("case-insensitive", reputation.buildReputation(ctx, "aria").board.posts === 3);

  const nobody = reputation.buildReputation(ctx, "Zed");
  check("empty reputation", nobody.board.posts === 0 && nobody.connections.length === 0 && nobody.pinned.length === 0);

  // pin validation (fake deps)
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rep-"));
  const deps = {
    dataDir: tmpDir,
    findThread: (id) => id === "th-plaza-1" ? { room: plaza, thread: { id: "th-plaza-1" } } : null,
    threadHasEvent: (room, tid, evId) => plaza.transcript.some((e) => e.ev_id === evId && e.thread_id === tid),
  };
  let pr = reputation.applyPinHighlight({ isHost: false, muse: "Aria", thread_id: "th-plaza-1" }, deps);
  check("non-host cannot pin", pr.error && pr.error.code === "HOST_ONLY");
  pr = reputation.applyPinHighlight({ isHost: true, muse: "Aria", thread_id: "th-nope" }, deps);
  check("bad thread rejected", pr.error && pr.error.code === "NO_SUCH_THREAD");
  pr = reputation.applyPinHighlight({ isHost: true, muse: "Aria", thread_id: "th-plaza-1", ev_id: "e-bogus" }, deps);
  check("bad event rejected", pr.error && pr.error.code === "NO_SUCH_EVENT");
  pr = reputation.applyPinHighlight({ isHost: true, muse: "", thread_id: "th-plaza-1" }, deps);
  check("empty muse rejected", pr.error && pr.error.code === "BAD_MUSE");
  const evId = plaza.transcript[0].ev_id;
  pr = reputation.applyPinHighlight({ isHost: true, by: "Apollo", muse: "Aria", thread_id: "th-plaza-1", ev_id: evId, note: "x".repeat(300) }, deps);
  check("pin created", pr.highlight && pr.highlight.id.startsWith("hl-") && pr.highlight.note.length === 200);
  check("pin persisted", reputation.readHighlights(tmpDir).length === 1);
  let ur = reputation.applyUnpinHighlight({ isHost: false }, tmpDir, pr.highlight.id);
  check("non-host cannot unpin", ur.error && ur.error.code === "HOST_ONLY");
  ur = reputation.applyUnpinHighlight({ isHost: true }, tmpDir, "hl-nope");
  check("bad unpin rejected", ur.error && ur.error.code === "NO_SUCH_HIGHLIGHT");
  ur = reputation.applyUnpinHighlight({ isHost: true }, tmpDir, pr.highlight.id);
  check("unpin works", !!ur.unpinned && reputation.readHighlights(tmpDir).length === 0);
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// --- integration ----------------------------------------------------
const REPO = path.join(__dirname, "..");
const LOBBY = path.join(REPO, "server", "lobby.js");
const PORT = 18795;
for (const f of ["transcripts.json", "presence.json", "asks.json", "highlights.json", "profiles.json", "board.json"]) {
  try { fs.unlinkSync(path.join(REPO, "data", f)); } catch { /* ignore */ }
}
const RUN = Math.random().toString(36).slice(2, 8);
const T = (s) => `${s}-${RUN}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startLobby() {
  return spawn("node", [LOBBY], {
    env: { ALLOW_UNVERIFIED: "1", ...process.env, PORT: String(PORT), LOBBY_PUBLIC_URL: `http://127.0.0.1:${PORT}/` },
    stdio: ["ignore", "pipe", "pipe"],
  });
}
function waitForListening(child) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("server did not start")), 15000);
    let out = "";
    const onData = (d) => {
      out += d.toString();
      if (out.includes("listening")) { clearTimeout(timer); child.stdout.off("data", onData); resolve(); }
    };
    child.stdout.on("data", onData);
    child.on("exit", (c) => { clearTimeout(timer); reject(new Error(`server exited ${c}: ${out}`)); });
  });
}
function openAgent(name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    const rec = { ws, name, msgs: [] };
    const timer = setTimeout(() => reject(new Error(`hello timeout for ${name}`)), 10000);
    ws.on("open", () => ws.send(JSON.stringify({ type: "hello", name })));
    ws.on("message", (raw) => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      rec.msgs.push(m);
      if (m.type === "state" && m.agents && m.agents.some((a) => a.name === name)) { clearTimeout(timer); resolve(rec); }
    });
    ws.on("error", (e) => { clearTimeout(timer); reject(e); });
  });
}
function get(p) {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${PORT}${p}`, (res) => {
      let body = ""; res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    }).on("error", reject);
  });
}
function waitFor(rec, pred, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("wait timeout")), timeout);
    const iv = setInterval(() => {
      const m = rec.msgs.find(pred);
      if (m) { clearInterval(iv); clearTimeout(timer); resolve(m); }
    }, 50);
  });
}

async function main() {
  const server = startLobby();
  try {
    await waitForListening(server);
    console.log("integration");
    const aName = T("RepA"), bName = T("RepB");
    const a = await openAgent(aName);
    const b = await openAgent(bName);
    // chat: a and b talk (directed, same pair thread)
    a.ws.send(JSON.stringify({ type: "talk", from: aName, to: bName, text: `hey b ${RUN}` }));
    await sleep(300);
    b.ws.send(JSON.stringify({ type: "talk", from: bName, to: aName, text: `hey a ${RUN}` }));
    await sleep(400);
    // a posts a board offer
    a.ws.send(JSON.stringify({ type: "post", kind: "offer", topics: [`topic-${RUN}`], title: `offer ${RUN}`, details: "test" }));
    await waitFor(a, (m) => m.type === "post_ok");
    await sleep(300);

    const prof = JSON.parse((await get(`/api/muse/${encodeURIComponent(aName)}`)).body).profile;
    check("reputation present", !!prof.reputation, "missing");
    check("board post counted", prof.reputation.board.posts === 1 && prof.reputation.board.offers === 1,
      JSON.stringify(prof.reputation.board));
    check("connection found", prof.reputation.connections.some((c) => c.name === bName),
      JSON.stringify(prof.reputation.connections));
    check("standout thread", prof.reputation.standout_threads.length >= 1);

    // non-host pin attempt is rejected over the wire
    a.ws.send(JSON.stringify({ type: "pin_highlight", muse: aName, thread_id: "th-plaza-1", note: "sneaky" }));
    const denied = await waitFor(a, (m) => m.type === "error" && m.code === "HOST_ONLY");
    check("non-host pin rejected", !!denied);

    // profile page renders the reputation section with the hard-rule copy
    const page = await get(`/muse/${encodeURIComponent(aName)}`);
    check("page shows reputation", page.status === 200 && page.body.includes("In the Commons"), String(page.status));
    check("no endorsement language", page.body.includes("not endorsement"));
    check("verification/trust not conflated",
      page.body.includes("Verification proves control of identity") && page.body.includes("trust reflects behavior"));

    a.ws.close();
    b.ws.close();
  } finally {
    server.kill("SIGTERM");
  }
  if (failures) { console.log(`\n${failures} FAILURES`); process.exit(1); }
  console.log("\nall reputation tests passed");
}

main().catch((e) => { console.error("fatal:", e); process.exit(1); });
