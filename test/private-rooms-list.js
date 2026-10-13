// Private rooms in the rooms directory: a private room appears at the top
// of the rooms list for clients authorized to see it (member, invited,
// creator), keyed on the persistent identity id. Unauthorized clients never
// see it - not the topic, not the occupancy - in full state or deltas.
//   node test/private-rooms-list.js
// Exit 0 = all pass, 1 = any failure.
const path = require("path");
const { spawn } = require("child_process");
const WebSocket = require("ws");

const REPO = path.join(__dirname, "..");
const LOBBY = path.join(REPO, "server", "lobby.js");
const PORT = 18797;
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
      DATA_DIR: `/tmp/privrooms-test-${RUN}`,
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
const lastOfType = (inbox, t) => ofType(inbox, t).slice(-1)[0];
function roomsOf(msg) { return (msg && Array.isArray(msg.rooms)) ? msg.rooms : null; }
function latestRooms(inbox) {
  // newest rooms list from a full state or a delta carrying rooms
  for (let i = inbox.length - 1; i >= 0; i--) {
    const r = roomsOf(inbox[i]);
    if (r) return r;
  }
  return null;
}
const seesRoom = (rooms, topic) => rooms && rooms.some((r) => r.topic === topic);
const noLeak = (inbox, topic) =>
  !inbox.some((m) => JSON.stringify(m).includes(topic));

(async () => {
  const lobby = startLobby();
  await sleep(2500);
  try {
    // 1. creator makes a private room, inviting priv-b
    const a = await connect({ type: "hello", name: "priv-a", serves: "t", room: "plaza", accepts_deltas: true });
    a.inbox.length = 0;
    a.ws.send(JSON.stringify({ type: "create_room", topic: "game-room", visibility: "private", entry: "invite", invites: ["priv-b"] }));
    await sleep(800);
    const created = lastOfType(a.inbox, "room_created");
    check("private room created with ack", !!created && created.visibility === "private", `ack=${!!created}`);
    const roomId = created && created.room_id;
    // creator was moved into the new room; go back to plaza to read the directory
    a.ws.send(JSON.stringify({ type: "hello", name: "priv-a", serves: "t", room: "plaza", accepts_deltas: true }));
    await sleep(1200);

    // 2. invited identity sees it at the top; stranger does not see it at all
    const b = await connect({ type: "hello", name: "priv-b", serves: "t", room: "plaza", accepts_deltas: true });
    const c = await connect({ type: "hello", name: "priv-c", serves: "t", room: "plaza", accepts_deltas: true });
    await sleep(1200);
    const bRooms = latestRooms(b.inbox);
    const cRooms = latestRooms(c.inbox);
    check("invited user sees the private room", seesRoom(bRooms, "game-room"));
    check("private room is listed first for the invited user",
      bRooms && bRooms[0].topic === "game-room" && bRooms[0].visibility === "private",
      `first=${bRooms && bRooms[0] && bRooms[0].topic}`);
    check("stranger does not see the private room", !seesRoom(cRooms, "game-room"));
    check("no topic/occupancy leak to stranger in any message", noLeak(c.inbox, "game-room"));
    check("creator still sees their private room", seesRoom(latestRooms(a.inbox), "game-room"));

    // 3. legacy (non-delta) client gets the same per-client directory
    const leg = await connect({ type: "hello", name: "priv-leg", serves: "t", room: "plaza" });
    await sleep(1200);
    // priv-leg was invited? no - invite them now via the room
    a.ws.send(JSON.stringify({ type: "invite", room_id: roomId, to: "priv-leg" }));
    await sleep(1200);
    const legRooms = latestRooms(leg.inbox);
    check("legacy client sees invited private room at top",
      legRooms && legRooms[0].topic === "game-room" && legRooms[0].visibility === "private");

    // 4. invite acceptance: priv-d is invited after connecting, visibility flips via delta
    const d = await connect({ type: "hello", name: "priv-d", serves: "t", room: "plaza", accepts_deltas: true });
    await sleep(1000);
    check("priv-d starts without the room", !seesRoom(latestRooms(d.inbox), "game-room"));
    d.inbox.length = 0;
    a.ws.send(JSON.stringify({ type: "invite", room_id: roomId, to: "priv-d" }));
    await sleep(1000);
    const dRooms = latestRooms(d.inbox);
    check("invite flips visibility on via delta", seesRoom(dRooms, "game-room"));
    check("invited room lands at top", dRooms && dRooms[0].topic === "game-room");

    // 5. no cross-user leakage in deltas: occupancy change reaches the
    //    authorized client with the room, the stranger without it
    b.inbox.length = 0;
    c.inbox.length = 0;
    // priv-b joins the private room (re-hello switches rooms)
    b.ws.send(JSON.stringify({ type: "hello", name: "priv-b", serves: "t", room: roomId, accepts_deltas: true }));
    await sleep(1200);
    // a is in plaza and authorized: should see occupancy bump in a rooms delta
    const aRoomsAfter = latestRooms(a.inbox);
    const aGame = aRoomsAfter && aRoomsAfter.find((r) => r.topic === "game-room");
    check("authorized client sees occupancy update", !!aGame && aGame.occupancy === 1, `occ=${aGame && aGame.occupancy}`);
    check("stranger inbox has zero trace of the private room", noLeak(c.inbox, "game-room"));
    const cRoomsAfter = latestRooms(c.inbox);
    check("stranger rooms list still clean", !seesRoom(cRoomsAfter, "game-room"));

    // 6. offline invite: name-keyed fallback grants visibility on hello
    // (fresh creator: priv-a's invite quota is spent from the earlier steps)
    const f = await connect({ type: "hello", name: "priv-f", serves: "t", room: "plaza", accepts_deltas: true });
    await sleep(800);
    f.ws.send(JSON.stringify({ type: "create_room", topic: "secret-club", visibility: "private", entry: "invite", invites: ["priv-offline"] }));
    await sleep(800);
    const sc = f.inbox.filter((m) => m.type === "room_created" || m.type === "error").slice(-1)[0];
    check("secret-club created", !!sc && sc.type === "room_created", JSON.stringify(sc && { type: sc.type, code: sc.code }));
    const e = await connect({ type: "hello", name: "priv-offline", serves: "t", room: "plaza", accepts_deltas: true });
    await sleep(1200);
    check("offline-invited user sees the room on hello", seesRoom(latestRooms(e.inbox), "secret-club"));

    for (const cxn of [a, b, c, d, e, f, leg]) { try { cxn.ws.close(); } catch {} }
  } finally {
    lobby.kill("SIGKILL");
  }
  console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
})();
