// Phase 3 manifest-verification tests.
//
// Spawns real lobby server children plus a fixture manifest server and
// exercises the full hello -> verify -> admit/reject path over WebSocket.
//
//   node test/manifest-verify.js
//
// Exit 0 = all pass, 1 = any failure.
const http = require("http");
const { spawn } = require("child_process");
const path = require("path");
const WebSocket = require("ws");

const REPO = path.join(__dirname, "..");
const LOBBY = path.join(REPO, "server", "lobby.js");
const PORT1 = 18771; // MANIFEST_ALLOW_PRIVATE=1 (fixture manifests are loopback)
const PORT2 = 18772; // strict SSRF (no private IPs)
const FIXTURE_PORT = 18770;

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
}

// --- fixture manifest server (loopback HTTP) ---
let fixtureHits = 0;
const fixture = http.createServer((req, res) => {
  fixtureHits++;
  const p = req.url.split("?")[0];
  const send = (code, obj, raw) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(raw !== undefined ? raw : JSON.stringify(obj));
  };
  const lobbyUrl = `http://127.0.0.1:${PORT1}/`;
  if (p === "/good/.well-known/muse-protocol.json") {
    send(200, {
      muse: {
        name: "FixtureMuse",
        serves: "Tester",
        avatar_url: `http://127.0.0.1:${FIXTURE_PORT}/ava.png`,
        lobbies: [{ url: lobbyUrl, name: "muse-commons", home: true }],
      },
    });
  } else if (p === "/nolobbies/.well-known/muse-protocol.json") {
    send(200, { muse: { name: "NoLobbyMuse", serves: "Tester" } });
  } else if (p === "/wronglobby/.well-known/muse-protocol.json") {
    send(200, {
      muse: {
        name: "WrongMuse",
        serves: "Tester",
        lobbies: ["https://example.com/some-other-lobby/"],
      },
    });
  } else if (p === "/badjson/.well-known/muse-protocol.json") {
    send(200, null, "{ this is not json");
  } else if (p === "/noname/.well-known/muse-protocol.json") {
    send(200, { foo: "bar" });
  } else if (p === "/slow/.well-known/muse-protocol.json") {
    // never responds: exercises the fetch timeout (client gives up first)
    // (connection left hanging on purpose)
  } else {
    send(404, { error: "nope" });
  }
});

function startLobby(port, extraEnv = {}) {
  const child = spawn("node", [LOBBY], {
    env: { ...process.env, PORT: String(port), ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return child;
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

// Connect, send hello, resolve with {ok:true, agent} once the agent shows up
// in a state broadcast, or {ok:false, error} on the first error message.
function helloAndWait(port, helloMsg, timeoutMs = 12000) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const name = helloMsg.name;
    let done = false;
    const finish = (result) => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        ws.close();
        resolve(result);
      }
    };
    const timer = setTimeout(() => finish({ ok: false, reason: "timeout waiting for admit/error" }), timeoutMs);
    ws.on("open", () => ws.send(JSON.stringify(helloMsg)));
    ws.on("message", (raw) => {
      let m;
      try {
        m = JSON.parse(raw);
      } catch {
        return;
      }
      if (m.type === "error") finish({ ok: false, error: m.message });
      else if (m.type === "state" && m.agents && m.agents.some((a) => a.name === name)) {
        finish({ ok: true, agent: m.agents.find((a) => a.name === name) });
      }
    });
    ws.on("error", (e) => finish({ ok: false, reason: "ws error: " + e.message }));
  });
}

function viewerState(port, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    let done = false;
    const finish = (r) => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        ws.close();
        resolve(r);
      }
    };
    const timer = setTimeout(() => finish({ ok: false }), timeoutMs);
    ws.on("open", () => ws.send(JSON.stringify({ type: "hello", kind: "viewer", room: "plaza" })));
    ws.on("message", (raw) => {
      let m;
      try {
        m = JSON.parse(raw);
      } catch {
        return;
      }
      if (m.type === "state") finish({ ok: true, state: m });
    });
    ws.on("error", () => finish({ ok: false }));
  });
}

