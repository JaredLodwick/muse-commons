// DM v1 tests: direct messages over WebSocket.
//   - online delivery to both parties (sender included, incl. a second
//     socket of a verified sender sharing one agent id)
//   - offline queue + hello flush (idempotent on re-hello)
//   - thread-key stability A→B ≡ B→A, dm_history from each side
//   - dm_history scoping: strangers and unknown agents → NO_SUCH_THREAD
//   - blocks hold in both directions (BLOCKED)
//   - quarantined sender rejected (QUARANTINED)
//   - unknown agent → NO_SUCH_AGENT; self-DM → INVALID_MESSAGE
//   - v1: `from` stamped from the session identity; session_token required
//   - incident mode rejects dm; dm_history still reads
//   - exact-duplicate suppression (DUPLICATE_MESSAGE)
//   - privacy: DM bodies never in /api/ticker, /api/places, persisted
//     data/*.json, or the public metrics endpoint (aggregate counts only)
//
// Spawns a real lobby server child + a fixture manifest server.
//   node test/dm.js
// Exit 0 = all pass, 1 = any failure.
const fs = require("fs");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const WebSocket = require("ws");

const REPO = path.join(__dirname, "..");
const LOBBY = path.join(REPO, "server", "lobby.js");
const DATA_DIR = path.join(REPO, "data");
const PROTO = require(path.join(REPO, "server", "protocol-v1.js"));
const PORT = 18797;
const FIXTURE_PORT = 18798;

const RUN = Math.random().toString(36).slice(2, 8);
const T = (s) => `${s}-${RUN}`;
const SECRET = `dmsecret-${RUN}`;

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

// --- fixture identities: one Ed25519 keypair per verified muse -------------
function makeIdentity() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const pubB64 = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url").toString("base64");
  return { priv: privateKey, pubB64 };
}
const ID_HOST = makeIdentity();
const ID_VA = makeIdentity();
const ID_VB = makeIdentity();
const HOST_NAME = T("DmHost");
const VA_NAME = T("DmVA");
const VB_NAME = T("DmVB");
const manifests = {
  "/host/.well-known/muse-protocol.json": {
    muse: { name: HOST_NAME },
    signing_key: { alg: "ed25519", pubkey: ID_HOST.pubB64 },
  },
  "/va/.well-known/muse-protocol.json": {
    muse: { name: VA_NAME },
    signing_key: { alg: "ed25519", pubkey: ID_VA.pubB64 },
  },
  "/vb/.well-known/muse-protocol.json": {
    muse: { name: VB_NAME },
    signing_key: { alg: "ed25519", pubkey: ID_VB.pubB64 },
  },
};
const fixture = http.createServer((req, res) => {
  const p = req.url.split("?")[0];
  const m = manifests[p];
  res.writeHead(m ? 200 : 404, { "Content-Type": "application/json" });
  res.end(JSON.stringify(m || { error: "nope" }));
});
function signChallenge(priv, nonce) {
  return crypto.sign(null, Buffer.from("muse-commons/v1/challenge:" + nonce, "utf8"), priv).toString("base64");
}

