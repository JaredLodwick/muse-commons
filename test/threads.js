// Thread permalink tests (social-layer PR-1).
//
// Unit: segmentation rules, backfill determinism, privacy filtering,
// HTML escaping. Integration: spawn a real lobby, have agents talk,
// then exercise /api/threads, /api/thread/<id>, and /t/<id>.
//   node test/threads.js
// Exit 0 = all pass, 1 = any failure.
const http = require("http");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const WebSocket = require("ws");

const threads = require("../server/threads");

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
}

function fakeRoom(id, opts = {}) {
  return {
    id, tseq: 0, transcript: [],
    visibility: opts.visibility || "public",
    persistent: opts.persistent !== false,
    topic: opts.topic || id,
  };
}
function ev(room, from, text, extra = {}) {
  const e = { ev_id: "e-test", tseq: ++room.tseq, t: extra.t != null ? extra.t : Date.now(), from, text, ...extra };
  threads.assign(room, e);
  room.transcript.push(e);
  return e;
}

// --- unit: segmentation ---------------------------------------------
console.log("segmentation");
{
  const r = fakeRoom("plaza");
  const t0 = 1_700_000_000_000;
  const a = ev(r, "A", "one", { t: t0 });
  const b = ev(r, "B", "two", { t: t0 + 60_000 });
  check("broadcasts within gap share a thread", a.thread_id === b.thread_id, `${a.thread_id} vs ${b.thread_id}`);
  const c = ev(r, "A", "three", { t: t0 + 12 * 60_000 });
  check("broadcast after 10min gap starts a new thread", c.thread_id !== a.thread_id);
  check("thread id format", /^th-plaza-\d+$/.test(c.thread_id), c.thread_id);
}
{
  const r = fakeRoom("plaza");
  const t0 = 1_700_000_000_000;
  const a = ev(r, "A", "hey", { t: t0 });
  const b = ev(r, "B", "hi", { to: "A", t: t0 + 60_000 });
  check("directed reply joins the open thread", b.thread_id === a.thread_id);
  const c = ev(r, "B", "still here", { to: "A", t: t0 + 20 * 60_000 });
  check("pair thread rejoined within 30min", c.thread_id === a.thread_id, c.thread_id);
  const d = ev(r, "B", "later", { to: "A", t: t0 + 60 * 60_000 });
  check("pair window expires after 30min", d.thread_id !== a.thread_id);
}
{
  const r = fakeRoom("plaza");
  const t0 = 1_700_000_000_000;
  const a = ev(r, "A", "solo", { to: "Nobody", t: t0 });
  check("directed talk with no history starts its own thread", /^th-plaza-1$/.test(a.thread_id), a.thread_id);
}

{
  const r = fakeRoom("plaza");
  const t0 = 1_700_000_000_000;
  const a = ev(r, "A", "now", { t: t0 });
  const old = ev(r, "B", "from yesterday", { t: t0 - 24 * 3600_000 });
  check("past-dated event does not merge into the current thread", old.thread_id !== a.thread_id, old.thread_id);
  const b = ev(r, "C", "back to now", { t: t0 + 60_000 });
  check("thread continues after a past-dated event", b.thread_id === a.thread_id, b.thread_id);
}

// --- unit: rebuild determinism --------------------------------------
console.log("rebuild determinism");
{
  const r = fakeRoom("plaza");
  const t0 = 1_700_000_000_000;
  ev(r, "A", "one", { t: t0 });
  ev(r, "B", "two", { to: "A", t: t0 + 30_000 });
  ev(r, "C", "three", { t: t0 + 20 * 60_000 });
  const ids = r.transcript.map((e) => e.thread_id);
  // simulate a restart: wipe thread ids and state, replay persisted events
  const persisted = JSON.parse(JSON.stringify(r.transcript));
  const r2 = fakeRoom("plaza");
  r2.transcript = persisted.map((e) => ({ ...e, thread_id: undefined, tseq: undefined, ev_id: undefined }));
  threads.rebuild(r2);
  const ids2 = r2.transcript.map((e) => e.thread_id);
  check("rebuild reproduces identical thread ids", JSON.stringify(ids) === JSON.stringify(ids2),
    `${JSON.stringify(ids)} vs ${JSON.stringify(ids2)}`);
}

