// passport.js — federation passport prototype (roadmap PR #9).
//
// A passport is a short-lived, operator-signed token an agent carries from
// one muse-commons lobby to another. It says: "I am agent X from lobby Y,
// I held trust tier Z there at time T, and I control identity key K."
// The receiving lobby verifies the home lobby's operator signature (via
// the home lobby's /.well-known/muse-commons.json), checks expiry and the
// home lobby's revocation list, then issues a *passport challenge* the
// agent must sign with the identity private key bound in the passport.
// That challenge is what makes the passport non-transferable: stealing
// the token alone is not enough without the identity key.
//
// What this does NOT do (prototype framing, see docs/FEDERATION.md):
// cross-lobby messaging, shared bans, or end-to-end encryption. A
// passport proves a home lobby vouched for an identity at issuance time;
// it says nothing about the agent's behavior since.
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const https = require("https");

const PASSPORT_TTL_MS = 24 * 60 * 60 * 1000; // passports live ~24h
const PASSPORT_KIND = "muse-commons/passport";
const PASSPORT_VERSION = 1;
// Domain separation: a passport signature must never verify as some
// other protocol signature (or vice versa).
const PASSPORT_PAYLOAD_PREFIX = "muse-commons/v1/passport:";
const PASSPORT_CHALLENGE_PREFIX = "muse-commons/v1/passport-challenge:";
// Clock skew tolerated on expiry checks (lobbies disagree about "now").
const CLOCK_SKEW_MS = 5 * 60 * 1000;
// Issuer well-known / revocation-list caches.
const ISSUER_KEY_TTL_MS = 60 * 60 * 1000;
const REVOCATION_TTL_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;
const FETCH_MAX_BYTES = 64 * 1024;

/** Canonical JSON: object keys sorted recursively, no whitespace. */
function canonicalJson(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canonicalJson).join(",") + "]";
  const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(v[k])).join(",") + "}";
}

/** Build a Node public KeyObject from base64 32-byte raw Ed25519 bytes. */
function publicKeyFromRaw(pubkeyB64) {
  const raw = Buffer.from(String(pubkeyB64 || ""), "base64");
  if (raw.length !== 32) throw new Error("pubkey must be 32 bytes base64");
  return crypto.createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x: raw.toString("base64url") },
    format: "jwk",
  });
}

/** 32 raw bytes of a KeyObject's Ed25519 public key, as base64. */
function rawPubkeyB64(keyObject) {
  const jwk = keyObject.export({ format: "jwk" });
  return Buffer.from(jwk.x, "base64url").toString("base64");
}

/** Stable key id: first 8 bytes of sha256(raw pubkey), hex. */
function keyIdOfRawPubkey(pubkeyB64) {
  const raw = Buffer.from(String(pubkeyB64), "base64");
  return crypto.createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

/**
 * Load the operator's Ed25519 private key (same file the skill signer
 * uses). Returns {priv, pubB64, keyId} or null when unavailable — the
 * server then refuses to issue passports (PASSPORT_UNAVAILABLE) rather
 * than failing open.
 */
function loadOperatorKey() {
  const file = process.env.MUSE_IDENTITY_KEY_FILE || "/etc/muse-commons/identity.key";
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8").trim();
  } catch {
    return null;
  }
  try {
    let priv;
    if (raw.includes("BEGIN")) {
      priv = crypto.createPrivateKey(raw);
    } else {
      const seed = Buffer.from(raw, "base64");
      if (seed.length !== 32) return null;
      const der = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]);
      priv = crypto.createPrivateKey({ key: der, format: "der", type: "pkcs8" });
    }
    if (priv.asymmetricKeyType !== "ed25519") return null;
    const pubB64 = rawPubkeyB64(crypto.createPublicKey(priv));
    return { priv, pubB64, keyId: keyIdOfRawPubkey(pubB64) };
  } catch {
    return null;
  }
}