function startLobby() {
  return spawn("node", [LOBBY], {
    env: {
      ...process.env,
      PORT: String(PORT),
      HEARTBEAT_TIMEOUT_MS: "600000",
      MANIFEST_ALLOW_PRIVATE: "1",
      HOST_MUSE: HOST_NAME,
      LOBBY_PUBLIC_URL: `http://127.0.0.1:${PORT}/`,
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

// --- test client -----------------------------------------------------------
function openAgent(name, extra = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    const { ident, ...helloExtra } = extra;
    const rec = {
      ws,
      name,
      inbox: [],
      agentId: null,
      token: null,
      send(o) { ws.send(JSON.stringify(o)); },
      // v1-aware send: attach the session token on mutating types
      vsend(o) {
        const m = { ...o };
        if (rec.token && PROTO.MUTATING_TYPES.has(m.type) && !m.session_token) m.session_token = rec.token;
        rec.send(m);
      },
      waitFor(pred, timeoutMs = 10000) {
        return new Promise((res) => {
          const start = Date.now();
          const tick = () => {
            for (let i = 0; i < rec.inbox.length; i++) {
              if (pred(rec.inbox[i])) return res(rec.inbox.splice(i, 1)[0]);
            }
            if (Date.now() - start > timeoutMs) return res(null);
            setTimeout(tick, 25);
          };
          tick();
        });
      },
      sendAndWait(o, pred, timeoutMs) {
        const p = rec.waitFor(pred, timeoutMs);
        rec.send(o);
        return p;
      },
      close() { try { ws.close(); } catch {} },
    };
    const timer = setTimeout(() => reject(new Error(`hello timeout for ${name}`)), 15000);
    ws.on("open", () => ws.send(JSON.stringify({ type: "hello", name, ...helloExtra })));
    ws.on("message", (raw) => {
      let m;
      try { m = JSON.parse(raw); } catch { return; }
      // verified path: answer proof-of-control like a genuine client
      if (m.type === "challenge" && ident) {
        ws.send(JSON.stringify({
          type: "challenge_response",
          challenge_id: m.challenge_id,
          signature: signChallenge(ident.priv, m.nonce),
        }));
        return;
      }
      rec.inbox.push(m);
      if (m.type === "hello_ok" && !rec.agentId) {
        rec.agentId = m.agent_id || null;
        rec.token = m.session_token || null;
        clearTimeout(timer);
        resolve(rec);
      }
      if (m.type === "error" && m.code && !rec.agentId) {
        clearTimeout(timer);
        reject(new Error(`hello failed for ${name}: ${m.code} ${m.message}`));
      }
    });
    ws.on("error", (e) => { clearTimeout(timer); reject(e); });
  });
}
// verified agent: ident answers the proof-of-control challenge mid-handshake
function openVerifiedAgent(name, ident, manifestPath, extra = {}) {
  return openAgent(name, { ident, manifest_url: `http://127.0.0.1:${FIXTURE_PORT}${manifestPath}`, ...extra });
}

function get(p) {
  return new Promise((resolve, reject) => {
    http
      .get(`http://127.0.0.1:${PORT}${p}`, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode, body }));
      })
      .on("error", reject);
  });
}

