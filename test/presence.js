// Presence history tests: /api/presence logs joins/leaves newest-first,
// with room + limit filters, viewer exclusion, re-hello dedup, room-switch
// leave+join, heartbeat-expiry leaves, and data/presence.json persistence.
//
// Spawns a real lobby server child with a short heartbeat timeout.
//   node test/presence.js
// Exit 0 = all pass, 1 = any failure.
const fs = require("fs");
const http = require("http");
const path = require("path");
const { spawn } = require("child_process");
const WebSocket = require("ws");

const REPO = path.join(__dirname, "..");
const LOBBY = path.join(REPO, "server", "lobby.js");
const PRESENCE_FILE = path.join(REPO, "data", "presence.json");
const PORT = 18784;

const RUN = Math.random().toString(36).slice(2, 8);
const T = (s) => `${s}-${RUN}`;

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
}

function startLobby() {
  return spawn("node", [LOBBY], {
    env: {
      ALLOW_UNVERIFIED: "1",
      ...process.env,
      PORT: String(PORT),
      HEARTBEAT_TIMEOUT_MS: "2000",
      LOBBY_PUBLIC_URL: `http://127.0.0.1:${PORT}/`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}
function waitForListening(child) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("server did not start")), 15000);
    let out = "";
    const onData = (d) => {
      out += d.toString();
      if (out.includes("listening")) {
        clearTimeout(timer);
        child.stdout.off("data", onData);
        resolve();
      }
    };
    child.stdout.on("data", onData);
    child.on("exit", (c) => {
      clearTimeout(timer);
      reject(new Error(`server exited with ${c}: ${out}`));
    });
  });
}
// Opens an agent that heartbeats every 700ms (timeout is 2000ms) so it stays
// alive. Call rec.stopBeat() to let it expire, rec.close() to disconnect.
function openAgent(name, extra = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    const rec = {
      ws,
      name,
      beat: null,
      stopBeat() { if (rec.beat) clearInterval(rec.beat); rec.beat = null; },
      close() { rec.stopBeat(); try { ws.close(); } catch {} },
    };
    const timer = setTimeout(() => reject(new Error(`hello timeout for ${name}`)), 10000);
    ws.on("open", () => ws.send(JSON.stringify({ type: "hello", name, ...extra })));
    ws.on("message", (raw) => {
      let m;
      try { m = JSON.parse(raw); } catch { return; }
      if (m.type === "state" && m.agents && m.agents.some((a) => a.name === name)) {
        clearTimeout(timer);
        rec.beat = setInterval(() => {
          if (ws.readyState === 1) ws.send(JSON.stringify({ type: "heartbeat" }));
        }, 700);
        resolve(rec);
      }
      if (m.type === "error") { clearTimeout(timer); reject(new Error(m.message)); }
    });
    ws.on("error", (e) => { clearTimeout(timer); reject(e); });
  });
}
function openViewer() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    const timer = setTimeout(() => reject(new Error("viewer timeout")), 10000);
    ws.on("open", () => ws.send(JSON.stringify({ type: "hello", kind: "viewer", room: "plaza" })));
    ws.on("message", (raw) => {
      let m;
      try { m = JSON.parse(raw); } catch { return; }
      if (m.type === "state") { clearTimeout(timer); resolve(ws); }
    });
    ws.on("error", (e) => { clearTimeout(timer); reject(e); });
  });
}
function get(p) {
  return new Promise((resolve, reject) => {
    http
      .get(`http://127.0.0.1:${PORT}${p}`, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode, body }));
      })
      .on("error", reject);
  });
}
async function presence(qs = "") {
  const r = await get(`/api/presence${qs}`);
  return { status: r.status, events: JSON.parse(r.body).events };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mine = (events, name) => events.filter((e) => e.name === name);

async function main() {
  // isolate: back up the real presence file, restore at the end
  const hadFile = fs.existsSync(PRESENCE_FILE);
  const backup = hadFile ? fs.readFileSync(PRESENCE_FILE) : null;

  const server = startLobby();
  try {
    await waitForListening(server);

    console.log("join logging + newest-first order");
    const a = await openAgent(T("PresenceA"), { serves: T("Human"), room: "plaza" });
    await sleep(400);
    const b = await openAgent(T("PresenceB"), { serves: T("Human"), room: "plaza" });
    await sleep(400);
    let r = await presence();
    check("/api/presence 200 + events array", r.status === 200 && Array.isArray(r.events), `got ${r.status}`);
    const ma = mine(r.events, a.name);
    const mb = mine(r.events, b.name);
    check("join event for A", ma.length === 1 && ma[0].event === "join", JSON.stringify(ma));
    check("join event carries room/serves", ma[0] && ma[0].room_id === "plaza" && ma[0].serves === T("Human") && typeof ma[0].t === "number", JSON.stringify(ma[0]));
    check("newest-first: B's join before A's", r.events.indexOf(mb[0]) < r.events.indexOf(ma[0]));

    console.log("viewer exclusion");
    const before = (await presence()).events.length;
    const v = await openViewer();
    await sleep(400);
    const after = (await presence()).events.length;
    check("viewer join logs nothing", before === after, `${before} -> ${after}`);
    v.close();

    console.log("re-hello dedup (bridge reconnect must not double-log)");
    a.ws.send(JSON.stringify({ type: "hello", name: a.name, serves: T("Human"), room: "plaza" }));
    await sleep(500);
    r = await presence();
    check("re-hello same room -> still exactly 1 join", mine(r.events, a.name).filter((e) => e.event === "join").length === 1);

    console.log("room switch = leave(old) + join(new)");
    a.ws.send(JSON.stringify({ type: "hello", name: a.name, serves: T("Human"), room: "tech" }));
    await sleep(500);
    const plazaEv = mine((await presence("?room=plaza")).events, a.name);
    const techEv = mine((await presence("?room=tech")).events, a.name);
    check("leave logged for old room", plazaEv.length >= 1 && plazaEv[0].event === "leave" && plazaEv[0].room_id === "plaza", JSON.stringify(plazaEv[0]));
    check("join logged for new room", techEv.length >= 1 && techEv[0].event === "join" && techEv[0].room_id === "tech", JSON.stringify(techEv[0]));
    const allMine = mine((await presence()).events, a.name);
    check("no duplicate joins across switch", allMine.filter((e) => e.event === "join").length === 2, // plaza + tech
      JSON.stringify(allMine.map((e) => e.event + "@" + e.room_id)));

    console.log("heartbeat-expiry leave");
    b.stopBeat();
    b.close();
    await sleep(3500); // timeout 2000ms + tick cadence
    r = await presence("?room=plaza");
    const bleave = mine(r.events, b.name).find((e) => e.event === "leave");
    check("leave appears after expiry", !!bleave && bleave.room_id === "plaza", JSON.stringify(mine(r.events, b.name)));

    console.log("limit param");
    r = await presence("?limit=2");
    check("?limit=2 returns exactly 2", r.events.length === 2, `got ${r.events.length}`);
    r = await presence("?limit=abc");
    check("bad limit falls back to default", r.status === 200 && r.events.length <= 50, `got ${r.events.length}`);

    console.log("persistence round-trip");
    await sleep(300); // let the write land
    const onDisk = JSON.parse(fs.readFileSync(PRESENCE_FILE, "utf8"));
    check("data/presence.json contains the leave", Array.isArray(onDisk) && onDisk.some((e) => e.name === b.name && e.event === "leave"));

    a.close();
    console.log(failures === 0 ? "ALL PRESENCE TESTS PASSED" : `${failures} FAILURES`);
  } finally {
    server.kill();
    await sleep(300);
    if (backup !== null) fs.writeFileSync(PRESENCE_FILE, backup);
    else if (fs.existsSync(PRESENCE_FILE)) fs.unlinkSync(PRESENCE_FILE);
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.log("FATAL:", e.message);
  process.exit(1);
});
