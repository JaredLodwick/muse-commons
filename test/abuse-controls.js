// PR #3 abuse-controls tests.
//
// Spawns a real lobby server child plus a fixture manifest server and
// exercises, over WebSocket, against a LOCAL lobby only:
//   1. tiered quotas: burst of says -> structured RATE_LIMITED, socket lives
//   2. duplicate suppression: identical speech twice -> DUPLICATE_MESSAGE
//   3. block: blocked agent's bubbles/transcript never reach the blocker
//   4. report: report_ok, host notified, host can list the queue
//   5. quarantine: held speech never broadcasts; release restores; audited
//   6. incident kill switch: mutations rejected, reads fine, reversible
//   7. room-switch quota: rapid re-hellos -> structured RATE_LIMITED
//   8. per-IP connection cap: excess connections refused with 1013
//
//   node test/abuse-controls.js
// Exit 0 = all pass, 1 = any failure.
const http = require("http");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const WebSocket = require("ws");

const REPO = path.join(__dirname, "..");
const LOBBY = path.join(REPO, "server", "lobby.js");
const PROTO = require(path.join(REPO, "server", "protocol-v1.js"));
const PORT = 18794;
const FIXTURE_PORT = 18795;
const DATA_DIR = path.join(REPO, "data");

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

// --- fixture identity: Ed25519 keypair for the verified host muse --------
const { privateKey: HOST_PRIV, publicKey: HOST_PUB } = crypto.generateKeyPairSync("ed25519");
const HOST_PUB_B64 = Buffer.from(HOST_PUB.export({ format: "jwk" }).x, "base64url").toString("base64");
const HOST_MANIFEST_URL = `http://127.0.0.1:${FIXTURE_PORT}/.well-known/muse-protocol.json`;
const fixture = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      muse: { name: "HostMuse", serves: "Host" },
      signing_key: { alg: "ed25519", key_id: "abuse-fixture-1", pubkey: HOST_PUB_B64 },
    })
  );
});
function signHostChallenge(nonce) {
  return crypto
    .sign(null, Buffer.from("muse-commons/v1/challenge:" + nonce, "utf8"), HOST_PRIV)
    .toString("base64");
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

// v1 agent: hello with protocol_version, resolve with token once hello_ok.
function vconnect(name, extra = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    const rec = { ws, name, msgs: [], token: null, helloOk: null };
    const timer = setTimeout(() => reject(new Error(`hello timeout for ${name}`)), 15000);
    ws.on("open", () =>
      ws.send(JSON.stringify({ type: "hello", name, protocol_version: "1.0", ...extra }))
    );
    ws.on("message", (raw) => {
      let m;
      try {
        m = JSON.parse(raw);
      } catch {
        return;
      }
      rec.msgs.push(m);
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
    ws.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

// Verified host muse: answer the proof-of-control challenge with the
// fixture key. HOST_MUSE=HostMuse confers the host role.
function vconnectHost() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    const rec = { ws, name: "HostMuse", msgs: [], token: null, helloOk: null };
    const timer = setTimeout(() => reject(new Error("host hello timeout")), 15000);
    ws.on("open", () =>
      ws.send(
        JSON.stringify({
          type: "hello",
          name: "HostMuse",
          protocol_version: "1.0",
          manifest_url: HOST_MANIFEST_URL,
        })
      )
    );
    ws.on("message", (raw) => {
      let m;
      try {
        m = JSON.parse(raw);
      } catch {
        return;
      }
      rec.msgs.push(m);
      if (m.type === "challenge") {
        ws.send(
          JSON.stringify({
            type: "challenge_response",
            challenge_id: m.challenge_id,
            signature: signHostChallenge(m.nonce),
          })
        );
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
        reject(new Error(`host hello failed: ${m.code} ${m.message}`));
      }
    });
    ws.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

// Legacy (claim-based) agent, no protocol version.
function lconnect(name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    const rec = { ws, name, msgs: [] };
    const timer = setTimeout(() => reject(new Error(`hello timeout for ${name}`)), 15000);
    ws.on("open", () => ws.send(JSON.stringify({ type: "hello", name })));
    ws.on("message", (raw) => {
      let m;
      try {
        m = JSON.parse(raw);
      } catch {
        return;
      }
      rec.msgs.push(m);
      if (m.type === "hello_ok") {
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

function waitFor(rec, pred, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const found = rec.msgs.find(pred);
    if (found) return resolve(found);
    const timer = setTimeout(() => {
      rec.ws.removeListener("message", onMsg);
      resolve(null);
    }, timeoutMs);
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

function vsay(rec, text, extra = {}) {
  rec.ws.send(JSON.stringify({ type: "say", text, session_token: rec.token, ...extra }));
}

function getJson(pathname) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port: PORT, path: pathname }, (res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () => resolve({ status: res.statusCode, body }));
      })
      .on("error", reject);
  });
}

function unitTests() {
  console.log("unit: abuse-control config");
  for (const bucket of ["say", "room_switch", "invite", "board"]) {
    const q = PROTO.TIERED_QUOTAS[bucket];
    check(
      `tiered quota ${bucket}: unverified < verified < host`,
      !!q &&
        q.unverified.max < q.verified.max &&
        q.verified.max < q.host.max,
      JSON.stringify(q)
    );
  }
  check("dedup window is 30s", PROTO.DEDUP_WINDOW_MS === 30000);
  check("connection cap is sane", PROTO.MAX_CONN_PER_IP >= 16 && PROTO.MAX_CONN_PER_IP <= 128);
  for (const t of ["block", "unblock", "report", "quarantine", "release", "incident", "list_reports"]) {
    check(`incident-exempt: ${t}`, PROTO.INCIDENT_EXEMPT.has(t));
  }
  for (const code of ["DUPLICATE_MESSAGE", "NO_SUCH_AGENT", "QUARANTINED", "INCIDENT_MODE"]) {
    const p = PROTO.errorPayload(code, {});
    check(
      `error ${code} is structured+actionable`,
      p.type === "error" && p.code === code && !!p.message && !!p.hint
    );
  }
  for (const t of ["block", "unblock", "report", "quarantine", "release", "incident"]) {
    check(`mutating: ${t}`, PROTO.MUTATING_TYPES.has(t));
  }
  check("list_reports is read-only", !PROTO.MUTATING_TYPES.has("list_reports"));
}

async function floodTest() {
  console.log("integration: tiered quotas (flood)");
  const rec = await lconnect(T("FloodBot"));
  const errors = [];
  let sayOks = 0;
  let closed = false;
  rec.ws.on("message", (raw) => {
    try {
      const m = JSON.parse(raw.toString());
      if (m.type === "error" && m.code === "RATE_LIMITED") errors.push(m);
      if (m.type === "say_ok") sayOks++;
    } catch {
      /* ignore */
    }
  });
  rec.ws.on("close", () => {
    closed = true;
  });
  for (let i = 0; i < 40; i++) {
    rec.ws.send(JSON.stringify({ type: "say", from: rec.name, text: `flood-${i}` }));
  }
  await new Promise((r) => setTimeout(r, 1500));
  check("flood produced structured errors", errors.length >= 10, `got ${errors.length}`);
  check(
    "quota errors are actionable",
    errors.every((e) => e.code === "RATE_LIMITED" && e.hint && typeof e.retry_after_ms === "number"),
    JSON.stringify(errors[0])
  );
  check(
    "unverified tier capped the burst (say_ok <= 20)",
    sayOks <= 20 && sayOks >= 10,
    `say_ok=${sayOks}`
  );
  check("socket stays open after quota errors (no silent kill)", !closed && rec.ws.readyState === 1);
  rec.ws.close();
}

async function dedupeTest() {
  console.log("integration: duplicate suppression");
  const rec = await vconnect(T("DedupeDan"));
  const marker = `dedupe-${RUN}-one`;
  vsay(rec, marker);
  const ok1 = await waitFor(rec, (m) => m.type === "say_ok");
  check("first say accepted", !!ok1);
  vsay(rec, marker);
  const dup = await waitFor(rec, (m) => m.type === "error" && m.code === "DUPLICATE_MESSAGE");
  check("exact repeat suppressed with DUPLICATE_MESSAGE", !!dup, JSON.stringify(rec.msgs.slice(-2)));
  check("dupe error is actionable", !!dup && !!dup.hint);
  vsay(rec, `  ${marker}  `);
  const dup2 = await waitFor(rec, (m) => m.type === "error" && m.code === "DUPLICATE_MESSAGE");
  check("padded repeat also suppressed", !!dup2);
  vsay(rec, `dedupe-${RUN}-two`);
  const ok2 = await waitFor(rec, (m) => m.type === "say_ok");
  check("different text still accepted", !!ok2);
  rec.ws.close();
}

async function blockTest() {
  console.log("integration: block");
  const alice = await vconnect(T("Alice"));
  const bob = await vconnect(T("Bob"));
  const sendA = (obj) => alice.ws.send(JSON.stringify({ ...obj, session_token: alice.token }));

  sendA({ type: "block", agent: "NobodyHere" });
  const noAgent = await waitFor(alice, (m) => m.type === "error" && m.code === "NO_SUCH_AGENT");
  check("blocking an unknown agent is NO_SUCH_AGENT", !!noAgent);

  sendA({ type: "block", agent: alice.name });
  const selfBlock = await waitFor(alice, (m) => m.type === "error" && m.code === "INVALID_MESSAGE");
  check("blocking yourself is rejected", !!selfBlock);

  sendA({ type: "block", agent: bob.name });
  const blockOk = await waitFor(alice, (m) => m.type === "block_ok" && m.blocked === true);
  check("block acknowledged", !!blockOk && blockOk.name === bob.name);

  const secret = `bob-secret-${RUN}`;
  const mark = alice.msgs.length;
  vsay(bob, secret);
  await waitFor(bob, (m) => m.type === "say_ok");
  await new Promise((r) => setTimeout(r, 800)); // several state ticks
  const leaked = alice.msgs.slice(mark).filter((m) => m.type === "state").some((m) =>
    (m.agents || []).some((a) => a.bubble === secret)
  );
  check("blocked agent's bubbles never reach the blocker", !leaked);

  // transcript on (re)join must not contain the blocked agent's lines
  alice.ws.send(
    JSON.stringify({ type: "hello", name: alice.name, room: "plaza", protocol_version: "1.0" })
  );
  const tr = await waitFor(
    alice,
    (m) => m.type === "transcript" && (m.events || []).some((e) => e.text === secret),
    4000
  );
  check("blocked agent's lines filtered from transcript", !tr);

  sendA({ type: "unblock", agent: bob.name });
  const unblockOk = await waitFor(alice, (m) => m.type === "block_ok" && m.blocked === false);
  check("unblock acknowledged", !!unblockOk);

  const visible = `bob-visible-${RUN}`;
  const mark2 = alice.msgs.length;
  vsay(bob, visible);
  await waitFor(bob, (m) => m.type === "say_ok");
  const seen = await waitFor(
    { ws: alice.ws, msgs: alice.msgs.slice(mark2) },
    (m) => m.type === "state" && (m.agents || []).some((a) => a.bubble === visible),
    6000
  );
  check("after unblock, messages reach the blocker again", !!seen);

  alice.ws.close();
  bob.ws.close();
}

async function reportTest() {
  console.log("integration: report -> operator queue");
  const host = await vconnectHost();
  const alice = await vconnect(T("Reporter"));
  const bob = await vconnect(T("Spammer"));
  const sendA = (obj) => alice.ws.send(JSON.stringify({ ...obj, session_token: alice.token }));

  sendA({ type: "report", target: bob.name });
  const needReason = await waitFor(alice, (m) => m.type === "error" && m.code === "INVALID_MESSAGE");
  check("report without a reason is rejected", !!needReason);

  const reason = `spam test ${RUN}`;
  sendA({ type: "report", target: bob.name, reason });
  const reportOk = await waitFor(alice, (m) => m.type === "report_ok" && m.id);
  check("report acknowledged with an id", !!reportOk);

  const filed = await waitFor(
    host,
    (m) => m.type === "report_filed" && m.report && m.report.id === (reportOk && reportOk.id)
  );
  check("host is notified of the report", !!filed && filed.report.reason === reason);

  host.ws.send(JSON.stringify({ type: "list_reports", session_token: host.token }));
  const list = await waitFor(host, (m) => m.type === "reports_list" && Array.isArray(m.reports));
  check(
    "host can list the report queue",
    !!list && list.reports.some((r) => r.id === reportOk.id && r.reason === reason)
  );

  bob.ws.send(JSON.stringify({ type: "list_reports", session_token: bob.token }));
  const denied = await waitFor(bob, (m) => m.type === "error" && m.code === "HOST_ONLY");
  check("non-host cannot list reports", !!denied);

  const q = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "reports.json"), "utf8"));
  check(
    "report queue is persisted",
    Array.isArray(q) && q.some((r) => r.id === reportOk.id)
  );

  alice.ws.close();
  bob.ws.close();
  return host; // keep the host for the next tests
}

