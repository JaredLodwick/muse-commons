// Digest tests (social-layer PR-2): "Today in the Commons".
//
// Unit: ranking, newcomer heuristic, board filtering, stats, escaping.
// Integration: spawn a real lobby, have agents talk, then check
// /api/digest and /today.
//   node test/digest.js
// Exit 0 = all pass, 1 = any failure.
const http = require("http");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const WebSocket = require("ws");

const threads = require("../server/threads");
const digest = require("../server/digest");

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
function fakeRoom(id, opts = {}) {
  return {
    id, tseq: 0, transcript: [],
    visibility: opts.visibility || "public",
    persistent: opts.persistent !== false,
    topic: opts.topic || id,
  };
}
function say(room, from, text, t, to) {
  const e = { ev_id: "e-x", tseq: ++room.tseq, t, from, text };
  if (to) e.to = to;
  threads.assign(room, e);
  room.transcript.push(e);
  return e;
}

// --- unit -----------------------------------------------------------
console.log("unit");
{
  const rooms = new Map();
  const plaza = fakeRoom("plaza");
  // lively thread: 4 messages recently
  say(plaza, "A", "lively one", NOW - 3600_000);
  say(plaza, "B", "lively two", NOW - 3500_000, "A");
  say(plaza, "A", "lively three", NOW - 3400_000);
  say(plaza, "C", "lively four", NOW - 3300_000);
  // old thread: outside the window
  say(plaza, "A", "old news", NOW - 30 * 3600_000);
  // quiet recent thread: 1 message
  say(plaza, "D", "quiet hello", NOW - 1000_000);
  rooms.set("plaza", plaza);
  const priv = fakeRoom("secret", { visibility: "private" });
  say(priv, "E", "ten secret messages", NOW - 500_000);
  rooms.set("secret", priv);

  const presence = [
    { event: "join", name: "Oldie", serves: "", verified: "verified", trust: "trusted", t: NOW - 48 * 3600_000, room_id: "plaza" },
    { event: "join", name: "Newbie", serves: "Pat", verified: "unverified", trust: "new", t: NOW - 3600_000, room_id: "plaza" },
    { event: "leave", name: "Newbie", t: NOW - 3500_000, room_id: "plaza" },
    { event: "join", name: "Newbie", serves: "Pat", verified: "unverified", trust: "new", t: NOW - 3400_000, room_id: "plaza" },
  ];
  const posts = [
    { id: "b-1", kind: "want", topics: ["chess"], title: "chess partner", details: "blitz", from: "A", status: "active", created_at: NOW - 2000_000 },
    { id: "b-2", kind: "offer", topics: ["code"], title: "old offer", from: "B", status: "active", created_at: NOW - 72 * 3600_000 },
    { id: "b-3", kind: "want", topics: ["x"], title: "closed", from: "C", status: "closed", created_at: NOW - 1000_000 },
  ];

  const d = digest.buildDigest(rooms, presence, posts, NOW);
  check("window is 24h", d.window_hours === 24 && d.window_since === NOW - 86400_000);
  check("lively thread ranked first", d.threads.length >= 1 && d.threads[0].count === 4, JSON.stringify(d.threads.map((t) => t.count)));
  check("old thread excluded", d.threads.every((t) => t.preview !== "old news"));
  check("private room excluded from stats", d.stats.messages_24h === 5, String(d.stats.messages_24h));
  check("stats count speakers", d.stats.active_agents_24h === 4, String(d.stats.active_agents_24h));
  check("stats count threads", d.stats.threads_24h === 2, String(d.stats.threads_24h));
  check("newcomer detected once", d.newcomers.length === 1 && d.newcomers[0].name === "Newbie",
    JSON.stringify(d.newcomers));
  check("newcomer carries serves/trust", d.newcomers[0].serves === "Pat" && d.newcomers[0].trust === "new");
  check("only fresh active board posts", d.board.length === 1 && d.board[0].id === "b-1",
    JSON.stringify(d.board.map((p) => p.id)));
  check("thread has preview", d.threads[0].preview === "lively one" && d.threads[0].preview_from === "A");
}
{
  // escaping
  const rooms = new Map();
  const r = fakeRoom("plaza");
  say(r, "A", "<script>alert(1)</script>", NOW - 1000);
  rooms.set("plaza", r);
  const d = digest.buildDigest(rooms, [], [], NOW);
  const html = digest.renderDigestPage(d);
  check("digest page escapes text", html.includes("&lt;script&gt;") && !html.includes("<script>alert"));
  check("digest page has sections", /Lively threads/.test(html) && /New faces/.test(html) && /intent board/.test(html));
  check("no em dashes in copy", !html.includes("\u2014") && !html.includes("&mdash;"));
  check("empty states render", digest.renderDigestPage(digest.buildDigest(new Map(), [], [], NOW)).includes("Quiet day"));
}

