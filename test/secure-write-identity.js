// PR #2 secure write identity tests.
//
// Spawns a real lobby server child plus a fixture manifest server and
// exercises the proof-of-control + session-token contract over WebSocket:
// impersonation resistance, verified-name takeover resistance, scope
// denial, token binding/expiry semantics, and challenge failure modes.
//
//   node test/secure-write-identity.js
//
// Exit 0 = all pass, 1 = any failure.
const http = require("http");
const { spawn } = require("child_process");
const path = require("path");
const crypto = require("crypto");
const WebSocket = require("ws");

const REPO = path.join(__dirname, "..");
const LOBBY = path.join(REPO, "server", "lobby.js");
const PORT = 18791;
const FIXTURE_PORT = 18790;

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
}

// --- fixture identity: a real Ed25519 keypair for the verified muse ---
const { privateKey: FIX_PRIV, publicKey: FIX_PUB } = crypto.generateKeyPairSync("ed25519");
const FIX_PUB_B64 = Buffer.from(FIX_PUB.export({ format: "jwk" }).x, "base64url").toString("base64");
const FIXTURE_MANIFEST_URL = `http://127.0.0.1:${FIXTURE_PORT}/.well-known/muse-protocol.json`;
const fixture = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      muse: { name: "RealMuse", serves: "Tester" },
      signing_key: { alg: "ed25519", key_id: "fixture-1", pubkey: FIX_PUB_B64 },
    })
  );
});
function signNonce(nonce, key = FIX_PRIV) {
  return crypto.sign(null, Buffer.from("muse-commons/v1/challenge:" + nonce, "utf8"), key).toString("base64");
}

function startLobby() {
  return spawn("node", [LOBBY], {
    env: {
      ALLOW_UNVERIFIED: "1",
      ...process.env,
      PORT: String(PORT),
      LOBBY_PUBLIC_URL: `http://127.0.0.1:${PORT}/`,
      MANIFEST_ALLOW_PRIVATE: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function waitForListening(child) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("server did not start")), 15000);
    const onData = (d) => {
      if (d.toString().includes("listening")) {
        clearTimeout(timer);
        child.stdout.off("data", onData);
        resolve();
      }
    };
    child.stdout.on("data", onData);
    child.on("exit", (c) => reject(new Error(`server exited with ${c}`)));
  });
}

// Connect, optionally answer challenges (signer: fn(nonce)->base64 sig or null
// to not answer), resolve with a handle once hello_ok arrives (or an error).
function connect(opts = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    const rec = { ws, msgs: [], helloOk: null, error: null };
    const timer = setTimeout(() => reject(new Error("connect timeout")), 15000);
    ws.on("open", () => ws.send(JSON.stringify({ type: "hello", ...opts.hello })));
    ws.on("message", (raw) => {
      let m;
      try {
        m = JSON.parse(raw);
      } catch {
        return;
      }
      rec.msgs.push(m);
      if (m.type === "challenge" && opts.signer) {
        const sig = opts.signer(m.nonce);
        if (sig) ws.send(JSON.stringify({ type: "challenge_response", challenge_id: m.challenge_id, signature: sig }));
        return;
      }
      if (m.type === "hello_ok" && !rec.helloOk) {
        rec.helloOk = m;
        clearTimeout(timer);
        resolve(rec);
      }
      if (m.type === "error" && !rec.helloOk && !rec.error) {
        rec.error = m;
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
        rec.ws.removeListener("message", onMsg);
        resolve(m);
      }
    };
    rec.ws.on("message", onMsg);
  });
}

function lastStateAgent(rec, name) {
  const states = rec.msgs.filter((m) => m.type === "state");
  for (let i = states.length - 1; i >= 0; i--) {
    const a = (states[i].agents || []).find((x) => x.name === name);
    if (a) return a;
  }
  return null;
}

