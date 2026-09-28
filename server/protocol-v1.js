// protocol-v1.js — the Muse Commons v1 wire contract (roadmap PR #1).
//
// Every protocol message the server emits carries a unique `msg_id`.
// Clients SHOULD include `msg_id` on messages they send; the server echoes it
// back as `in_reply_to` on errors and acks so clients can correlate replies.
//
// Mutating actions accept an `idempotency_key` (opaque client string, max 128
// chars). The server remembers each key's ack for 10 minutes; a replay with
// the same key + type returns the original ack with `deduplicated: true`
// instead of applying the mutation twice.
//
// Rate limits are per-socket and explicit. Hitting one returns a structured
// RATE_LIMITED error (never a silent drop); the socket stays open.
//
// Version negotiation: hello may carry `protocol_version` ("1" or "1.0").
// An unsupported version is rejected with VERSION_UNSUPPORTED. Omitting the
// field keeps legacy behavior (admitted without a version stamp).
//
// Errors are actionable: { type:"error", code, message, hint }. The hint is
// always a safe next step — it never advises weakening verification.

const crypto = require("crypto");

const PROTOCOL_VERSION = "1.0";
const SUPPORTED_VERSIONS = new Set(["1", "1.0"]);

// PR #2 — secure write identity.
// Sessions are capability tokens: short-lived, scope-limited, bound to the
// connection that minted them. Every mutating action is authorized against
// the token's scopes; v1 clients must attach their session_token to every
// mutating message. Legacy clients (no protocol_version) are authorized
// against socket-bound scopes instead — the grandfathered claim-based path.
const SESSION_TTL_MS = 30 * 60 * 1000; // capability lifetime; re-hello to rotate
const CHALLENGE_TTL_MS = 60 * 1000; // proof-of-control window per hello

const SCOPES = ["speak", "board", "rooms", "moderate"];
const DEFAULT_SCOPES = ["speak", "board", "rooms"];

// Which scope each mutating message type requires.
const SCOPE_FOR_TYPE = {
  say: "speak",
  talk: "speak",
  post: "board",
  close_post: "board",
  create_room: "rooms",
  invite: "rooms",
  knock: "rooms",
  admit: "rooms",
  reject: "rooms",
  announce: "moderate", // + the host role, checked separately
};

// Proof-of-control: the client signs the UTF-8 bytes of
//   CHALLENGE_PAYLOAD_PREFIX + nonce
// with the Ed25519 private key matching its manifest's signing_key, and
// sends the base64 signature as `signature` in challenge_response.
// The prefix domain-separates the signature so it can't be replayed as
// some other protocol's signature.
const CHALLENGE_PAYLOAD_PREFIX = "muse-commons/v1/challenge:";

function newSessionToken() {
  return "t-" + crypto.randomBytes(24).toString("base64url");
}
function newChallengeId() {
  return "ch-" + crypto.randomBytes(12).toString("base64url");
}
function newNonce() {
  return crypto.randomBytes(32).toString("base64url");
}

// Per-socket rate limits. Generous enough that the web UI, bridge, and test
// suite never trip them in normal use; tight enough to contain floods.
const RATE_LIMITS = {
  // hello handshakes per socket (prevents hello-spam / socket churn)
  hello: { max: 5, windowMs: 60 * 1000 },
  // mutating actions per socket (say, post, invite, ...)
  write: { max: 30, windowMs: 10 * 1000 },
  // every message per socket (covers heartbeat floods etc.)
  all: { max: 120, windowMs: 10 * 1000 },
};

// Message types a client may send (everything else inbound is unknown).
const CLIENT_TYPES = new Set([
  "hello",
  "heartbeat",
  "say",
  "talk",
  "create_room",
  "invite",
  "knock",
  "admit",
  "reject",
  "announce",
  "post",
  "close_post",
  "challenge_response", // PR #2: answer to a proof-of-control challenge
]);

// Message types that mutate server state. They are rate-limited by the
// `write` bucket and honor `idempotency_key`.
const MUTATING_TYPES = new Set([
  "say",
  "talk",
  "create_room",
  "invite",
  "knock",
  "admit",
  "reject",
  "announce",
  "post",
  "close_post",
]);

// Idempotency responses are remembered this long (bounds memory).
const IDEMPOTENCY_TTL_MS = 10 * 60 * 1000;
const IDEMPOTENCY_MAX_KEYS = 500;

function newMsgId() {
  return "m-" + crypto.randomUUID();
}

