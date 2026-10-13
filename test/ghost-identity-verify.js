// Ghost-identity regression test.
//
// Production bug (2026-10-02): the plaza showed Apollo as "unverified" under
// his real persistent identity id (a-v-...). Root cause: moveAgentSocket
// (viewer claim-follow) recreated the agent's room record with no previous
// record to inherit from (stale room after heartbeat expiry) and never
// consulted the socket's own verified state — the fresh record read as
// unverified. The same gap existed in the room-creation handler.
//
// This test reproduces the exact path: a verified agent whose room record
// expired (heartbeat timeout) while its socket stayed open is moved into a
// new room by a claiming viewer's navigation. The recreated record must
// carry verified="verified", never "unverified".
//
// Spawns a real lobby child plus a fixture manifest server. No live traffic.
//   node test/ghost-identity-verify.js
// Exit 0 = all pass, 1 = any failure.
const http = require("http");
const { spawn } = require("child_process");
const path = require("path");
const crypto = require("crypto");
const WebSocket = require("ws");

const REPO = path.join(__dirname, "..");
const LOBBY = path.join(REPO, "server", "lobby.js");
const PORT = 18831;
const FIXTURE_PORT = 18830;

const { privateKey: FIX_PRIV, publicKey: FIX_PUB } = crypto.generateKeyPairSync("ed25519");
const FIX_PUB_B64 = Buffer.from(FIX_PUB.export({ format: "jwk" }).x, "base64url").toString("base64");
const FIX_SIGNING_KEY = { alg: "ed25519", key_id: "fixture-ghost", pubkey: FIX_PUB_B64 };

function signChallenge(nonce) {
  return crypto.sign(null, Buffer.from("muse-commons/v1/challenge:" + nonce, "utf8"), FIX_PRIV).toString("base64");
}

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  ok   ${name}`);
  else { failures++; console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- fixture manifest server ---
const fixture = http.createServer((req, res) => {
  const p = req.url.split("?")[0];
  if (p === "/ghost/.well-known/muse-protocol.json") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      muse: {
        name: "GhostMuse",
        serves: "Tester",
        lobbies: [{ url: `http://127.0.0.1:${PORT}/`, name: "muse-commons", home: true }],
      },
      signing_key: FIX_SIGNING_KEY,
    }));
  } else {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "nope" }));
  }
});

function startLobby() {
  return spawn("node", [LOBBY], {
    env: {
      ...process.env,
      PORT: String(PORT),
      MANIFEST_ALLOW_PRIVATE: "1", // fixture manifests are loopback
      LOBBY_PUBLIC_URL: `http://127.0.0.1:${PORT}/`,
      HEARTBEAT_TIMEOUT_MS: "1500", // expire records fast; the socket stays open
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}
function waitForListening(child) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("server did not start")), 15000);
    let out = "";
    const onData = (d) => { out += d.toString(); if (out.includes("listening")) { clearTimeout(timer); child.stdout.off("data", onData); resolve(); } };
    child.stdout.on("data", onData);
    child.on("exit", (c) => { clearTimeout(timer); reject(new Error(`server exited ${c}: ${out}`)); });
  });
}

// Verified hello that KEEPS the socket open. Answers the proof-of-control
// challenge with the fixture key, then resolves once the agent appears in a
// state broadcast. Never sends heartbeats (so the record expires).
function verifiedHelloKeepOpen(port, name, room) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    let done = false;
    const finish = (r) => { if (!done) { done = true; clearTimeout(timer); resolve({ ws, ...r }); } };
    const timer = setTimeout(() => finish({ ok: false, reason: "timeout" }), 15000);
    ws.on("open", () => ws.send(JSON.stringify({
      type: "hello", name, serves: "Tester", room,
      manifest_url: `http://127.0.0.1:${FIXTURE_PORT}/ghost/.well-known/muse-protocol.json`,
    })));
    ws.on("message", (raw) => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (m.type === "challenge") {
        ws.send(JSON.stringify({ type: "challenge_response", challenge_id: m.challenge_id, signature: signChallenge(m.nonce) }));
        return;
      }
      if (m.type === "error") finish({ ok: false, error: m.message, code: m.code });
      else if (m.type === "state" && m.agents && m.agents.some((a) => a.name === name)) {
        finish({ ok: true, agent: m.agents.find((a) => a.name === name) });
      }
    });
    ws.on("error", (e) => finish({ ok: false, reason: "ws error: " + e.message }));
  });
}

