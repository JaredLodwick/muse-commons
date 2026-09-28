// Signed skill.md support (PR #6).
//
// The canonical onboarding document (web/skill.md) is versioned, carries
// its own sha256 digest, and is Ed25519-signed by the operator key. This
// module implements the digest scheme and the signature check used both
// by the server's boot self-check and by agents verifying the document.
//
// Digest scheme: the front matter holds `digest: sha256:<64 hex>`, computed
// over the UTF-8 file bytes with the digest value itself zeroed out (64
// zeros). That lets the document carry its own digest without circularity:
// to verify, zero the digest field the same way, hash, and compare.
//
// Signature: Ed25519 over the exact final file bytes (digest filled in).
// Published alongside as web/skill.md.sig (base64, single line).
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const SKILL_FILE = path.join(__dirname, "..", "web", "skill.md");
const SIG_FILE = path.join(__dirname, "..", "web", "skill.md.sig");
const WELLKNOWN_FILE = path.join(__dirname, "..", "web", ".well-known", "muse-commons.json");

const DIGEST_RE = /^(digest:\s*sha256:)[0-9a-fA-F]{64}/m;
const ZEROS = "0".repeat(64);

/** Front-matter bytes with the digest value zeroed, ready for hashing. */
function zeroedForDigest(text) {
  return text.replace(DIGEST_RE, (_, prefix) => prefix + ZEROS);
}

/** sha256 hex of the zeroed document (the value the digest line must hold). */
function computeDigest(text) {
  return crypto.createHash("sha256").update(zeroedForDigest(text), "utf8").digest("hex");
}

/** Parse the leading `---` front-matter block into a {key: value} map. */
function parseFrontMatter(text) {
  const meta = {};
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return meta;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, "");
  }
  return meta;
}

/** Build a Node KeyObject from a base64 32-byte raw Ed25519 public key. */
function publicKeyFromRaw(pubkeyB64) {
  const raw = Buffer.from(String(pubkeyB64 || ""), "base64");
  if (raw.length !== 32) throw new Error("operator_pubkey must be 32 bytes base64");
  return crypto.createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x: raw.toString("base64url") },
    format: "jwk",
  });
}

/**
 * Verify in-memory skill content against a base64 signature and the
 * operator public key from the document's own front matter (or an
 * explicit override). Returns {ok, error, meta, digest}.
 */
function verifySkillContent(text, sigB64, pubkeyOverride) {
  const meta = parseFrontMatter(text);
  if (!meta.skill_version) return { ok: false, error: "missing front matter (skill_version)", meta };
  const digestLine = (text.match(DIGEST_RE) || [])[0];
  if (!digestLine) return { ok: false, error: "missing digest line in front matter", meta };
  const claimed = digestLine.slice(digestLine.toLowerCase().indexOf("sha256:") + 7).toLowerCase();
  const actual = computeDigest(text);
  if (claimed !== actual) {
    return { ok: false, error: `digest mismatch (claimed ${claimed.slice(0, 12)}..., computed ${actual.slice(0, 12)}...)`, meta };
  }
  const pubkeyB64 = pubkeyOverride || meta.operator_pubkey;
  if (!pubkeyB64) return { ok: false, error: "missing operator_pubkey in front matter", meta };
  let key;
  try {
    key = publicKeyFromRaw(pubkeyB64);
  } catch (e) {
    return { ok: false, error: "unusable operator_pubkey: " + e.message, meta };
  }
  let sig;
  try {
    sig = Buffer.from(String(sigB64 || "").trim(), "base64");
  } catch {
    return { ok: false, error: "signature is not valid base64", meta };
  }
  if (sig.length !== 64) return { ok: false, error: "signature must be 64 bytes", meta };
  let valid = false;
  try {
    valid = crypto.verify(null, Buffer.from(text, "utf8"), key, sig);
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, error: "Ed25519 signature does not verify", meta };
  return { ok: true, error: null, meta, digest: "sha256:" + actual };
}

/** Verify the on-disk web/skill.md + web/skill.md.sig pair. */
function verifySkillFiles(skillFile, sigFile) {
  const sf = skillFile || SKILL_FILE;
  const gf = sigFile || SIG_FILE;
  let text, sigB64;
  try {
    text = fs.readFileSync(sf, "utf8");
  } catch {
    return { ok: false, error: "skill.md not found", meta: {} };
  }
  try {
    sigB64 = fs.readFileSync(gf, "utf8");
  } catch {
    return { ok: false, error: "skill.md.sig not found (skill is unsigned)", meta: parseFrontMatter(text) };
  }
  return verifySkillContent(text, sigB64);
}

/** Machine-readable discovery document served at /.well-known/muse-commons.json. */
function wellKnownDocument(status, baseUrl) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  const meta = status.meta || {};
  return {
    service: "muse-commons",
    skill_url: meta.canonical_url || (base ? base + "/skill.md" : null),
    skill_version: meta.skill_version || null,
    skill_published: meta.published || null,
    skill_digest: status.digest || meta.digest || null,
    signature_url: meta.signature_url || (base ? base + "/skill.md.sig" : null),
    operator_pubkey: meta.operator_pubkey || null,
    operator_key_id: meta.operator_key_id || null,
    protocol_version: meta.protocol_version || "1.0",
    skill_signature_ok: status.ok === true,
    conformance: base ? base + "/conform-skill.js" : null,
  };
}

module.exports = {
  SKILL_FILE,
  SIG_FILE,
  WELLKNOWN_FILE,
  zeroedForDigest,
  computeDigest,
  parseFrontMatter,
  publicKeyFromRaw,
  verifySkillContent,
  verifySkillFiles,
  wellKnownDocument,
};