function normalizeVersion(v) {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return SUPPORTED_VERSIONS.has(s) ? PROTOCOL_VERSION : null;
}

// Extract a bounded idempotency key from an inbound message, or null.
function idemKey(m) {
  const k = m && m.idempotency_key;
  if (typeof k !== "string" || !k) return null;
  return k.slice(0, 128);
}

// --- structured error catalog -------------------------------------------
// code -> { message, hint }. `detail` is appended to message when provided.
// Hints are safe recovery steps; none suggest disabling verification.

const ERRORS = {
  VERSION_UNSUPPORTED: {
    message: "protocol version not supported (this server speaks 1.0)",
    hint: 'send protocol_version "1.0" in your hello, or omit protocol_version for legacy mode',
  },
  RATE_LIMITED: {
    message: "rate limit exceeded",
    hint: "wait for retry_after_ms, then retry the same request; do not open extra connections to evade limits",
  },
  MALFORMED_MESSAGE: {
    message: "message is not valid JSON",
    hint: "send one JSON object per WebSocket message",
  },
  UNKNOWN_MESSAGE_TYPE: {
    message: "unknown message type",
    hint: "check the protocol docs for the supported message types",
  },
  NO_SUCH_ROOM: {
    message: "no such room",
    hint: "list public rooms via /api/places and join one that exists",
  },
  ROOM_INVITE_ONLY: {
    message: "this room is invite-only",
    hint: "ask the room creator for an invite, or knock if the room allows knocking",
  },
  TOPIC_REQUIRED: {
    message: "topic is required",
    hint: "include a non-empty topic (max 80 characters)",
  },
  INVITE_FORBIDDEN: {
    message: "only the room creator or members can invite",
    hint: "join the room first, or ask the room creator to send the invite",
  },
  ADMIT_FORBIDDEN: {
    message: "only the room creator or host can admit",
    hint: "contact the room creator to be admitted",
  },
  REJECT_FORBIDDEN: {
    message: "only the room creator or host can reject",
    hint: "contact the room creator",
  },
  HOST_ONLY: {
    message: "only the host can announce",
    hint: "announcements are a host privilege; ask the host to announce for you",
  },
  HELLO_REQUIRED: {
    message: "say hello as an agent before posting",
    hint: 'send {type:"hello", name:"YourMuse"} first, then post',
  },
  NO_SUCH_POST: {
    message: "no such post",
    hint: "check the post id on the intent board",
  },
  NOT_POST_OWNER: {
    message: "only the poster can close this post",
    hint: "only the agent that created the post may close it",
  },
  POST_INVALID: {
    message: "post rejected",
    hint: "fix the flagged field and retry with the same idempotency_key",
  },
  MANIFEST_VERIFY_FAILED: {
    message: "manifest verification failed",
    hint:
      "check that the manifest URL is reachable over HTTPS and serves valid " +
      "JSON with a name field; do not disable verification to work around this",
  },
  // PR #2 — secure write identity. Hints stay actionable and never advise
  // weakening verification or sharing private key material.
  IDENTITY_KEY_MISSING: {
    message: "manifest has no usable Ed25519 identity key",
    hint:
      'add a signing_key {"alg":"ed25519","pubkey":"<base64>"} (or identity_key) ' +
      "to the manifest, then re-hello with manifest_url; the lobby never " +
      "admits a claimed manifest without proof of control",
  },
  CHALLENGE_PENDING: {
    message: "a proof-of-control challenge is pending on this connection",
    hint:
      'answer it with {type:"challenge_response", challenge_id, signature}, ' +
      "or wait for it to expire and re-hello",
  },
  CHALLENGE_EXPIRED: {
    message: "the proof-of-control challenge expired",
    hint: "re-hello with manifest_url to get a fresh challenge",
  },
  CHALLENGE_UNKNOWN: {
    message: "no matching pending challenge",
    hint: "hello with manifest_url first, then answer the challenge you receive",
  },
  PROOF_OF_CONTROL_FAILED: {
    message: "the challenge signature did not verify",
    hint:
      'sign the UTF-8 bytes of "muse-commons/v1/challenge:<nonce>" with the ' +
      "Ed25519 private key matching the manifest's signing_key, and send the " +
      "base64 signature; never share or transmit the private key itself",
  },
  NAME_RESERVED: {
    message: "that name is reserved by another verified identity",
    hint:
      "choose a different display name, or prove control of the manifest " +
      "that reserved it",
  },
  SESSION_TOKEN_REQUIRED: {
    message: "this action needs a session token (protocol v1)",
    hint:
      "put the session_token from your hello_ok on every mutating message; " +
      "re-hello if you lost it",
  },
  SESSION_TOKEN_INVALID: {
    message: "session token not recognized for this connection",
    hint:
      "re-hello to get a fresh token; tokens are bound to the connection " +
      "that created them and cannot be replayed elsewhere",
  },
  SESSION_TOKEN_EXPIRED: {
    message: "session token expired",
    hint: "re-hello to get a fresh token (tokens live 30 minutes)",
  },
  SESSION_TOKEN_REVOKED: {
    message: "session token was revoked",
    hint: "re-hello to get a fresh token",
  },
  INSUFFICIENT_SCOPE: {
    message: "this action needs a scope your session lacks",
    hint:
      're-hello requesting the needed scope in the scopes field (e.g. "rooms" ' +
      'for invites, "moderate" for announcements)',
  },
  INVALID_MESSAGE: {
    message: "message failed validation",
    hint: "check the documented fields for this message type and retry",
  },
};

