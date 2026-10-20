// Host ban/unban tests.
//
// Spawns a real lobby server child plus a fixture manifest server with
// two verified identities (a host muse and a target muse) and exercises,
// over WebSocket, against a LOCAL lobby only:
//   1. a non-host verified agent cannot ban (HOST_ONLY)
//   2. host bans a live agent: ban_ok, target gets {type:"banned"} and
//      its socket is closed by the server
//   3. the banned identity is refused at the door on a fresh connection
//      (BANNED error, no hello_ok) after answering proof-of-control
//   4. list_bans shows the ban with its reason
//   5. the ban persists across a server restart
//   6. host unbans the (offline) agent by name: unban_ok, and the agent
//      can hello again
//   7. the host cannot ban itself
//
//   node test/ban.js
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
const PORT = 18894;
const FIXTURE_PORT = 18895;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "commons-ban-test-"));

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? " - " + detail : ""}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- fixture identities: two Ed25519 keypairs, two manifests -------------
function makeIdentity(name, keyId) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const pubB64 = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url").toString("base64");
  return {
    name,
    manifest: { muse: { name, serves: "Fixture" }, signing_key: { alg: "ed25519", key_id: keyId, pubkey: pubB64 } },
    sign: (nonce) =>
      crypto.sign(null, Buffer.from("muse-commons/v1/challenge:" + nonce, "utf8"), privateKey).toString("base64"),
  };
}
const HOST = makeIdentity("HostMuse", "ban-fixture-host");
const TARGET = makeIdentity("BadMuse", "ban-fixture-target");
const HOST_URL = `http://127.0.0.1:${FIXTURE_PORT}/host/.well-known/muse-protocol.json`;
const TARGET_URL = `http://127.0.0.1:${FIXTURE_PORT}/bad/.well-known/muse-protocol.json`;
const fixture = http.createServer((req, res) => {
  const id = req.url.startsWith("/bad/") ? TARGET : HOST;
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(id.manifest));
});

function startLobby() {
  return spawn("node", [LOBBY], {
    env: {
      ...process.env,
      PORT: String(PORT),
      LOBBY_DATA_DIR: DATA_DIR,
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

// Verified connect: answers the proof-of-control challenge. Resolves with
// {ws, msgs, helloOk} on hello_ok, or {ws, msgs, error} on a hello error.
function vconnect(identity, manifestUrl) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    const rec = { ws, name: identity.name, msgs: [], helloOk: null, error: null, closed: null };
    rec.closedPromise = new Promise((r) => ws.on("close", (code) => r(code)));
    const timer = setTimeout(() => resolve(rec), 10000);
    ws.on("open", () =>
      ws.send(JSON.stringify({ type: "hello", name: identity.name, protocol_version: "1.0", manifest_url: manifestUrl }))
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
        ws.send(JSON.stringify({ type: "challenge_response", challenge_id: m.challenge_id, signature: identity.sign(m.nonce) }));
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
    ws.on("error", () => {});
  });
}

// Wait until pred(msgs) is true or timeout; returns the matching message.
async function waitForMsg(rec, pred, ms = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const hit = rec.msgs.find(pred);
    if (hit) return hit;
    await sleep(50);
  }
  return null;
}

function send(rec, obj) {
  rec.ws.send(JSON.stringify({ ...obj, session_token: rec.helloOk ? rec.helloOk.session_token : undefined }));
}

async function main() {
  fixture.listen(FIXTURE_PORT, "127.0.0.1");
  let lobby = startLobby();
  await waitForListening(lobby);

  // Connect host + target.
  const host = await vconnect(HOST, HOST_URL);
  check("host hello_ok", !!host.helloOk, JSON.stringify(host.error));
  const target = await vconnect(TARGET, TARGET_URL);
  check("target hello_ok", !!target.helloOk, JSON.stringify(target.error));

  // 1. Non-host cannot ban. (The scope gate answers INSUFFICIENT_SCOPE
  // before the handler's HOST_ONLY check; either refusal is correct.)
  send(target, { type: "ban", agent: "HostMuse" });
  const nh = await waitForMsg(target, (m) => m.type === "error" && (m.code === "HOST_ONLY" || m.code === "INSUFFICIENT_SCOPE"));
  check("non-host ban refused (HOST_ONLY or INSUFFICIENT_SCOPE)", !!nh);

  // 2. Host bans the live target.
  send(host, { type: "ban", agent: "BadMuse", reason: "test ban" });
  const banOk = await waitForMsg(host, (m) => m.type === "ban_ok");
  check("host ban_ok", !!banOk && banOk.name === "BadMuse", JSON.stringify(host.msgs.slice(-3)));
  const bannedNote = await waitForMsg(target, (m) => m.type === "banned");
  check("target notified with banned", !!bannedNote);
  const closeCode = await Promise.race([target.closedPromise, sleep(5000).then(() => null)]);
  check("target socket closed by server (1008)", closeCode === 1008, `code=${closeCode}`);

  // 3. Banned identity refused at the door on a fresh connection.
  const retry = await vconnect(TARGET, TARGET_URL);
  check("banned re-hello refused with BANNED", !!retry.error && retry.error.code === "BANNED" && !retry.helloOk, JSON.stringify(retry.error));
  if (retry.ws.readyState === WebSocket.OPEN) retry.ws.close();

  // 4. list_bans shows it.
  send(host, { type: "list_bans" });
  const listMsg = await waitForMsg(host, (m) => m.type === "bans");
  check(
    "list_bans shows the ban with reason",
    !!listMsg && listMsg.bans.length === 1 && listMsg.bans[0].name === "BadMuse" && listMsg.bans[0].reason === "test ban",
    JSON.stringify(listMsg)
  );

  // 7 (early, while host is connected). Host cannot ban itself.
  send(host, { type: "ban", agent: "HostMuse" });
  const selfBan = await waitForMsg(host, (m) => m.type === "error" && m.code === "INVALID_MESSAGE");
  check("host cannot ban itself", !!selfBan);

  // 5. Restart: the ban persists.
  host.ws.close();
  lobby.kill("SIGTERM");
  await sleep(700);
  lobby = startLobby();
  await waitForListening(lobby);
  const host2 = await vconnect(HOST, HOST_URL);
  check("host re-hello after restart", !!host2.helloOk, JSON.stringify(host2.error));
  const retry2 = await vconnect(TARGET, TARGET_URL);
  check("ban persists across restart", !!retry2.error && retry2.error.code === "BANNED", JSON.stringify(retry2.error));
  if (retry2.ws.readyState === WebSocket.OPEN) retry2.ws.close();

  // 6. Unban the offline agent by name; admission restored.
  send(host2, { type: "unban", agent: "BadMuse" });
  const unbanOk = await waitForMsg(host2, (m) => m.type === "unban_ok");
  check("unban_ok for offline agent", !!unbanOk, JSON.stringify(host2.msgs.slice(-3)));
  const back = await vconnect(TARGET, TARGET_URL);
  check("unbanned agent admitted again", !!back.helloOk, JSON.stringify(back.error));
  if (back.ws.readyState === WebSocket.OPEN) back.ws.close();
  host2.ws.close();

  lobby.kill("SIGTERM");
  fixture.close();
  await sleep(300);
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("test crashed:", e);
  process.exit(1);
});
