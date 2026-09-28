// PR #8 trust-tiers tests.
//
// Spawns a real lobby server child plus a fixture manifest server and
// exercises, over WebSocket, against a LOCAL lobby only:
//   1. tier on join: unverified -> "new", verified -> "verified"
//   2. trust badge in state roster + presence events, distinct from verified
//   3. automatic verified -> regular promotion on sustained presence days
//   4. host trust_promote -> "trusted", trust_demote -> one tier down
//   5. non-host promote -> HOST_ONLY; promote of unverified -> TRUST_IDENTITY_REQUIRED
//   6. report resolve "upheld" -> demote one tier; "dismissed" -> no change
//   7. quarantine -> demote one tier; release does not restore
//   8. tiers + history survive a server restart
//   9. quota ladder unit check: new < verified < regular < trusted < host
//
//   node test/trust-tiers.js
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
const PORT = 18810;
const FIXTURE_PORT = 18811;
const DATA_DIR = path.join(REPO, "data");
const TRUST_FILE = path.join(DATA_DIR, "trust.json");

const RUN = Math.random().toString(36).slice(2, 8);
const T = (s) => `${s}-${RUN}`;

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? " — " + detail : " " + detail}`);
  }
}

// --- fixture identity: per-agent Ed25519 keypairs -------------------------
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
const manifestUrlFor = (name) => `http://127.0.0.1:${FIXTURE_PORT}/m/${encodeURIComponent(name)}`;
const fixture = http.createServer((req, res) => {
  const m = req.url.match(/^\/m\/([^/?]+)/);
  const name = m ? decodeURIComponent(m[1]) : null;
  if (!name || !keys[name]) {
    res.writeHead(404);
    res.end("nope");
    return;
  }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      muse: { name, serves: "testing" },
      signing_key: { alg: "ed25519", key_id: `trust-fixture-${name}`, pubkey: keys[name].pubB64 },
    })
  );
});
function signChallenge(name, nonce) {
  return crypto
    .sign(null, Buffer.from("muse-commons/v1/challenge:" + nonce, "utf8"), keyFor(name).priv)
    .toString("base64");
}