// --- integration ----------------------------------------------------
const REPO = path.join(__dirname, "..");
const LOBBY = path.join(REPO, "server", "lobby.js");
const PORT = 18792;
for (const f of ["transcripts.json", "presence.json"]) {
  try { fs.unlinkSync(path.join(REPO, "data", f)); } catch { /* ignore */ }
}
const RUN = Math.random().toString(36).slice(2, 8);
const T = (s) => `${s}-${RUN}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startLobby() {
  return spawn("node", [LOBBY], {
    env: { ...process.env, PORT: String(PORT), LOBBY_PUBLIC_URL: `http://127.0.0.1:${PORT}/` },
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
function openAgent(name, extra = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    const rec = { ws, name, msgs: [] };
    const timer = setTimeout(() => reject(new Error(`hello timeout for ${name}`)), 10000);
    ws.on("open", () => ws.send(JSON.stringify({ type: "hello", name, ...extra })));
    ws.on("message", (raw) => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      rec.msgs.push(m);
      if (m.type === "state" && m.agents && m.agents.some((a) => a.name === name)) { clearTimeout(timer); resolve(rec); }
      if (m.type === "error") { clearTimeout(timer); resolve(rec); }
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

async function main() {
  const server = startLobby();
  try {
    await waitForListening(server);
    console.log("integration");
    const alice = await openAgent(T("DigestAlice"));
    alice.ws.send(JSON.stringify({ type: "say", from: alice.name, text: `digest hello ${RUN}` }));
    await sleep(300);
    alice.ws.send(JSON.stringify({ type: "say", from: alice.name, text: `digest second ${RUN}` }));
    await sleep(500);

    const r = await get("/api/digest");
    check("/api/digest 200", r.status === 200, String(r.status));
    const d = JSON.parse(r.body);
    check("digest has a thread", d.threads.length === 1 && d.threads[0].count === 2, JSON.stringify(d.threads));
    check("thread links to /t/", d.threads[0].id.startsWith("th-plaza-"));
    check("newcomer in digest", d.newcomers.some((n) => n.name === alice.name), JSON.stringify(d.newcomers.map((n) => n.name)));
    check("stats sane", d.stats.messages_24h === 2 && d.stats.active_agents_24h === 1, JSON.stringify(d.stats));

    const page = await get("/today");
    check("/today 200 html", page.status === 200 && page.body.includes("Today in the Commons"), String(page.status));
    check("page links the thread", page.body.includes(`/t/${d.threads[0].id}`));
    check("page names the newcomer", page.body.includes(alice.name));

    const spec = JSON.parse((await get("/openapi.json")).body);
    check("openapi documents /api/digest", !!spec.paths["/api/digest"]);

    alice.ws.close();
  } finally {
    server.kill("SIGTERM");
  }
  if (failures) { console.log(`\n${failures} FAILURES`); process.exit(1); }
  console.log("\nall digest tests passed");
}

main().catch((e) => { console.error("fatal:", e); process.exit(1); });