async function quarantineTest(host) {
  console.log("integration: quarantine");
  const carol = await vconnect(T("Carol"));
  const dave = await vconnect(T("Dave"));
  const sendH = (obj) => host.ws.send(JSON.stringify({ ...obj, session_token: host.token }));

  carol.ws.send(JSON.stringify({ type: "quarantine", agent: dave.name, session_token: carol.token }));
  const denied = await waitFor(carol, (m) => m.type === "error" && m.code === "HOST_ONLY");
  check("non-host cannot quarantine", !!denied);

  sendH({ type: "quarantine", agent: dave.name });
  const qok = await waitFor(host, (m) => m.type === "quarantine_ok");
  check("host quarantine acknowledged", !!qok && qok.name === dave.name);
  const notice = await waitFor(dave, (m) => m.type === "quarantined");
  check("quarantined agent is notified", !!notice);

  const held = `held-${RUN}`;
  const mark = carol.msgs.length;
  vsay(dave, held);
  const qerr = await waitFor(dave, (m) => m.type === "error" && m.code === "QUARANTINED");
  check("quarantined speech gets QUARANTINED (not silent)", !!qerr && !!qerr.hint);
  await new Promise((r) => setTimeout(r, 800));
  const leaked = carol.msgs.slice(mark).filter((m) => m.type === "state").some((m) =>
    (m.agents || []).some((a) => a.bubble === held)
  );
  check("quarantined speech never broadcasts", !leaked);
  const flagged = carol.msgs.slice(mark).filter((m) => m.type === "state").some((m) =>
    (m.agents || []).some((a) => a.name === dave.name && a.quarantined === true)
  );
  check("quarantine is visible in state", !!flagged);

  sendH({ type: "release", agent: dave.name });
  const rok = await waitFor(host, (m) => m.type === "release_ok");
  check("host release acknowledged", !!rok);
  const rnotice = await waitFor(dave, (m) => m.type === "released");
  check("released agent is notified", !!rnotice);

  const free = `free-${RUN}`;
  const mark2 = carol.msgs.length;
  vsay(dave, free);
  await waitFor(dave, (m) => m.type === "say_ok");
  const seen = await waitFor(
    { ws: carol.ws, msgs: carol.msgs.slice(mark2) },
    (m) => m.type === "state" && (m.agents || []).some((a) => a.bubble === free),
    6000
  );
  check("released agent's speech broadcasts again", !!seen);

  const audit = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "audit.json"), "utf8"));
  check(
    "quarantine + release are in the audit trail",
    Array.isArray(audit) &&
      audit.some((e) => e.action === "quarantine" && e.targetName === dave.name) &&
      audit.some((e) => e.action === "release" && e.targetName === dave.name)
  );

  carol.ws.close();
  dave.ws.close();
}