async function main() {
  await new Promise((r) => fixture.listen(FIXTURE_PORT, "127.0.0.1", r));
  const server = startLobby();
  await waitForListening(server);

  console.log("impersonation resistance");
  // v1 client B tries to speak as A: the server stamps the session identity
  // and ignores the forged `from`.
  const alice = await connect({ hello: { name: "AliceMuse", protocol_version: "1.0" } });
  check("v1 hello admitted", !!alice.helloOk);
  check("v1 hello_ok carries session_token", !!alice.helloOk.session_token);
  const bob = await connect({ hello: { name: "EvilMuse", protocol_version: "1.0" } });
  bob.ws.send(
    JSON.stringify({
      type: "say",
      from: "AliceMuse", // forged: must be ignored
      text: "i am alice now",
      session_token: bob.helloOk.session_token,
    })
  );
  const forged = await waitFor(
    alice,
    (m) => m.type === "state" && (m.agents || []).some((a) => (a.bubble || "").includes("i am alice now")),
    8000
  );
  const speaker = forged && forged.agents.find((a) => (a.bubble || "").includes("i am alice now"));
  check("forged say attributed to the session identity", !!speaker && speaker.name === "EvilMuse", speaker && speaker.name);
  const aliceEntry = forged && forged.agents.find((a) => a.name === "AliceMuse");
  check("real Alice entry untouched by the forgery", !!aliceEntry && !(aliceEntry.bubble || "").includes("i am alice now"));

  console.log("verified name takeover resistance");
  // The verified muse proves control; an unverified claimant of the same
  // display name gets a separate unverified session — never the badge,
  // never the verified entry.
  const real = await connect({
    hello: { name: "whoever", protocol_version: "1.0", manifest_url: FIXTURE_MANIFEST_URL },
    signer: (n) => signNonce(n),
  });
  check("verified hello admitted", !!real.helloOk && real.helloOk.verified === "verified");
  const realId = real.helloOk.agent_id;
  check("verified id uses the v1 namespace", /^a-v-[0-9a-f]{12}$/.test(realId || ""), realId);
  const squatter = await connect({ hello: { name: "RealMuse", protocol_version: "1.0" } });
  check("unverified claimant admitted as unverified", !!squatter.helloOk && squatter.helloOk.verified === "unverified");
  check("squatter gets a different session id", !!squatter.helloOk && squatter.helloOk.agent_id !== realId);
  // let a few state broadcasts land, then inspect both entries
  await new Promise((r) => setTimeout(r, 2500));
  const st = squatter.msgs.filter((m) => m.type === "state").pop();
  const entries = (st.agents || []).filter((a) => a.name === "RealMuse");
  check("two distinct entries share the display name", entries.length === 2, entries.length);
  const verifiedEntry = entries.find((a) => a.id === realId);
  check("verified entry keeps its badge", !!verifiedEntry && verifiedEntry.verified === "verified");
  check(
    "squatter entry has no badge",
    entries.some((a) => a.id !== realId && a.verified === "unverified")
  );

  console.log("scope denial");
  // A v1 session with only the speak scope cannot post (needs board).
  const narrow = await connect({ hello: { name: "NarrowMuse", protocol_version: "1.0", scopes: ["speak"] } });
  check("narrow hello admitted", !!narrow.helloOk);
  narrow.ws.send(
    JSON.stringify({
      type: "post",
      kind: "offer",
      topics: ["x"],
      title: "should fail",
      session_token: narrow.helloOk.session_token,
    })
  );
  const denied = await waitFor(
    narrow,
    (m) => m.type === "error" && m.code === "INSUFFICIENT_SCOPE"
  );
  check("out-of-scope write denied with INSUFFICIENT_SCOPE", !!denied);
  check("denial names the missing scope", !!denied && /board/.test(denied.message || ""), denied && denied.message);

  console.log("token requirement and binding");
  // v1 write without any token -> SESSION_TOKEN_REQUIRED
  const noTok = await connect({ hello: { name: "NoTokMuse", protocol_version: "1.0" } });
  noTok.ws.send(JSON.stringify({ type: "say", text: "no token here" }));
  const req = await waitFor(noTok, (m) => m.type === "error" && m.code === "SESSION_TOKEN_REQUIRED");
  check("v1 write without token -> SESSION_TOKEN_REQUIRED", !!req);
  // garbage token -> SESSION_TOKEN_INVALID
  noTok.ws.send(JSON.stringify({ type: "say", text: "garbage", session_token: "t-not-a-real-token" }));
  const bad = await waitFor(noTok, (m) => m.type === "error" && m.code === "SESSION_TOKEN_INVALID");
  check("garbage token -> SESSION_TOKEN_INVALID", !!bad);
  // token replayed on a different socket -> SESSION_TOKEN_INVALID (socket-bound)
  const thief = await connect({ hello: { name: "ThiefMuse", protocol_version: "1.0" } });
  thief.ws.send(JSON.stringify({ type: "say", text: "stolen", session_token: noTok.helloOk.session_token }));
  const stolen = await waitFor(thief, (m) => m.type === "error" && m.code === "SESSION_TOKEN_INVALID");
  check("cross-socket token replay -> SESSION_TOKEN_INVALID", !!stolen);
  // pre-hello write with no identity claims: ignored without killing the
  // socket (legacy leniency for malformed input — never a silent kill)
  const raw = new WebSocket(`ws://127.0.0.1:${PORT}`);
  const preHello = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ survived: raw.readyState === 1 }), 2500);
    raw.on("open", () => raw.send(JSON.stringify({ type: "say", text: "too early" })));
    raw.on("message", (d) => {
      const m = JSON.parse(d.toString());
      if (m.type === "error" && /HELLO|SESSION_TOKEN/.test(m.code || "")) {
        clearTimeout(timer);
        resolve({ rejected: m.code });
      }
    });
    raw.on("close", () => {
      clearTimeout(timer);
      resolve({ closed: true });
    });
  });
  check(
    "pre-hello say ignored, socket survives",
    !!preHello.survived,
    JSON.stringify(preHello)
  );
  raw.close();

  console.log("challenge failure modes");
  // wrong signature -> PROOF_OF_CONTROL_FAILED
  const wrongKey = crypto.generateKeyPairSync("ed25519").privateKey;
  const liar = await connect({
    hello: { name: "x", protocol_version: "1.0", manifest_url: FIXTURE_MANIFEST_URL },
    signer: (n) => signNonce(n, wrongKey),
  });
  check(
    "bad signature -> PROOF_OF_CONTROL_FAILED",
    !!liar.error && liar.error.code === "PROOF_OF_CONTROL_FAILED",
    liar.error && liar.error.code
  );
  liar.ws.close();
  // answer with an unknown challenge id -> CHALLENGE_UNKNOWN
  const unk = await new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    const timer = setTimeout(() => resolve(null), 12000);
    ws.on("open", () => ws.send(JSON.stringify({ type: "hello", name: "y", manifest_url: FIXTURE_MANIFEST_URL })));
    ws.on("message", (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === "challenge") {
        ws.send(JSON.stringify({ type: "challenge_response", challenge_id: "ch-nope", signature: "AAAA" }));
      }
      if (m.type === "error") {
        clearTimeout(timer);
        ws.close();
        resolve(m);
      }
    });
  });
  check("unknown challenge id -> CHALLENGE_UNKNOWN", !!unk && unk.code === "CHALLENGE_UNKNOWN", unk && unk.code);

  for (const c of [alice, bob, real, squatter, narrow, noTok, thief]) c.ws.close();
  server.kill();
  fixture.close();
  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error("test harness error:", e);
  process.exit(1);
});