// --- lobby child ------------------------------------------------------------
let lobby = null;
function startLobby() {
  lobby = spawn("node", [LOBBY], {
    env: {
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
  return waitForListening(lobby);
}
function stopLobby() {
  return new Promise((resolve) => {
    if (!lobby || lobby.exitCode !== null) return resolve();
    lobby.on("exit", () => resolve());
    lobby.kill();
    setTimeout(resolve, 3000);
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

// --- client -----------------------------------------------------------------
function connect(helloExtra = {}, signerName = null) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    const rec = { ws, msgs: [], helloOk: null, token: null };
    const timer = setTimeout(() => reject(new Error("hello timeout")), 15000);
    ws.on("open", () => ws.send(JSON.stringify({ type: "hello", protocol_version: "1.0", ...helloExtra })));
    ws.on("message", (raw) => {
      let m;
      try {
        m = JSON.parse(raw);
      } catch {
        return;
      }
      rec.msgs.push(m);
      if (m.type === "challenge" && signerName) {
        ws.send(
          JSON.stringify({
            type: "challenge_response",
            challenge_id: m.challenge_id,
            signature: signChallenge(signerName, m.nonce),
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
        reject(new Error(`hello failed: ${m.code} ${m.message}`));
      }
    });
    ws.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}
function vconnect(name) {
  keyFor(name);
  return connect({ name, manifest_url: manifestUrlFor(name) }, name);
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
// host sends a mutating message with its session token, waits for the
// expected ack type (or a structured error).
function sendMut(rec, obj, expectType) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      rec.ws.removeListener("message", onMsg);
      reject(new Error(`no ack (${expectType}) for ${obj.type}`));
    }, 8000);
    const onMsg = (raw) => {
      let m;
      try {
        m = JSON.parse(raw);
      } catch {
        return;
      }
      if (m.type === expectType || m.type === "error") {
        clearTimeout(timer);
        rec.ws.removeListener("message", onMsg);
        resolve(m);
      }
    };
    rec.ws.on("message", onMsg);
    rec.ws.send(JSON.stringify({ ...obj, session_token: rec.token, protocol_version: "1.0" }));
  });
}
const hostSend = (host, obj, expectType) => sendMut(host, obj, expectType);
function readTrustFile() {
  try {
    return JSON.parse(fs.readFileSync(TRUST_FILE, "utf8"));
  } catch {
    return null;
  }
}
function dayAgo(n) {
  return new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
}

async function main() {
  await new Promise((r) => fixture.listen(FIXTURE_PORT, "127.0.0.1", r));
  await startLobby();
  const conns = [];
  const seenIds = new Set();
  const track = (r) => {
    conns.push(r);
    if (r.helloOk && r.helloOk.agent_id) seenIds.add(r.helloOk.agent_id);
    return r;
  };

  try {
    // 1. tier on join -------------------------------------------------------
    const newbie = track(await connect({ name: T("Newbie") }));
    check("unverified hello -> trust 'new'", newbie.helloOk.trust === "new", JSON.stringify(newbie.helloOk.trust));
    const vera = track(await vconnect(T("Vera")));
    check("verified hello -> trust 'verified'", vera.helloOk.trust === "verified", JSON.stringify(vera.helloOk.trust));
    check(
      "verified badge and trust badge stay distinct fields",
      vera.helloOk.verified === "verified" && vera.helloOk.trust === "verified",
      JSON.stringify({ verified: vera.helloOk.verified, trust: vera.helloOk.trust })
    );

    // 2. roster + presence payloads ------------------------------------------
    const state = await waitFor(
      vera,
      (m) => m.type === "state" && m.agents && m.agents.some((a) => a.name === T("Vera")),
      8000
    );
    const veraEntry = state && state.agents.find((a) => a.name === T("Vera"));
    const newEntry = state && state.agents.find((a) => a.name === T("Newbie"));
    check("state roster carries trust", !!veraEntry && veraEntry.trust === "verified", JSON.stringify(veraEntry));
    check("state roster: new agent trust 'new'", !!newEntry && newEntry.trust === "new", JSON.stringify(newEntry));

    // presence event for a fresh join (PR #7 subscribe)
    const watcher = track(await connect({ name: T("Watcher") }));
    watcher.ws.send(JSON.stringify({ type: "subscribe", events: ["presence"], protocol_version: "1.0" }));
    await waitFor(watcher, (m) => m.type === "subscribed", 5000);
    const joiner = track(await vconnect(T("Joiner")));
    const pev = await waitFor(
      watcher,
      (m) => m.type === "event" && m.event === "presence" && m.presence === "join" && m.name === T("Joiner"),
      8000
    );
    check("presence event carries trust", !!pev && pev.trust === "verified", JSON.stringify(pev));
    check(
      "presence event keeps verified distinct",
      !!pev && pev.verified === "verified" && pev.trust === "verified",
      JSON.stringify(pev)
    );

    // 3. host promote / demote ------------------------------------------------
    keyFor("HostMuse");
    const host = track(await vconnect("HostMuse"));
    const promo = await hostSend(host, { type: "trust_promote", agent: T("Vera") }, "trust_promoted");
    check(
      "host trust_promote -> trusted",
      promo.type === "trust_promoted" && promo.trust === "trusted",
      JSON.stringify(promo).slice(0, 160)
    );
    const changed = await waitFor(vera, (m) => m.type === "trust_changed" && m.trust === "trusted", 6000);
    check("agent notified of promotion", !!changed, "no trust_changed");
    const demote = await hostSend(host, { type: "trust_demote", agent: T("Vera") }, "trust_demoted");
    check(
      "host trust_demote -> regular",
      demote.type === "trust_demoted" && demote.trust === "regular",
      JSON.stringify(demote).slice(0, 160)
    );

    // 4. authorization boundaries ----------------------------------------------
    const notHostRes = await sendMut(vera, { type: "trust_promote", agent: T("Joiner") }, "trust_promoted");
    check(
      "non-host promote denied (scope gate + host check)",
      notHostRes.type === "error" &&
        (notHostRes.code === "HOST_ONLY" || notHostRes.code === "INSUFFICIENT_SCOPE"),
      JSON.stringify(notHostRes).slice(0, 120)
    );
    const badTarget = await hostSend(host, { type: "trust_promote", agent: T("Newbie") }, "trust_promoted");
    check(
      "promote unverified -> TRUST_IDENTITY_REQUIRED",
      badTarget.type === "error" && badTarget.code === "TRUST_IDENTITY_REQUIRED",
      JSON.stringify(badTarget).slice(0, 160)
    );

    // 5. upheld report demotes --------------------------------------------------
    const reporter = track(await vconnect(T("Reporter")));
    const repAck = await hostSend(reporter, {
      type: "report",
      target: T("Vera"),
      reason: "test report for trust demotion",
    }, "report_ok");
    const repId = repAck.type === "report_ok" ? repAck.id : null;
    check("report filed", repAck.type === "report_ok" && !!repId, JSON.stringify(repAck).slice(0, 120));
    // Vera is currently "regular" (promoted then demoted); upheld -> "verified"
    const resUpheld = await hostSend(host, { type: "resolve_report", id: repId, outcome: "upheld" }, "report_resolved");
    check(
      "resolve upheld -> demote one tier",
      resUpheld.type === "report_resolved" && resUpheld.outcome === "upheld" && resUpheld.trust === "verified",
      JSON.stringify(resUpheld).slice(0, 160)
    );
    const tf1 = readTrustFile();
    const veraRec1 = tf1 && Object.entries(tf1).find(([id]) => id === vera.helloOk.agent_id);
    check(
      "upheld report counted on record",
      !!veraRec1 && veraRec1[1].upheldReports === 1,
      JSON.stringify(veraRec1 && veraRec1[1])
    );

    const repAck2 = await hostSend(reporter, { type: "report", target: T("Vera"), reason: "second test report" }, "report_ok");
    const resDismiss = await hostSend(host, { type: "resolve_report", id: repAck2.id, outcome: "dismissed" }, "report_resolved");
    check(
      "resolve dismissed -> no demotion",
      resDismiss.type === "report_resolved" && resDismiss.outcome === "dismissed" && resDismiss.trust === null,
      JSON.stringify(resDismiss).slice(0, 160)
    );

    // 6. quarantine demotes, release does not restore ----------------------------
    // re-promote Vera to trusted first (host grant works despite the upheld flag)
    await hostSend(host, { type: "trust_promote", agent: T("Vera") }, "trust_promoted");
    const q = await hostSend(host, { type: "quarantine", agent: T("Vera") }, "quarantine_ok");
    check("quarantine ok", q.type === "quarantine_ok", JSON.stringify(q).slice(0, 120));
    const rel1 = await hostSend(host, { type: "release", agent: T("Vera") }, "release_ok");
    check("release ok", rel1.type === "release_ok", JSON.stringify(rel1).slice(0, 120));
    // re-hello to read the live tier
    vera.ws.close();
    const vera2 = track(await vconnect(T("Vera")));
    check(
      "quarantine demoted one tier (trusted -> regular)",
      vera2.helloOk.trust === "regular",
      JSON.stringify(vera2.helloOk.trust)
    );

    // 7. sustained presence -> regular (simulated days) ---------------------------
    // Vera is "regular" now with 1 upheld report -> cannot auto-promote; use Joiner.
    await stopLobby();
    const tf = readTrustFile() || {};
    const joinerId = joiner.helloOk.agent_id;
    if (tf[joinerId]) {
      tf[joinerId].daysSeen = [dayAgo(3), dayAgo(2), dayAgo(1)];
      tf[joinerId].upheldReports = 0;
      tf[joinerId].quarantines = 0;
      fs.writeFileSync(TRUST_FILE, JSON.stringify(tf));
    }
    await startLobby();
    const joiner2 = track(await vconnect(T("Joiner")));
    check(
      "3 distinct presence days -> automatic regular",
      joiner2.helloOk.trust === "regular",
      JSON.stringify(joiner2.helloOk.trust)
    );

    // 8. restart persistence -------------------------------------------------------
    const host2 = track(await vconnect("HostMuse"));
    await hostSend(host2, { type: "trust_promote", agent: T("Joiner") }, "trust_promoted");
    await stopLobby();
    await startLobby();
    const joiner3 = track(await vconnect(T("Joiner")));
    check("trusted survives restart", joiner3.helloOk.trust === "trusted", JSON.stringify(joiner3.helloOk.trust));
    const tf3 = readTrustFile();
    const jrec = tf3 && tf3[joiner3.helloOk.agent_id];
    check(
      "promotion history persisted",
      !!jrec && Array.isArray(jrec.history) && jrec.history.some((h) => h.to === "trusted"),
      JSON.stringify(jrec && jrec.history)
    );

    // 9. quota ladder unit check ----------------------------------------------------
    console.log("unit: trust-tier quota ladder");
    let ladderOk = true;
    for (const bucket of ["say", "room_switch", "invite", "board"]) {
      const q = PROTO.TIERED_QUOTAS[bucket];
      const ok =
        !!q &&
        q.new.max < q.verified.max &&
        q.verified.max < q.regular.max &&
        q.regular.max < q.trusted.max &&
        q.trusted.max < q.host.max;
      if (!ok) ladderOk = false;
      check(`quota ladder ${bucket}: new < verified < regular < trusted < host`, ok, JSON.stringify(q));
    }
    void ladderOk;
  } finally {
    for (const c of conns) {
      try {
        c.ws.close();
      } catch {
        /* ignore */
      }
    }
    await stopLobby();
    fixture.close();
    // tidy the shared data dir: drop this run's trust records
    try {
      const tf = readTrustFile();
      if (tf) {
        for (const id of seenIds) delete tf[id];
        fs.writeFileSync(TRUST_FILE, JSON.stringify(tf));
      }
    } catch {
      /* ignore */
    }
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("fatal:", e.message);
  process.exit(1);
});