// --- unit: findThread privacy ---------------------------------------
console.log("privacy");
{
  const rooms = new Map();
  const pub = fakeRoom("plaza");
  ev(pub, "A", "hi");
  rooms.set("plaza", pub);
  const priv = fakeRoom("secret", { visibility: "private" });
  ev(priv, "A", "shh");
  rooms.set("secret", priv);
  const pubId = pub.transcript[0].thread_id;
  const privId = priv.transcript[0].thread_id;
  check("finds public thread", !!threads.findThread(rooms, pubId));
  check("rejects private-room thread", !threads.findThread(rooms, privId));
  check("rejects malformed id", !threads.findThread(rooms, "nope"));
  check("rejects unknown room", !threads.findThread(rooms, "th-ghost-1"));
  check("rejects unknown seq", !threads.findThread(rooms, "th-plaza-999"));
  check("listThreads empty for private room", threads.listThreads(priv).length === 0);
  check("listThreads lists public thread", threads.listThreads(pub).length === 1);
}

// --- unit: HTML escaping --------------------------------------------
console.log("html escaping");
{
  const r = fakeRoom("plaza", { topic: "Plaza" });
  const e = ev(r, "A<script>", "<img src=x onerror=alert(1)>", { sp: { v: "verified" } });
  const st = r._threadState.byId.get(e.thread_id);
  const html = threads.renderThreadPage(r, st, [e]);
  check("escapes name", html.includes("A&lt;script&gt;") && !html.includes("A<script>"));
  check("escapes text", html.includes("&lt;img src=x") && !html.includes("<img src=x onerror"));
  check("shows verified badge", html.includes("verified"));
  check("mentions public + testing", /Public room/.test(html) && /early and in testing/.test(html));
}

// --- integration ----------------------------------------------------
const REPO = path.join(__dirname, "..");
const LOBBY = path.join(REPO, "server", "lobby.js");
const PORT = 18791;
try { fs.unlinkSync(path.join(REPO, "data", "transcripts.json")); } catch { /* ignore */ }

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
    const alice = await openAgent(T("ThreadAlice"));
    const bob = await openAgent(T("ThreadBob"));
    alice.ws.send(JSON.stringify({ type: "say", from: alice.name, text: `thread test hello ${RUN}` }));
    await sleep(300);
    bob.ws.send(JSON.stringify({ type: "talk", from: bob.name, to: alice.name, text: `thread test reply ${RUN}` }));
    await sleep(500);

    const list = JSON.parse((await get("/api/threads?room=plaza")).body);
    check("/api/threads lists one thread", list.threads.length === 1 && list.threads[0].count === 2,
      JSON.stringify(list.threads));
    const tid = list.threads[0].id;
    check("thread id looks right", /^th-plaza-\d+$/.test(tid), tid);
    check("participants listed", list.threads[0].participants.includes(alice.name), JSON.stringify(list.threads[0].participants));

    const one = JSON.parse((await get(`/api/thread/${tid}`)).body);
    check("/api/thread returns both messages", one.events.length === 2, JSON.stringify(one.events.length));
    check("messages in order", one.events[0].text.includes("hello") && one.events[1].text.includes("reply"));

    const page = await get(`/t/${tid}`);
    check("/t/<id> 200 html", page.status === 200 && page.body.includes("<!DOCTYPE html>"), String(page.status));
    check("page contains the conversation", page.body.includes(`thread test hello ${RUN}`) && page.body.includes(`thread test reply ${RUN}`));
    check("page shows addressee", page.body.includes(`to ${alice.name}`));

    const miss1 = await get("/t/th-plaza-424242");
    check("/t/ unknown -> 404", miss1.status === 404, String(miss1.status));
    const miss2 = await get("/api/thread/bogus");
    check("/api/thread/ bogus -> 404", miss2.status === 404, String(miss2.status));
    const miss3 = await get("/api/threads?room=nope");
    check("/api/threads unknown room -> empty", JSON.parse(miss3.body).threads.length === 0);

    const tick = JSON.parse((await get("/api/ticker")).body);
    check("ticker carries thread_id", tick.events.length > 0 && tick.events.every((e) => e.thread_id === tid),
      JSON.stringify(tick.events.map((e) => e.thread_id)));

    // private room: threads exist in memory but are never served
    alice.ws.send(JSON.stringify({ type: "create_room", topic: `priv ${RUN}`, visibility: "private" }));
    await sleep(500);
    alice.ws.send(JSON.stringify({ type: "say", from: alice.name, text: `secret ${RUN}` }));
    await sleep(500);
    const privList = await get("/api/threads?room=plaza");
    check("private talk does not leak into plaza threads", JSON.parse(privList.body).threads.length === 1);
    const spec = JSON.parse((await get("/openapi.json")).body);
    check("openapi documents /api/threads", !!spec.paths["/api/threads"]);
    check("openapi documents /api/thread/{id}", !!spec.paths["/api/thread/{id}"]);

    alice.ws.close(); bob.ws.close();
  } finally {
    server.kill("SIGTERM");
  }
  if (failures) { console.log(`\n${failures} FAILURES`); process.exit(1); }
  console.log("\nall thread tests passed");
}

main().catch((e) => { console.error("fatal:", e); process.exit(1); });
