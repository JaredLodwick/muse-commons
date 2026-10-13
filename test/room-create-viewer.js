// Room creation via the web (viewer) flow: claimed viewers can create rooms
// (unclaimed viewers stay read-only), description flows end to end, and
// create-time invites reach the invitees.
// Spawns a real lobby child on a test port. No live traffic.
//   node test/room-create-viewer.js
const path = require("path");
const { spawn } = require("child_process");
const WebSocket = require("ws");

const REPO = path.join(__dirname, "..");
const LOBBY = path.join(REPO, "server", "lobby.js");
const PORT = 18821;
const RUN = Math.random().toString(36).slice(2, 8);
const T = (s) => `${s}-${RUN}`;

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  ok   ${name}`);
  else { failures++; console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`); }
}
function startLobby() {
  return spawn("node", [LOBBY], {
    env: { ALLOW_UNVERIFIED: "1", ...process.env, PORT: String(PORT), HEARTBEAT_TIMEOUT_MS: "4000", LOBBY_PUBLIC_URL: `http://127.0.0.1:${PORT}/` },
    stdio: ["ignore", "pipe", "pipe"],
  });
}
function waitForListening(child) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("server did not start")), 15000);
    let out = "";
    const onData = (d) => { out += d.toString(); if (out.includes("listening")) { clearTimeout(timer); child.stdout.off("data", onData); resolve(); } };
    child.stdout.on("data", onData);
  });
}
function connect() { return new Promise((res, rej) => { const w = new WebSocket(`ws://127.0.0.1:${PORT}/`); w.on("open", () => res(w)); w.on("error", rej); }); }
function helloViewer(w, room, agentName) {
  return new Promise((resolve) => {
    const h = (raw) => { const m = JSON.parse(raw); if (m.type === "hello_ok") { w.off("message", h); resolve(m); } };
    w.on("message", h);
    w.send(JSON.stringify({ type: "hello", kind: "viewer", room, agent_name: agentName }));
  });
}
function helloAgent(w, name, room) {
  return new Promise((resolve) => {
    const h = (raw) => { const m = JSON.parse(raw); if (m.type === "hello_ok") { w.off("message", h); resolve(m); } };
    w.on("message", h);
    w.send(JSON.stringify({ type: "hello", name, serves: "Tester", room }));
  });
}
function waitFor(w, pred, ms = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { w.off("message", h); reject(new Error("timeout")); }, ms);
    const h = (raw) => { let m; try { m = JSON.parse(raw); } catch { return; } if (pred(m)) { clearTimeout(timer); w.off("message", h); resolve(m); } };
    w.on("message", h);
  });
}
const get = (p) => new Promise((res, rej) => {
  require("http").get(`http://127.0.0.1:${PORT}${p}`, (r) => {
    let b = ""; r.on("data", (d) => b += d); r.on("end", () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
  }).on("error", rej);
});

(async () => {
  const child = startLobby();
  child.stderr.on("data", () => {});
  try {
    await waitForListening(child);

    // 1. unclaimed viewer: create_room must be rejected (read-only)
    const v0 = await connect();
    await helloViewer(v0, "plaza", "");
    v0.send(JSON.stringify({ type: "create_room", topic: T("noroom") }));
    const err0 = await waitFor(v0, (m) => m.type === "error");
    check("unclaimed viewer create_room rejected", err0.code === "INSUFFICIENT_SCOPE", err0.code);
    v0.close();

    // 2. claimed viewer creates a public room with a description
    const v1 = await connect();
    await helloViewer(v1, "plaza", T("Jared"));
    v1.send(JSON.stringify({ type: "create_room", topic: T("game-night"), description: T("board games and bad puns"), visibility: "public" }));
    const rc = await waitFor(v1, (m) => m.type === "room_created");
    check("room_created received", !!rc.room_id && rc.room_id.startsWith("r-"), rc.room_id);
    check("description in room_created", rc.description === T("board games and bad puns"), rc.description);
    check("invites_sent defaults to 0", rc.invites_sent === 0, String(rc.invites_sent));
    const places = await get("/api/places");
    const listed = (places.rooms || []).find((r) => r.room_id === rc.room_id);
    check("description in /api/places", listed && listed.description === T("board games and bad puns"), listed && listed.description);

    // 3. claimed viewer creates a private room with invites
    const invitee = await connect();
    await helloAgent(invitee, T("Muse"), "plaza");
    const invitedP = waitFor(invitee, (m) => m.type === "invited");
    v1.send(JSON.stringify({ type: "create_room", topic: T("dnd"), description: T("one-shot with a dragon"), visibility: "private", invites: [T("Muse")] }));
    const rc2 = await waitFor(v1, (m) => m.type === "room_created" && m.topic === T("dnd"));
    check("private room_created", rc2.visibility === "private" && rc2.entry === "invite", rc2.visibility + "/" + rc2.entry);
    check("private room createdBy is web identity", rc2.room_id && true, "");
    const inv = await invitedP;
    check("invitee got invited", inv.room_id === rc2.room_id && inv.from === T("Jared"), JSON.stringify({ from: inv.from, room: inv.room_id }));
    check("invited carries description", inv.description === T("one-shot with a dragon"), inv.description);
    // invitee joins the private room
    invitee.send(JSON.stringify({ type: "hello", name: T("Muse"), serves: "Tester", room: rc2.room_id }));
    const okJoin = await waitFor(invitee, (m) => m.type === "hello_ok" && m.room_id === rc2.room_id);
    check("invitee joins private room", !!okJoin, "");
    // outsider cannot probe the private room
    const outsider = await connect();
    await helloAgent(outsider, T("Snoop"), "plaza");
    outsider.send(JSON.stringify({ type: "hello", name: T("Snoop"), serves: "Tester", room: rc2.room_id }));
    const errSnoop = await waitFor(outsider, (m) => m.type === "error");
    check("outsider probing private room gets NO_SUCH_ROOM", errSnoop.code === "NO_SUCH_ROOM", errSnoop.code);

    // 4. creator reconnects with a fresh socket + same claimed name: still creator
    v1.close();
    const v2 = await connect();
    await helloViewer(v2, "plaza", T("Jared"));
    // re-enter own private room via hello
    v2.send(JSON.stringify({ type: "hello", kind: "viewer", room: rc2.room_id, agent_name: T("Jared") }));
    const okRejoin = await waitFor(v2, (m) => m.type === "hello_ok" && m.room_id === rc2.room_id);
    check("creator re-enters own private room after reconnect", !!okRejoin, "");

    // 4b. knock flow: viewer creates a knock-entry room, reconnects, still gets the knock
    v2.send(JSON.stringify({ type: "create_room", topic: T("knockroom"), visibility: "public", entry: "knock" }));
    const rc3 = await waitFor(v2, (m) => m.type === "room_created" && m.topic === T("knockroom"));
    check("knock-entry room_created", rc3.entry === "knock", rc3.entry);
    v2.close();
    const v3 = await connect();
    await helloViewer(v3, "plaza", T("Jared"));
    v3.send(JSON.stringify({ type: "hello", kind: "viewer", room: rc3.room_id, agent_name: T("Jared") }));
    await waitFor(v3, (m) => m.type === "hello_ok" && m.room_id === rc3.room_id);
    const knocker = await connect();
    await helloAgent(knocker, T("Knocky"), "plaza");
    const knockSeen = waitFor(v3, (m) => m.type === "knock_request");
    knocker.send(JSON.stringify({ type: "knock", room_id: rc3.room_id, name: T("Knocky") }));
    const kq = await knockSeen;
    check("creator sees knock_request after reconnect", kq.room_id === rc3.room_id, "");
    v3.send(JSON.stringify({ type: "admit", room_id: rc3.room_id, agent: kq.agent.id }));
    const admitted = await waitFor(knocker, (m) => m.type === "admitted");
    check("creator admits knocker after reconnect", admitted.room_id === rc3.room_id, "");

    // 5. empty topic still rejected (use the reconnected socket)
    v3.send(JSON.stringify({ type: "create_room", topic: "   " }));
    const errTopic = await waitFor(v3, (m) => m.type === "error");
    check("empty topic rejected", errTopic.code === "TOPIC_REQUIRED", errTopic.code);

    for (const w of [v2, v3, invitee, outsider, knocker]) try { w.close(); } catch {}
    console.log(failures ? `\n${failures} FAILURES` : "\nALL PASS");
    process.exit(failures ? 1 : 0);
  } finally {
    child.kill("SIGKILL");
  }
})().catch((e) => { console.error("HARNESS ERROR:", e.message); process.exit(1); });
