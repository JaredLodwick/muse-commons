// Production origin tests (PR #5).
//
//  1. GET /api/health returns 200 with the documented shape, no private data.
//  2. incident_mode flag reflects the persisted incident state across boots.
//  3. OpenAPI spec and llms.txt advertise /api/health.
//  4. The PHP proxy whitelist includes /api/health.
//  5. TLS cert expiry math handles future/expired/unreadable certs (mocked).
//  6. checkTlsFront degrades gracefully against an unreachable host.
//  7. deploy/health-check/health-check.py exits 0 on healthy, 1 on unreachable.
//
// Spawns real lobby children on a test port. TLS network checks are disabled
// in the spawned lobby (TLS_CHECK_ENABLED=0) so tests never hit the network
// except the localhost HTTP calls.
//   node test/production-origin.js
// Exit 0 = all pass, 1 = any failure.
const http = require("http");
const path = require("path");
const fs = require("fs");
const { spawn, execFile } = require("child_process");

const REPO = path.join(__dirname, "..");
const LOBBY = path.join(REPO, "server", "lobby.js");
const PORT = 18803;
const BASE = "https://commons.example.com";
const INCIDENT_FILE = path.join(REPO, "data", "incident.json");
const HEALTH_SCRIPT = path.join(REPO, "deploy", "health-check", "health-check.py");
const PROXY_FILE = path.join(REPO, "connectors", "php-proxy", "index.php");
const { certExpiryDays, checkTlsFront } = require(path.join(REPO, "server", "tls-check.js"));

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
}

