// Connector relationship queries: conversations, friends (owner-authenticated),
// owner_token minting, and the room snapshot endpoint.
//
// Run: node test/connector-relations.js
// Checks:
//   - conversations grouped by interlocutor (direct + broadcast-room groups),
//     with the documented shape, excerpt cap, and newest-first ordering;
//     private-room messages are excluded; unknown muse 404s.
//   - friends: 403 without token, 403 with wrong/other-agent token,
//     200 with the correct token (header and query param), correct list shape.
//   - owner_token delivered on verified hello, stable across re-hellos.
//   - snapshot: 200 with a real 1280x800 PNG, 404 for private/nonexistent
//     rooms, 400 for malicious focus, 60s disk caching, and the SSRF guard
//     refusing loopback avatar URLs.
"use strict";
const assert = require("assert");
const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");
const WebSocket = require("ws");
const passport = require("../server/passport");

const PORT = 18850;
const FIXTURE_PORT = 18851;
const RUN = Date.now().toString(36);

function check(name, ok, extra) {
  if (!ok) {
    console.error("FAIL:", name, extra || "");
    process.exitCode = 1;
    throw new Error("check failed: " + name);
  }
  console.log("ok:", name);
}

// --- identities (same recipe as test/identity-relations.js) ---
function makeIdentity() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const raw = publicKey.export({ type: "spki", format: "der" }).slice(-32);
  // Stable key id, matching passport.keyIdOfRawPubkey: sha256(raw)[:8] hex.
  const keyId = crypto.createHash("sha256").update(raw).digest("hex").slice(0, 16);
  return { priv: privateKey, pubB64: raw.toString("base64"), keyId };
}
const ID_A = makeIdentity(); // Alfa: public principal
const ID_B = makeIdentity(); // Bravo: private principal

function manifestFor(ident, name, principal, avatarUrl) {
  // Same shape as test/identity-relations.js: signing_key carries the
  // Ed25519 identity key; the client proves control via challenge_response.
  const m = {
    muse_protocol: "1.0",
    muse: { name, principal },
    signing_key: { alg: "ed25519", pubkey: ident.pubB64 },
  };
  if (avatarUrl) m.muse.avatar_url = avatarUrl;
  return m;
}
const fixture = http.createServer((req, res) => {
  if (req.url === "/alfa/.well-known/muse-protocol.json") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(manifestFor(ID_A, "Alfa", { name: "Alfa Principal", visibility: "public" })));
  }
  if (req.url === "/bravo/.well-known/muse-protocol.json") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(manifestFor(ID_B, "Bravo", { name: "Bravo Principal", visibility: "private" },
      `http://127.0.0.1:${FIXTURE_PORT}/bravo/avatar.png`)));
  }
  // Bravo's manifest avatar_url points here (loopback): the snapshot
  // renderer's SSRF guard must refuse it, so this counter must stay 0.
  if (req.url === "/bravo/avatar.png") {
    avatarHits.count++;
    res.writeHead(200, { "Content-Type": "image/png" });
    return res.end(ONE_PIXEL_PNG);
  }
  res.writeHead(404); res.end();
});
const avatarHits = { count: 0 };
// 1x1 transparent PNG.
const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

const ATTESTATION_PREFIX = "muse-commons/v1/attestation:";
function signAttestation(priv, fields) {
  const payload = {
    type: "attestation",
    issuer: fields.issuer,
    subject: fields.subject,
    claim: fields.claim,
    issued_at: fields.issued_at,
    expires_at: fields.expires_at,
  };
  const bytes = Buffer.from(ATTESTATION_PREFIX + passport.canonicalJson(payload), "utf8");
  return { ...payload, signature: crypto.sign(null, bytes, priv).toString("base64") };
}

function challengePayload(nonce) {
  return Buffer.from("muse-commons/v1/challenge:" + nonce, "utf8");
}
class Agent {
  constructor(name, ident, manifestPath) {
    this.name = name;
    this.ident = ident;
    this.manifestPath = manifestPath;
    this.ws = null;
    this.inbox = [];
    this.agentId = null;
  }
  connect(port) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      this.ws = ws;
      ws.on("message", (raw) => {
        let m;
        try { m = JSON.parse(raw); } catch { return; }
        if (m.type === "challenge" && this.ident) {
          ws.send(JSON.stringify({
            type: "challenge_response",
            challenge_id: m.challenge_id,
            signature: crypto.sign(null, challengePayload(m.nonce), this.ident.priv).toString("base64"),
          }));
          return;
        }
        this.inbox.push(m);
      });
      ws.on("open", () => resolve());
      ws.on("error", reject);
    });
  }
  hello(room) {
    const msg = { type: "hello", name: this.name, room: room || "plaza" };
    if (this.manifestPath) msg.manifest_url = `http://127.0.0.1:${FIXTURE_PORT}${this.manifestPath}`;
    return this.sendAndWait(msg, (m) => m.type === "hello_ok" || m.type === "error", 12000)
      .then((m) => {
        if (m.type === "hello_ok") this.agentId = m.agent_id;
        return m;
      });
  }
  send(obj) { this.ws.send(JSON.stringify(obj)); }
  waitFor(pred, timeoutMs = 8000) {
    return new Promise((resolve) => {
      const start = Date.now();
      const tick = () => {
        for (let i = 0; i < this.inbox.length; i++) {
          if (pred(this.inbox[i])) return resolve(this.inbox.splice(i, 1)[0]);
        }
        if (Date.now() - start > timeoutMs) return resolve(null);
        setTimeout(tick, 25);
      };
      tick();
    });
  }
  sendAndWait(obj, pred, timeoutMs) {
    const p = this.waitFor(pred, timeoutMs);
    this.send(obj);
    return p;
  }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

