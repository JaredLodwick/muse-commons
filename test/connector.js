// Connector surface tests: GET /openapi.json and GET /llms.txt.
// Verifies both endpoints serve, the spec is valid JSON with the five
// read-only paths, and PUBLIC_BASE_URL flows into servers/llms.txt.
//
// Spawns a real lobby server child.
//   node test/connector.js
// Exit 0 = all pass, 1 = any failure.
const http = require("http");
const path = require("path");
const { spawn } = require("child_process");

const REPO = path.join(__dirname, "..");
const LOBBY = path.join(REPO, "server", "lobby.js");
const PORT = 18791;
const BASE = "https://commons.example.com";

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
  return spawn("node", [LOBBY], {
    env: { ALLOW_UNVERIFIED: "1", ...process.env, PORT: String(PORT), PUBLIC_BASE_URL: BASE },
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

(async () => {
  const child = startLobby();
  try {
    await waitForListening(child);

    const specRes = await get("/openapi.json");
    check("openapi.json returns 200 JSON", specRes.status === 200 &&
      (specRes.headers["content-type"] || "").includes("application/json"));
    let spec = null;
    try { spec = JSON.parse(specRes.body); } catch { spec = null; }
    check("openapi.json parses", !!spec);
    const paths = (spec && spec.paths) || {};
    for (const p of ["/api/places", "/api/ticker", "/api/presence", "/api/board", "/api/directory"]) {
      check(`spec includes ${p}`, !!paths[p]);
    }
    const servers = (spec && spec.servers) || [];
    check("servers[0].url uses PUBLIC_BASE_URL", servers[0] && servers[0].url === BASE,
      JSON.stringify(servers[0]));

    const llmsRes = await get("/llms.txt");
    check("llms.txt returns 200 markdown", llmsRes.status === 200 &&
      (llmsRes.headers["content-type"] || "").includes("text/markdown"));
    check("llms.txt mentions all five endpoints",
      ["/api/places", "/api/ticker", "/api/presence", "/api/board", "/api/directory"]
        .every((p) => llmsRes.body.includes(p)));
    check("llms.txt uses PUBLIC_BASE_URL", llmsRes.body.includes(BASE));
    check("llms.txt links openapi.json", llmsRes.body.includes("/openapi.json"));

    // Default base URL when env is unset is covered by code review; the
    // live check above pins the env-driven path used for the domain hookup.
  } catch (e) {
    failures++;
    console.log(`  FAIL harness — ${e.message}`);
  } finally {
    child.kill();
  }
  console.log(failures === 0 ? "PASS" : `${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
})();
