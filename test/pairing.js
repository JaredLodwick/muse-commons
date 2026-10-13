// Human-to-agent pairing (login) tests.
//
// A verified agent requests a pairing code over its own socket, hands it to
// its human out-of-band; the human redeems it to link their browser session
// to the agent's identity (private rooms, DM history, mentions). No user
// database: trust rides the agent-to-human channel.
//
// Spawns a real lobby child plus a fixture manifest server. No live traffic.
//   node test/pairing.js
// Exit 0 = all pass, 1 = any failure.
const http = require("http");
const fs = require("fs");
const { spawn } = require("child_process");
const path = require("path");
const crypto = require("crypto");
const WebSocket = require("ws");

const REPO = path.join(__dirname, "..");
const LOBBY = path.join(REPO, "server", "lobby.js");
const PORT = 18841;
const FIXTURE_PORT = 18840;

const { privateKey: FIX_PRIV, publicKey: FIX_PUB } = crypto.generateKeyPairSync("ed25519");
const FIX_PUB_B64 = Buffer.from(FIX_PUB.export({ format: "jwk" }).x, "base64url").toString("base64");
const FIX_SIGNING_KEY = { alg: "ed25519", key_id: "fixture-pairing", pubkey: FIX_PUB_B64 };
function signChallenge(nonce) {
  return crypto.sign(null, Buffer.from("muse-commons/v1/challenge:" + nonce, "utf8"), FIX_PRIV).toString("base64");
}

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  ok   ${name}`);
  else { failures++; console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const fixture = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    muse: {
      name: "PairMuse",
      serves: "Tester",
      lobbies: [{ url: `http://127.0.0.1:${PORT}/`, name: "muse-commons", home: true }],
    },
    signing_key: FIX_SIGNING_KEY,
  }));
});

function startLobby() {
  return spawn("node", [LOBBY], {
    env: {
      ...process.env,
      PORT: String(PORT),
      MANIFEST_ALLOW_PRIVATE: "1",
      LOBBY_PUBLIC_URL: `http://127.0.0.1:${PORT}/`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}
function waitForListening(child) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("server did not start")), 15000);
    let out = "";
    const onData = (d) => { out += d.toString(); if (out.includes("listening")) { clearTimeout(timer); child.stdout.off("data", onData); resolve(); } };
    child.stdout.on("data", onData);
    child.on("exit", (c) => { clearTimeout(timer); reject(new Error(`server exited ${c}: ${out}`)); });
  });
}

// Raw socket helper: send a message, resolve with the first response of one
// of the expected types.
function rawSocket() {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    ws.on("open", () => res(ws));
    ws.on("error", rej);
  });
}
function sendAndWait(ws, msg, types, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { ws.off("message", h); resolve({ timeout: true }); }, timeoutMs);
    const h = (raw) => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (types.includes(m.type)) { clearTimeout(timer); ws.off("message", h); resolve(m); }
    };
    ws.on("message", h);
    ws.send(JSON.stringify(msg));
  });
}
// Verified agent hello; keeps the socket open. Answers the challenge.
async function verifiedAgent() {
  const ws = await rawSocket();
  const helloP = sendAndWait(ws, {
    type: "hello", name: "PairMuse", serves: "Tester", room: "plaza",
    manifest_url: `http://127.0.0.1:${FIXTURE_PORT}/.well-known/muse-protocol.json`,
  }, ["state", "error"], 15000);
  // Answer challenges until admitted (state shows us).
  const admitted = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 15000);
    const h = (raw) => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (m.type === "challenge") {
        ws.send(JSON.stringify({ type: "challenge_response", challenge_id: m.challenge_id, signature: signChallenge(m.nonce) }));
      } else if (m.type === "state" && m.agents && m.agents.some((a) => a.name === "PairMuse" && a.verified === "verified")) {
        clearTimeout(timer); ws.off("message", h);
        resolve(m.agents.find((a) => a.name === "PairMuse"));
      } else if (m.type === "error") {
        clearTimeout(timer); ws.off("message", h); resolve({ error: m.code });
      }
    };
    ws.on("message", h);
  });
  return { ws, agent: admitted };
}
async function viewerHello(ws, extra = {}) {
  const r = await sendAndWait(ws, { type: "hello", kind: "viewer", room: "plaza", ...extra }, ["hello_ok", "error"]);
  return r;
}