async function incidentTest(host) {
  console.log("integration: incident kill switch");
  const eve = await vconnect(T("Eve"));
  const sendH = (obj) => host.ws.send(JSON.stringify({ ...obj, session_token: host.token }));
  const sendE = (obj) => eve.ws.send(JSON.stringify({ ...obj, session_token: eve.token }));

  sendE({ type: "incident", action: "on" });
  const denied = await waitFor(eve, (m) => m.type === "error" && m.code === "HOST_ONLY");
  check("non-host cannot flip incident mode", !!denied);

  sendH({ type: "incident", action: "on" });
  const onOk = await waitFor(host, (m) => m.type === "incident_ok" && m.on === true);
  check("host enables incident mode", !!onOk);
  const bcast = await waitFor(eve, (m) => m.type === "incident" && m.on === true);
  check("incident state is broadcast to clients", !!bcast);

  const mark = eve.msgs.length;
  sendE({ type: "say", text: `incident-say-${RUN}` });
  const sayErr = await waitFor(eve, (m) => m.type === "error" && m.code === "INCIDENT_MODE");
  check("say rejected in incident mode", !!sayErr && !!sayErr.hint);
  sendE({ type: "post", kind: "want", topics: ["x"], title: "incident post" });
  const postErr = await waitFor(eve, (m) => m.type === "error" && m.code === "INCIDENT_MODE");
  check("post rejected in incident mode", !!postErr);
  sendE({ type: "invite", room_id: "plaza", to: "Nobody" });
  const invErr = await waitFor(eve, (m) => m.type === "error" && m.code === "INCIDENT_MODE");
  check("invite rejected in incident mode", !!invErr);

  // reads + presence unaffected
  const places = await getJson("/api/places");
  check("read APIs unaffected (/api/places 200)", places.status === 200);
  await new Promise((r) => setTimeout(r, 500));
  const states = eve.msgs.slice(mark).filter((m) => m.type === "state");
  check("presence/state still flows in incident mode", states.length > 0);
  check(
    "state carries the incident flag",
    states.some((m) => m.incident === true)
  );

  // defensive actions still work mid-incident
  const frank = await vconnect(T("Frank"));
  check("hello_ok carries incident:true", frank.helloOk && frank.helloOk.incident === true);
  sendE({ type: "block", agent: frank.name });
  const blockOk = await waitFor(eve, (m) => m.type === "block_ok" && m.blocked === true);
  check("block still works in incident mode", !!blockOk);

  sendH({ type: "incident", action: "off" });
  const offOk = await waitFor(host, (m) => m.type === "incident_ok" && m.on === false);
  check("host disables incident mode (one command)", !!offOk);
  sendE({ type: "say", text: `after-incident-${RUN}` });
  const sayOk = await waitFor(eve, (m) => m.type === "say_ok");
  check("mutations work again after incident mode", !!sayOk);

  eve.ws.close();
  frank.ws.close();
}

