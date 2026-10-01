// Signed skill.md tests (PR #6).
//
//  1. Digest scheme: zeroed-digest hashing is self-consistent; tampering
//     the body breaks the digest; corrupting the digest line fails.
//  2. Signature: verifySkillContent accepts a valid signature, rejects a
//     tampered body, a wrong key, and a truncated signature.
//  3. Real artifacts: if web/skill.md.sig exists (signed on the droplet),
//     the committed pair verifies with the embedded operator key.
//  4. Local lobby: /skill.md, /skill.md.sig, /.well-known/muse-commons.json
//     are served (200) iff the boot self-check passed, 503 otherwise;
//     /api/health reports the skill status; the well-known shape is exact.
//  5. Conformance: web/conform-skill.js passes against the LOCAL lobby.
//
// Spawns real lobby children on a test port. No live traffic, ever.
//   node test/signed-skill.js
// Exit 0 = all pass, 1 = any failure.
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn, execFile } = require("child_process");

const REPO = path.join(__dirname, "..");
const LOBBY = path.join(REPO, "server", "lobby.js");
const CONFORM = path.join(REPO, "web", "conform-skill.js");
const PORT = 18811;
const BASE = `http://127.0.0.1:${PORT}`;
const skill = require(path.join(REPO, "server", "skill.js"));

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? " — " + detail : " "}`);
  }
}

function startLobby() {
  return spawn("node", [LOBBY], {
    env: { ALLOW_UNVERIFIED: "1", ...process.env, PORT: String(PORT), TLS_CHECK_ENABLED: "0" },
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
        child.stderr.off("data", onData);
        resolve(out);
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", () => reject(new Error("server exited during boot: " + out)));
  });
}
function get(p) {
  return new Promise((resolve, reject) => {
    http
      .get(BASE + p, (res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
      })
      .on("error", reject);
  });
}
function stopLobby(child) {
  return new Promise((res) => {
    child.on("exit", () => res());
    child.kill();
    setTimeout(res, 3000);
  });
}

// --- ephemeral keypair for unit tests (never the operator key) ---
const { privateKey: ephPriv, publicKey: ephPub } = crypto.generateKeyPairSync("ed25519");
const ephPubB64 = Buffer.from(ephPub.export({ format: "jwk" }).x, "base64url").toString("base64");

function makeTestSkill(extra) {
  const body = [
    "---",
    "skill: test",
    "skill_version: 0.0.1",
    "published: 2026-01-01T00:00:00Z",
    "canonical_url: http://example.invalid/skill.md",
    "digest: sha256:" + "0".repeat(64),
    "signature_url: http://example.invalid/skill.md.sig",
    "operator_pubkey: " + ephPubB64,
    "operator_key_id: testkey",
    'protocol_version: "1.0"',
    "---",
    "",
    "# Test skill",
    "",
    (extra || "hello world"),
    "",
  ].join("\n");
  const digest = skill.computeDigest(body);
  const text = body.replace("sha256:" + "0".repeat(64), "sha256:" + digest);
  const sig = crypto.sign(null, Buffer.from(text, "utf8"), ephPriv).toString("base64");
  return { text, sig, digest };
}

async function unitTests() {
  console.log("digest + signature unit tests (ephemeral key):");
  const { text, sig, digest } = makeTestSkill();

  const v = skill.verifySkillContent(text, sig);
  check("valid doc verifies", v.ok === true && v.meta.skill_version === "0.0.1", v.error);

  const tampered = text.replace("hello world", "hello worle");
  const v2 = skill.verifySkillContent(tampered, sig);
  check("tampered body fails", v2.ok === false, v2.error);

  const badDigest = text.replace("sha256:" + digest, "sha256:" + "f".repeat(64));
  const v3 = skill.verifySkillContent(badDigest, sig);
  check("corrupt digest line fails", v3.ok === false, v3.error);

  const other = crypto.generateKeyPairSync("ed25519");
  const otherB64 = Buffer.from(other.publicKey.export({ format: "jwk" }).x, "base64url").toString("base64");
  const v4 = skill.verifySkillContent(text, sig, otherB64);
  check("wrong public key fails", v4.ok === false, v4.error);

  const v5 = skill.verifySkillContent(text, sig.slice(0, 40));
  check("truncated signature fails", v5.ok === false, v5.error);

  const v6 = skill.verifySkillContent("no front matter here", sig);
  check("missing front matter fails", v6.ok === false, v6.error);

  // verifySkillFiles against temp files
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-test-"));
  const sf = path.join(dir, "skill.md");
  const gf = path.join(dir, "skill.md.sig");
  fs.writeFileSync(sf, text);
  fs.writeFileSync(gf, sig);
  const vf = skill.verifySkillFiles(sf, gf);
  check("verifySkillFiles ok on temp pair", vf.ok === true, vf.error);
  const vfMissing = skill.verifySkillFiles(sf, path.join(dir, "nope.sig"));
  check("missing .sig reports unsigned", vfMissing.ok === false && /unsigned/.test(vfMissing.error), vfMissing.error);
  fs.rmSync(dir, { recursive: true, force: true });

  // well-known shape
  const doc = skill.wellKnownDocument({ ok: true, meta: skill.parseFrontMatter(text), digest: "sha256:" + digest }, "http://example.invalid");
  const needed = ["skill_url", "skill_version", "skill_digest", "signature_url", "protocol_version", "operator_key_id", "skill_signature_ok", "conformance"];
  check("well-known document shape", needed.every((k) => doc[k] !== undefined && doc[k] !== null), JSON.stringify(doc));
}

async function realArtifactTest() {
  console.log("committed artifact test:");
  if (!fs.existsSync(skill.SIG_FILE)) {
    console.log("  skip real-artifact check (web/skill.md.sig not present; sign on the droplet first)");
    return;
  }
  const v = skill.verifySkillFiles();
  check("committed skill.md + skill.md.sig verify", v.ok === true, v.error);
  if (v.ok) {
    check("committed digest matches content", v.digest === v.meta.digest, `${v.digest} vs ${v.meta.digest}`);
    console.log(`  info skill v${v.meta.skill_version}, key_id ${v.meta.operator_key_id}`);
  }
}

async function lobbyTests() {
  console.log("local lobby integration:");
  const child = startLobby();
  let bootLog = "";
  try {
    bootLog = await waitForListening(child);
  } catch (e) {
    check("lobby boots", false, e.message);
    await stopLobby(child);
    return;
  }
  check("lobby boots", true);

  const health = await get("/api/health").then((r) => ({ status: r.status, body: JSON.parse(r.body) }));
  const skillOk = health.body.skill && health.body.skill.ok === true;
  check("/api/health reports skill status", health.status === 200 && health.body.skill && typeof skillOk === "boolean",
    JSON.stringify(health.body.skill));
  console.log(`  info skill.ok=${skillOk} (boot: ${/SELF-CHECK FAILED/.test(bootLog) ? "self-check failed" : "self-check passed"})`);

  const want = skillOk ? 200 : 503;
  const sm = await get("/skill.md");
  check(`/skill.md -> ${want}`, sm.status === want, `got ${sm.status}`);
  if (skillOk) check("/skill.md is markdown", /Muse Commons/.test(sm.body), sm.body.slice(0, 60));

  const sg = await get("/skill.md.sig");
  check(`/skill.md.sig -> ${want}`, sg.status === want, `got ${sg.status}`);

  const wk = await get("/.well-known/muse-commons.json");
  check(`/.well-known/muse-commons.json -> ${want}`, wk.status === want, `got ${wk.status}`);
  if (skillOk && wk.status === 200) {
    const doc = JSON.parse(wk.body);
    const shape = ["skill_url", "skill_version", "skill_digest", "signature_url", "protocol_version", "operator_key_id", "skill_signature_ok"].every(
      (k) => doc[k] !== undefined && doc[k] !== null
    );
    check("well-known shape on lobby", shape, wk.body.slice(0, 200));
    check("well-known digest matches served skill", doc.skill_digest === sm.body.match(/^digest:\s*(sha256:[0-9a-f]{64})/m)[1],
      `${doc.skill_digest}`);
    check("well-known signature flag true", doc.skill_signature_ok === true);
    check("well-known conformance on skill origin",
      typeof doc.conformance === "string" && doc.conformance === doc.skill_url.replace(/\/skill\.md$/, "/conform-skill.js"),
      doc.conformance);
  }

  // conformance script against the LOCAL lobby only
  if (skillOk) {
    console.log("  running conform-skill.js against local lobby...");
    const result = await new Promise((resolve) => {
      execFile("node", [CONFORM, BASE], { cwd: REPO, timeout: 60000 }, (err, stdout, stderr) => {
        resolve({ err, stdout: String(stdout), stderr: String(stderr) });
      });
    });
    check("conform-skill.js exits 0 locally", !result.err, (result.stderr || result.stdout).slice(-500));
    check("conform-skill.js prints RESULT: PASS", /RESULT: PASS/.test(result.stdout), result.stdout.slice(-300));
  } else {
    console.log("  skip conform-skill.js (skill unsigned locally; it refuses unverified copies by design)");
  }

  await stopLobby(child);
}

(async () => {
  try {
    await unitTests();
    await realArtifactTest();
    await lobbyTests();
  } catch (e) {
    failures++;
    console.log("  FAIL harness error —", e.message);
  }
  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
})();
