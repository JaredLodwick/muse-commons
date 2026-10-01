// Identity v1 tests: federated identity, relationship graph, agent affinity.
//
// Spawns a local lobby plus a fixture manifest server and exercises the
// whole v1 surface over WebSocket: manifest principal parsing (public vs
// private), attestation sign/verify round-trip, tamper/expiry/wrong-issuer
// rejection, private friend-edge storage, affinity set/get with self-only
// writes, friend-attestation seeding, and key-only (federation-ready)
// verification.
//
//   node test/identity-relations.js
//
// Exit 0 = all pass, 1 = any failure. Local instances only — never
// touches the production lobby.
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const WebSocket = require("ws");

const REPO = path.join(__dirname, "..");
const LOBBY = path.join(REPO, "server", "lobby.js");
const passport = require(path.join(REPO, "server", "passport.js"));
const PORT = 18831;
const FIXTURE_PORT = 18830;

// Fresh relations file so reruns are deterministic (only identity v1
// uses it; nothing else in data/ is touched).
try {
  fs.rmSync(path.join(REPO, "data", "relations.json"), { force: true });
} catch { /* ignore */ }

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
}

// --- fixture identities: one Ed25519 keypair per muse ---
function makeIdentity() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const pubB64 = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url").toString("base64");
  return { priv: privateKey, pubB64, keyId: passport.keyIdOfRawPubkey(pubB64) };
}
const ID_A = makeIdentity(); // Alfa: public principal
const ID_B = makeIdentity(); // Bravo: private principal
const ID_C = makeIdentity(); // Charlie: no principal
const ID_D = makeIdentity(); // Delta: malformed principal (cosmetic)

const PUBLIC_PRINCIPAL_NAME = "Public Person Alfa";
const PRIVATE_PRINCIPAL_NAME = "Private Person Bravo";

// --- fixture manifest server ---
const manifests = {
  "/alfa/.well-known/muse-protocol.json": {
    muse: { name: "Alfa", principal: { name: PUBLIC_PRINCIPAL_NAME, visibility: "public" } },
    signing_key: { alg: "ed25519", pubkey: ID_A.pubB64 },
  },
  "/bravo/.well-known/muse-protocol.json": {
    muse: { name: "Bravo", principal: { name: PRIVATE_PRINCIPAL_NAME, visibility: "private" } },
    signing_key: { alg: "ed25519", pubkey: ID_B.pubB64 },
  },
  "/charlie/.well-known/muse-protocol.json": {
    muse: { name: "Charlie" },
    signing_key: { alg: "ed25519", pubkey: ID_C.pubB64 },
  },
  "/delta/.well-known/muse-protocol.json": {
    muse: { name: "Delta", principal: "nonsense-not-an-object" },
    signing_key: { alg: "ed25519", pubkey: ID_D.pubB64 },
  },
};
const fixture = http.createServer((req, res) => {
  const p = req.url.split("?")[0];
  const m = manifests[p];
  res.writeHead(m ? 200 : 404, { "Content-Type": "application/json" });
  res.end(JSON.stringify(m || { error: "nope" }));
});