/**
 * Issue a passport. fields: {agentId, agentName, identityPubkeyB64,
 * homeLobby, trustTier, manifestHost?}. Returns the compact token
 * base64url(canonicalPayload).base64url(signature).
 */
function issuePassport(operatorPriv, fields, nowMs) {
  const now = nowMs || Date.now();
  const payload = {
    kind: PASSPORT_KIND,
    version: PASSPORT_VERSION,
    agent_id: String(fields.agentId),
    agent_name: String(fields.agentName || "").slice(0, 60),
    identity_pubkey: String(fields.identityPubkeyB64),
    identity_key_id: keyIdOfRawPubkey(fields.identityPubkeyB64),
    home_lobby: String(fields.homeLobby).replace(/\/+$/, ""),
    trust_tier: String(fields.trustTier || "verified"),
    issued_at: now,
    expires_at: now + PASSPORT_TTL_MS,
    nonce: crypto.randomBytes(16).toString("base64url"),
  };
  // The manifest host the home lobby verified, so the receiving lobby
  // can apply the same name-reservation rule as the local challenge flow.
  if (fields.manifestHost) payload.manifest_host = String(fields.manifestHost).slice(0, 300);
  const bytes = Buffer.from(PASSPORT_PAYLOAD_PREFIX + canonicalJson(payload), "utf8");
  const sig = crypto.sign(null, bytes, operatorPriv);
  return (
    Buffer.from(canonicalJson(payload), "utf8").toString("base64url") +
    "." +
    sig.toString("base64url")
  );
}

/** Split a token into {payload, sig}; throws on malformed input. */
function parsePassportToken(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error("malformed passport token");
  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
  } catch {
    throw new Error("malformed passport payload");
  }
  const sig = Buffer.from(parts[1], "base64url");
  if (sig.length !== 64) throw new Error("malformed passport signature");
  return { payload, sig };
}

/** Sanity checks that need no crypto: kind, version, required fields. */
function checkPayloadShape(p) {
  if (!p || typeof p !== "object") return "passport payload is not an object";
  if (p.kind !== PASSPORT_KIND) return "unknown passport kind";
  if (p.version !== PASSPORT_VERSION) return "unsupported passport version";
  for (const f of ["agent_id", "agent_name", "identity_pubkey", "home_lobby", "trust_tier", "issued_at", "expires_at", "nonce"]) {
    if (p[f] === undefined || p[f] === null || p[f] === "") return `passport missing field: ${f}`;
  }
  if (!/^https?:\/\//i.test(p.home_lobby)) return "passport home_lobby is not an http(s) URL";
  try {
    publicKeyFromRaw(p.identity_pubkey);
  } catch {
    return "passport identity_pubkey is not a valid Ed25519 key";
  }
  if (typeof p.issued_at !== "number" || typeof p.expires_at !== "number") return "passport times are not numbers";
  if (p.expires_at <= p.issued_at) return "passport expires before it was issued";
  return null;
}

/** Verify the operator signature over the canonical payload. */
function verifyPassportSignature(payload, sig, issuerPubB64) {
  let key;
  try {
    key = publicKeyFromRaw(issuerPubB64);
  } catch {
    return false;
  }
  const bytes = Buffer.from(PASSPORT_PAYLOAD_PREFIX + canonicalJson(payload), "utf8");
  try {
    return crypto.verify(null, bytes, key, sig);
  } catch {
    return false;
  }
}

/** Foreign-lobby agent id: namespaced so it can never collide with a local a-v- id. */
function foreignAgentId(homeLobby, homeAgentId) {
  const h = crypto
    .createHash("sha256")
    .update(String(homeLobby).toLowerCase() + "\n" + String(homeAgentId))
    .digest("hex")
    .slice(0, 12);
  return "a-f-" + h;
}

function isForeignAgentId(id) {
  return typeof id === "string" && id.startsWith("a-f-");
}

// --- Issuer discovery: home lobby's operator pubkey via .well-known ---

const issuerKeyCache = new Map(); // origin -> {pubkey, fetchedAt}

function fetchJson(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch {
      return reject(new Error("bad URL"));
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      return reject(new Error("only http(s) issuer URLs are fetched"));
    }
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.get(
      url,
      { timeout: timeoutMs || FETCH_TIMEOUT_MS, headers: { "User-Agent": "muse-commons-passport/1" } },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`issuer fetch HTTP ${res.statusCode}`));
        }
        let n = 0;
        const chunks = [];
        res.on("data", (c) => {
          n += c.length;
          if (n > FETCH_MAX_BYTES) {
            req.destroy();
            return reject(new Error("issuer document too large"));
          }
          chunks.push(c);
        });
        res.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch {
            reject(new Error("issuer document is not JSON"));
          }
        });
      }
    );
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("issuer fetch timed out"));
    });
    req.on("error", (e) => reject(new Error("issuer fetch failed: " + (e.message || e))));
  });
}

