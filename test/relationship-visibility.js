// Relationship visibility tests: the two independent visibility
// toggles (friends, agent_graph) and their enforcement in profiles.
//
// Spawns a local lobby plus a fixture manifest server and exercises
// set_visibility over WebSocket: defaults (friends private,
// agent_graph public), independent toggling, invalid values rejected,
// unverified senders rejected, buildProfile omitting private fields
// entirely (never null/placeholder), and persistence in relations.json.
//
//   node test/relationship-visibility.js
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
const profiles = require(path.join(REPO, "server", "profiles.js"));
const PORT = 18841;
const FIXTURE_PORT = 18840;
const RELATIONS_FILE = path.join(REPO, "data", "relations.json");

// Fresh relations file so reruns are deterministic.
try {
  fs.rmSync(RELATIONS_FILE, { force: true });
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

function makeIdentity() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const pubB64 = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url").toString("base64");
  return { priv: privateKey, pubB64, keyId: passport.keyIdOfRawPubkey(pubB64) };
}
const ID_A = makeIdentity(); // Alfa
const ID_B = makeIdentity(); // Bravo

const manifests = {
  "/alfa/.well-known/muse-protocol.json": {
    muse: { name: "Alfa", principal: { name: "Public Person Alfa", visibility: "public" } },
    signing_key: { alg: "ed25519", pubkey: ID_A.pubB64 },
  },
  "/bravo/.well-known/muse-protocol.json": {
    muse: { name: "Bravo", principal: { name: "Private Person Bravo", visibility: "private" } },
    signing_key: { alg: "ed25519", pubkey: ID_B.pubB64 },
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
  close() {
    try { this.ws.close(); } catch { /* ignore */ }
  }
}

function httpGet(port, p) {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}${p}`, (res) => {
      let s = "";
      res.on("data", (c) => (s += c));
      res.on("end", () => resolve({ status: res.statusCode, body: s }));
    }).on("error", reject);
  });
}

async function main() {
  await new Promise((r) => fixture.listen(FIXTURE_PORT, "127.0.0.1", r));
  const lobby = startLobby(PORT);
  await waitForListening(lobby, PORT);
  const get = (p) => httpGet(PORT, p);

  console.log("visibility: admission and defaults");
  const A = new Agent("Alfa", ID_A, "/alfa/.well-known/muse-protocol.json");
  const B = new Agent("Bravo", ID_B, "/bravo/.well-known/muse-protocol.json");
  await A.connect(PORT); await B.connect(PORT);
  let r = await A.hello();
  check("Alfa admitted verified", r.type === "hello_ok" && r.verified === "verified");
  r = await B.hello();
  check("Bravo admitted verified", r.type === "hello_ok" && r.verified === "verified");

  const prof = async (name) => JSON.parse((await get(`/api/muse/${name}`)).body).profile;
  const p0 = await prof("Alfa");
  check("friends_count omitted by default", p0 && !("friends_count" in p0), JSON.stringify(Object.keys(p0 || {})));
  check("affinity present by default (empty)", p0 && p0.affinity && Object.keys(p0.affinity).length === 0);

  console.log("visibility: hello gate");
  const noHello = new Agent("NoHello", null, null);
  await noHello.connect(PORT);
  r = await noHello.sendAndWait({ type: "set_visibility", friends: "public" }, (m) => m.type === "error");
  check("set_visibility needs hello", r && r.code === "HELLO_REQUIRED", r && r.code);

  console.log("visibility: verified-only gate");
  const U = new Agent("Unauth", null, null);
  await U.connect(PORT);
  await U.hello();
  r = await U.sendAndWait({ type: "set_visibility", friends: "public" }, (m) => m.type === "error");
  check("unverified sender -> VERIFIED_ONLY", r && r.code === "VERIFIED_ONLY", r && r.code);

  console.log("visibility: independent toggles");
  // seed an affinity entry so the agent_graph toggle has something to gate
  r = await A.sendAndWait(
    { type: "set_affinity", agent_id: A.agentId, target: B.agentId, score: 0.8, note: "good talker" },
    (m) => m.type === "affinity_updated" || m.type === "error");
  check("affinity seeded for the toggle test", r && r.type === "affinity_updated");

  // friends -> public: only friends_count appears
  r = await A.sendAndWait({ type: "set_visibility", friends: "public" },
    (m) => m.type === "visibility_updated" || m.type === "error");
  check("set_visibility ack", r && r.type === "visibility_updated" && r.friends === "public" && r.agent_graph === "public",
    JSON.stringify(r).slice(0, 160));
  let p1 = await prof("Alfa");
  check("friends_count appears when friends is public", p1 && p1.friends_count === 0, p1 && p1.friends_count);
  check("affinity still present", p1 && p1.affinity && p1.affinity[B.agentId] && p1.affinity[B.agentId].score === 0.8);

  // agent_graph -> private: only affinity disappears
  r = await A.sendAndWait({ type: "set_visibility", agent_graph: "private" },
    (m) => m.type === "visibility_updated" || m.type === "error");
  check("agent_graph ack", r && r.type === "visibility_updated" && r.agent_graph === "private" && r.friends === "public");
  let p2 = await prof("Alfa");
  check("friends_count still present", p2 && p2.friends_count === 0);
  check("affinity omitted when agent_graph is private", p2 && !("affinity" in p2), JSON.stringify(Object.keys(p2 || {})));

  // friends -> private again: both gone, independently
  r = await A.sendAndWait({ type: "set_visibility", friends: "private" },
    (m) => m.type === "visibility_updated" || m.type === "error");
  check("friends ack", r && r.type === "visibility_updated" && r.friends === "private");
  let p3 = await prof("Alfa");
  check("friends_count omitted again", p3 && !("friends_count" in p3));
  check("affinity still omitted", p3 && !("affinity" in p3));

  // back to agent_graph public only: affinity returns, friends_count stays hidden
  r = await A.sendAndWait({ type: "set_visibility", agent_graph: "public" },
    (m) => m.type === "visibility_updated" || m.type === "error");
  let p4 = await prof("Alfa");
  check("affinity returns when agent_graph is public", p4 && p4.affinity && p4.affinity[B.agentId]);
  check("friends_count stays hidden", p4 && !("friends_count" in p4));

  // one agent's toggles never touch another's
  const pB = await prof("Bravo");
  check("Bravo unaffected: friends_count still omitted", pB && !("friends_count" in pB));
  check("Bravo unaffected: affinity present", pB && pB.affinity && typeof pB.affinity === "object");

  console.log("visibility: invalid values");
  r = await A.sendAndWait({ type: "set_visibility", friends: "everyone" }, (m) => m.type === "error");
  check("bad friends value -> VISIBILITY_INVALID", r && r.code === "VISIBILITY_INVALID", r && r.code);
  r = await A.sendAndWait({ type: "set_visibility", agent_graph: 123 }, (m) => m.type === "error");
  check("non-string agent_graph -> VISIBILITY_INVALID", r && r.code === "VISIBILITY_INVALID", r && r.code);
  r = await A.sendAndWait({ type: "set_visibility" }, (m) => m.type === "error");
  check("empty set_visibility -> VISIBILITY_INVALID", r && r.code === "VISIBILITY_INVALID", r && r.code);
  // prefs unchanged after rejections
  const p5 = await prof("Alfa");
  check("rejections leave prefs alone", p5 && !("friends_count" in p5) && p5.affinity && p5.affinity[B.agentId]);

  console.log("visibility: private data in no public output");
  const blobs = [
    (await get("/api/places")).body,
    (await get("/api/directory")).body,
    (await get("/api/ticker")).body,
    (await get("/api/presence")).body,
    (await get("/muse/Alfa")).body, // standalone profile page
  ];
  check("no friends_count field anywhere public while private",
    !blobs.some((b) => b.includes("friends_count")));
  // flip agent_graph private and confirm the affinity note leaves all public surfaces
  await A.sendAndWait({ type: "set_visibility", agent_graph: "private" },
    (m) => m.type === "visibility_updated");
  const blobs2 = [
    (await get("/api/places")).body,
    (await get("/api/directory")).body,
    (await get("/api/ticker")).body,
    JSON.stringify(await prof("Alfa")),
    (await get("/muse/Alfa")).body,
  ];
  check("affinity note in no public output while private", !blobs2.some((b) => b.includes("good talker")));
  check("profile page has no affinity section while private", !(await get("/muse/Alfa")).body.includes("Relationship graph"));

  console.log("visibility: persistence");
  const doc = JSON.parse(fs.readFileSync(RELATIONS_FILE, "utf8"));
  check("visibility persisted to relations.json",
    doc.visibility && doc.visibility[A.agentId] && doc.visibility[A.agentId].agent_graph === "private",
    JSON.stringify(doc.visibility));

  console.log("visibility: unit checks (pure helpers)");
  check("unit: defaults",
    JSON.stringify(profiles.effectiveVisibility(new Map(), "x")) ===
    JSON.stringify({ friends: "private", agent_graph: "public" }));
  check("unit: public friends",
    profiles.effectiveVisibility(new Map([["x", { friends: "public" }]]), "x").friends === "public");
  check("unit: private graph",
    profiles.effectiveVisibility(new Map([["x", { agent_graph: "private" }]]), "x").agent_graph === "private");
  check("unit: garbage values fail closed",
    JSON.stringify(profiles.effectiveVisibility(new Map([["x", { friends: "everyone", agent_graph: 7 }]]), "x")) ===
    JSON.stringify({ friends: "private", agent_graph: "public" }));
  const relPub = profiles.renderRelationships({
    name: "X", verified: "verified", principal: { name: "Ada", id: "k" },
    friends_count: 1, affinity: { bob: { score: 0.8, note: "fun", updated_at: 1 } },
  });
  check("unit: relationships section renders disclosed fields",
    relPub.includes("Relationships") && relPub.includes("Ada") && relPub.includes("1 friend") && relPub.includes("bob"));
  const relNone = profiles.renderRelationships({ name: "X", verified: "unverified", principal: null });
  check("unit: relationships section empty when nothing disclosed", relNone === "");
  const affHtml = profiles.renderAffinityList({
    bob: { score: 0.8, note: "fun", updated_at: 1 },
    sue: { score: -0.6, note: "", updated_at: 1 },
  });
  check("unit: affinity list renders rows with signed scores",
    affHtml.includes("bob") && affHtml.includes("+0.8") && affHtml.includes("sue") && affHtml.includes("-0.6"));
  const pageBase = {
    name: "X", verified: "unverified", trust_tier: "new", principal: null, avatar: {},
    online: false, last_seen_t: 1, rooms: [], highlights: [], custom: null, reputation: null,
  };
  const page = profiles.renderProfilePage(pageBase);
  check("unit: profile page omits private sections",
    !page.includes("friends_count") && !page.includes("Relationship graph"));
  const pagePub = profiles.renderProfilePage({
    ...pageBase, verified: "verified", principal: { name: "Ada", id: "k" },
    friends_count: 1, affinity: { bob: { score: 0.8, note: "", updated_at: 1 } },
  });
  check("unit: profile page renders public sections",
    pagePub.includes("1 friend") && pagePub.includes("Relationship graph") && pagePub.includes("Ada"));

  // cleanup
  for (const c of [A, B, U, noHello]) c.close();
  await new Promise((r2) => setTimeout(r2, 300));
  fixture.close();
  lobby.kill("SIGTERM");
  await new Promise((r2) => setTimeout(r2, 500));

  console.log(failures === 0 ? "\nvisibility: all tests passed" : `\nvisibility: ${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
