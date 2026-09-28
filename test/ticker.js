// Talk history ticker tests: GET /api/ticker returns recent public talk
// events newest-first, excludes private rooms, and handles the empty state.
//
// Spawns a real lobby server child.
//   node test/ticker.js
// Exit 0 = all pass, 1 = any failure.
const http = require("http");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const WebSocket = require("ws");

const REPO = path.join(__dirname, "..");
const LOBBY = path.join(REPO, "server", "lobby.js");
const PORT = 18783;
// The "fresh server -> empty ticker" check below assumes no persisted history:
// earlier test files now leave data/transcripts.json behind (transcripts
// persist across restarts by design), so start from a clean slate.
try { fs.unlinkSync(path.join(REPO, "data", "transcripts.json")); } catch { /* ignore */ }

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
      if (m.type === "error") {
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const server = startLobby();
  await waitForListening(server);

  console.log("empty state");
  {
    const r = await get("/api/ticker");
    check("/api/ticker 200", r.status === 200, `got ${r.status}`);
    const data = JSON.parse(r.body);
    check("fresh server -> empty events array", Array.isArray(data.events) && data.events.length === 0,
      JSON.stringify(data.events));
  }

  console.log("public talk events");
  const alice = await openAgent(T("TickerAlice"), { serves: T("Human") });
  alice.ws.send(JSON.stringify({ type: "say", from: alice.name, text: T("hello world one") }));
  await sleep(300);
  alice.ws.send(JSON.stringify({ type: "say", from: alice.name, text: T("hello world two") }));
  await sleep(300);
  {
    const r = await get("/api/ticker");
    const data = JSON.parse(r.body);
    const mine = data.events.filter((e) => e.from === alice.name);
    check("both say events in ticker", mine.length === 2, `got ${mine.length}`);
    check("newest first", mine[0].text === T("hello world two") && mine[1].text === T("hello world one"));
    const ev = mine[0];
    check("event shape", ev.room_id === "plaza" && ev.topic === "Plaza" &&
      typeof ev.text === "string" && typeof ev.t === "number" && "to" in ev,
      JSON.stringify(ev));
    check("cap at 30", data.events.length <= 30, `got ${data.events.length}`);
  }

  console.log("cross-room chatter included");
  const bob = await openAgent(T("TickerBob"), { room: "tech" });
  bob.ws.send(JSON.stringify({ type: "say", from: bob.name, text: T("tech talk") }));
  await sleep(300);
  {
    const r = await get("/api/ticker");
    const data = JSON.parse(r.body);
    const ev = data.events.find((e) => e.from === bob.name);
    check("tech room event present", !!ev);
    check("room_id + topic correct", ev && ev.room_id === "tech" && ev.topic === "#tech");
    check("newest overall is the tech event", data.events[0].from === bob.name);
  }

  console.log("private rooms excluded");
  {
    alice.ws.send(JSON.stringify({ type: "create_room", topic: T("secret"), visibility: "private" }));
    const created = await waitFor(alice, (m) => m.type === "room_created", 6000);
    check("private room created", !!created && created.visibility === "private");
    alice.ws.send(JSON.stringify({ type: "say", from: alice.name, text: T("secret chatter") }));
    await sleep(300);
    const r = await get("/api/ticker");
    const data = JSON.parse(r.body);
    const leaked = data.events.some((e) => e.text === T("secret chatter"));
    check("private room chatter not in ticker", !leaked);
    const anyPrivate = data.events.some((e) => e.room_id === (created && created.room_id));
    check("no events from private room id", !anyPrivate);
  }

  alice.ws.close();
  bob.ws.close();
  server.kill();
  console.log(failures ? `\n${failures} FAILURE(S)` : "\nall ticker tests passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error("harness error:", e);
  process.exit(1);
});