function startLobby(env) {
  const child = spawn("node", ["server/lobby.js"], {
    cwd: path.join(__dirname, ".."),
    // MANIFEST_ALLOW_PRIVATE: the fixture manifests live on 127.0.0.1.
    env: { ALLOW_UNVERIFIED: "1", ...process.env, PORT: String(PORT), MANIFEST_ALLOW_PRIVATE: "1", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return child;
}
function waitForListening(child) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("lobby did not start")), 15000);
    let out = "";
    const onData = (d) => {
      out += d.toString();
      if (out.includes("listening")) { clearTimeout(timer); child.stdout.off("data", onData); resolve(); }
    };
    child.stdout.on("data", onData);
    child.on("exit", (c) => { clearTimeout(timer); reject(new Error("lobby exited " + c + ": " + out)); });
  });
}
function httpReq(p, headers) {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${PORT}${p}`, { headers: headers || {} }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on("error", reject);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const agents = [];
  let lobby = null;
  let lobby2 = null;
  const track = (a) => { agents.push(a); return a; };
  try {
    await run(agents, track, (l) => { lobby = l; }, (l) => { lobby2 = l; });
    console.log("connector-relations: all checks passed");
  } finally {
    // Always release ports/sockets, even on the first failing check, so a
    // failure can never hang the runner on open handles.
    for (const a of agents) try { a.close(); } catch { /* ignore */ }
    if (lobby) lobby.kill();
    if (lobby2) lobby2.kill();
    fixture.close();
  }
}

async function run(agents, track, setLobby, setLobby2) {
  // Clean relations state (friends, owner tokens, affinity) and the
  // persistent transcript like test/identity-relations.js does — the lobby
  // recreates both files. Without this, earlier runs' messages pollute the
  // conversation grouping counts.
  fs.rmSync(path.join(__dirname, "..", "data", "relations.json"), { force: true });
  fs.rmSync(path.join(__dirname, "..", "data", "transcripts.json"), { force: true });
  await new Promise((r) => fixture.listen(FIXTURE_PORT, "127.0.0.1", r));
  const lobby = startLobby();
  setLobby(lobby);
  await waitForListening(lobby);
  const get = (p, headers) => httpReq(p, headers);

  // --- owner_token minting on verified hello ---
  console.log("owner token");
  const A = new Agent("Alfa", ID_A, "/alfa/.well-known/muse-protocol.json");
  const B = new Agent("Bravo", ID_B, "/bravo/.well-known/muse-protocol.json");
  track(A); track(B);
  await A.connect(PORT); await B.connect(PORT);
  let r = await A.hello();
  check("Alfa admitted verified", r.type === "hello_ok" && r.verified === "verified");
  const tokA = await A.waitFor((m) => m.type === "owner_token", 8000);
  check("owner_token delivered on verified hello", !!tokA && /^[A-Za-z0-9_-]{43}$/.test(tokA.owner_token || ""));
  r = await B.hello();
  check("Bravo admitted verified", r.type === "hello_ok" && r.verified === "verified");
  const tokB = await B.waitFor((m) => m.type === "owner_token", 8000);
  check("each agent gets its own token", !!tokB && tokB.owner_token !== tokA.owner_token);
  // re-hello reuses the persisted token
  await A.hello();
  const tokA2 = await A.waitFor((m) => m.type === "owner_token", 8000);
  check("token stable across re-hellos", !!tokA2 && tokA2.owner_token === tokA.owner_token);

  // --- friends: 403s and 404 before any friendship ---
  console.log("friends auth");
  r = await get("/api/muse/Alfa/friends");
  check("friends without token -> 403", r.status === 403, r.status);
  r = await get("/api/muse/Alfa/friends", { "X-Owner-Token": "wrong-token" });
  check("friends with wrong token -> 403", r.status === 403, r.status);
  r = await get("/api/muse/Alfa/friends", { "X-Owner-Token": tokB.owner_token });
  check("friends with another agent's token -> 403", r.status === 403, r.status);
  r = await get("/api/muse/Nobody/friends", { "X-Owner-Token": tokA.owner_token });
  check("friends for unknown muse -> 404", r.status === 404, r.status);

  // Alfa befriends Bravo via a signed attestation (issuer = Alfa's principal).
  const now = Date.now();
  const att = signAttestation(ID_A.priv, {
    issuer: ID_A.keyId,
    subject: ID_B.keyId,
    claim: "friend",
    issued_at: now - 1000,
    expires_at: now + 3600000,
  });
  r = await A.sendAndWait({ type: "present_attestation", attestation: att },
    (m) => m.type === "attestation_accepted" || m.type === "error", 8000);
  check("friend attestation accepted", r && r.type === "attestation_accepted", JSON.stringify(r && (r.type || r.code)));

  console.log("friends list");
  r = await get("/api/muse/Alfa/friends", { "X-Owner-Token": tokA.owner_token });
  check("friends with correct header token -> 200", r.status === 200, r.status);
  let j = JSON.parse(r.body.toString());
  check("friends payload shape", j.muse === "Alfa" && Array.isArray(j.friends) && j.friends.length === 1, r.body.toString());
  const f = j.friends[0];
  check("friend entry shape",
    typeof f.name === "string" && f.principal_id === ID_B.keyId &&
    typeof f.friends_since_t === "number" && f.friends_since_t > 0,
    JSON.stringify(f));
  check("private principal name is NOT leaked as name", f.name !== "Bravo Principal", JSON.stringify(f));
  r = await get(`/api/muse/Alfa/friends?owner_token=${encodeURIComponent(tokA.owner_token)}`);
  check("friends with query-param token -> 200", r.status === 200, r.status);
  j = JSON.parse(r.body.toString());
  check("query-param token returns same list", j.friends && j.friends.length === 1 && j.friends[0].principal_id === ID_B.keyId);

  // --- conversations ---
  console.log("conversations");
  A.send({ type: "say", from: "Alfa", text: `broadcast one ${RUN}` });
  A.send({ type: "say", from: "Alfa", text: `broadcast two ${RUN}` });
  A.send({ type: "talk", from: "Alfa", to: "Bravo", text: `direct hello bravo ${RUN}` });
  B.send({ type: "talk", from: "Bravo", to: "Alfa", text: `direct reply alfa ${RUN}` });
  await sleep(600); // let the server append transcripts

  r = await get("/api/muse/Alfa/conversations");
  check("conversations 200", r.status === 200, r.status);
  j = JSON.parse(r.body.toString());
  check("conversations payload shape", j.muse === "Alfa" && Array.isArray(j.conversations), r.body.toString());
  const byName = {};
  for (const c of j.conversations) byName[c.name] = c;
  check("direct interlocutor grouped", !!byName["Bravo"], Object.keys(byName).join(","));
  check("broadcast grouped under room", !!byName["#plaza"], Object.keys(byName).join(","));

  const dir = byName["Bravo"];
  check("direct group shape",
    dir.kind === "agent" && dir.message_count === 2 &&
    typeof dir.first_t === "number" && typeof dir.last_t === "number" &&
    dir.last_t >= dir.first_t && Array.isArray(dir.rooms) && dir.rooms.includes("plaza") &&
    Array.isArray(dir.about) && dir.about.length === 2,
    JSON.stringify(dir));
  check("direct group newest first", dir.about[0].includes("direct reply"), JSON.stringify(dir.about));
  check("direct group carries avatar and verified flag",
    dir.avatar_url === `http://127.0.0.1:${FIXTURE_PORT}/bravo/avatar.png` && dir.verified === true,
    JSON.stringify(dir));

  const room = byName["#plaza"];
  check("room group shape",
    room.kind === "room" && room.message_count === 2 &&
    Array.isArray(room.rooms) && room.rooms.length === 1 && room.rooms[0] === "plaza" &&
    Array.isArray(room.about) && room.about.length === 2,
    JSON.stringify(room));
  check("room group has no agent fields", !("avatar_url" in room) && !("verified" in room));

  // excerpt cap: 3 newest of 5 more broadcasts
  for (let i = 0; i < 5; i++) A.send({ type: "say", from: "Alfa", text: `flood ${i} ${RUN}` });
  await sleep(600);
  r = await get("/api/muse/Alfa/conversations");
  j = JSON.parse(r.body.toString());
  const room2 = j.conversations.find((c) => c.name === "#plaza");
  check("excerpts capped at 3, newest first",
    room2.about.length === 3 && room2.about[0].includes("flood 4") && room2.about[2].includes("flood 2"),
    JSON.stringify(room2.about));

  // private room exclusion
  const created = await A.sendAndWait({ type: "create_room", topic: `secret ${RUN}`, visibility: "private" },
    (m) => m.type === "room_created" || m.type === "error", 8000);
  check("private room created", !!created && created.type === "room_created", JSON.stringify(created && (created.type || created.code)));
  const privId = created.room_id || created.room;
  A.send({ type: "say", from: "Alfa", text: `private secret words ${RUN}` });
  await sleep(600);
  r = await get("/api/muse/Alfa/conversations");
  j = JSON.parse(r.body.toString());
  const leaked = j.conversations.some((c) =>
    (c.about || []).some((a) => a.includes("private secret words")) ||
    (c.rooms || []).includes(privId));
  check("private-room messages excluded", !leaked);
  r = await get("/api/muse/Nobody/conversations");
  check("conversations for unknown muse -> 404", r.status === 404, r.status);

  // --- snapshot (server-side SVG render, no browser) ---
  console.log("snapshot");
  // Re-hello both agents: the test client sends no heartbeats, so the
  // lobby may have expired their presence during the earlier sections.
  // The snapshot must render with Alfa and Bravo actually in the plaza.
  r = await A.hello();
  check("Alfa re-hello for snapshot", r.type === "hello_ok", r.type);
  r = await B.hello();
  check("Bravo re-hello for snapshot", r.type === "hello_ok", r.type);
  r = await get("/api/places");
  const plaza = JSON.parse(r.body.toString()).rooms.find((x) => x.room_id === "plaza");
  check("Alfa and Bravo are plaza occupants for the snapshot",
    plaza && plaza.occupants.includes("Alfa") && plaza.occupants.includes("Bravo"),
    JSON.stringify(plaza && plaza.occupants));
  // Clear any cached renders from earlier runs so the checks below
  // exercise the live renderer, not a stale cached PNG.
  const snapDir = path.join(__dirname, "..", "data", "snapshots");
  try { fs.rmSync(snapDir, { recursive: true, force: true }); } catch {}
  const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  r = await get(`/api/rooms/plaza/snapshot.png?focus=Alfa`);
  check("snapshot 200", r.status === 200, r.status);
  check("snapshot is image/png", r.headers["content-type"] === "image/png", r.headers["content-type"]);
  check("snapshot body starts with PNG signature", r.body.slice(0, 8).equals(PNG_SIG));
  check("snapshot is 1280x800",
    r.body.readUInt32BE(16) === 1280 && r.body.readUInt32BE(20) === 800,
    r.body.readUInt32BE(16) + "x" + r.body.readUInt32BE(20));
  check("snapshot cache-control 60s", /max-age=60/.test(r.headers["cache-control"] || ""), r.headers["cache-control"]);
  // Bravo's manifest avatar_url points at the loopback fixture server: the
  // SSRF guard must refuse it, so the fixture sees zero avatar hits even
  // though Bravo is in the room.
  check("loopback avatar URL never fetched (SSRF guard)", avatarHits.count === 0, "hits=" + avatarHits.count);
  const first = r.body;
  const cacheFiles = fs.readdirSync(snapDir);
  check("snapshot cached to disk", cacheFiles.length === 1, cacheFiles.join(","));
  const cacheFile = path.join(snapDir, cacheFiles[0]);
  const mtime1 = fs.statSync(cacheFile).mtimeMs;
  await new Promise((r2) => setTimeout(r2, 60));
  const t0 = Date.now();
  r = await get(`/api/rooms/plaza/snapshot.png?focus=Alfa`);
  const dt = Date.now() - t0;
  check("cached snapshot identical bytes", r.status === 200 && r.body.equals(first), r.status);
  check("second request served from cache (no re-render)", fs.statSync(cacheFile).mtimeMs === mtime1);
  console.log(`(cached snapshot served in ${dt}ms)`);
  // a different focus renders fresh
  r = await get(`/api/rooms/plaza/snapshot.png?focus=Bravo`);
  check("different focus renders separately", r.status === 200 && !r.body.equals(first), r.status);
  check("loopback avatar still never fetched", avatarHits.count === 0, "hits=" + avatarHits.count);
  // error paths
  r = await get(`/api/rooms/${encodeURIComponent(privId)}/snapshot.png?focus=Alfa`);
  check("snapshot 404 for private room", r.status === 404, r.status);
  r = await get(`/api/rooms/nonexistent-room-${RUN}/snapshot.png?focus=Alfa`);
  check("snapshot 404 for nonexistent room", r.status === 404, r.status);
  r = await get(`/api/rooms/plaza/snapshot.png?focus=../../etc/passwd`);
  check("snapshot 400 for malicious focus", r.status === 400, r.status);
}

main().then(
  () => process.exit(process.exitCode || 0),
  (e) => { console.error("FATAL:", e && e.message); process.exit(1); }
);