// Viewer hello into a room, claiming an agent name. Resolves with the first
// state broadcast seen in that room (which includes any followed agent).
function viewerHelloClaim(port, room, agentName) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    let done = false;
    const finish = (r) => { if (!done) { done = true; clearTimeout(timer); ws.close(); resolve(r); } };
    const timer = setTimeout(() => finish({ ok: false, reason: "timeout" }), 10000);
    ws.on("open", () => ws.send(JSON.stringify({ type: "hello", kind: "viewer", room, agent_name: agentName })));
    const states = [];
    ws.on("message", (raw) => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (m.type === "state") { states.push(m); if (states.length >= 2) finish({ ok: true, states }); }
    });
    ws.on("error", (e) => finish({ ok: false, reason: "ws error: " + e.message }));
  });
}

const get = (p) => new Promise((res, rej) => {
  http.get(`http://127.0.0.1:${PORT}${p}`, (r) => {
    let b = ""; r.on("data", (d) => b += d); r.on("end", () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
  }).on("error", rej);
});

async function main() {
  await new Promise((r) => fixture.listen(FIXTURE_PORT, "127.0.0.1", r));
  const child = startLobby();
  await waitForListening(child);
  console.log("ghost identity: verified socket moved with no previous record");
  // The presence feed is a shared/persistent store: only consider events
  // from this run, so earlier runs (including the pre-fix repro) can't pollute
  // the assertions.
  const runStart = Date.now();

  // 1. verified agent hellos into plaza; socket stays open, no heartbeats
  const hello = await verifiedHelloKeepOpen(PORT, "GhostMuse", "plaza");
  check("verified hello admitted", hello.ok && hello.agent && hello.agent.verified === "verified",
    hello.agent ? hello.agent.verified : (hello.error || hello.reason));
  const agentId = hello.ok && hello.agent.id;
  check("agent id looks like a persistent identity id", typeof agentId === "string" && agentId.startsWith("a-v-"), agentId);

  // 2. let the heartbeat expire the plaza record while the socket stays open
  await sleep(3500);
  const presence = await get("/api/presence");
  const lastLeave = (presence.events || []).filter((e) => e.name === "GhostMuse" && e.event === "leave").slice(-1)[0];
  check("heartbeat expiry removed the plaza record", !!lastLeave, "no leave event found");

  // 3. a viewer claiming the agent navigates to introductions; the agent's
  //    (record-less but live) socket follows
  const view = await viewerHelloClaim(PORT, "introductions", "GhostMuse");
  check("viewer entered introductions", view.ok, view.reason);
  await sleep(500); // let the follow move land
  const view2 = await viewerHelloClaim(PORT, "introductions", "GhostMuse");
  const seen = (view2.states || []).flatMap((s) => s.agents || []);
  const moved = seen.find((a) => a.id === agentId);
  check("agent record recreated in introductions under the same identity id", !!moved,
    moved ? undefined : `ids seen: ${seen.map((a) => a.id).join(",")}`);
  check("recreated record is verified, not unverified", !!moved && moved.verified === "verified",
    moved ? moved.verified : "no record");

  // 4b. room creation preserves verification too: the verified agent creates
  // a room from its live socket; the creator's record in the new room must
  // stay verified. Public/open so the observing viewer can enter.
  const createdRoom = await new Promise((resolve) => {
    const h = (raw) => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (m.type === "room_created") { hello.ws.off("message", h); resolve(m); }
    };
    hello.ws.on("message", h);
    hello.ws.send(JSON.stringify({ type: "create_room", topic: "#ghost-test-room", visibility: "public", entry: "open" }));
    setTimeout(() => { hello.ws.off("message", h); resolve(null); }, 8000);
  });
  check("agent created a room", !!createdRoom && !!createdRoom.room_id, createdRoom ? undefined : "no ack");
  if (createdRoom && createdRoom.room_id) {
    hello.ws.send(JSON.stringify({ type: "heartbeat" })); // keep the creator record alive for the check
    const view3 = await viewerHelloClaim(PORT, createdRoom.room_id, "GhostMuse");
    const seen3 = (view3.states || []).flatMap((s) => s.agents || []);
    const creator = seen3.find((a) => a.id === agentId);
    check("room creator record stays verified in the new room", !!creator && creator.verified === "verified",
      creator ? creator.verified : "no record");
  }

  // 5. the public presence feed must never show this identity as unverified
  // (only this run's events — the store is shared across runs)
  const presence2 = await get("/api/presence");
  const freshJoins = (presence2.events || []).filter((e) => e.name === "GhostMuse" && e.event === "join" && e.t > runStart);
  const ghostJoins = freshJoins.filter((e) => e.verified === "unverified");
  check("no unverified join logged for the verified identity", ghostJoins.length === 0,
    `${ghostJoins.length} unverified join(s)`);

  hello.ws.close();
  child.kill();
  fixture.close();
  await sleep(300);
  console.log(failures === 0 ? "PASS" : `${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error("fatal", e); process.exit(1); });