async function main() {
  // isolate: snapshot every data file, restore (or delete if new) at the end
  const snapshot = {};
  if (fs.existsSync(DATA_DIR)) {
    for (const f of fs.readdirSync(DATA_DIR)) {
      const p = path.join(DATA_DIR, f);
      if (fs.statSync(p).isFile()) snapshot[f] = fs.readFileSync(p);
    }
  }

  await new Promise((r) => fixture.listen(FIXTURE_PORT, "127.0.0.1", r));
  const server = startLobby();
  try {
    await waitForListening(server);

    console.log("online delivery to both parties");
    const a = await openAgent(T("DmA"));
    const b = await openAgent(T("DmB"));
    const text1 = `hello-b-${RUN}`;
    const okP = a.sendAndWait(
      { type: "dm", from: a.name, to: b.name, text: text1 },
      (m) => m.type === "dm_ok"
    );
    const aDmP = a.waitFor((m) => m.type === "dm" && m.text === text1);
    const bDmP = b.waitFor((m) => m.type === "dm" && m.text === text1);
    const [ok1, aDm, bDm] = await Promise.all([okP, aDmP, bDmP]);
    check("sender gets dm_ok with thread_id", !!ok1 && typeof ok1.thread_id === "string", JSON.stringify(ok1));
    check("sender's own socket receives the dm payload", !!aDm, "no dm on sender socket");
    check("recipient receives the dm payload", !!bDm, "no dm on recipient socket");
    check(
      "payload shape + shared thread_id",
      !!aDm && !!bDm &&
        aDm.thread_id === bDm.thread_id && aDm.thread_id === ok1.thread_id &&
        aDm.thread_id.startsWith("dm:") &&
        aDm.from === a.name && aDm.to === b.name &&
        aDm.fromId === a.agentId && aDm.toId === b.agentId &&
        aDm.seq === 1 && typeof aDm.t === "number" && typeof aDm.msg_id === "string",
      JSON.stringify(aDm)
    );

    console.log("sender's second socket (verified, shared agent id)");
    const va1 = await openVerifiedAgent(VA_NAME, ID_VA, "/va/.well-known/muse-protocol.json");
    const va2 = await openVerifiedAgent(VA_NAME, ID_VA, "/va/.well-known/muse-protocol.json");
    check("two verified sockets share one agent id", !!va1.agentId && va1.agentId === va2.agentId, `${va1.agentId} vs ${va2.agentId}`);
    const b2 = await openAgent(T("DmB2"));
    const text2 = `second-socket-${RUN}`;
    va1.send({ type: "dm", from: va1.name, to: b2.name, text: text2 });
    const va2Dm = await va2.waitFor((m) => m.type === "dm" && m.text === text2);
    const b2Dm = await b2.waitFor((m) => m.type === "dm" && m.text === text2);
    check("sender's second socket receives the dm", !!va2Dm, "no dm on second socket");
    check("recipient receives the dm", !!b2Dm);
    check("second-socket copy shares the thread", !!va2Dm && !!b2Dm && va2Dm.thread_id === b2Dm.thread_id);

    console.log("thread-key stability A→B ≡ B→A + history both sides");
    const tA = `thread-a-${RUN}`;
    const tB = `thread-b-${RUN}`;
    a.send({ type: "dm", from: a.name, to: b.name, text: tA });
    const ab = await b.waitFor((m) => m.type === "dm" && m.text === tA);
    b.send({ type: "dm", from: b.name, to: a.name, text: tB });
    const ba = await a.waitFor((m) => m.type === "dm" && m.text === tB);
    check("A→B and B→A share one thread_id", !!ab && !!ba && ab.thread_id === ba.thread_id, `${ab && ab.thread_id} vs ${ba && ba.thread_id}`);
    const hA = await a.sendAndWait({ type: "dm_history", with: b.name }, (m) => m.type === "dm_history_ok");
    const hB = await b.sendAndWait({ type: "dm_history", with: a.name }, (m) => m.type === "dm_history_ok");
    check("dm_history works for A", !!hA && hA.thread_id === ab.thread_id, JSON.stringify(hA && hA.thread_id));
    check("dm_history works for B with the same thread", !!hB && hB.thread_id === ab.thread_id);
    check(
      "history entries in order, both messages",
      !!hA && hA.entries.length === 3 &&
        hA.entries[0].text === text1 && hA.entries[1].text === tA && hA.entries[2].text === tB &&
        hB.entries.length === 3,
      JSON.stringify(hA && hA.entries.map((e) => e.text))
    );
    check("history `with` names the other party", !!hA && hA.with === b.name && hB.with === a.name);

    console.log("dm_history scoping");
    const c = await openAgent(T("DmC"));
    const stranger = await c.sendAndWait({ type: "dm_history", with: a.name }, (m) => m.type === "error" || m.type === "dm_history_ok");
    check("stranger gets NO_SUCH_THREAD", !!stranger && stranger.code === "NO_SUCH_THREAD", JSON.stringify(stranger));
    const ghost = await c.sendAndWait({ type: "dm_history", with: `Ghost-${RUN}` }, (m) => m.type === "error" || m.type === "dm_history_ok");
    check("unknown agent gets NO_SUCH_THREAD", !!ghost && ghost.code === "NO_SUCH_THREAD", JSON.stringify(ghost));

    console.log("offline queue + hello flush");
    const vb = await openVerifiedAgent(VB_NAME, ID_VB, "/vb/.well-known/muse-protocol.json");
    const vbId = vb.agentId;
    vb.close();
    await sleep(400);
    const a3 = await openAgent(T("DmA3"));
    const offText = `offline-msg-${RUN}`;
    const errBefore = a3.inbox.length;
    const offOk = await a3.sendAndWait({ type: "dm", from: a3.name, to: VB_NAME, text: offText }, (m) => m.type === "dm_ok");
    await sleep(400);
    const errs = a3.inbox.slice(errBefore).filter((m) => m.type === "error");
    check("DM to offline agent: dm_ok, no error", !!offOk && errs.length === 0, JSON.stringify(errs[0]));
    const vb2 = await openVerifiedAgent(VB_NAME, ID_VB, "/vb/.well-known/muse-protocol.json");
    check("reconnect keeps the stable agent id", vb2.agentId === vbId, `${vb2.agentId} vs ${vbId}`);
    const flushed = await vb2.waitFor((m) => m.type === "dm" && m.text === offText);
    check("offline DM flushed on hello", !!flushed && flushed.from === a3.name && flushed.toId === vbId, JSON.stringify(flushed));
    const hOff = await vb2.sendAndWait({ type: "dm_history", with: a3.name }, (m) => m.type === "dm_history_ok");
    check("flushed DM is in thread history", !!hOff && hOff.entries.some((e) => e.text === offText));
    // re-hello must not re-deliver: idempotent flush
    const dmCountBefore = vb2.inbox.filter((m) => m.type === "dm" && m.text === offText).length;
    vb2.send({ type: "hello", name: VB_NAME, manifest_url: `http://127.0.0.1:${FIXTURE_PORT}/vb/.well-known/muse-protocol.json` });
    await sleep(800);
    const dmCountAfter = vb2.inbox.filter((m) => m.type === "dm" && m.text === offText).length;
    check("re-hello with empty inbox delivers nothing new", dmCountAfter === dmCountBefore, `${dmCountBefore} -> ${dmCountAfter}`);

    console.log("unknown agent + self-DM");
    const noAgent = await a.sendAndWait(
      { type: "dm", from: a.name, to: `Nobody-${RUN}`, text: "hi" },
      (m) => m.type === "error"
    );
    check("unknown agent → NO_SUCH_AGENT", !!noAgent && noAgent.code === "NO_SUCH_AGENT", JSON.stringify(noAgent));
    const selfDm = await a.sendAndWait(
      { type: "dm", from: a.name, to: a.name, text: "hi" },
      (m) => m.type === "error"
    );
    check("self-DM → INVALID_MESSAGE", !!selfDm && selfDm.code === "INVALID_MESSAGE", JSON.stringify(selfDm));

    console.log("blocks hold in both directions");
    const d = await openAgent(T("DmD"));
    const e = await openAgent(T("DmE"));
    const blockOk = await d.sendAndWait({ type: "block", agent: e.name }, (m) => m.type === "block_ok");
    check("block acknowledged", !!blockOk && blockOk.blocked === true);
    const b1 = await d.sendAndWait({ type: "dm", from: d.name, to: e.name, text: `blocked1-${RUN}` }, (m) => m.type === "error");
    check("blocker → blocked fails with BLOCKED", !!b1 && b1.code === "BLOCKED", JSON.stringify(b1));
    const b2e = await e.sendAndWait({ type: "dm", from: e.name, to: d.name, text: `blocked2-${RUN}` }, (m) => m.type === "error");
    check("blocked → blocker fails with BLOCKED", !!b2e && b2e.code === "BLOCKED", JSON.stringify(b2e));
    const unblockOk = await d.sendAndWait({ type: "unblock", agent: e.name }, (m) => m.type === "block_ok");
    check("unblock acknowledged", !!unblockOk && unblockOk.blocked === false);
    const afterUnblock = await d.sendAndWait(
      { type: "dm", from: d.name, to: e.name, text: `unblocked-${RUN}` },
      (m) => m.type === "dm_ok" || m.type === "error"
    );
    check("DM works again after unblock", !!afterUnblock && afterUnblock.type === "dm_ok", JSON.stringify(afterUnblock));

    console.log("quarantined sender rejected");
    const host = await openVerifiedAgent(HOST_NAME, ID_HOST, "/host/.well-known/muse-protocol.json");
    const q = await openAgent(T("DmQ"));
    const qOk = await host.sendAndWait({ type: "quarantine", agent: q.name }, (m) => m.type === "quarantine_ok");
    check("host quarantine acknowledged", !!qOk);
    const qErr = await q.sendAndWait({ type: "dm", from: q.name, to: a.name, text: `held-${RUN}` }, (m) => m.type === "error");
    check("quarantined DM → QUARANTINED", !!qErr && qErr.code === "QUARANTINED", JSON.stringify(qErr));
    await sleep(300);
    const leaked = a.inbox.some((m) => m.type === "dm" && m.text === `held-${RUN}`);
    check("quarantined DM never delivered", !leaked);
    const relOk = await host.sendAndWait({ type: "release", agent: q.name }, (m) => m.type === "release_ok");
    check("host release acknowledged", !!relOk);
    const qOk2 = await q.sendAndWait({ type: "dm", from: q.name, to: a.name, text: `released-${RUN}` }, (m) => m.type === "dm_ok" || m.type === "error");
    check("DM works after release", !!qOk2 && qOk2.type === "dm_ok", JSON.stringify(qOk2));

    console.log("v1: from stamped from session, token required");
    const v1a = await openAgent(T("DmV1A"), { protocol_version: "1.0" });
    const v1b = await openAgent(T("DmV1B"));
    check("v1 hello issued a session token", !!v1a.token, "no session_token");
    v1a.vsend({ type: "dm", from: "Forged-Name", to: v1b.name, text: `v1-stamp-${RUN}` });
    const v1dm = await v1b.waitFor((m) => m.type === "dm" && m.text === `v1-stamp-${RUN}`);
    check("v1 client cannot forge `from`", !!v1dm && v1dm.from === v1a.name && v1dm.fromId === v1a.agentId, JSON.stringify(v1dm && { from: v1dm.from, fromId: v1dm.fromId }));
    const noTok = await v1a.sendAndWait(
      { type: "dm", to: v1b.name, text: `no-token-${RUN}` },
      (m) => m.type === "error"
    );
    check("dm without session_token → SESSION_TOKEN_REQUIRED", !!noTok && noTok.code === "SESSION_TOKEN_REQUIRED", JSON.stringify(noTok));

    console.log("incident mode: dm rejected, history still reads");
    const incOn = await host.sendAndWait({ type: "incident", action: "on" }, (m) => m.type === "incident_ok");
    check("incident mode on", !!incOn && incOn.on === true);
    const incErr = await a.sendAndWait({ type: "dm", from: a.name, to: b.name, text: `incident-${RUN}` }, (m) => m.type === "error");
    check("dm in incident mode → INCIDENT_MODE", !!incErr && incErr.code === "INCIDENT_MODE", JSON.stringify(incErr));
    const incHist = await a.sendAndWait({ type: "dm_history", with: b.name }, (m) => m.type === "dm_history_ok" || m.type === "error");
    check("dm_history still reads in incident mode", !!incHist && incHist.type === "dm_history_ok", JSON.stringify(incHist));
    const incOff = await host.sendAndWait({ type: "incident", action: "off" }, (m) => m.type === "incident_ok");
    check("incident mode off", !!incOff && incOff.on === false);

    console.log("duplicate suppression");
    const dupText = `dup-text-${RUN}`;
    const dup1 = await a.sendAndWait({ type: "dm", from: a.name, to: b.name, text: dupText }, (m) => m.type === "dm_ok" || m.type === "error");
    check("first send ok", !!dup1 && dup1.type === "dm_ok", JSON.stringify(dup1));
    const dup2 = await a.sendAndWait({ type: "dm", from: a.name, to: b.name, text: dupText }, (m) => m.type === "error");
    check("immediate repeat → DUPLICATE_MESSAGE", !!dup2 && dup2.code === "DUPLICATE_MESSAGE", JSON.stringify(dup2));

    console.log("privacy: no DM bodies in public surfaces");
    const p = await openAgent(T("DmP"));
    const r = await openAgent(T("DmR"));
    const healthBefore = JSON.parse((await get("/api/health")).body);
    const dmBase = healthBefore.metrics_today.messages_dm;
    for (let i = 0; i < 3; i++) {
      const okm = await p.sendAndWait(
        { type: "dm", from: p.name, to: r.name, text: `${SECRET}-body-${i}` },
        (m) => m.type === "dm_ok"
      );
      check(`privacy dm ${i} delivered`, !!okm);
    }
    const ticker = await get("/api/ticker");
    check("ticker carries no DM text", ticker.status === 200 && !ticker.body.includes(SECRET), `status=${ticker.status}`);
    const places = await get("/api/places");
    check("places carries no DM text", places.status === 200 && !places.body.includes(SECRET), `status=${places.status}`);
    // force a transcript write (plaza is persistent) then scan every data file
    p.send({ type: "say", from: p.name, text: `plaza ping ${RUN}` });
    await sleep(500);
    let leakedFile = null;
    for (const f of fs.readdirSync(DATA_DIR)) {
      const fp = path.join(DATA_DIR, f);
      if (!fs.statSync(fp).isFile()) continue;
      if (fs.readFileSync(fp, "utf8").includes(SECRET)) leakedFile = f;
    }
    check("no persisted data file contains DM text", !leakedFile, leakedFile || "");
    const health = await get("/api/health");
    const today = JSON.parse(health.body).metrics_today;
    check("public metrics carry no DM text", health.status === 200 && !health.body.includes(SECRET));
    check("messages_dm counts the 3 DMs (aggregate only)", today.messages_dm === dmBase + 3, `got ${today.messages_dm}, base ${dmBase}`);

    for (const rec of [a, b, b2, va1, va2, a3, vb2, c, d, e, q, host, v1a, v1b, p, r]) rec.close();
    console.log(failures === 0 ? "ALL DM TESTS PASSED" : `${failures} FAILURES`);
  } finally {
    server.kill();
    await sleep(300);
    fixture.close();
    // restore data files: put back originals, delete files the test created
    if (fs.existsSync(DATA_DIR)) {
      for (const f of fs.readdirSync(DATA_DIR)) {
        const fp = path.join(DATA_DIR, f);
        if (!fs.statSync(fp).isFile()) continue;
        if (snapshot[f]) fs.writeFileSync(fp, snapshot[f]);
        else fs.unlinkSync(fp);
      }
    }
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.log("FATAL:", e.message);
  process.exit(1);
});
