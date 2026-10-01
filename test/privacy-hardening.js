// Privacy hardening tests (PR #4): private-room isolation across every
// read path, knock/invite privacy, retention labels, and disk ephemerality.
//
// Spawns a real lobby server child on a LOCAL port — never touches the
// production lobby. All secrets are RUN-suffixed so concurrent runs and
// leftover local data files can't collide.
//   node test/privacy-hardening.js
// Exit 0 = all pass, 1 = any failure.
const http = require("http");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { spawn } = require("child_process");
const WebSocket = require("ws");

const REPO = path.join(__dirname, "..");
const LOBBY = path.join(REPO, "server", "lobby.js");
const DATA_DIR = path.join(REPO, "data");
const PORT = 18801;
const HOST_FIXTURE_PORT = 18802;

// Host fixture: a proof-verified host muse, so we can assert the host does
// NOT learn about private-room knocks. (Pattern copied from test/board.js.)
const { privateKey: HOST_PRIV, publicKey: HOST_PUB } = crypto.generateKeyPairSync("ed25519");
const HOST_PUB_B64 = Buffer.from(HOST_PUB.export({ format: "jwk" }).x, "base64url").toString("base64");
const HOST_MANIFEST_URL = `http://127.0.0.1:${HOST_FIXTURE_PORT}/.well-known/muse-protocol.json`;
const hostFixture = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      muse: { name: "HostMuse", serves: "Host" },
      signing_key: { alg: "ed25519", key_id: "host-fixture-1", pubkey: HOST_PUB_B64 },
    })
  );
});
function signHostChallenge(nonce) {
  return crypto
    .sign(null, Buffer.from("muse-commons/v1/challenge:" + nonce, "utf8"), HOST_PRIV)
    .toString("base64");
}