function startLobby(port) {
  return spawn("node", [LOBBY], {
    env: {
      ALLOW_UNVERIFIED: "1",
      ...process.env,
      PORT: String(port),
      MANIFEST_ALLOW_PRIVATE: "1",
      LOBBY_PUBLIC_URL: `http://127.0.0.1:${port}/`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}
function waitForListening(child, port) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server on ${port} did not start`)), 15000);
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
      reject(new Error(`server on ${port} exited with ${c}: ${out}`));
    });
  });
}

// --- attestation signing (the documented client recipe) ---
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
  if (fields.note !== undefined && fields.note !== null) payload.note = fields.note;
  const bytes = Buffer.from(ATTESTATION_PREFIX + passport.canonicalJson(payload), "utf8");
  return { ...payload, signature: crypto.sign(null, bytes, priv).toString("base64") };
}
// Key-only verification: no server state involved (federation-readiness).
function verifyAttestationKeyOnly(att, issuerPubB64) {
  const { signature, ...rest } = att;
  const bytes = Buffer.from(ATTESTATION_PREFIX + passport.canonicalJson(rest), "utf8");
  try {
    return crypto.verify(null, bytes, passport.publicKeyFromRaw(issuerPubB64), Buffer.from(signature, "base64"));
  } catch {
    return false;
  }
}

// --- persistent test client ---
function challengePayload(nonce) {
  return Buffer.from("muse-commons/v1/challenge:" + nonce, "utf8");
}
class Agent {
  constructor(name, ident, manifestPath) {
    this.name = name;
    this.ident = ident; // {priv, pubB64, keyId} or null for unverified
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
        // answer proof-of-control like a genuine client
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
  hello() {
    const msg = { type: "hello", name: this.name, room: "plaza" };
    if (this.manifestPath) msg.manifest_url = `http://127.0.0.1:${FIXTURE_PORT}${this.manifestPath}`;
    return this.sendAndWait(msg, (m) => m.type === "hello_ok" || m.type === "error", 12000)
      .then((m) => {
        if (m.type === "hello_ok") this.agentId = m.agent_id;
        return m;
      });
  }
  send(obj) {
    this.ws.send(JSON.stringify(obj));
  }
  // resolve with the first inbox message matching pred (polls inbox)
  waitFor(pred, timeoutMs = 8000) {
    return new Promise((resolve) => {
      const start = Date.now();
      const tick = () => {
        for (let i = 0; i < this.inbox.length; i++) {
          if (pred(this.inbox[i])) {
            const found = this.inbox.splice(i, 1)[0];
            return resolve(found);
          }
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
  latestState() {
    const states = this.inbox.filter((m) => m.type === "state");
    return states.length ? states[states.length - 1] : null;
  }
  close() {
    try { this.ws.close(); } catch { /* ignore */ }
  }
}

function httpGetJson(port, p) {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}${p}`, (res) => {
      let s = "";
      res.on("data", (c) => (s += c));
      res.on("end", () => {
        try { resolve(JSON.parse(s)); } catch (e) { reject(e); }
      });
    }).on("error", reject);
  });
}

async function main() {
  await new Promise((r) => fixture.listen(FIXTURE_PORT, "127.0.0.1", r));
  const lobby = startLobby(PORT);
  await waitForListening(lobby, PORT);
  const get = (p) => httpGetJson(PORT, p);

  console.log("identity v1: manifest principal parsing");
  const A = new Agent("Alfa", ID_A, "/alfa/.well-known/muse-protocol.json");
  const B = new Agent("Bravo", ID_B, "/bravo/.well-known/muse-protocol.json");
  const C = new Agent("Charlie", ID_C, "/charlie/.well-known/muse-protocol.json");
  const D = new Agent("Delta", ID_D, "/delta/.well-known/muse-protocol.json");
  await A.connect(PORT); await B.connect(PORT); await C.connect(PORT); await D.connect(PORT);
  let r = await A.hello();
  check("Alfa admitted verified", r.type === "hello_ok" && r.verified === "verified", JSON.stringify(r).slice(0, 160));
  r = await B.hello();
  check("Bravo admitted verified", r.type === "hello_ok" && r.verified === "verified");
  r = await C.hello();
  check("Charlie admitted verified", r.type === "hello_ok" && r.verified === "verified");
  r = await D.hello();
  check("malformed principal is cosmetic, Delta admitted", r.type === "hello_ok" && r.verified === "verified", JSON.stringify(r).slice(0, 160));

  // wait for a state that includes everyone
  let st = null;
  for (let i = 0; i < 40 && !st; i++) {
    await new Promise((rr) => setTimeout(rr, 250));
    const s = A.latestState();
    if (s && ["Alfa", "Bravo", "Charlie", "Delta"].every((n) => s.agents.some((a) => a.name === n))) st = s;
  }
  check("state includes all four agents", !!st);
  const entry = (n) => st.agents.find((a) => a.name === n);
  check("public principal in state",
    !!entry("Alfa").principal && entry("Alfa").principal.name === PUBLIC_PRINCIPAL_NAME && entry("Alfa").principal.id === ID_A.keyId,
    JSON.stringify(entry("Alfa").principal));
  check("private principal hidden from state", entry("Bravo").principal === null || entry("Bravo").principal === undefined,
    JSON.stringify(entry("Bravo").principal));
  check("missing principal -> null in state", entry("Charlie").principal == null);
  check("malformed principal -> null in state", entry("Delta").principal == null);

  // private principal name must appear in NO public output
  const places = await get("/api/places");
  const directory = await get("/api/directory");
  const ticker = await get("/api/ticker");
  const presence = await get("/api/presence");
  const profB = await get("/api/muse/Bravo");
  const profA = await get("/api/muse/Alfa");
  const pubBlobs = [JSON.stringify(places), JSON.stringify(directory), JSON.stringify(ticker), JSON.stringify(presence)];
  check("private principal name absent from /api/places", !pubBlobs[0].includes(PRIVATE_PRINCIPAL_NAME));
  check("private principal name absent from /api/directory", !pubBlobs[1].includes(PRIVATE_PRINCIPAL_NAME));
  check("private principal name absent from /api/ticker", !pubBlobs[2].includes(PRIVATE_PRINCIPAL_NAME));
  check("private principal name absent from /api/presence", !pubBlobs[3].includes(PRIVATE_PRINCIPAL_NAME));
  check("private principal null in profile", profB.profile && profB.profile.principal === null,
    JSON.stringify(profB.profile && profB.profile.principal));
  check("public principal in profile",
    profA.profile && profA.profile.principal && profA.profile.principal.name === PUBLIC_PRINCIPAL_NAME && profA.profile.principal.id === ID_A.keyId,
    JSON.stringify(profA.profile && profA.profile.principal));
  check("friends_count omitted by default (friends toggle is private)",
    profA.profile && !("friends_count" in profA.profile),
    JSON.stringify(Object.keys(profA.profile || {})));
  check("affinity starts empty (agent_graph toggle is public)",
    profA.profile && profA.profile.affinity && Object.keys(profA.profile.affinity).length === 0);

  console.log("identity v1: attestations");
  const now = Date.now();
  const mkFriend = (priv, issuer, subject, expOffsetMs, note) =>
    signAttestation(priv, {
      issuer, subject, claim: "friend",
      issued_at: now - 1000, expires_at: now + expOffsetMs, note,
    });

  // hello-required gate
  const noHello = new Agent("NoHello", null, null);
  await noHello.connect(PORT);
  r = await noHello.sendAndWait({ type: "present_attestation", attestation: {} }, (m) => m.type === "error");
  check("present_attestation needs hello", r && r.code === "HELLO_REQUIRED", r && r.code);
  r = await noHello.sendAndWait({ type: "set_affinity", agent_id: "x", target: "y", score: 0 }, (m) => m.type === "error");
  check("set_affinity needs hello", r && r.code === "HELLO_REQUIRED", r && r.code);

  // unverified agents hold no identity key
  const U = new Agent("Unauth", null, null);
  await U.connect(PORT);
  await U.hello();
  const uAtt = mkFriend(ID_A.priv, ID_A.keyId, ID_B.keyId, 3600000);
  r = await U.sendAndWait({ type: "present_attestation", attestation: uAtt }, (m) => m.type === "error");
  check("unverified presenter -> VERIFIED_ONLY", r && r.code === "VERIFIED_ONLY", r && r.code);

  // valid round-trip: Alfa declares Bravo's key as a friend
  const good = mkFriend(ID_A.priv, ID_A.keyId, ID_B.keyId, 3600000, "golf buddies");
  r = await A.sendAndWait({ type: "present_attestation", attestation: good }, (m) => m.type === "attestation_accepted" || m.type === "error", 8000);
  check("valid attestation accepted", r && r.type === "attestation_accepted", JSON.stringify(r).slice(0, 200));
  check("friends_count in ack", r && r.friends_count === 1, r && r.friends_count);
  check("affinity seeded toward Bravo", r && r.affinity_seeded === B.agentId, r && r.affinity_seeded);

  // tampered: flip the subject after signing
  const tampered = { ...mkFriend(ID_A.priv, ID_A.keyId, ID_B.keyId, 3600000), subject: ID_C.keyId };
  r = await A.sendAndWait({ type: "present_attestation", attestation: tampered }, (m) => m.type === "error");
  check("tampered attestation -> ATTESTATION_BAD_SIGNATURE", r && r.code === "ATTESTATION_BAD_SIGNATURE", r && r.code);

  // expired (issued 2h ago, expired 1h ago: shape-valid, past)
  const expired = signAttestation(ID_A.priv, {
    issuer: ID_A.keyId, subject: ID_B.keyId, claim: "friend",
    issued_at: now - 7200000, expires_at: now - 3600000,
  });
  r = await A.sendAndWait({ type: "present_attestation", attestation: expired }, (m) => m.type === "error");
  check("expired attestation -> ATTESTATION_EXPIRED", r && r.code === "ATTESTATION_EXPIRED", r && r.code);

  // wrong issuer: signed by Alfa's key but claims Bravo as issuer
  const wrongIssuer = mkFriend(ID_A.priv, ID_B.keyId, ID_C.keyId, 3600000);
  r = await A.sendAndWait({ type: "present_attestation", attestation: wrongIssuer }, (m) => m.type === "error");
  check("wrong issuer -> ATTESTATION_NOT_SELF", r && r.code === "ATTESTATION_NOT_SELF", r && r.code);

  // reserved claim
  const vouch = mkFriend(ID_A.priv, ID_A.keyId, ID_B.keyId, 3600000);
  vouch.claim = "vouch";
  r = await A.sendAndWait({ type: "present_attestation", attestation: vouch }, (m) => m.type === "error");
  check("reserved vouch claim rejected", r && r.code === "INVALID_MESSAGE", r && r.code);

  console.log("identity v1: private friend edges");
  // friends_count is private by default: absent even after an edge exists
  const profA1b = await get("/api/muse/Alfa");
  check("friends_count still omitted while friends toggle is private",
    profA1b.profile && !("friends_count" in profA1b.profile));
  // opt in, then the count appears (members never do)
  r = await A.sendAndWait({ type: "set_visibility", friends: "public" },
    (m) => m.type === "visibility_updated" || m.type === "error");
  check("set_visibility ack carries effective prefs",
    r && r.type === "visibility_updated" && r.friends === "public" && r.agent_graph === "public",
    JSON.stringify(r).slice(0, 160));
  const profA2 = await get("/api/muse/Alfa");
  check("friends_count incremented", profA2.profile && profA2.profile.friends_count === 1, profA2.profile && profA2.profile.friends_count);
  // the full edge list appears nowhere public
  const st2 = A.latestState();
  const blobs = [
    JSON.stringify(st2), JSON.stringify(await get("/api/places")),
    JSON.stringify(await get("/api/directory")), JSON.stringify(profA2),
  ];
  const edgeLeaked = blobs.some((b) => b.includes(ID_B.keyId));
  check("friend edge (subject key id) appears in no public output", !edgeLeaked);

  console.log("identity v1: affinity ledger");
  // seeding from the accepted attestation above
  const profA3 = await get("/api/muse/Alfa");
  const seeded = profA3.profile && profA3.profile.affinity && profA3.profile.affinity[B.agentId];
  check("seeded +0.5 our-humans-are-friends", seeded && seeded.score === 0.5 && seeded.note === "our humans are friends",
    JSON.stringify(seeded));

  // agent writes its own ledger
  r = await A.sendAndWait(
    { type: "set_affinity", agent_id: A.agentId, target: B.agentId, score: 0.8, note: "Bravo is funny, seek out" },
    (m) => m.type === "affinity_updated" || m.type === "error");
  check("set_affinity ack", r && r.type === "affinity_updated" && r.score === 0.8, JSON.stringify(r).slice(0, 160));
  const profA4 = await get("/api/muse/Alfa");
  const aff = profA4.profile && profA4.profile.affinity && profA4.profile.affinity[B.agentId];
  check("affinity round-trips through profile", aff && aff.score === 0.8 && aff.note === "Bravo is funny, seek out",
    JSON.stringify(aff));

  // a second attestation must not overwrite the agent's own experience
  const good2 = mkFriend(ID_A.priv, ID_A.keyId, ID_B.keyId, 3600000);
  r = await A.sendAndWait({ type: "present_attestation", attestation: good2 }, (m) => m.type === "attestation_accepted" || m.type === "error");
  check("second attestation still accepted", r && r.type === "attestation_accepted");
  check("no reseed over existing entry", r && r.affinity_seeded === null, JSON.stringify(r && r.affinity_seeded));
  const profA5 = await get("/api/muse/Alfa");
  const aff2 = profA5.profile.affinity[B.agentId];
  check("agent's own score survives", aff2 && aff2.score === 0.8, JSON.stringify(aff2));

  // self-only writes: Bravo tries to write Alfa's ledger
  r = await B.sendAndWait(
    { type: "set_affinity", agent_id: A.agentId, target: C.agentId, score: -1 },
    (m) => m.type === "error");
  check("second agent writing first agent's ledger -> AFFINITY_INVALID", r && r.code === "AFFINITY_INVALID", r && r.code);

  // invalid scores / targets
  r = await A.sendAndWait({ type: "set_affinity", agent_id: A.agentId, target: B.agentId, score: 2 }, (m) => m.type === "error");
  check("score > 1 rejected", r && r.code === "AFFINITY_INVALID", r && r.code);
  r = await A.sendAndWait({ type: "set_affinity", agent_id: A.agentId, target: B.agentId, score: "high" }, (m) => m.type === "error");
  check("non-numeric score rejected", r && r.code === "AFFINITY_INVALID", r && r.code);
  r = await A.sendAndWait({ type: "set_affinity", agent_id: A.agentId, target: A.agentId, score: 1 }, (m) => m.type === "error");
  check("self-target rejected", r && r.code === "AFFINITY_INVALID", r && r.code);

  console.log("identity v1: federation-readiness (key-only verification)");
  const indep = mkFriend(ID_B.priv, ID_B.keyId, ID_A.keyId, 3600000);
  check("attestation verifies against the key alone, no registry",
    verifyAttestationKeyOnly(indep, ID_B.pubB64) === true);
  check("key-only verification fails for the wrong key",
    verifyAttestationKeyOnly(indep, ID_A.pubB64) === false);

  // cleanup
  for (const c of [A, B, C, D, U, noHello]) c.close();
  await new Promise((r2) => setTimeout(r2, 300));
  fixture.close();
  lobby.kill("SIGTERM");
  await new Promise((r2) => setTimeout(r2, 500));

  console.log(failures === 0 ? "\nidentity v1: all tests passed" : `\nidentity v1: ${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
