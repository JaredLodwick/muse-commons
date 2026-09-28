// Launch instrumentation tests (PR #10).
//
//  1. metrics module unit: rollup correctness, day rollover, newAgents only
//     for stable ids, private rooms collapse to one bucket, persistence.
//  2. host-only get_metrics: host gets release aggregates + daily rollups;
//     non-host gets HOST_ONLY.
//  3. event counting: joins, messages per public room, private aggregate,
//     reports, quarantine/release, incident toggles, skill fetches,
//     conformance passes.
//  4. privacy: host summary and /api/health carry no message bodies, no
//     names, no private-room ids.
//  5. persistence: metrics survive a server restart.
//
// Spawns real lobby children on test ports against a LOCAL lobby only.
// Backs up data/metrics.json and restores it afterwards.
//   node test/launch-metrics.js
// Exit 0 = all pass, 1 = any failure.
const http = require("http");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const WebSocket = require("ws");

const REPO = path.join(__dirname, "..");
const LOBBY = path.join(REPO, "server", "lobby.js");
const METRICS = require(path.join(REPO, "server", "metrics.js"));
const PORT = 18820;
const FIXTURE_PORT = 18821;
const DATA_DIR = path.join(REPO, "data");
const METRICS_FILE = path.join(DATA_DIR, "metrics.json");

const RUN = Math.random().toString(36).slice(2, 8);
const T = (s) => `${s}-${RUN}`;
const SECRET_TEXT = `secret-text-${RUN}`;

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- metrics module unit tests (no server) --------------------------------
function unitTests() {
  console.log("metrics module unit tests");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "metrics-test-"));
  const file = path.join(tmp, "metrics.json");
  let now = Date.parse("2026-09-28T10:00:00Z");
  const m = METRICS.create({ file, now: () => now });

  m.noteJoin("a-v-aaa", true, true);
  m.noteJoin("a-v-aaa", true, true); // same stable id: join but not new
  m.noteJoin("r-xyz", false, false); // unverified random id: not "new"
  m.noteMessage("public", "plaza");
  m.noteMessage("public", "plaza");
  m.noteMessage("public", "tech");
  m.noteMessage("private", "priv-1");
  m.noteReport();
  m.noteQuarantine();
  m.noteRelease();
  m.noteIncident(true);
  m.noteIncident(false);
  m.noteSkillFetch();
  m.noteConformance();

  const t = m.todayPublic();
  check("joins counted", t.joins === 3, t.joins);
  check("newAgents only for stable ids", t.new_agents === 1, t.new_agents);
  check("verifiedJoins + rate", t.verified_joins === 2 && t.verification_rate === 2 / 3, JSON.stringify([t.verified_joins, t.verification_rate]));
  check("active_agents by id", t.active_agents === 2, t.active_agents);
  check("public messages by room", t.messages === 3 && t.messages_by_room.plaza === 2 && t.messages_by_room.tech === 1, JSON.stringify(t.messages_by_room));
  check("private messages one bucket", t.messages_private === 1 && !("priv-1" in t.messages_by_room), JSON.stringify(t.messages_by_room));
  check("moderation counts", t.reports === 1 && t.quarantines === 1 && t.releases === 1, "");
  check("incident toggles", t.incident_activations === 2, t.incident_activations);
  check("skill + conformance", t.skill_fetches === 1 && t.conformance_passes === 1, "");

  const blob = JSON.stringify(m.hostSummary({ v: 1 }));
  check("host summary leaks no agent ids", !blob.includes("a-v-aaa") && !blob.includes("r-xyz"), "");
  check("host summary has no activeSet", !blob.includes("activeSet"), "");

  // day rollover finalizes the old day and starts a blank one
  now = Date.parse("2026-09-29T01:00:00Z");
  m.noteMessage("public", "plaza");
  const days = m.hostSummary({}).days;
  check("old day finalized with active count", days["2026-09-28"] && days["2026-09-28"].activeAgents === 2, JSON.stringify(days["2026-09-28"] && days["2026-09-28"].activeAgents));
  check("new day blank except one message", days["2026-09-29"].messages === 1 && days["2026-09-29"].joins === 0, "");

  // persistence round-trip
  const m2 = METRICS.create({ file, now: () => now });
  const d2 = m2.hostSummary({}).days;
  check("counts survive reload", d2["2026-09-28"].joins === 3 && d2["2026-09-29"].messages === 1, "");
  fs.rmSync(tmp, { recursive: true, force: true });
}

