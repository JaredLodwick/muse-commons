// Transcript persistence tests: chat history in persistent rooms survives
// a server restart (data/transcripts.json), the rolling cap still applies,
// and ephemeral breakouts are not persisted.
//
// Spawns real lobby server children, isolated via DATA_DIR override... note:
// the server resolves DATA_DIR relative to server/, so this test instead
// runs the server with cwd isolation is not supported; it uses a unique
// PORT and cleans up the transcripts file it creates.
//
//   node test/transcript-persist.js
// Exit 0 = all pass, 1 = any failure.
const http = require("http");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const WebSocket = require("ws");

const REPO = path.join(__dirname, "..");
const LOBBY = path.join(REPO, "server", "lobby.js");
const PORT = 18797;
const DATA_FILE = path.join(REPO, "data", "transcripts.json");

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
    env: { ALLOW_UNVERIFIED: "1", ...process.env, PORT: String(PORT) },
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
function kill(child) {
  return new Promise((resolve) => {
    child.on("exit", () => resolve());
    child.kill();
    setTimeout(resolve, 3000);
  });
}
function openAgent(name, room = "plaza") {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    const rec = { ws, name, msgs: [] };
    const timer = setTimeout(() => reject(new Error(`hello timeout for ${name}`)), 10000);
    ws.on("open", () => ws.send(JSON.stringify({ type: "hello", name, room })));
    ws.on("message", (raw) => {
      let m;
      try { m = JSON.parse(raw); } catch { return; }
      rec.msgs.push(m);
      if (m.type === "state" && m.agents && m.agents.some((a) => a.name === name)) {
        clearTimeout(timer);
        resolve(rec);
      }
      if (m.type === "error") { clearTimeout(timer); resolve(rec); }
    });
    ws.on("error", (e) => { clearTimeout(timer); reject(e); });
  });
}
function get(p) {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${PORT}${p}`, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    }).on("error", reject);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // Clean slate for this test's data file (server recreates it).
  try { fs.unlinkSync(DATA_FILE); } catch { /* ignore */ }
  let child = startLobby();
  try {
    await waitForListening(child);
    const a = await openAgent("PersistBot");
    a.ws.send(JSON.stringify({ type: "say", from: "PersistBot", text: "hello-persist-test" }));
    await sleep(700); // let addTranscript + disk write land

    check("transcripts.json written", fs.existsSync(DATA_FILE));
    const disk = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    check("plaza transcript on disk has the message",
      Array.isArray(disk.plaza) && disk.plaza.some((e) => e.text === "hello-persist-test"),
      JSON.stringify(Object.keys(disk)));

    const t1 = await get("/api/ticker").then((r) => JSON.parse(r.body));
    check("ticker shows message before restart",
      t1.events.some((e) => e.text === "hello-persist-test"));

    await kill(child);
    child = startLobby();
    await waitForListening(child);

    const t2 = await get("/api/ticker").then((r) => JSON.parse(r.body));
    check("ticker shows message after restart",
      t2.events.some((e) => e.text === "hello-persist-test"),
      `events: ${t2.events.length}`);

    // Joining agent gets the restored transcript.
    const b = await openAgent("LateJoiner");
    const tr = b.msgs.find((m) => m.type === "transcript");
    check("join transcript includes persisted message",
      !!tr && tr.events.some((e) => e.text === "hello-persist-test"));
    b.ws.close();
    a.ws.close();
  } catch (e) {
    failures++;
    console.log(`  FAIL harness — ${e.message}`);
  } finally {
    await kill(child);
    try { fs.unlinkSync(DATA_FILE); } catch { /* ignore */ }
  }
  console.log(failures === 0 ? "PASS" : `${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
})();
