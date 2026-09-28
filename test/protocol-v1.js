// Protocol v1 contract tests (roadmap PR #1):
//   1. every server message carries a unique msg_id
//   2. idempotent retries don't double-apply (say + post)
//   3. version mismatch is rejected cleanly with a structured error
//   4. rate limits trigger structured errors (not silent drops)
//
// Also unit-tests the protocol-v1 module (RateLimiter, IdempotencyStore,
// error payloads, version normalization).
//
// Spawns a real lobby server child.
//   node test/protocol-v1.js
// Exit 0 = all pass, 1 = any failure.
const http = require("http");
const { spawn } = require("child_process");
const path = require("path");
const WebSocket = require("ws");

const REPO = path.join(__dirname, "..");
const LOBBY = path.join(REPO, "server", "lobby.js");
const PROTO = require(path.join(REPO, "server", "protocol-v1.js"));
const PORT = 18793;

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
  return new Promise((resolve, reject) => {
    const child = spawn("node", [LOBBY], {
      env: { ...process.env, PORT: String(PORT), HEARTBEAT_TIMEOUT_MS: "600000" },
      cwd: REPO,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    const timer = setTimeout(() => reject(new Error("lobby did not start: " + out)), 15000);
    child.stdout.on("data", (d) => {
      out += d.toString();
      if (out.includes("listening")) {
        clearTimeout(timer);
        resolve(child);
      }
    });
    child.stderr.on("data", (d) => { out += d.toString(); });
    child.on("exit", (c) => reject(new Error("lobby exited " + c + ": " + out)));
  });
}

function getJSON(pathname) {
  return new Promise((resolve, reject) => {
    http.get({ host: "localhost", port: PORT, path: pathname }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(e); }
      });
    }).on("error", reject);
  });
}

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/`);
    const timer = setTimeout(() => reject(new Error("ws connect timeout")), 10000);
    ws.on("open", () => { clearTimeout(timer); resolve(ws); });
    ws.on("error", reject);
  });
}

function hello(ws, extra) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("hello timeout")), 10000);
    const onMsg = (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === "hello_ok" || (m.type === "error" && m.code)) {
        clearTimeout(timer);
        ws.removeListener("message", onMsg);
        resolve(m);
      }
    };
    ws.on("message", onMsg);
    ws.send(JSON.stringify({ type: "hello", name: T("ProtoBot"), ...extra }));
  });
}

// --- unit tests: protocol-v1 module (no server needed) ---

async function unitTests() {
  console.log("unit: protocol-v1 module");
  check("normalizeVersion accepts 1.0", PROTO.normalizeVersion("1.0") === "1.0");
  check("normalizeVersion accepts 1", PROTO.normalizeVersion("1") === "1.0");
  check("normalizeVersion rejects 2.0", PROTO.normalizeVersion("2.0") === null);
  check("normalizeVersion rejects garbage", PROTO.normalizeVersion("abc") === null);
  check("normalizeVersion rejects non-string", PROTO.normalizeVersion(1) === null);

  const ids = new Set();
  for (let i = 0; i < 1000; i++) ids.add(PROTO.newMsgId());
  check("newMsgId unique over 1000", ids.size === 1000);

  const err = PROTO.errorPayload("RATE_LIMITED", { detail: "x", msgId: "c1", retryAfterMs: 500 });
  check("error payload has code", err.type === "error" && err.code === "RATE_LIMITED");
  check("error payload has message", typeof err.message === "string" && err.message.length > 0);
  check("error payload has hint", typeof err.hint === "string" && err.hint.length > 0);
  check("error payload echoes in_reply_to", err.in_reply_to === "c1");
  check("error payload carries retry_after_ms", err.retry_after_ms === 500);
  check(
    "no hint advises weakening verification",
    !Object.values(PROTO.ERRORS).some((e) => {
      // strip negated clauses ("do not ...", "don't ...", "never ...") first:
      // only affirmative advice to weaken counts
      const stripped = e.hint
        .replace(/do not [^.]+/gi, "")
        .replace(/don't [^.]+/gi, "")
        .replace(/never [^.]+/gi, "");
      return /disable|weaken|bypass/i.test(stripped);
    })
  );

  const rl = new PROTO.RateLimiter(3, 1000);
  const t0 = Date.now();
  check("rate limiter allows up to max", rl.check(t0).ok && rl.check(t0).ok && rl.check(t0).ok);
  const over = rl.check(t0);
  check("rate limiter rejects over max", !over.ok && over.retryAfterMs > 0);
  check("rate limiter recovers after window", rl.check(t0 + 1001).ok);

  const store = new PROTO.IdempotencyStore(500, 10);
  check("idempotency miss returns undefined", store.get("k") === undefined);
  store.set("k", { type: "say_ok" });
  check("idempotency hit returns response", store.get("k").type === "say_ok");
  await new Promise((r) => setTimeout(r, 600));
  check("idempotency entry expires", store.get("k") === undefined);
}

// --- integration tests against a live server ---

async function msgIdTest() {
  console.log("integration: message ids");
  const ws = await connect();
  const seen = [];
  ws.on("message", (raw) => {
    try { seen.push(JSON.parse(raw.toString())); } catch { /* ignore */ }
  });
  await hello(ws, { protocol_version: "1.0", msg_id: "hello-1" });
  ws.send(JSON.stringify({ type: "say", from: T("ProtoBot"), text: "id-test", msg_id: "say-1" }));
  await new Promise((r) => setTimeout(r, 1200)); // let state ticks arrive
  ws.close();
  const withId = seen.filter((m) => typeof m.msg_id === "string" && m.msg_id);
  check("all sampled messages carry msg_id", withId.length === seen.length && seen.length > 5, `saw ${seen.length}`);
  check("msg_ids are unique", new Set(withId.map((m) => m.msg_id)).size === withId.length);
}

async function idempotencyTest() {
  console.log("integration: idempotency");
  const ws = await connect();
  const inbox = [];
  ws.on("message", (raw) => {
    try { inbox.push(JSON.parse(raw.toString())); } catch { /* ignore */ }
  });
  await hello(ws, { protocol_version: "1.0" });

  // say, twice with the same key
  const text = T("idem-say");
  const key = T("key-say");
  ws.send(JSON.stringify({ type: "say", from: T("ProtoBot"), text, idempotency_key: key }));
  ws.send(JSON.stringify({ type: "say", from: T("ProtoBot"), text, idempotency_key: key }));
  await new Promise((r) => setTimeout(r, 800));
  const acks = inbox.filter((m) => m.type === "say_ok");
  check("both says acked", acks.length === 2, `got ${acks.length}`);
  check("replay flagged deduplicated", acks.length === 2 && acks[1].deduplicated === true);
  check("replay echoes same ack shape", acks.length === 2 && acks[0].room_id === acks[1].room_id);

  const ticker = await getJSON("/api/ticker");
  const hits = ticker.events.filter((e) => e.text === text).length;
  check("say applied exactly once", hits === 1, `ticker shows ${hits}`);

  // post, twice with the same key — must not create two board posts
  const title = T("idem-post");
  const pkey = T("key-post");
  const postMsg = {
    type: "post", kind: "want", topics: [T("topic")], title,
    details: "idempotency probe", idempotency_key: pkey,
  };
  ws.send(JSON.stringify(postMsg));
  ws.send(JSON.stringify(postMsg));
  await new Promise((r) => setTimeout(r, 800));
  const postAcks = inbox.filter((m) => m.type === "post_ok");
  check("both posts acked", postAcks.length === 2, `got ${postAcks.length}`);
  check(
    "post replay deduplicated with same id",
    postAcks.length === 2 && postAcks[1].deduplicated === true && postAcks[0].id === postAcks[1].id
  );
  const board = await getJSON("/api/board");
  // /api/board lists active posts only (publicPost drops the status field)
  const posts = board.posts.filter((p) => p.title === title).length;
  check("post applied exactly once", posts === 1, `board shows ${posts}`);
  // cleanup: close the probe post
  if (postAcks.length) {
    ws.send(JSON.stringify({ type: "close_post", id: postAcks[0].id }));
    await new Promise((r) => setTimeout(r, 500));
  }
  ws.close();
}

async function versionTest() {
  console.log("integration: version negotiation");
  // unsupported version -> clean structured rejection, no admission
  const bad = await connect();
  const badRes = await hello(bad, { protocol_version: "99.0", msg_id: "vbad" });
  check("unsupported version rejected", badRes.type === "error");
  check("rejection has code", badRes.code === "VERSION_UNSUPPORTED", `got ${badRes.code}`);
  check("rejection has hint", typeof badRes.hint === "string" && badRes.hint.length > 0);
  check("rejection correlates msg_id", badRes.in_reply_to === "vbad");
  check("no admission after rejection", badRes.type !== "hello_ok");
  bad.close();

  // supported version -> hello_ok stamps the negotiated version
  const good = await connect();
  const goodRes = await hello(good, { protocol_version: "1.0" });
  check("supported version admitted", goodRes.type === "hello_ok");
  check("hello_ok stamps protocol_version", goodRes.protocol_version === "1.0");
  good.close();

  // legacy client (no version) -> still admitted
  const legacy = await connect();
  const legacyRes = await hello(legacy, {});
  check("legacy hello still admitted", legacyRes.type === "hello_ok");
  legacy.close();
}

async function rateLimitTest() {
  console.log("integration: rate limits");
  const ws = await connect();
  const errors = [];
  let closed = false;
  ws.on("message", (raw) => {
    try {
      const m = JSON.parse(raw.toString());
      if (m.type === "error" && m.code === "RATE_LIMITED") errors.push(m);
    } catch { /* ignore */ }
  });
  ws.on("close", () => { closed = true; });
  await hello(ws, {});
  // write bucket is 30/10s: 40 rapid says must trip it
  for (let i = 0; i < 40; i++) {
    ws.send(JSON.stringify({ type: "say", from: T("FloodBot"), text: `flood-${i}` }));
  }
  await new Promise((r) => setTimeout(r, 1000));
  check("rate limit produced structured errors", errors.length > 0, `got ${errors.length}`);
  check(
    "rate limit errors are actionable",
    errors.every((e) => e.code === "RATE_LIMITED" && e.hint && typeof e.retry_after_ms === "number")
  );
  check("socket stays open after rate limit (no silent kill)", !closed && ws.readyState === 1);
  ws.close();
}

(async () => {
  try {
    await unitTests();
    const child = startLobby();
    const server = await child;
    try {
      await msgIdTest();
      await idempotencyTest();
      await versionTest();
      await rateLimitTest();
    } finally {
      server.kill();
    }
  } catch (e) {
    failures++;
    console.log("  FAIL harness — " + (e && e.message));
  }
  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
})();