function startLobby(extraEnv) {
  return spawn("node", [LOBBY], {
    env: {
      ...process.env,
      PORT: String(PORT),
      PUBLIC_BASE_URL: BASE,
      TLS_CHECK_ENABLED: "0",
      ...(extraEnv || {}),
    },
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
function get(p) {
  return new Promise((resolve, reject) => {
    http
      .get(`http://127.0.0.1:${PORT}${p}`, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () =>
          resolve({ status: res.statusCode, headers: res.headers, body })
        );
      })
      .on("error", reject);
  });
}
function stopLobby(child) {
  return new Promise((resolve) => {
    child.on("exit", () => resolve());
    child.kill();
    setTimeout(resolve, 3000);
  });
}
function runScript(args) {
  return new Promise((resolve) => {
    execFile("python3", [HEALTH_SCRIPT, ...args], { timeout: 30000 }, (err, stdout, stderr) => {
      resolve({ code: err && typeof err.code === "number" ? err.code : err ? 1 : 0, out: (stdout || "") + (stderr || "") });
    });
  });
}

(async () => {
  // --- unit: cert expiry math (mocked certs) ---
  const future = new Date(Date.now() + 60 * 86400000).toUTCString();
  const past = new Date(Date.now() - 5 * 86400000).toUTCString();
  const daysFuture = certExpiryDays({ valid_to: future });
  check("certExpiryDays: ~60 days for future cert", daysFuture > 59 && daysFuture < 61, String(daysFuture));
  const daysPast = certExpiryDays({ valid_to: past });
  check("certExpiryDays: negative for expired cert", daysPast < 0, String(daysPast));
  check("certExpiryDays: null for missing cert", certExpiryDays(null) === null);
  check("certExpiryDays: null for unreadable valid_to", certExpiryDays({ valid_to: "not a date" }) === null);

  // --- unit: checkTlsFront never throws on unreachable host ---
  const deadState = { ok: null, error: null };
  let threw = false;
  try {
    await checkTlsFront(deadState, { host: "127.0.0.1", port: 1, warnDays: 30, timeoutMs: 3000 });
  } catch {
    threw = true;
  }
  check("checkTlsFront resolves (never rejects) on dead host", !threw);
  check("checkTlsFront records ok:false + error on dead host", deadState.ok === false && !!deadState.error, deadState.error);

  // --- integration: /api/health shape ---
  let child = startLobby();
  try {
    await waitForListening(child);
    const res = await get("/api/health");
    check("health returns 200 JSON", res.status === 200 && (res.headers["content-type"] || "").includes("application/json"));
    check("health is Cache-Control: no-store", (res.headers["cache-control"] || "") === "no-store");
    let h = null;
    try { h = JSON.parse(res.body); } catch { h = null; }
    check("health parses", !!h);
    if (h) {
      check("ok:true", h.ok === true);
      check("service name", h.service === "muse-commons", String(h.service));
      check("protocol_version 1.0", h.protocol_version === "1.0", String(h.protocol_version));
      check("uptime_seconds is a number", typeof h.uptime_seconds === "number" && h.uptime_seconds >= 0);
      check("started_at is a number", typeof h.started_at === "number");
      check("incident_mode is false by default", h.incident_mode === false);
      check("counts are numbers", typeof h.rooms === "number" && typeof h.agents === "number" && typeof h.sockets === "number");
      check("base_url uses PUBLIC_BASE_URL", h.base_url === BASE, String(h.base_url));
      check("tls block present", !!h.tls && typeof h.tls === "object");
      check("tls disabled state honest", h.tls.ok === null && h.tls.error === "disabled", JSON.stringify(h.tls));
      const blob = JSON.stringify(h);
      const leaks = ["occupants", "transcript", "\"text\"", "\"from\"", "presence", "private"].filter((k) => blob.includes(k));
      check("no private data in health payload", leaks.length === 0, "leaked keys: " + leaks.join(","));
    }

    // --- integration: openapi + llms advertise /api/health ---
    const specRes = await get("/openapi.json");
    let spec = null;
    try { spec = JSON.parse(specRes.body); } catch { spec = null; }
    check("openapi includes /api/health", !!(spec && spec.paths && spec.paths["/api/health"]));
    const llms = await get("/llms.txt");
    check("llms.txt mentions /api/health", llms.body.includes("/api/health"));
  } catch (e) {
    failures++;
    console.log(`  FAIL harness — ${e.message}`);
  } finally {
    await stopLobby(child);
  }

  // --- integration: incident_mode flag reflects persisted state ---
  const backup = fs.existsSync(INCIDENT_FILE) ? fs.readFileSync(INCIDENT_FILE, "utf8") : null;
  try {
    fs.writeFileSync(INCIDENT_FILE, JSON.stringify({ on: true, t: Date.now() }));
    child = startLobby();
    await waitForListening(child);
    const res = await get("/api/health");
    const h = JSON.parse(res.body);
    check("incident_mode true when incident.json on", h.incident_mode === true, String(h.incident_mode));
    await stopLobby(child);
  } catch (e) {
    failures++;
    console.log(`  FAIL incident-flag harness — ${e.message}`);
    try { await stopLobby(child); } catch {}
  } finally {
    if (backup !== null) fs.writeFileSync(INCIDENT_FILE, backup);
    else if (fs.existsSync(INCIDENT_FILE)) fs.unlinkSync(INCIDENT_FILE);
  }

  // --- static: proxy whitelist ---
  const proxySrc = fs.readFileSync(PROXY_FILE, "utf8");
  check("proxy whitelist includes /api/health", proxySrc.includes('"/api/health"'));

  // --- integration: external monitor script ---
  child = startLobby();
  try {
    await waitForListening(child);
    const okRun = await runScript(["--url", `http://127.0.0.1:${PORT}/api/health`]);
    check("health-check.py exits 0 on healthy lobby", okRun.code === 0, `code=${okRun.code} out=${okRun.out.trim()}`);
    check("health-check.py prints OK", okRun.out.includes("OK:"), okRun.out.trim().slice(0, 120));
    const deadRun = await runScript(["--url", "http://127.0.0.1:1/api/health"]);
    check("health-check.py exits 1 on unreachable URL", deadRun.code === 1, `code=${deadRun.code} out=${deadRun.out.trim()}`);
    check("health-check.py prints CRITICAL", deadRun.out.includes("CRITICAL"), deadRun.out.trim().slice(0, 120));
  } catch (e) {
    failures++;
    console.log(`  FAIL monitor-script harness — ${e.message}`);
  } finally {
    await stopLobby(child);
  }

  console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
})();