async function main() {
  await new Promise((r) => fixture.listen(FIXTURE_PORT, "127.0.0.1", r));
  let child = startLobby();
  await waitForListening(child);
  console.log("human-to-agent pairing");

  // 1. verified agent requests a code
  const { ws: agentWs, agent } = await verifiedAgent();
  check("verified agent admitted", !!agent && !agent.error, agent && agent.error);
  const codeResp = await sendAndWait(agentWs, { type: "request_pairing_code" }, ["pairing_code", "error"]);
  check("verified agent gets a pairing code", codeResp.type === "pairing_code", codeResp.code || codeResp.type);
  const code = codeResp.code || "";
  check("code is 6 unambiguous chars", /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/.test(code), code);
  check("code expiry advertised", codeResp.expires_in === 600, String(codeResp.expires_in));

  // 2. unverified socket cannot request a code
  const anonWs = await rawSocket();
  await viewerHello(anonWs);
  const denied = await sendAndWait(anonWs, { type: "request_pairing_code" }, ["pairing_code", "error"]);
  check("viewer cannot request a pairing code", denied.type === "error" && denied.code === "PAIRING_FORBIDDEN", denied.code || denied.type);

  // 3. redeem the valid code on a fresh viewer socket
  const viewerWs = await rawSocket();
  await viewerHello(viewerWs);
  const ok = await sendAndWait(viewerWs, { type: "redeem_pairing_code", code }, ["pairing_ok", "error"]);
  check("valid code redeems", ok.type === "pairing_ok", ok.code || ok.type);
  check("pairing_ok carries a token", !!ok.token && /^[0-9a-f]{64}$/.test(ok.token || ""), (ok.token || "").slice(0, 12));
  check("pairing_ok names the agent", ok.agent && ok.agent.name === "PairMuse", ok.agent && ok.agent.name);
  const token = ok.token;

  // 4. double-use fails
  const viewer2 = await rawSocket();
  await viewerHello(viewer2);
  const reuse = await sendAndWait(viewer2, { type: "redeem_pairing_code", code }, ["pairing_ok", "error"]);
  check("used code rejected", reuse.type === "error" && reuse.code === "BAD_PAIRING_CODE", reuse.code || reuse.type);

  // 5. bad code fails (vague error)
  const bad = await sendAndWait(viewer2, { type: "redeem_pairing_code", code: "ZZZZZZ" }, ["pairing_ok", "error"]);
  check("bad code rejected", bad.type === "error" && bad.code === "BAD_PAIRING_CODE", bad.code || bad.type);

  // 6. linked session sees the agent's private rooms. Agent makes one first.
  const roomResp = await sendAndWait(agentWs, { type: "create_room", topic: "#pair-test", visibility: "private", entry: "invite" }, ["room_created", "error"]);
  check("agent created a private room", roomResp.type === "room_created", roomResp.code || roomResp.type);
  const privRoomId = roomResp.room_id;
  // The linked viewer's plaza state should carry the private room directory.
  const stateWithPriv = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 8000);
    const h = (raw) => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (m.type === "state" && Array.isArray(m.rooms) && m.rooms.some((r) => r.room_id === privRoomId)) {
        clearTimeout(timer); viewerWs.off("message", h); resolve(m);
      }
    };
    viewerWs.on("message", h);
  });
  check("linked browser sees the private room", !!stateWithPriv, "not in directory");
  // An unlinked viewer must not.
  const anonState = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 8000);
    const h = (raw) => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (m.type === "state" && Array.isArray(m.rooms)) {
        clearTimeout(timer); anonWs.off("message", h); resolve(m);
      }
    };
    anonWs.on("message", h);
  });
  check("unlinked viewer does not see the private room",
    !!anonState && !anonState.rooms.some((r) => r.room_id === privRoomId), "leaked");

  // 7. link_token on hello re-links a fresh socket
  const viewer3 = await rawSocket();
  const hello3 = await viewerHello(viewer3, { link_token: token });
  check("hello with link_token succeeds", hello3.type === "hello_ok", hello3.code || hello3.type);
  const state3 = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 8000);
    const h = (raw) => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (m.type === "state" && Array.isArray(m.rooms) && m.rooms.some((r) => r.room_id === privRoomId)) {
        clearTimeout(timer); viewer3.off("message", h); resolve(m);
      }
    };
    viewer3.on("message", h);
  });
  check("re-linked socket sees the private room", !!state3, "not in directory");

  // 8. bad link_token errors but leaves the socket usable
  const viewer4 = await rawSocket();
  const errs = [];
  const hello4P = new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 8000);
    const h = (raw) => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (m.type === "error" && m.code === "BAD_LINK_TOKEN") errs.push(m);
      if (m.type === "hello_ok") { clearTimeout(timer); viewer4.off("message", h); resolve(m); }
    };
    viewer4.on("message", h);
    viewer4.send(JSON.stringify({ type: "hello", kind: "viewer", room: "plaza", link_token: "deadbeef" }));
  });
  const hello4 = await hello4P;
  check("bad link_token errors, hello still ok", hello4 && hello4.type === "hello_ok" && errs.length === 1,
    hello4 ? `errs=${errs.length}` : "no hello_ok");

  // 9. logout revokes the token
  const out = await sendAndWait(viewerWs, { type: "logout" }, ["ok", "error"]);
  check("logout acks", out.type === "ok", out.code || out.type);
  const viewer5 = await rawSocket();
  const errs5 = [];
  const hello5P = new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 8000);
    const h = (raw) => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (m.type === "error" && m.code === "BAD_LINK_TOKEN") errs5.push(m);
      if (m.type === "hello_ok") { clearTimeout(timer); viewer5.off("message", h); resolve(m); }
    };
    viewer5.on("message", h);
    viewer5.send(JSON.stringify({ type: "hello", kind: "viewer", room: "plaza", link_token: token }));
  });
  const hello5 = await hello5P;
  check("revoked token rejected on next hello", hello5 && hello5.type === "hello_ok" && errs5.length === 1,
    hello5 ? `errs=${errs5.length}` : "no hello_ok");

  // 10. redeem rate limit: 5 bad attempts then the 6th is rate-limited
  const viewer6 = await rawSocket();
  await viewerHello(viewer6);
  let limited = false;
  for (let i = 0; i < 6; i++) {
    const r = await sendAndWait(viewer6, { type: "redeem_pairing_code", code: "QQQQQQ" }, ["pairing_ok", "error"]);
    if (r.type === "error" && r.code === "RATE_LIMITED") limited = true;
  }
  check("redeem rate limit trips after 5 attempts", limited, "never limited");

  // 11. logout_all revokes every token for the identity, on all sockets.
  // Fresh code + two linked sockets, then logout_all from one.
  const code2 = (await sendAndWait(agentWs, { type: "request_pairing_code" }, ["pairing_code", "error"])).code;
  const va = await rawSocket(); await viewerHello(va);
  const vb = await rawSocket(); await viewerHello(vb);
  // Need two codes (single-use): request a second one.
  const code3 = (await sendAndWait(agentWs, { type: "request_pairing_code" }, ["pairing_code", "error"])).code;
  const oka = await sendAndWait(va, { type: "redeem_pairing_code", code: code2 }, ["pairing_ok", "error"]);
  const okb = await sendAndWait(vb, { type: "redeem_pairing_code", code: code3 }, ["pairing_ok", "error"]);
  check("two sessions linked", oka.type === "pairing_ok" && okb.type === "pairing_ok", "redeem failed");
  const outAll = await sendAndWait(va, { type: "logout_all" }, ["ok", "error"]);
  check("logout_all acks", outAll.type === "ok", outAll.code || outAll.type);
  const vc = await rawSocket();
  const errsC = [];
  const helloCP = new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 8000);
    const h = (raw) => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (m.type === "error" && m.code === "BAD_LINK_TOKEN") errsC.push(m);
      if (m.type === "hello_ok") { clearTimeout(timer); vc.off("message", h); resolve(m); }
    };
    vc.on("message", h);
    vc.send(JSON.stringify({ type: "hello", kind: "viewer", room: "plaza", link_token: oka.token }));
  });
  const helloC = await helloCP;
  check("logout_all revoked the other session's token", helloC && helloC.type === "hello_ok" && errsC.length === 1,
    helloC ? `errs=${errsC.length}` : "no hello_ok");

  // 12. link tokens persist across restarts with a 30-day expiry.
  const LINK_FILE = path.join(REPO, "data", "link-tokens.json");
  async function restartLobby() {
    const old = child;
    old.kill();
    await new Promise((r) => { old.once("exit", r); setTimeout(r, 8000); });
    await sleep(500);
    child = startLobby();
    await waitForListening(child);
  }
  async function helloWithToken(tok) {
    const w = await rawSocket();
    const errs = [];
    const helloP = new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 8000);
      const h = (raw) => {
        let m; try { m = JSON.parse(raw); } catch { return; }
        if (m.type === "error" && m.code === "BAD_LINK_TOKEN") errs.push(m);
        if (m.type === "hello_ok") { clearTimeout(timer); w.off("message", h); resolve({ w, m }); }
      };
      w.on("message", h);
      w.send(JSON.stringify({ type: "hello", kind: "viewer", room: "plaza", link_token: tok }));
    });
    const r = await helloP;
    return { w, ok: !!(r && r.m), badTokenErrs: errs.length };
  }
  const code4 = (await sendAndWait(agentWs, { type: "request_pairing_code" }, ["pairing_code", "error"])).code;
  const vd = await rawSocket(); await viewerHello(vd);
  const okd = await sendAndWait(vd, { type: "redeem_pairing_code", code: code4 }, ["pairing_ok", "error"]);
  check("redeem for persistence test", okd.type === "pairing_ok", okd.code || okd.type);
  const tokD = okd.token;
  let saved = null;
  try { saved = JSON.parse(fs.readFileSync(LINK_FILE, "utf8")); } catch {}
  const recD = saved && saved[tokD];
  const skewMs = recD ? recD.expiresAt - Date.now() : -1;
  check("token persisted with ~30-day expiry",
    !!recD && skewMs > 29 * 864e5 && skewMs < 31 * 864e5,
    recD ? ("skew=" + Math.round(skewMs / 36e5) + "h") : "token not in file");

  await restartLobby();
  const re = await helloWithToken(tokD);
  check("token survives restart", re.ok && re.badTokenErrs === 0, "rejected after restart");

  // An expired token in the file is rejected and pruned.
  let saved2 = {};
  try { saved2 = JSON.parse(fs.readFileSync(LINK_FILE, "utf8")); } catch {}
  saved2["expired-test-token"] = {
    agentId: "test-agent", agentName: "X", serves: "", avatar: null,
    createdAt: Date.now() - 864e5, expiresAt: Date.now() - 1000,
  };
  fs.writeFileSync(LINK_FILE, JSON.stringify(saved2));
  await restartLobby();
  const rf = await helloWithToken("expired-test-token");
  check("expired token rejected", rf.ok && rf.badTokenErrs === 1, "not rejected");
  let saved3 = {};
  try { saved3 = JSON.parse(fs.readFileSync(LINK_FILE, "utf8")); } catch {}
  check("expired token pruned from file", !saved3["expired-test-token"], "still present");

  for (const w of [agentWs, anonWs, viewerWs, viewer2, viewer3, viewer4, viewer5, viewer6, va, vb, vc, vd, re.w, rf.w]) {
    try { w.close(); } catch {}
  }
  child.kill();
  fixture.close();
  await sleep(300);
  try { fs.unlinkSync(LINK_FILE); } catch {} // don't leave test tokens in the dev data dir
  console.log(failures === 0 ? "PASS" : `${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error("fatal", e); process.exit(1); });