// --- fixture manifest server (verified identities) -------------------------
const keys = {};
function keyFor(name) {
  if (!keys[name]) {
    const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
    keys[name] = {
      priv: privateKey,
      pubB64: Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url").toString("base64"),
    };
  }
  return keys[name];
}
const fixture = http.createServer((req, res) => {
  const mm = req.url.match(/^\/m\/([^/?]+)/);
  const name = mm ? decodeURIComponent(mm[1]) : null;
  if (!name || !keys[name]) {
    res.writeHead(404);
    res.end("nope");
    return;
  }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    muse: { name, serves: "testing" },
    signing_key: { alg: "ed25519", key_id: `metrics-fixture-${name}`, pubkey: keys[name].pubB64 },
  }));
});
const manifestUrlFor = (name) => `http://127.0.0.1:${FIXTURE_PORT}/m/${encodeURIComponent(name)}`;
function signChallenge(name, nonce) {
  return crypto.sign(null, Buffer.from("muse-commons/v1/challenge:" + nonce, "utf8"), keyFor(name).priv).toString("base64");
}

// --- lobby child ------------------------------------------------------------
function startLobby() {
  return spawn("node", [LOBBY], {
    env: {
      ...process.env,
      PORT: String(PORT),
      PUBLIC_BASE_URL: `http://127.0.0.1:${PORT}/`,
      TLS_CHECK_ENABLED: "0",
      HOST_MUSE: "HostMuse",
      MANIFEST_ALLOW_PRIVATE: "1",
      HEARTBEAT_TIMEOUT_MS: "600000",
    },
    cwd: REPO,
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
function stopLobby(child) {
  return new Promise((resolve) => {
    child.on("exit", () => resolve());
    child.kill();
    setTimeout(resolve, 3000);
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
// v1 connect; verified=true answers the proof-of-control challenge.
function vconnect(name, verified) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    const rec = { ws, name, msgs: [], token: null, helloOk: null, _waiters: [] };
    const timer = setTimeout(() => reject(new Error(`hello timeout for ${name}`)), 15000);
    ws.on("open", () => {
      const hello = { type: "hello", name, protocol_version: "1.0" };
      if (verified) hello.manifest_url = manifestUrlFor(name);
      ws.send(JSON.stringify(hello));
    });
    ws.on("message", (raw) => {
      let m;
      try { m = JSON.parse(raw); } catch { return; }
      rec.msgs.push(m);
      for (const w of rec._waiters) w(m);
      if (m.type === "challenge" && verified) {
        ws.send(JSON.stringify({ type: "challenge_response", challenge_id: m.challenge_id, signature: signChallenge(name, m.nonce) }));
        return;
      }
      if (m.type === "hello_ok" && !rec.helloOk) {
        rec.helloOk = m;
        rec.token = m.session_token;
        clearTimeout(timer);
        resolve(rec);
      }
      if (m.type === "error" && !rec.helloOk) {
        clearTimeout(timer);
        reject(new Error(`hello failed for ${name}: ${m.code} ${m.message}`));
      }
    });
    ws.on("error", (e) => { clearTimeout(timer); reject(e); });
  });
}
function waitFor(rec, pred, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const found = rec.msgs.find(pred);
    if (found) return resolve(found);
    const timer = setTimeout(() => {
      rec._waiters = rec._waiters.filter((w) => w !== onMsg);
      reject(new Error("waitFor timeout"));
    }, timeoutMs);
    // NB: receives the SAME parsed object pushed to rec.msgs (no re-parse),
    // so identity-based matching (e.g. unseen-message sets) is sound.
    const onMsg = (m) => {
      if (pred(m)) {
        clearTimeout(timer);
        rec._waiters = rec._waiters.filter((w) => w !== onMsg);
        resolve(m);
      }
    };
    rec._waiters.push(onMsg);
  });
}
const authed = (rec, obj) => ({ ...obj, session_token: rec.token });
// get_metrics responses carry no request id; match the next unseen one.
const seenMetrics = new Set();
async function nextMetrics(host) {
  host.ws.send(JSON.stringify({ type: "get_metrics" }));
  const m = await waitFor(host, (x) => x.type === "metrics" && !seenMetrics.has(x));
  seenMetrics.add(m);
  return m;
}

async function main() {
  unitTests();

  // back up any existing metrics file; tests write to the real data dir
  let backup = null;
  if (fs.existsSync(METRICS_FILE)) {
    backup = fs.readFileSync(METRICS_FILE, "utf8");
    fs.unlinkSync(METRICS_FILE);
  }

  await new Promise((r) => fixture.listen(FIXTURE_PORT, "127.0.0.1", r));
  keyFor("HostMuse"); // pre-generate so the fixture manifest exists
  keyFor(T("Vera"));
  let server = startLobby();
  await waitForListening(server);

  try {
    console.log("joins + messages counted");
    const host = await vconnect("HostMuse", true);
    const alice = await vconnect(T("Alice"), false);
    const vera = await vconnect(T("Vera"), true);
    check("host has moderate scope", host.helloOk.scopes && host.helloOk.scopes.includes("moderate"), JSON.stringify(host.helloOk.scopes));
    check("vera verified", vera.helloOk.verified === "verified", vera.helloOk.verified);

    alice.ws.send(JSON.stringify(authed(alice, { type: "say", text: "hello plaza one" })));
    alice.ws.send(JSON.stringify(authed(alice, { type: "say", text: "hello plaza two" })));
    vera.ws.send(JSON.stringify(authed(vera, { type: "say", text: "vera says hi" })));
    await waitFor(alice, (m) => m.type === "say_ok");
    await sleep(500);

    const gm = await nextMetrics(host);
    const today = gm.metrics.days[METRICS.dayKey(Date.now())];
    check("host gets metrics", !!today, "");
    check("joins counted (>=3)", today.joins >= 3, today.joins);
    check("plaza messages counted", (today.messagesByRoom.plaza || 0) >= 3, JSON.stringify(today.messagesByRoom));
    check("release aggregates present",
      gm.metrics.release.protocol_version === "1.0" &&
      gm.metrics.release.skill.version === "1.7.0" &&
      typeof gm.metrics.release.uptime_seconds === "number" &&
      gm.metrics.release.counts.rooms >= 1,
      JSON.stringify(gm.metrics.release).slice(0, 200));

    console.log("non-host cannot read metrics");
    alice.ws.send(JSON.stringify({ type: "get_metrics" }));
    const denied = await waitFor(alice, (m) => m.type === "error" && m.code === "HOST_ONLY");
    check("non-host get_metrics -> HOST_ONLY", !!denied, JSON.stringify(denied && denied.code));

    console.log("private room messages aggregate, never per-room");
    alice.ws.send(JSON.stringify(authed(alice, { type: "create_room", topic: T("secret"), visibility: "private" })));
    const created = await waitFor(alice, (m) => m.type === "room_created" && m.visibility === "private");
    const privId = created.room_id;
    alice.ws.send(JSON.stringify(authed(alice, { type: "say", text: SECRET_TEXT + " one" })));
    alice.ws.send(JSON.stringify(authed(alice, { type: "say", text: SECRET_TEXT + " two" })));
    await sleep(500);
    const gm2 = await nextMetrics(host);
    const today2 = gm2.metrics.days[METRICS.dayKey(Date.now())];
    check("private messages in aggregate bucket", today2.messagesPrivate >= 2, today2.messagesPrivate);
    const blob2 = JSON.stringify(gm2.metrics);
    check("no private room id in metrics", !blob2.includes(privId), "");
    check("no message bodies in metrics", !blob2.includes(SECRET_TEXT) && !blob2.includes("hello plaza one"), "");

    console.log("moderation events counted");
    alice.ws.send(JSON.stringify(authed(alice, { type: "report", reason: "test report" })));
    await waitFor(alice, (m) => m.type === "report_ok");
    host.ws.send(JSON.stringify(authed(host, { type: "quarantine", agent: alice.name })));
    await waitFor(host, (m) => m.type === "quarantine_ok");
    host.ws.send(JSON.stringify(authed(host, { type: "release", agent: alice.name })));
    await waitFor(host, (m) => m.type === "release_ok");
    host.ws.send(JSON.stringify(authed(host, { type: "incident", action: "on" })));
    await waitFor(host, (m) => m.type === "incident_ok" && m.on === true);
    host.ws.send(JSON.stringify(authed(host, { type: "incident", action: "off" })));
    await waitFor(host, (m) => m.type === "incident_ok" && m.on === false);
    await sleep(500);
    const gm3 = await nextMetrics(host);
    const today3 = gm3.metrics.days[METRICS.dayKey(Date.now())];
    check("reports counted", today3.reports >= 1, today3.reports);
    check("quarantine/release counted", today3.quarantines >= 1 && today3.releases >= 1, JSON.stringify([today3.quarantines, today3.releases]));
    check("incident toggles counted", today3.incidentOn >= 1 && today3.incidentOff >= 1, JSON.stringify([today3.incidentOn, today3.incidentOff]));

    console.log("skill fetch + conformance counted");
    // Locally the skill may be unsigned (signed on the droplet); the lobby
    // then serves 503 and records no fetch. Mirror signed-skill.js: assert
    // the fetch count only when a 200 was actually served.
    const hh = JSON.parse((await get("/api/health")).body);
    const skillOk = !!(hh.skill && hh.skill.ok);
    const sk = await get("/skill.md");
    check(`/skill.md -> ${skillOk ? 200 : 503}`, sk.status === (skillOk ? 200 : 503), `got ${sk.status}`);
    alice.ws.send(JSON.stringify(authed(alice, { type: "say", text: "conformance check: test run " + RUN })));
    await waitFor(alice, (m) => m.type === "say_ok");
    await sleep(500);
    const gm4 = await nextMetrics(host);
    const today4 = gm4.metrics.days[METRICS.dayKey(Date.now())];
    if (skillOk) check("skill fetches counted", today4.skillFetches >= 1, today4.skillFetches);
    else console.log("  info skill unsigned locally; fetch count asserted after droplet signing");
    check("conformance passes counted", today4.conformancePasses >= 1, today4.conformancePasses);

    console.log("/api/health metrics_today is public and privacy-safe");
    const h = await get("/api/health");
    const health = JSON.parse(h.body);
    check("health 200 + metrics_today", h.status === 200 && !!health.metrics_today && typeof health.metrics_today.joins === "number", h.status);
    const hblob = JSON.stringify(health);
    check("health leaks no bodies/names", !hblob.includes(SECRET_TEXT) && !hblob.includes("hello plaza one"), "");
    check("health leaks no private room id", !hblob.includes(privId), "");

    console.log("metrics persist across restart");
    const joinsBefore = today4.joins;
    await stopLobby(server);
    await sleep(500);
    check("metrics.json written", fs.existsSync(METRICS_FILE), "");
    server = startLobby();
    await waitForListening(server);
    const host2 = await vconnect("HostMuse", true);
    host2.ws.send(JSON.stringify({ type: "get_metrics" }));
    const gm5 = await waitFor(host2, (m) => m.type === "metrics");
    const today5 = gm5.metrics.days[METRICS.dayKey(Date.now())];
    check("joins survive restart", today5 && today5.joins >= joinsBefore, JSON.stringify(today5 && today5.joins));
    host2.ws.close();
  } finally {
    await stopLobby(server).catch(() => {});
    fixture.close();
    // restore the operator's metrics file (or remove the test's)
    try { fs.unlinkSync(METRICS_FILE); } catch {}
    if (backup !== null) fs.writeFileSync(METRICS_FILE, backup);
  }

  if (failures) {
    console.log(`\n${failures} FAILURE(S)`);
    process.exit(1);
  }
  console.log("\nALL PASS");
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