async function main() {
  await new Promise((r) => fixture.listen(FIXTURE_PORT, "127.0.0.1", r));
  const s1 = startLobby(PORT1, {
    MANIFEST_ALLOW_PRIVATE: "1",
    LOBBY_PUBLIC_URL: `http://127.0.0.1:${PORT1}/`,
  });
  const s2 = startLobby(PORT2, { LOBBY_PUBLIC_URL: `http://127.0.0.1:${PORT2}/` });
  await waitForListening(s1, PORT1);
  await waitForListening(s2, PORT2);
  const fix = (p) => `http://127.0.0.1:${FIXTURE_PORT}${p}`;

  console.log("manifest verification");

  // 1. good manifest -> verified, badge present, avatar_url used
  let r = await helloAndWait(PORT1, {
    type: "hello", name: "GoodMuse", serves: "Tester",
    manifest_url: fix("/good/.well-known/muse-protocol.json"),
  });
  check("good manifest admitted", r.ok, JSON.stringify(r).slice(0, 200));
  check("good manifest -> verified", r.ok && r.agent.verified === "verified", r.agent && r.agent.verified);
  check(
    "manifest avatar_url used for portrait",
    r.ok && r.agent.image === fix("/ava.png"),
    r.agent && r.agent.image
  );

  // 2. manifest without lobbies -> verified (check skipped, it's optional)
  r = await helloAndWait(PORT1, {
    type: "hello", name: "NoLobbyMuse", manifest_url: fix("/nolobbies/.well-known/muse-protocol.json"),
  });
  check("manifest without lobbies admitted as verified", r.ok && r.agent.verified === "verified");

  // 3. manifest whose lobbies don't list us -> rejected
  r = await helloAndWait(PORT1, {
    type: "hello", name: "WrongMuse", manifest_url: fix("/wronglobby/.well-known/muse-protocol.json"),
  });
  check("wrong lobbies rejected", !r.ok && /not listed/.test(r.error || ""), r.error);

  // 4. invalid JSON -> rejected with clear error
  const hitsBeforeBad = fixtureHits;
  r = await helloAndWait(PORT1, {
    type: "hello", name: "BadJsonMuse", manifest_url: fix("/badjson/.well-known/muse-protocol.json"),
  });
  check("invalid manifest rejected", !r.ok && /not valid JSON/.test(r.error || ""), r.error);

  // 5. negative cache: same bad URL again -> rejected without refetching
  r = await helloAndWait(PORT1, {
    type: "hello", name: "BadJsonMuse2", manifest_url: fix("/badjson/.well-known/muse-protocol.json"),
  });
  check("negative cache rejects again", !r.ok, r.error);
  check("negative cache avoids refetch", fixtureHits === hitsBeforeBad + 1, `hits=${fixtureHits}`);

  // 6. manifest with no identity -> rejected
  r = await helloAndWait(PORT1, {
    type: "hello", name: "NoNameMuse", manifest_url: fix("/noname/.well-known/muse-protocol.json"),
  });
  check("manifest without name rejected", !r.ok && /recognizable identity/.test(r.error || ""), r.error);

  // 7. unreachable manifest -> rejected with clear error
  r = await helloAndWait(PORT1, {
    type: "hello", name: "GoneMuse", manifest_url: "http://127.0.0.1:9/nope.json",
  });
  check("unreachable manifest rejected", !r.ok && /manifest verification failed/.test(r.error || ""), r.error);

  // 8. non-http(s) manifest_url -> rejected
  r = await helloAndWait(PORT1, {
    type: "hello", name: "FtpMuse", manifest_url: "ftp://example.com/manifest.json",
  });
  check("non-http(s) manifest_url rejected", !r.ok && /http\(s\)/.test(r.error || ""), r.error);

  console.log("ssrf protection (strict server, no MANIFEST_ALLOW_PRIVATE)");
  const hitsBeforePrivate = fixtureHits;
  r = await helloAndWait(PORT2, {
    type: "hello", name: "PrivateMuse", manifest_url: fix("/good/.well-known/muse-protocol.json"),
  });
  check("private-IP manifest rejected", !r.ok && /private address/.test(r.error || ""), r.error);
  check("private-IP manifest never fetched", fixtureHits === hitsBeforePrivate, `hits=${fixtureHits}`);

  console.log("backward compatibility");
  // 9. legacy hello (no manifest_url) -> admitted as unverified
  r = await helloAndWait(PORT1, { type: "hello", name: "LegacyMuse", serves: "Old" });
  check("legacy hello admitted", r.ok);
  check("legacy hello -> unverified", r.ok && r.agent.verified === "unverified", r.agent && r.agent.verified);

  // 10. regression: talk/say still work between legacy agents
  const wsA = new WebSocket(`ws://127.0.0.1:${PORT1}`);
  const wsB = new WebSocket(`ws://127.0.0.1:${PORT1}`);
  await Promise.all([
    new Promise((res) => wsA.on("open", res)),
    new Promise((res) => wsB.on("open", res)),
  ]);
  wsA.send(JSON.stringify({ type: "hello", name: "TalkerA" }));
  wsB.send(JSON.stringify({ type: "hello", name: "TalkerB" }));
  await new Promise((r2) => setTimeout(r2, 1500)); // let hellos land
  wsA.send(JSON.stringify({ type: "talk", from: "TalkerA", to: "TalkerB", text: "hi there" }));
  const st = await viewerState(PORT1);
  const talker = st.ok && st.state.agents.find((a) => a.name === "TalkerA");
  check("talk still works (bubble set)", !!(talker && talker.bubble === "hi there"));
  wsA.close();
  wsB.close();

  // 11. viewer path unaffected
  const v = await viewerState(PORT2);
  check("viewer hello still works", v.ok);

  fixture.close();
  s1.kill();
  s2.kill();
  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error("test harness error:", e);
  process.exit(1);
});
