// Hotel lobby v1 tests: the lobby room and its world definition in
// /api/places, the check-in desk stub endpoint, and static serving of
// the 3D lobby module.
//
// Spawns a real lobby server child.
//   node test/lobby.js
// Exit 0 = all pass, 1 = any failure.
const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const WebSocket = require("ws");

const REPO = path.join(__dirname, "..");
const LOBBY = path.join(REPO, "server", "lobby.js");
const PORT = 18871;

const RUN = Math.random().toString(36).slice(2, 8);
const T = (s) => `${s}-${RUN}`;

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? " - " + detail : ""}`);
  }
}

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
function get(p) {
  return new Promise((resolve, reject) => {
    http
      .get(`http://127.0.0.1:${PORT}${p}`, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
      })
      .on("error", reject);
  });
}
function openAgent(name, extra = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    const rec = { ws, name, msgs: [] };
    const timer = setTimeout(() => reject(new Error(`hello timeout for ${name}`)), 10000);
    ws.on("open", () => ws.send(JSON.stringify({ type: "hello", name, ...extra })));
    ws.on("message", (raw) => {
      let m;
      try {
        m = JSON.parse(raw);
      } catch {
        return;
      }
      rec.msgs.push(m);
      if (m.type === "state" && m.agents && m.agents.some((a) => a.name === name)) {
        clearTimeout(timer);
        resolve(rec);
      }
    });
    ws.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}
function waitFor(rec, pred, timeoutMs = 6000) {
  return new Promise((resolve) => {
    const found = rec.msgs.find(pred);
    if (found) return resolve(found);
    const timer = setTimeout(() => resolve(null), timeoutMs);
    const onMsg = (raw) => {
      let m;
      try {
        m = JSON.parse(raw);
      } catch {
        return;
      }
      if (pred(m)) {
        clearTimeout(timer);
        rec.ws.off("message", onMsg);
        resolve(m);
      }
    };
    rec.ws.on("message", onMsg);
  });
}

async function main() {
  const server = startLobby();
  await waitForListening(server);
  try {
    console.log("lobby room + world definition");
    {
      const r = await get("/api/places");
      check("/api/places 200", r.status === 200, `got ${r.status}`);
      const data = JSON.parse(r.body);
      const byId = Object.fromEntries((data.rooms || []).map((x) => [x.room_id, x]));
      const lob = byId["lobby"];
      check("lobby room seeded", !!lob);
      check("lobby topic/category", lob && lob.topic === "Lobby" && lob.category === "utility");
      const L = lob && lob.layout;
      check("lobby layout published", !!L);
      check("layout floor is the shared 1000x620", !!L && L.floor.w === 1000 && L.floor.h === 620);
      check("desk at center", !!L && L.desk.x === 500 && L.desk.y === 320 && L.desk.label === "Check-in");
      const portals = (L && L.portals) || [];
      check("seven portals", portals.length === 7, `got ${portals.length}`);
      const ids = portals.map((p) => p.id).sort();
      check(
        "portal ids",
        JSON.stringify(ids) === JSON.stringify(["cafe", "garden-terrace", "gym", "nightclub", "pool-deck", "restaurant-one", "restaurant-two"]),
        ids.join(",")
      );
      const cafe = portals.find((p) => p.id === "cafe");
      check("cafe portal open into room plaza", !!cafe && cafe.state === "open" && cafe.target === "plaza");
      check(
        "other portals locked, no target",
        portals.every((p) => p.id === "cafe" || (p.state === "locked" && p.target === null))
      );
      check(
        "portals carry name + position",
        portals.every((p) => typeof p.name === "string" && p.name.length > 0 && typeof p.x === "number" && typeof p.y === "number")
      );
      check("plain rooms publish layout null", byId["plaza"] && byId["plaza"].layout === null);
    }

    console.log("3d lobby module serving");
    {
      const r = await get("/lobby3d.js");
      check("/lobby3d.js 200", r.status === 200, `got ${r.status}`);
      check("/lobby3d.js is the lobby module", r.body.includes("createLobbyView") && r.body.includes("FALLBACK_LAYOUT"));
    }

    console.log("check-in desk stub");
    {
      const r = await get("/api/lobby/check-in?agent=" + encodeURIComponent(T("NoSuchMuse")));
      check("unknown muse 404", r.status === 404, `got ${r.status}`);
    }
    const name = T("DeskMuse");
    const rec = await openAgent(name, { room: "lobby" });
    {
      const r = await get("/api/lobby/check-in?agent=" + encodeURIComponent(name));
      check("live muse 200", r.status === 200, `got ${r.status}`);
      const j = JSON.parse(r.body);
      check("present + unclaimed before any room", j.present === true && j.claimed === false && j.personal_room === null, r.body);
    }
    rec.ws.send(JSON.stringify({ type: "create_room", topic: T("DeskMuse Room"), visibility: "public", invites: [] }));
    const created = await waitFor(rec, (m) => m.type === "room_created");
    check("room_created", !!created);
    {
      const r = await get("/api/lobby/check-in?agent=" + encodeURIComponent(name));
      const j = JSON.parse(r.body);
      check("claimed after creating a room", j.claimed === true, r.body);
      check(
        "public personal room named",
        !!j.personal_room && !!created && j.personal_room.room_id === created.room_id,
        r.body
      );
    }
    rec.ws.close();
  } finally {
    server.kill();
  }
  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("test crashed:", e);
  process.exit(1);
});
