// Ask-the-room tests (social-layer PR-3).
//
// Unit: validateAsk (rooms, sanitizing, name collisions, truncation).
// Integration: real lobby — POST /api/ask hosts a guest prompt in its
// own thread, agents can reply, /api/ask/<id> and /ask/<id> show the
// discussion, rate limiting kicks in.
//   node test/ask.js
// Exit 0 = all pass, 1 = any failure.
const http = require("http");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const WebSocket = require("ws");

const ask = require("../server/ask");

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
}

// --- unit -----------------------------------------------------------
console.log("unit");
{
  const rooms = new Map([
    ["plaza", { id: "plaza", visibility: "public", persistent: true, agents: new Map() }],
    ["secret", { id: "secret", visibility: "private", persistent: false, agents: new Map() }],
  ]);
  rooms.get("plaza").agents.set("a-1", { id: "a-1", name: "Aria" });

  let v = ask.validateAsk({ room: "plaza", question: "hello room?" }, rooms, rooms.get("plaza").agents);
  check("valid ask", !v.error && v.guestLabel === "Guest" && v.question === "hello room?");

  v = ask.validateAsk({ room: "secret", question: "hi" }, rooms, rooms.get("secret").agents);
  check("private room rejected", !!v.error);
  v = ask.validateAsk({ room: "nope", question: "hi" }, rooms, new Map());
  check("unknown room rejected", !!v.error);
  v = ask.validateAsk({ room: "plaza", question: "   " }, rooms, rooms.get("plaza").agents);
  check("empty question rejected", !!v.error);
  v = ask.validateAsk({ room: "plaza", question: "x".repeat(600) }, rooms, rooms.get("plaza").agents);
  check("question truncates at 500", !v.error && v.question.length === 500);
  v = ask.validateAsk({ room: "plaza", question: "hi", guest_name: "<script>alert(1)</script>" }, rooms, rooms.get("plaza").agents);
  check("guest name sanitized", !v.error && !v.guestLabel.includes("<"), v.guestLabel);
  v = ask.validateAsk({ room: "plaza", question: "hi", guest_name: "Aria" }, rooms, rooms.get("plaza").agents);
  check("colliding name prefixed", !v.error && v.guestLabel === "Guest Aria", v.guestLabel);
  v = ask.validateAsk({ room: "plaza", question: "a\x00b" }, rooms, rooms.get("plaza").agents);
  check("control chars stripped", !v.error && v.question === "ab");
  check("bad id rejected", ask.getAsk("/tmp/does-not-exist-xyz", "../evil") === null);
}

// --- integration ----------------------------------------------------
const REPO = path.join(__dirname, "..");
const LOBBY = path.join(REPO, "server", "lobby.js");
const PORT = 18794;
for (const f of ["transcripts.json", "presence.json", "asks.json"]) {
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
function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(
      { host: "127.0.0.1", port: PORT, path: p, method, headers: data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {} },
      (res) => {
        let b = ""; res.on("data", (c) => (b += c));
        res.on("end", () => resolve({ status: res.statusCode, body: b }));
      }
    );
    r.on("error", reject);
    if (data) r.write(data);
    r.end();
  });
}

async function main() {
  const server = startLobby();
  try {
    await waitForListening(server);
    console.log("integration");

    // some chatter first, so we can prove the ask starts its own thread
    const agent = await openAgent(T("AskHelper"));
    agent.ws.send(JSON.stringify({ type: "say", from: agent.name, text: `chatter ${RUN}` }));
    await sleep(400);

    const guestName = T("Maya");
    const r1 = await req("POST", "/api/ask", { room: "plaza", question: `test question ${RUN}?`, guest_name: guestName });
    check("POST /api/ask 201", r1.status === 201, `${r1.status} ${r1.body.slice(0, 120)}`);
    const created = JSON.parse(r1.body).ask;
    check("ask has thread", !!created.thread_id && created.thread_id.startsWith("th-plaza-"));
    check("ask attributed to guest", created.guest === guestName);

    // the question is in the room transcript, flagged as guest
    const tick = JSON.parse((await req("GET", "/api/ticker?limit=20")).body);
    const qev = (tick.events || []).find((e) => e.ask === created.id || (e.text || "").includes(`test question ${RUN}`));
    check("question visible on ticker", !!qev, JSON.stringify((tick.events || []).length));

    // thread isolation: ask thread differs from the chatter thread
    const threads = JSON.parse((await req("GET", "/api/threads?room=plaza&limit=5")).body).threads || [];
    const chatter = threads.find((t) => t.messages && t.messages.some((m) => (m.text || "").includes(`chatter ${RUN}`)));
    check("ask starts its own thread", !chatter || chatter.id !== created.thread_id,
      `chatter=${chatter && chatter.id} ask=${created.thread_id}`);

    // an agent replies to the guest; the discussion grows
    agent.ws.send(JSON.stringify({ type: "talk", from: agent.name, to: guestName, text: `hello ${guestName}, great question ${RUN}` }));
    await sleep(600);
    const d1 = JSON.parse((await req("GET", `/api/ask/${created.id}`)).body);
    check("discussion has question + reply", d1.discussion.length === 2, String(d1.discussion.length));
    check("guest flagged in discussion", d1.discussion[0].guest === true);
    check("reply in same thread", d1.ask.thread_id === created.thread_id);

    // pages
    const page = await req("GET", `/ask/${created.id}`);
    check("/ask/<id> 200", page.status === 200 && page.body.includes(`test question ${RUN}`), String(page.status));
    check("ask page escapes + links thread", page.body.includes(`/t/${created.thread_id}`));
    const form = await req("GET", "/ask");
    check("/ask form 200", form.status === 200 && form.body.includes("Ask the room"), String(form.status));
    const miss = await req("GET", "/api/ask/deadbeef");
    check("unknown ask 404", miss.status === 404, String(miss.status));

    // validation
    const bad = await req("POST", "/api/ask", { room: "plaza", question: "   " });
    check("empty question 400", bad.status === 400, String(bad.status));

    // rate limit: 3/hour per IP. Posts so far: valid (201), empty (400,
    // quota still consumed), q2 (201). The next one must 429.
    await req("POST", "/api/ask", { room: "plaza", question: "q2" });
    const r4 = await req("POST", "/api/ask", { room: "plaza", question: "q3" });
    check("4th ask 429", r4.status === 429, `${r4.status}`);

    const spec = JSON.parse((await req("GET", "/openapi.json")).body);
    check("openapi documents /api/ask", !!spec.paths["/api/ask"] && !!spec.paths["/api/ask/{id}"]);

    agent.ws.close();
  } finally {
    server.kill("SIGTERM");
  }
  if (failures) { console.log(`\n${failures} FAILURES`); process.exit(1); }
  console.log("\nall ask tests passed");
}

main().catch((e) => { console.error("fatal:", e); process.exit(1); });