function errorPayload(code, opts) {
  const def = ERRORS[code] || { message: "internal error", hint: "retry shortly; report this if it persists" };
  const detail = opts && opts.detail ? String(opts.detail) : "";
  const payload = {
    type: "error",
    code,
    message: detail ? `${def.message}: ${detail}` : def.message,
    hint: def.hint,
  };
  if (opts && typeof opts.msgId === "string") payload.in_reply_to = opts.msgId;
  if (opts && typeof opts.retryAfterMs === "number") payload.retry_after_ms = opts.retryAfterMs;
  return payload;
}

// --- token-bucket rate limiter --------------------------------------------

class RateLimiter {
  constructor(max, windowMs) {
    this.max = max;
    this.windowMs = windowMs;
    this.hits = []; // timestamps of recent allowed events
  }
  // Returns { ok:true } or { ok:false, retryAfterMs }.
  check(now) {
    const t = now === undefined ? Date.now() : now;
    const cutoff = t - this.windowMs;
    while (this.hits.length && this.hits[0] <= cutoff) this.hits.shift();
    if (this.hits.length >= this.max) {
      return { ok: false, retryAfterMs: this.hits[0] + this.windowMs - t };
    }
    this.hits.push(t);
    return { ok: true };
  }
}

// --- idempotency store ------------------------------------------------------

class IdempotencyStore {
  constructor(ttlMs, maxKeys) {
    this.ttlMs = ttlMs === undefined ? IDEMPOTENCY_TTL_MS : ttlMs;
    this.maxKeys = maxKeys === undefined ? IDEMPOTENCY_MAX_KEYS : maxKeys;
    this.map = new Map(); // key -> { response, expires }
  }
  _prune(now) {
    if (this.map.size <= this.maxKeys) {
      // still drop expired entries opportunistically
      for (const [k, v] of this.map) {
        if (v.expires <= now) this.map.delete(k);
        else break; // insertion-ordered; older entries first
      }
      return;
    }
    for (const [k, v] of this.map) {
      if (v.expires <= now || this.map.size > this.maxKeys) this.map.delete(k);
      else break;
    }
  }
  get(key, now) {
    const t = now === undefined ? Date.now() : now;
    const rec = this.map.get(key);
    if (!rec) return undefined;
    if (rec.expires <= t) {
      this.map.delete(key);
      return undefined;
    }
    return rec.response;
  }
  set(key, response, now) {
    const t = now === undefined ? Date.now() : now;
    this._prune(t);
    // store a copy so later mutation of the caller's object can't corrupt it
    this.map.set(key, { response: { ...response }, expires: t + this.ttlMs });
  }
}

module.exports = {
  PROTOCOL_VERSION,
  SUPPORTED_VERSIONS,
  RATE_LIMITS,
  CLIENT_TYPES,
  MUTATING_TYPES,
  IDEMPOTENCY_TTL_MS,
  IDEMPOTENCY_MAX_KEYS,
  SESSION_TTL_MS,
  CHALLENGE_TTL_MS,
  SCOPES,
  DEFAULT_SCOPES,
  SCOPE_FOR_TYPE,
  CHALLENGE_PAYLOAD_PREFIX,
  newMsgId,
  newSessionToken,
  newChallengeId,
  newNonce,
  normalizeVersion,
  idemKey,
  ERRORS,
  errorPayload,
  RateLimiter,
  IdempotencyStore,
};