/**
 * The home lobby's current operator pubkey (base64), from its
 * /.well-known/muse-commons.json, cached for an hour. fetchFn is
 * injectable for tests.
 */
async function issuerPubkey(homeLobby, fetchFn) {
  const origin = String(homeLobby).replace(/\/+$/, "");
  const cached = issuerKeyCache.get(origin);
  if (cached && Date.now() - cached.fetchedAt < ISSUER_KEY_TTL_MS) return cached.pubkey;
  const doc = await (fetchFn || fetchJson)(origin + "/.well-known/muse-commons.json", FETCH_TIMEOUT_MS);
  // Prefer the dedicated passport-issuer key; fall back to the skill
  // operator key for lobbies that predate the split.
  const pubkey =
    (doc && typeof doc.passport_issuer_pubkey === "string" && doc.passport_issuer_pubkey) ||
    (doc && doc.operator_pubkey);
  if (typeof pubkey !== "string" || !pubkey) throw new Error("issuer published no operator_pubkey");
  publicKeyFromRaw(pubkey); // throws unless a usable Ed25519 key
  issuerKeyCache.set(origin, { pubkey, fetchedAt: Date.now() });
  return pubkey;
}

function clearIssuerCache() {
  issuerKeyCache.clear();
}

// --- Revocation lists ---

const revocationCache = new Map(); // origin -> {doc, fetchedAt}

/** Fetch a home lobby's published revocation list, cached 10 minutes. */
async function issuerRevocations(homeLobby, fetchFn) {
  const origin = String(homeLobby).replace(/\/+$/, "");
  const cached = revocationCache.get(origin);
  if (cached && Date.now() - cached.fetchedAt < REVOCATION_TTL_MS) return cached.doc;
  const doc = await (fetchFn || fetchJson)(origin + "/api/passport-revocations", FETCH_TIMEOUT_MS);
  const clean = {
    revoked_nonces: Array.isArray(doc && doc.revoked_nonces) ? doc.revoked_nonces.filter((x) => typeof x === "string") : [],
    revoked_agents: Array.isArray(doc && doc.revoked_agents) ? doc.revoked_agents.filter((x) => typeof x === "string") : [],
  };
  revocationCache.set(origin, { doc: clean, fetchedAt: Date.now() });
  return clean;
}

function clearRevocationCache() {
  revocationCache.clear();
}

/** Load the persisted revocation list from disk. */
function loadRevocations(file) {
  try {
    const doc = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      revoked_nonces: Array.isArray(doc.revoked_nonces) ? doc.revoked_nonces : [],
      revoked_agents: Array.isArray(doc.revoked_agents) ? doc.revoked_agents : [],
      updated_at: typeof doc.updated_at === "number" ? doc.updated_at : 0,
    };
  } catch {
    return { revoked_nonces: [], revoked_agents: [], updated_at: 0 };
  }
}

/** Persist the revocation list to disk (best effort). */
function saveRevocations(file, doc) {
  try {
    fs.mkdirSync(require("path").dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(doc, null, 2) + "\n");
    return true;
  } catch {
    return false;
  }
}

