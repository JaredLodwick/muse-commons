// Delta-state tests: clients opting in with accepts_deltas:true get one full
// "state" snapshot on join, then "state_delta" only when something visible
// changed. Legacy clients keep full snapshots every tick. Room isolation:
// a client never receives another room's agent movements.
//   node test/state-delta.js
// Exit 0 = all pass, 1 = any failure.
const path = require("path");
const { spawn } = require("child_process");
const WebSocket = require("ws");

const REPO = path.join(__dirname, "..");
const LOBBY = path.join(REPO, "server", "lobby.js");
const PORT = 18793;
const RUN = Math.random().toString(36).slice(2, 8);

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  ok   ${name}`);
  else { failures++; console.log(`  FAIL ${name}${detail ? " - " + detail : ""}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startLobby() {
  return spawn("node", [LOBBY], {
    env: {
      ALLOW_UNVERIFIED: "1",
      ...process.env,
      PORT: String(PORT),
      HEARTBEAT_TIMEOUT_MS: "60000",
      LOBBY_PUBLIC_URL: `http://127.0.0.1:${PORT}/`,
      DATA_DIR: `/tmp/delta-test-${RUN}`,
    },
    stdio: "ignore",
  });
}

function connect(hello) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/`);
    const inbox = [];
    ws.on("message", (d) => { try { inbox.push(JSON.parse(d.toString())); } catch {} });
    ws.on("open", () => ws.send(JSON.stringify(hello)));
    ws.on("error", reject);
    setTimeout(() => resolve({ ws, inbox }), 1200);
  });
}
const ofType = (inbox, t) => inbox.filter((m) => m.type === t);

(async () => {
  const lobby = startLobby();
  await sleep(2500);
  try {
    // 1. delta client gets a full snapshot on join
    const a = await connect({ type: "hello", name: "delta-a", serves: "t", room: "plaza", accepts_deltas: true });
    const b = await connect({ type: "hello", kind: "viewer", room: "plaza", agent_name: "delta-b-viewer", accepts_deltas: true });
    const aStates = ofType(a.inbox, "state");
    check("delta client gets full state on join", aStates.length >= 1 && Array.isArray(aStates[0].agents) && aStates[0].agents.some((x) => x.name === "delta-a"), `states=${aStates.length}`);
    const bStates = ofType(b.inbox, "state");
    check("viewer delta client gets full state on join", bStates.length >= 1 && bStates[0].room_id === "plaza");

    // 2. no more full states afterwards, only deltas or silence
    b.inbox.length = 0;
    await sleep(1500);
    check("no full state repeats for delta client", ofType(b.inbox, "state").length === 0, `got ${ofType(b.inbox, "state").length}`);

    // 3. a deterministic change (say -> bubble) arrives as a delta
    b.inbox.length = 0;
    a.ws.send(JSON.stringify({ type: "say", from: "delta-a", text: "delta-probe-bubble" }));
    await sleep(700);
    const deltas = ofType(b.inbox, "state_delta");
    const hit = deltas.find((d) => (d.agents_changed || []).some((x) => x.name === "delta-a" && x.bubble === "delta-probe-bubble"));
    check("bubble change arrives as state_delta", !!hit, `deltas=${deltas.length}`);
    if (hit) {
      check("delta carries room_id", hit.room_id === "plaza");
      check("delta omits unchanged rooms list", hit.rooms === undefined);
    }

    // 4. room isolation: activity in a breakout never reaches plaza clients
    const roomId = await new Promise((resolve) => {
      const h = (d) => {
        let m; try { m = JSON.parse(d.toString()); } catch { return; }
        if (m.type === "room_created") { a.ws.off("message", h); resolve(m.room_id); }
      };
      a.ws.on("message", h);
      a.ws.send(JSON.stringify({ type: "create_room", topic: "delta-room", visibility: "public" }));
    });
    check("breakout created", typeof roomId === "string" && roomId.length > 0);
    const c = await connect({ type: "hello", name: "delta-c", serves: "t", room: roomId, accepts_deltas: true });
    check("breakout client gets full state", ofType(c.inbox, "state").some((m) => m.room_id === roomId));
    b.inbox.length = 0;
    c.ws.send(JSON.stringify({ type: "say", from: "delta-c", text: "breakout-only" }));
    await sleep(700);
    const leaked = ofType(b.inbox, "state_delta").filter(
      (d) => d.room_id === roomId || (d.agents_changed || []).some((x) => x.name === "delta-c")
    );
    check("no cross-room delta leakage", leaked.length === 0, `leaked=${leaked.length}`);
    // and the breakout client did get its own delta
    const cHit = ofType(c.inbox, "state_delta").find((d) => (d.agents_changed || []).some((x) => x.name === "delta-c" && x.bubble === "breakout-only"));
    check("breakout client gets own-room delta", !!cHit);

    // 5. legacy client (no flag) keeps full snapshots every tick
    const d = await connect({ type: "hello", name: "delta-d", serves: "t", room: "plaza" });
    d.inbox.length = 0;
    await sleep(1200);
    const dStates = ofType(d.inbox, "state");
    check("legacy client keeps full snapshots", dStates.length >= 5, `got ${dStates.length}`);
    check("legacy client gets no deltas", ofType(d.inbox, "state_delta").length === 0);

    for (const cl of [a, b, c, d]) { try { cl.ws.close(); } catch {} }
  } finally {
    lobby.kill("SIGKILL");
  }
  await sleep(300);
  console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
