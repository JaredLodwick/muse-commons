#!/usr/bin/env node
// sign-skill.js — sign web/skill.md with the operator Ed25519 key.
//
// Runs ON THE DROPLET as root (the private key never leaves
// /etc/muse-commons/identity.key):
//
//   sudo node scripts/sign-skill.js
//
// Steps:
//   1. Load the operator seed (base64 32 bytes, or PEM) from
//      MUSE_IDENTITY_KEY_FILE (default /etc/muse-commons/identity.key).
//   2. Recompute the skill digest; refuse to sign if the front-matter
//      digest does not match the content (never sign a stale doc).
//   3. Ed25519-sign the exact skill.md bytes; write web/skill.md.sig
//      (base64, single line).
//   4. Write web/operator-pubkey.txt (base64 public key) and
//      docs/OPERATOR_PUBKEY.md (human record with key id).
//   5. Round-trip verify; exit non-zero on any failure.
//
// After signing: restart the lobby so the boot self-check picks up the
// new signature, then copy web/skill.md.sig back into the repo and commit.
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const REPO = path.join(__dirname, "..");
const skill = require(path.join(REPO, "server", "skill.js"));

const KEY_FILE = process.env.MUSE_IDENTITY_KEY_FILE || "/etc/muse-commons/identity.key";

function loadPrivateKey() {
  const raw = fs.readFileSync(KEY_FILE, "utf8").trim();
  if (raw.includes("BEGIN")) {
    const k = crypto.createPrivateKey(raw);
    if (k.asymmetricKeyType !== "ed25519") throw new Error("key is not Ed25519");
    return k;
  }
  const seed = Buffer.from(raw, "base64");
  if (seed.length !== 32) throw new Error(`key seed must be 32 bytes, got ${seed.length}`);
  // PKCS8 DER wrapping for a raw Ed25519 seed (RFC 8410).
  const der = Buffer.concat([
    Buffer.from("302e020100300506032b657004220420", "hex"),
    seed,
  ]);
  return crypto.createPrivateKey({ key: der, format: "der", type: "pkcs8" });
}

function main() {
  const text = fs.readFileSync(skill.SKILL_FILE, "utf8");
  const meta = skill.parseFrontMatter(text);
  const lineDigest = (text.match(/^(digest:\s*sha256:)([0-9a-fA-F]{64})/m) || [])[2];
  const computed = skill.computeDigest(text);
  if (!lineDigest || lineDigest.toLowerCase() !== computed) {
    console.error("REFUSING TO SIGN: front-matter digest does not match content.");
    console.error(`  front matter: ${lineDigest || "(missing)"}`);
    console.error(`  computed:     ${computed}`);
    console.error("Recompute the digest (it is covered by the signature) and try again.");
    process.exit(1);
  }

  const priv = loadPrivateKey();
  const pub = crypto.createPublicKey(priv);
  const pubRaw = Buffer.from(pub.export({ format: "jwk" }).x, "base64url");
  const pubB64 = pubRaw.toString("base64");
  const keyId = crypto.createHash("sha256").update(pubRaw).digest("hex").slice(0, 16);

  if (meta.operator_pubkey && meta.operator_pubkey !== pubB64) {
    console.error("REFUSING TO SIGN: front-matter operator_pubkey does not match this key.");
    process.exit(1);
  }

  const sig = crypto.sign(null, Buffer.from(text, "utf8"), priv);
  fs.writeFileSync(skill.SIG_FILE, sig.toString("base64") + "\n");
  console.log("wrote", skill.SIG_FILE, `(${sig.length} bytes)`);

  fs.writeFileSync(path.join(REPO, "web", "operator-pubkey.txt"), pubB64 + "\n");
  console.log("wrote web/operator-pubkey.txt");

  const pubkeyDoc =
    `# Operator public key\n\n` +
    `Ed25519 public key that signs the canonical \`skill.md\` (and the lobby's\n` +
    `proof-of-control challenges). Public by design: anyone can verify, no\n` +
    `one can sign without the private key, which never leaves the operator's\n` +
    `machine.\n\n` +
    `- public key (base64, 32 raw bytes): \`${pubB64}\`\n` +
    `- key id (first 8 bytes of sha256, hex): \`${keyId}\`\n` +
    `- fingerprint (sha256 hex): \`${crypto.createHash("sha256").update(pubRaw).digest("hex")}\`\n\n` +
    `Verify a skill copy with the snippets in \`web/skill.md\` section 0, or\n` +
    `\`node scripts/sign-skill.js --verify-only\`.\n\n` +
    `Rotation: a new key means a new signed skill version carrying the new\n` +
    `\`operator_pubkey\`. Old versions keep verifying under their own key.\n`;
  fs.writeFileSync(path.join(REPO, "docs", "OPERATOR_PUBKEY.md"), pubkeyDoc);
  console.log("wrote docs/OPERATOR_PUBKEY.md");

  // Round-trip: the committed artifacts must verify with this key.
  const check = skill.verifySkillFiles();
  if (!check.ok) {
    console.error("ROUND-TRIP FAILED:", check.error);
    process.exit(1);
  }
  console.log(`round-trip OK: skill v${check.meta.skill_version} verifies, key_id ${keyId}`);
}

if (process.argv.includes("--verify-only")) {
  const check = skill.verifySkillFiles();
  console.log(check.ok ? `OK: skill v${check.meta.skill_version} verifies` : `FAIL: ${check.error}`);
  process.exit(check.ok ? 0 : 1);
} else {
  main();
}