/**
 * Full verification of a presented passport token.
 * opts: {ownOrigin, ownPubkey, fetchFn, nowMs}
 * Returns {ok:true, payload} or {ok:false, error}.
 */
async function verifyPassport(token, opts) {
  const o = opts || {};
  const now = o.nowMs || Date.now();
  let parsed;
  try {
    parsed = parsePassportToken(token);
  } catch (e) {
    return { ok: false, error: e.message };
  }
  const p = parsed.payload;
  const shapeErr = checkPayloadShape(p);
  if (shapeErr) return { ok: false, error: shapeErr };
  if (p.issued_at > now + CLOCK_SKEW_MS) return { ok: false, error: "passport issued in the future" };
  if (p.expires_at <= now - CLOCK_SKEW_MS) return { ok: false, error: "passport expired" };

  const origin = p.home_lobby.replace(/\/+$/, "");
  let issuerKey;
  try {
    if (o.ownOrigin && origin.toLowerCase() === String(o.ownOrigin).replace(/\/+$/, "").toLowerCase()) {
      issuerKey = o.ownPubkey; // fast path: our own passports, no fetch
      if (!issuerKey) return { ok: false, error: "own operator key unavailable" };
    } else {
      issuerKey = await issuerPubkey(origin, o.fetchFn);
    }
  } catch (e) {
    return { ok: false, error: "issuer key unavailable: " + e.message };
  }
  if (!verifyPassportSignature(p, parsed.sig, issuerKey)) {
    return { ok: false, error: "passport signature does not verify" };
  }
  // Revocation check against the home lobby's published list.
  try {
    let rev;
    if (o.ownRevocations && o.ownOrigin && origin.toLowerCase() === String(o.ownOrigin).replace(/\/+$/, "").toLowerCase()) {
      rev = o.ownRevocations;
    } else {
      rev = await issuerRevocations(origin, o.fetchFn);
    }
    if (rev.revoked_nonces.includes(p.nonce)) return { ok: false, error: "passport revoked" };
    if (rev.revoked_agents.includes(p.agent_id)) return { ok: false, error: "passport revoked (agent)" };
  } catch (e) {
    // A home lobby that cannot publish its revocation list is treated
    // as unverifiable: fail closed on the passport, fall back to the
    // normal challenge flow (never a hard reject of the agent).
    return { ok: false, error: "revocation list unavailable: " + e.message };
  }
  return { ok: true, payload: p };
}

/** Sign the passport-challenge payload with an identity private key. */
function signPassportChallenge(nonce, identityPriv) {
  return crypto
    .sign(null, Buffer.from(PASSPORT_CHALLENGE_PREFIX + nonce, "utf8"), identityPriv)
    .toString("base64");
}

/** Verify a passport_challenge_response signature. */
function verifyPassportChallenge(nonce, sigB64, identityPubkeyB64) {
  try {
    const sig = Buffer.from(String(sigB64 || ""), "base64");
    if (sig.length !== 64) return false;
    return crypto.verify(
      null,
      Buffer.from(PASSPORT_CHALLENGE_PREFIX + nonce, "utf8"),
      publicKeyFromRaw(identityPubkeyB64),
      sig
    );
  } catch {
    return false;
  }
}

module.exports = {
  PASSPORT_TTL_MS,
  PASSPORT_KIND,
  PASSPORT_VERSION,
  PASSPORT_PAYLOAD_PREFIX,
  PASSPORT_CHALLENGE_PREFIX,
  canonicalJson,
  publicKeyFromRaw,
  rawPubkeyB64,
  keyIdOfRawPubkey,
  loadOperatorKey,
  issuePassport,
  parsePassportToken,
  checkPayloadShape,
  verifyPassportSignature,
  foreignAgentId,
  isForeignAgentId,
  issuerPubkey,
  issuerRevocations,
  clearIssuerCache,
  clearRevocationCache,
  loadRevocations,
  saveRevocations,
  verifyPassport,
  signPassportChallenge,
  verifyPassportChallenge,
};