async function roomSwitchTest() {
  console.log("integration: room-switch quota");
  const rec = await vconnect(T("Gail"));
  const rooms = ["tech", "food", "help", "introductions"];
  let oks = 0;
  for (const room of rooms) {
    rec.ws.send(
      JSON.stringify({ type: "hello", name: rec.name, room, protocol_version: "1.0", session_token: rec.token })
    );
    const ok = await waitFor(rec, (m) => m.type === "hello_ok" && m.room_id === room, 6000);
    if (ok) oks++;
  }
  check("normal room switching (4 rapid) is never quota'd", oks === 4, `oks=${oks}`);
  // 6th hello inside a minute: the per-socket hello bucket fires first —
  // still a structured, actionable RATE_LIMITED, socket stays open.
  rec.ws.send(
    JSON.stringify({ type: "hello", name: rec.name, room: "marketplace", protocol_version: "1.0", session_token: rec.token })
  );
  const limited = await waitFor(
    rec,
    (m) => m.type === "error" && m.code === "RATE_LIMITED" && typeof m.retry_after_ms === "number"
  );
  check("excessive room switching -> structured RATE_LIMITED", !!limited && !!limited.hint);
  check("socket survives room-switch quota", rec.ws.readyState === 1);
  rec.ws.close();
}

async function connCapTest() {
  console.log("integration: per-IP connection cap");
  await new Promise((r) => setTimeout(r, 600)); // let earlier closes drain
  const total = PROTO.MAX_CONN_PER_IP + 8;
  let refused = 0;
  let saw1013 = false;
  const sockets = [];
  await Promise.all(
    Array.from({ length: total }, () => {
      return new Promise((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
        sockets.push(ws);
        let done = false;
        const finish = () => {
          if (!done) {
            done = true;
            resolve();
          }
        };
        ws.on("message", (raw) => {
          try {
            const m = JSON.parse(raw.toString());
            if (m.type === "error" && m.code === "RATE_LIMITED") refused++;
          } catch {
            /* ignore */
          }
        });
        ws.on("close", (code) => {
          if (code === 1013) saw1013 = true;
          finish();
        });
        ws.on("open", () => setTimeout(finish, 1500));
        setTimeout(finish, 4000);
      });
    })
  );
  check("connections past the cap are refused", refused >= 3, `refused=${refused}/${total}`);
  check("refused connections close with 1013", saw1013);
  for (const ws of sockets) {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  }
}

(async () => {
  try {
    unitTests();
    await new Promise((r) => fixture.listen(FIXTURE_PORT, "127.0.0.1", r));
    const server = startLobby();
    await waitForListening(server);
    try {
      await floodTest();
      await dedupeTest();
      await blockTest();
      const host = await reportTest();
      await quarantineTest(host);
      await incidentTest(host);
      host.ws.close();
      await roomSwitchTest();
      await connCapTest();
    } finally {
      server.kill();
    }
    fixture.close();
  } catch (e) {
    failures++;
    console.log("  FAIL harness — " + (e && e.message));
  }
  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
})();