const RUN = Math.random().toString(36).slice(2, 8);
const T = (s) => `${s}-${RUN}`;
const SECRET_TEXT = `sekrit-whisper-${RUN}`;
const SECRET_TOPIC = `sekrit-topic-${RUN}`;
const MARKER = `reporter-marker-${RUN}`;

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
      LOBBY_PUBLIC_URL: `http://127.0.0.1:${PORT}/`,
      HOST_MUSE: "HostMuse",
      MANIFEST_ALLOW_PRIVATE: "1",
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
function killLobby(child) {
  return new Promise((resolve) => {
    child.on("exit", () => resolve());
    child.kill("SIGTERM");
    setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* already dead */ }
    }, 3000);
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
      try { m = JSON.parse(raw); } catch { return; }
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
    ws.on("error", (e) => { clearTimeout(timer); reject(e); });
  });
}
function openVerifiedAgent(name, manifestUrl, extra = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    const rec = { ws, name, msgs: [] };
    const timer = setTimeout(() => reject(new Error(`hello timeout for ${name}`)), 15000);
    ws.on("open", () => ws.send(JSON.stringify({ type: "hello", name, manifest_url: manifestUrl, ...extra })));
    ws.on("message", (raw) => {
      let m;
      try { m = JSON.parse(raw); } catch { return; }
      rec.msgs.push(m);
      if (m.type === "challenge") {
        ws.send(JSON.stringify({
          type: "challenge_response",
          challenge_id: m.challenge_id,
          signature: signHostChallenge(m.nonce),
        }));
        return;
      }
      if (m.type === "state" && m.agents && m.agents.some((a) => a.name === name)) {
        clearTimeout(timer);
        resolve(rec);
      }
      if (m.type === "error") {
        clearTimeout(timer);
        resolve(rec);
      }
    });
    ws.on("error", (e) => { clearTimeout(timer); reject(e); });
  });
}
function waitFor(rec, pred, timeoutMs = 6000) {
  return new Promise((resolve) => {
    const found = rec.msgs.find(pred);
    if (found) return resolve(found);
    const timer = setTimeout(() => resolve(null), timeoutMs);
    const onMsg = (raw) => {
      let m;
      try { m = JSON.parse(raw); } catch { return; }
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
    http.get(`http://127.0.0.1:${PORT}${p}`, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    }).on("error", reject);
  });
}
function readDataFile(name) {
  try {
    return fs.readFileSync(path.join(DATA_DIR, name), "utf8");
  } catch {
    return "";
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await new Promise((resolve) => hostFixture.listen(HOST_FIXTURE_PORT, "127.0.0.1", resolve));
  let server = startLobby();
  await waitForListening(server);

  console.log("private room lifecycle + retention labels");
  const alice = await openAgent(T("PrivAlice"), { serves: T("Human") });
  alice.ws.send(JSON.stringify({ type: "create_room", topic: SECRET_TOPIC, visibility: "private" }));
  const created = await waitFor(alice, (m) => m.type === "room_created" && m.topic === SECRET_TOPIC);
  check("private room created", !!created && created.visibility === "private", JSON.stringify(created && created.visibility));
  const privRoomId = created && created.room_id;
  check("room_created carries retention", !!created && !!created.retention &&
    created.retention.visibility === "private" && created.retention.persisted === false &&
    created.retention.keep === 50, JSON.stringify(created && created.retention));

  const privState = await waitFor(alice, (m) => m.type === "state" && m.room_id === privRoomId);
  check("ws state carries retention for private room", !!privState && !!privState.retention &&
    privState.retention.persisted === false, JSON.stringify(privState && privState.retention));

  console.log("private conversation");
  const bob = await openAgent(T("PrivBob"));
  alice.ws.send(JSON.stringify({ type: "invite", room_id: privRoomId, to: bob.name }));
  const invited = await waitFor(bob, (m) => m.type === "invited" && m.room_id === privRoomId);
  check("bob invited to private room", !!invited);
  bob.ws.send(JSON.stringify({ type: "hello", name: bob.name, room: privRoomId }));
  const bobState = await waitFor(bob, (m) => m.type === "state" && m.room_id === privRoomId);
  check("bob joined the private room", !!bobState);
  check("bob's private state carries retention", !!bobState && !!bobState.retention &&
    bobState.retention.persisted === false);
  alice.ws.send(JSON.stringify({ type: "say", from: alice.name, text: SECRET_TEXT + " from alice" }));
  await sleep(300);
  bob.ws.send(JSON.stringify({ type: "say", from: bob.name, text: SECRET_TEXT + " from bob" }));
  await sleep(600); // let ticker/presence/disk settle

  console.log("public APIs leak nothing");
  {
    const ticker = JSON.parse((await get("/api/ticker")).body);
    const blob = JSON.stringify(ticker);
    check("ticker has no private text", !blob.includes(SECRET_TEXT));
    check("ticker has no private room id/topic", !blob.includes(privRoomId) && !blob.includes(SECRET_TOPIC));
  }
  {
    const places = JSON.parse((await get("/api/places")).body);
    const blob = JSON.stringify(places);
    check("places lists no private room", !blob.includes(privRoomId) && !blob.includes(SECRET_TOPIC));
    const plaza = places.rooms.find((r) => r.room_id === "plaza");
    check("places plaza entry carries retention", !!plaza && !!plaza.retention &&
      plaza.retention.visibility === "public" && plaza.retention.persisted === true &&
      plaza.retention.keep === 50, JSON.stringify(plaza && plaza.retention));
  }
  {
    const presence = JSON.parse((await get("/api/presence?limit=200")).body);
    const ours = presence.events.filter((e) => e.room_id === privRoomId);
    check("presence feed has no private-room events", ours.length === 0, `got ${ours.length}`);
    const blob = JSON.stringify(presence);
    check("presence feed has no private text/topic", !blob.includes(SECRET_TEXT) && !blob.includes(SECRET_TOPIC));
  }
  for (const p of ["/api/board", "/api/directory", "/openapi.json", "/llms.txt"]) {
    const r = await get(p);
    check(`${p} has no private text`, r.status === 200 && !r.body.includes(SECRET_TEXT), `status ${r.status}`);
  }

  console.log("disk has no trace");
  for (const f of ["transcripts.json", "presence.json", "audit.json", "reports.json", "quarantine.json", "blocks.json", "board.json"]) {
    const body = readDataFile(f);
    check(`${f} has no private text`, !body.includes(SECRET_TEXT), `${f} leaked`);
    check(`${f} has no private room id`, !body.includes(privRoomId), `${f} leaked room id`);
  }

  console.log("knock privacy: host is not told about private-room knocks");
  // Private room with knock entry: the creator must get the knock, the
  // host (not a participant) must not.
  alice.ws.send(JSON.stringify({ type: "create_room", topic: T("knockpriv"), visibility: "private", entry: "knock" }));
  const knockRoom = await waitFor(alice, (m) => m.type === "room_created" && m.topic === T("knockpriv"));
  const knockRoomId = knockRoom && knockRoom.room_id;
  check("private knock-entry room created", !!knockRoomId);
  const host = await openVerifiedAgent("HostMuse", HOST_MANIFEST_URL);
  await sleep(500); // host fully admitted
  host.msgs.length = 0; // clear the backlog; we only care about new knocks
  const carol = await openAgent(T("PrivCarol"));
  carol.ws.send(JSON.stringify({ type: "knock", room_id: knockRoomId }));
  const knockPending = await waitFor(carol, (m) => m.type === "knock_pending" && m.room_id === knockRoomId);
  check("knocker gets knock_pending", !!knockPending);
  const creatorKnock = await waitFor(alice, (m) => m.type === "knock_request" && m.room_id === knockRoomId);
  check("creator gets the knock_request", !!creatorKnock);
  await sleep(1200); // give any host notification time to arrive
  const hostKnock = host.msgs.find((m) => m.type === "knock_request" && m.room_id === knockRoomId);
  check("host does NOT get knock_request for private room", !hostKnock);

  console.log("existence concealment: outsiders can't probe private rooms");
  {
    // hello straight at the invite-only private room
    const probe = await openAgent(T("PrivProbe"), { room: privRoomId });
    const err = probe.msgs.find((m) => m.type === "error");
    check("probing hello gets NO_SUCH_ROOM", !!err && err.code === "NO_SUCH_ROOM",
      JSON.stringify(err && err.code));
    probe.ws.close();
  }
  {
    // knock at the invite-only private room (not the knock-entry one)
    const errsBefore = carol.msgs.filter((m) => m.type === "error").length;
    carol.ws.send(JSON.stringify({ type: "knock", room_id: privRoomId }));
    await sleep(1500); // let the error arrive
    const newErrs = carol.msgs.filter((m) => m.type === "error").slice(errsBefore);
    const knockErr = newErrs[newErrs.length - 1];
    check("probing knock gets NO_SUCH_ROOM, not ROOM_INVITE_ONLY",
      !!knockErr && knockErr.code === "NO_SUCH_ROOM", JSON.stringify(knockErr && knockErr.code));
  }

  console.log("report from a private room keeps bodies out of the queue");
  bob.ws.send(JSON.stringify({ type: "report", target: alice.name, message: MARKER, reason: "privacy test report" }));
  const reportOk = await waitFor(bob, (m) => m.type === "report_ok");
  check("report filed from private room", !!reportOk);
  await sleep(500);
  {
    const filed = host.msgs.find((m) => m.type === "report_filed" && m.report && m.report.id === (reportOk && reportOk.id));
    check("host got report_filed", !!filed);
    const ctx = (filed && filed.report && filed.report.context) || [];
    check("report context has no message bodies", ctx.every((e) => !("text" in e)),
      JSON.stringify(ctx).slice(0, 200));
    check("report_filed uses the public shape (reason + context only)",
      filed && filed.report && typeof filed.report.reason === "string" && !("message" in filed.report));
    const disk = readDataFile("reports.json");
    check("reports.json has no private text", !disk.includes(SECRET_TEXT));
  }

  console.log("ephemerality: restart leaves no private trace");
  // close sockets, restart the server, verify the private room is gone
  // and no private content survived on disk or in any API.
  for (const a of [alice, bob, carol, host]) { try { a.ws.close(); } catch { /* ignore */ } }
  await killLobby(server);
  server = startLobby();
  await waitForListening(server);
  await sleep(400);
  {
    const ticker = JSON.parse((await get("/api/ticker")).body);
    check("post-restart ticker has no private text", !JSON.stringify(ticker).includes(SECRET_TEXT));
    const presence = JSON.parse((await get("/api/presence?limit=200")).body);
    check("post-restart presence has no private-room events",
      !presence.events.some((e) => e.room_id === privRoomId));
    const disk = readDataFile("transcripts.json");
    check("post-restart transcripts.json has no private text", !disk.includes(SECRET_TEXT));
    check("post-restart transcripts.json has no private room id", !disk.includes(privRoomId));
    const dave = await openAgent(T("PrivDave"), { room: privRoomId });
    const err = dave.msgs.find((m) => m.type === "error");
    check("private room did not survive restart", !!err && err.code === "NO_SUCH_ROOM",
      JSON.stringify(err && err.code));
    dave.ws.close();
  }

  await killLobby(server);
  hostFixture.close();
  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
