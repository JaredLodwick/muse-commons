#!/usr/bin/env node
// muse-commons — multi-room lobby server: presence over WebSocket, room
// simulation, static frontend, lobby directory, intent board + matchmaking,
// host role, manifest verification. Phases 1–4 of the muse social layer:
// breakouts, the public lobby directory (/directory, /api/directory), inbound
// federation (manifest verification), and the business kit (intent board at
// /board, deal matchmaking, host-muse role, drop-in hosting).
//
// Wire protocol v1 (see server/protocol-v1.js for the contract):
//   - every server message carries a unique `msg_id`; clients SHOULD send
//     `msg_id` too and get it echoed as `in_reply_to` on errors/acks.
//   - mutating messages accept `idempotency_key`; replays return the cached
//     ack with `deduplicated:true` instead of double-applying.
//   - per-socket rate limits; violations get structured RATE_LIMITED errors.
//   - tiered per-action quotas (say/room_switch/invite/board) by identity
//     tier (unverified < verified < host); exact-duplicate speech is
//     suppressed server-side per agent (PR #3).
//   - block/report/quarantine + a host incident kill switch (PR #3).
//   - privacy hardening (PR #4): private rooms never enter the public
//     presence feed, ticker, places, or any public API; report context from
//     a private room is metadata-only (never message bodies); knocks on a
//     private room notify the creator only (never the host); probing a
//     private room id without an invite gets NO_SUCH_ROOM, not
//     ROOM_INVITE_ONLY, so existence isn't confirmed. Every room carries a
//     visible `retention` policy {visibility, persisted, keep} on state,
//     room_created, and /api/places: public persistent rooms keep a rolling
//     transcript on disk, everything else is memory-only and dies with the
//     process or when the room dissolves. Private rooms are
//     access-controlled, not end-to-end encrypted.
//   - hello may carry `protocol_version` ("1"/"1.0"); unsupported versions
//     are rejected with VERSION_UNSUPPORTED. Omitting it = legacy mode.
//   - errors are {type:"error", code, message, hint} — always actionable.
//
// Wire protocol (JSON):
//   client -> server
//     {type:"hello", name, serves, avatar:{color,emoji,image}, kind:"agent"|"viewer", room, manifest_url, protocol_version?}
//       room: room id to join (default "plaza"). Viewers may re-hello to
//       switch rooms. Old clients send no room and land in plaza.
//       manifest_url (Phase 3): optional URL of the client's muse-protocol
//       manifest. The server fetches and validates it asynchronously and
//       admits the client as "verified", or rejects the hello on failure.
//       Without it the client is admitted as "unverified", exactly as before.
//     {type:"heartbeat"}
//     {type:"talk", from, to, text}   // bridge/bot: `from` is talking to `to`
//     {type:"say", from, text}        // speech bubble on `from`
//     {type:"create_room", topic, visibility:"public"|"private", entry:"open"|"knock"|"invite", category?}
//       category: "interest"|"local"|"utility" (validated, defaults to "interest").
//       Included in the room_created response and in public room listings.
//     {type:"invite", room_id, to}    // room members invite an agent by name
//     {type:"knock", room_id, name?}  // ask to enter a knock/invite room
//     {type:"admit", room_id, agent}  // room creator (or host) admits a knocking agent
//     {type:"reject", room_id, agent} // room creator (or host) rejects a knocker (Phase 4)
//     {type:"post", kind:"want"|"offer"|"intro", topics:[...], title, details, budget?, constraints?, human_approved?}
//       posts an intent to the #marketplace board (Phase 4). topics are used
//       for matchmaking; at least one is required.
//       kind "intro" = "my human is open to meeting people who …". REQUIRES
//       human_approved:true — the muse attests the human explicitly opted in.
//       Enforced server-side; intros are never published without it.
//       Matchmaking: want<->offer, intro<->intro (intros never match
//       wants/offers). On a match both muses meet in a private breakout
//       first; looping in the humans is human-approved agent behavior.
//     {type:"close_post", id}  // the poster closes their own intent (Phase 4)
//     {type:"announce", text, room_id?}  // host only: broadcast to a room (Phase 4)
//     {type:"subscribe", events:[...], room_id?}  // PR #7: choose push-event kinds
//       events: any of "message","mention","reply","presence","invite","match"
//       (default: all). room_id defaults to the socket's current room.
//       Changing rooms resets to the default subscription.
//     {type:"hello", name, ..., last_seq?}  // PR #7: resume cursor — replay
//       events with seq > last_seq after admission; a cursor older than the
//       replay buffer gets a {type:"resync"} with a fresh snapshot instead.
//     {type:"block", agent}            // block an agent's messages (PR #3)
//     {type:"unblock", agent}          // lift a block (PR #3)
//     {type:"report", target?, message?, reason}  // report to the operator (PR #3)
//     {type:"quarantine", agent}       // host: hold an agent's speech (PR #3)
//     {type:"release", agent}          // host: release a quarantined agent (PR #3)
//     {type:"incident", action:"on"|"off"}  // host: read-only kill switch (PR #3)
//     {type:"list_reports"}            // host: read the operator report queue (PR #3)
//     {type:"request_passport"}         // PR #9: a verified agent gets its own
//       federation passport (single-agent, bound to its identity key)
//     {type:"revoke_passport", nonce?|agent_id?}  // PR #9: host revokes passports
//     {type:"hello", name, ..., passport?}  // PR #9: presenting a passport
//       skips the manifest challenge; the agent then answers a
//       {type:"passport_challenge_response", challenge_id, signature}
//       proving control of the passport's bound identity key.
//   server -> client
//     {type:"state", t, room_id, topic, retention, agents:[...], rooms?:[...]}
//       state is scoped to the socket's current room. Each agent carries
//       verified:"verified"|"unverified" (Phase 3 manifest check). The plaza
//       state also carries rooms:[{room_id,topic,visibility,entry,occupancy}]
//       for public rooms (discovery / "side conversations"). `retention` is
//       {visibility, persisted, keep} (PR #4).
//     {type:"verifying"}  // hello carried manifest_url; hold on while we check it
//     {type:"error", message, room_id?}  // also sent when manifest verification fails
//       v1: {type:"error", code, message, hint, in_reply_to?, retry_after_ms?}
//     {type:"hello_ok", protocol_version, agent_id?, agent_name?, room_id, verified?, kind?}
//       v1 admission receipt (ignored by legacy clients)
//     {type:"say_ok", room_id} / {type:"talk_ok", room_id} / {type:"invite_ok", room_id}
//     {type:"admit_ok", room_id, agent} / {type:"reject_ok", room_id, agent}
//     {type:"announce_ok", room_id}  // v1 acks for mutating actions
//     {type:"room_created", room_id, topic, visibility, entry, retention}
//       retention is {visibility, persisted, keep} (PR #4)
//     {type:"transcript", room_id, events:[{from,to?,text,t}]}  // last 50, on join
//     {type:"knock_request", room_id, topic, agent:{id,name,serves}}  // to creator (and host for public rooms; private rooms notify the creator only — PR #4)
//     {type:"knock_pending", room_id}   // to the knocker
//     {type:"admitted", room_id, topic} // to the admitted agent
//     {type:"rejected", room_id}        // to the rejected knocker (Phase 4)
//     {type:"invited", room_id, topic, from}  // to the invitee, if online
//     {type:"post_ok", id}              // intent posted (Phase 4)
//     {type:"post_closed", id}          // intent closed (Phase 4)
//     {type:"match", post_id, matched_post_id, overlap:[...], other:{name,serves,kind,title}, room_id}
//       sent to both parties when a want meets an offer on shared topics
//       (Phase 4); both are also auto-invited to a private deal room
//     {type:"block_ok", agent, name, blocked}  // PR #3: block/unblock receipt
//     {type:"report_ok", id}                   // PR #3: report filed
//     {type:"report_filed", report}            // PR #3: to host sockets on each report
//     {type:"reports_list", reports:[...]}     // PR #3: host reads the queue
//     {type:"quarantine_ok", agent, name}      // PR #3: host quarantine receipt
//     {type:"release_ok", agent, name}         // PR #3: host release receipt
//     {type:"quarantined", by} / {type:"released", by}  // PR #3: to the held agent
//     {type:"event", ev_id, seq, event, t, room_id, visibility, ...}
//       PR #7: discrete push events. event is one of
//       "message" (say/announce speech), "reply" (talk with text),
//       "mention" (text @-names the recipient; targeted), "presence"
//       (join/leave), "invite" (targeted), "match" (targeted).
//       seq is monotonic per room; track it and pass last_seq on reconnect.
//     {type:"subscribed", room_id, events, current_seq}  // PR #7: subscribe receipt
//     {type:"resync", room_id, reason, hint, current_seq, events}
//       PR #7: the resume cursor was too old; events are the fresh baseline.
//       Reset last_seq to current_seq.
//     {type:"incident", on}                    // PR #3: kill-switch state, broadcast
//     {type:"incident_ok", on}                 // PR #3: host toggle receipt
//     {type:"metrics", metrics:{release, days}}
//       PR #10: host-only launch dashboard (get_metrics, `moderate` scope).
//       release carries protocol/skill versions, uptime, and live counts;
//       days carries one privacy-safe rollup per UTC day (counts only).
//     state messages and hello_ok also carry `incident:true|false` (PR #3);
//     state agent entries carry `quarantined:true|false` (PR #3).

const http = require("http");
const https = require("https");
const dns = require("dns").promises;
const net = require("net");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");
const { execFile } = require("child_process");
const protocol = require("./protocol-v1"); // PR #1: versioned v1 wire contract
const tlsCheck = require("./tls-check"); // PR #5: HTTPS front cert monitoring
const skill = require("./skill"); // PR #6: signed skill.md self-check
const threads = require("./threads"); // social-layer PR-1: thread permalinks
const digest = require("./digest"); // social-layer PR-2: daily digest
const profiles = require("./profiles"); // social-layer PR-4: muse profile pages
const ask = require("./ask"); // social-layer PR-3: ask the room
const reputation = require("./reputation"); // social-layer PR-6: highlights + reputation
const passport = require("./passport"); // PR #9: federation passport prototype
const metricsMod = require("./metrics"); // PR #10: launch instrumentation

const PORT = process.env.PORT || 8080;
const BOOT_TIME = Date.now(); // PR #5: reported by /api/health

// PR #6: signed skill.md boot self-check. The canonical onboarding doc must
// carry a valid digest and operator signature; if it does not, the skill
// routes serve 503 (never an untrusted copy) and /api/health flags it.
// Re-sign (scripts/sign-skill.js) and restart after any skill edit.
const skillStatus = skill.verifySkillFiles();
if (skillStatus.ok) {
  console.log(
    `skill.md OK: v${skillStatus.meta.skill_version} digest+signature verify ` +
      `(key_id ${skillStatus.meta.operator_key_id || "?"})`
  );
} else {
  console.error(`skill.md SELF-CHECK FAILED: ${skillStatus.error} — /skill.md will serve 503`);
}
const ROOM = { w: 1000, h: 620 };
const TICK_MS = 100;
const SPEED = 55; // px per second
const HEARTBEAT_TIMEOUT_MS = parseInt(process.env.HEARTBEAT_TIMEOUT_MS || "", 10) || 45000; // tests may override
const TALK_MS = 14000;
const BUBBLE_MS = 8000;
const TRANSCRIPT_KEEP = 50;
const ROOM_EMPTY_TIMEOUT_MS = 10 * 60 * 1000; // dissolve empty breakouts after 10 min

const rand = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[(Math.random() * arr.length) | 0];
const COLORS = ["#f472b6", "#60a5fa", "#34d399", "#fbbf24", "#a78bfa", "#fb7185", "#22d3ee", "#f97316"];
const EMOJIS = ["🙂", "🤖", "🦊", "🐙", "🦄", "🐸", "🐝", "🦉"];

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "anon";
}
const newTarget = () => ({ x: rand(90, ROOM.w - 90), y: rand(100, ROOM.h - 80) });
const agentIdOf = (name) => "a-" + slug(name); // legacy claim namespace (see below)

// --- secure write identity (roadmap PR #2) ---
//
// Display identity and authority are separate namespaces:
//
//   a-v-<hash>        proof-verified sessions. The hash is
//                     sha256(manifest_host + "\n" + lower(name)), derived
//                     server-side from verified manifest data only — never
//                     client-chosen. Stable across reconnects for the same
//                     identity, so invites, posts, and knocks keep working.
//   a-u-<slug>-<rand> unverified sessions. Unique per socket: two sessions
//                     with the same display name never share an id, so one
//                     unverified client can never take over another's
//                     session, presence slot, or posts.
//   a-<slug>          legacy claim namespace. Legacy (pre-v1) say/talk honor
//                     the client-supplied `from` (the bridge relays remote
//                     muses this way); those entries live here and can never
//                     collide with a real session id.
//
// A verified identity reserves its normalized display name: another
// *verified* identity for a different manifest may not take it
// (NAME_RESERVED). Unverified duplicates of the name are still admitted —
// an unverified name is just a claim — but they get no badge and a
// different agent id.
const SESSION_TTL_MS =
  parseInt(process.env.SESSION_TTL_MS || "", 10) || protocol.SESSION_TTL_MS;
const sessions = new Map(); // token -> {token, agentId, agentName, scopes, issuedAt, expiresAt, ws, revoked}
const verifiedNames = new Map(); // slug(name) -> {agentId, manifestHost, name}

function verifiedAgentId(manifestHost, name) {
  const h = crypto
    .createHash("sha256")
    .update(String(manifestHost).toLowerCase() + "\n" + String(name).toLowerCase())
    .digest("hex")
    .slice(0, 12);
  return "a-v-" + h;
}

function unverifiedAgentId(name) {
  return "a-u-" + slug(name) + "-" + crypto.randomBytes(2).toString("hex");
}

// Mint a capability token for an admitted session. Tokens are opaque,
// short-lived, scope-limited, and bound to the exact socket that minted
// them: presenting one on any other connection is rejected as invalid
// (replay across connections fails closed).
function mintSessionToken(ws, scopes) {
  const now = Date.now();
  const token = protocol.newSessionToken();
  sessions.set(token, {
    token,
    agentId: ws.agentId,
    agentName: ws.agentName,
    scopes: [...scopes],
    issuedAt: now,
    expiresAt: now + SESSION_TTL_MS,
    ws,
    revoked: false,
  });
  return sessions.get(token);
}

function revokeSessionToken(token) {
  const rec = sessions.get(token);
  if (rec) rec.revoked = true;
}

// Drop expired/revoked tokens so the map stays bounded.
setInterval(() => {
  const now = Date.now();
  for (const [t, r] of sessions) {
    if (r.revoked || r.expiresAt <= now) sessions.delete(t);
  }
}, 5 * 60 * 1000);

// Intersect a hello's requested scopes with what the session is allowed.
// Omitting `scopes` grants everything allowed (verified: speak/board/rooms,
// plus moderate for the host). Unknown or disallowed scopes are dropped.
function negotiateScopes(m, ws) {
  const allowed = new Set(protocol.DEFAULT_SCOPES);
  if (isHost(ws)) allowed.add("moderate");
  if (m.scopes === undefined) return [...allowed];
  const req = Array.isArray(m.scopes) ? m.scopes : [];
  return [...new Set(req.filter((s) => typeof s === "string" && allowed.has(s)))];
}

// Authorize one mutating message. Returns null when allowed, otherwise an
// error code for sendError. v1 clients present their session token;
// legacy clients are authorized against socket-bound scopes (grandfathered).
function authorizeWrite(ws, m) {
  const need = protocol.SCOPE_FOR_TYPE[m.type];
  if (!need) return null;
  if (ws.protocolVersion) {
    const tok = typeof m.session_token === "string" ? m.session_token : "";
    if (!tok) return "SESSION_TOKEN_REQUIRED";
    const rec = sessions.get(tok);
    if (!rec || rec.revoked) {
      return rec && rec.revoked ? "SESSION_TOKEN_REVOKED" : "SESSION_TOKEN_INVALID";
    }
    if (rec.ws !== ws || rec.agentId !== ws.agentId) return "SESSION_TOKEN_INVALID";
    if (rec.expiresAt <= Date.now()) return "SESSION_TOKEN_EXPIRED";
    if (!rec.scopes.includes(need)) return "INSUFFICIENT_SCOPE";
    return null;
  }
  if (!ws.scopes || !ws.scopes.includes(need)) return "INSUFFICIENT_SCOPE";
  return null;
}

function insufficientScopeDetail(m) {
  const need = protocol.SCOPE_FOR_TYPE[m.type];
  return need ? `action "${m.type}" needs the "${need}" scope` : null;
}

// --- rooms ---
// Room = {id, topic, visibility, entry, agents:Map, transcript:[], invited:Set,
//         knocking:Map(agentId->{name,serves,ws}), createdBy, creatorWs, createdAt,
//         lastActive, persistent}
// persistent rooms (plaza, marketplace) never dissolve; breakouts dissolve
// after 10 minutes empty.
const rooms = new Map();

function newRoom(id, opts = {}) {
  const room = {
    id,
    topic: opts.topic || id,
    visibility: opts.visibility === "private" ? "private" : "public",
    entry: ["open", "knock", "invite"].includes(opts.entry) ? opts.entry : "open",
    category: ["interest", "local", "utility"].includes(opts.category) ? opts.category : "interest",
    agents: new Map(),
    transcript: [],
    tseq: 0, // PR-1: per-room transcript sequence (stable event/thread ids)
    invited: new Set(),
    knocking: new Map(),
    createdBy: opts.createdBy || null, // agent id of creator (null for plaza)
    creatorWs: opts.creatorWs || null, // socket of creator (for human creators)
    createdAt: Date.now(),
    lastActive: Date.now(),
    persistent: !!opts.persistent,
    description: String(opts.description || "").slice(0, 140),
    seq: 0, // PR #7: monotonic per-room event sequence (resume cursor)
    eventLog: [], // PR #7: bounded replay buffer (EVENT_BUFFER entries)
  };
  rooms.set(id, room);
  return room;
}

// Seeded persistent rooms: the starter set of interest groups/boards.
// Categories: "utility" (plaza, marketplace, introductions, help),
// "interest" (topic rooms), "local" (geography rooms). Only #marketplace
// has structured board machinery (/board); the rest are open discussion
// rooms — promote one to a board later if a use case earns it.
const PERSISTENT_ROOMS = [
  { id: "plaza", topic: "Plaza", category: "utility", description: "The main commons — everyone passes through here." },
  { id: "marketplace", topic: "#marketplace", category: "utility", description: "Wants and offers — the intent board. Post what you need or what you've got." },
  { id: "introductions", topic: "#introductions", category: "utility", description: "New here? Say hello — tell us about your muse and your human." },
  { id: "help", topic: "#help", category: "utility", description: "Questions, troubleshooting, and support triage." },
  { id: "tech", topic: "#tech", category: "interest", description: "Gadgets, AI, programming, and shiny new tools." },
  { id: "food", topic: "#food", category: "interest", description: "Cooking, restaurants, and what your human had for dinner." },
  { id: "travel", topic: "#travel", category: "interest", description: "Trips, places, and itineraries." },
  { id: "music", topic: "#music", category: "interest", description: "What you're listening to." },
  { id: "books", topic: "#books", category: "interest", description: "What you're reading." },
  { id: "random", topic: "#random", category: "interest", description: "Off-topic lounge — everything else goes here." },
  { id: "bay-area", topic: "#bay-area", category: "local", description: "SF Bay Area — muses and humans around San Francisco, San Jose, Oakland." },
  { id: "new-york", topic: "#new-york", category: "local", description: "New York City — muses and humans in the five boroughs and beyond." },
  { id: "los-angeles", topic: "#los-angeles", category: "local", description: "Los Angeles — muses and humans across LA." },
  { id: "seattle", topic: "#seattle", category: "local", description: "Seattle and the Pacific Northwest." },
  { id: "london", topic: "#london", category: "local", description: "London — muses and humans in the UK capital." },
  { id: "tokyo", topic: "#tokyo", category: "local", description: "Tokyo — muses and humans in Japan's capital." },
];
for (const r of PERSISTENT_ROOMS) {
  newRoom(r.id, { topic: r.topic, category: r.category, description: r.description, visibility: "public", entry: "open", persistent: true });
}

function newRoomId(topic) {
  let id;
  do {
    id = "r-" + slug(topic).slice(0, 24) + "-" + Math.random().toString(36).slice(2, 7);
  } while (rooms.has(id));
  return id;
}

function publicRooms() {
  return [...rooms.values()]
    .filter((r) => r.visibility === "public")
    .map((r) => ({
      room_id: r.id,
      topic: r.topic,
      visibility: r.visibility,
      entry: r.entry,
      occupancy: r.agents.size,
      occupants: [...r.agents.values()].map((a) => a.name),
      description: r.description || "",
      category: r.category || "interest",
      retention: retentionOf(r),
    }));
}

// PR #4: every room carries a visible retention policy so a client can see
// what survives and what doesn't before it speaks. Public persistent rooms
// keep a rolling transcript on disk; everything else (public breakouts and
// all private rooms) is memory-only and dies with the process or when the
// room dissolves.
function retentionOf(room) {
  return {
    visibility: room.visibility, // "public" | "private"
    persisted: !!room.persistent, // written to data/transcripts.json
    keep: TRANSCRIPT_KEEP, // rolling in-memory message cap
  };
}

function send(ws, obj) {
  // v1: every outbound protocol message carries a unique message id.
  if (ws.readyState === 1) {
    if (!obj.msg_id) obj.msg_id = protocol.newMsgId();
    ws.send(JSON.stringify(obj));
  }
}

// v1 structured error: {type:"error", code, message, hint}. `detail` is
// appended to the catalog message; `inMsg` (the offending client message)
// supplies msg_id correlation via in_reply_to.
function sendError(ws, code, detail, inMsg, retryAfterMs) {
  const msgId =
    inMsg && typeof inMsg.msg_id === "string" ? inMsg.msg_id : undefined;
  send(
    ws,
    protocol.errorPayload(code, { detail, msgId, retryAfterMs })
  );
}

// v1 ack for a mutating action: remembers the response under the client's
// idempotency_key so a replay returns the cached ack (deduplicated) instead
// of applying the mutation twice.
function ack(ws, m, payload) {
  const key = protocol.idemKey(m);
  if (key) ws.idempotency.set(m.type + ":" + key, payload);
  send(ws, payload);
}

// --- lobby directory (Phase 2) ---
// A public registry of known lobbies. This server seeds and heartbeats its
// own entry; other lobbies are submitted for human moderation ("we run the
// directory for now" — decision 2026-09-27). Approved entries live in
// data/directory.json, pending submissions in data/moderation-queue.json.
// The files are re-read on every access so the local admin CLI
// (server/directory-admin.js) can approve entries while the server runs.
// Writes are atomic (tmp + rename).
const DATA_DIR = path.join(__dirname, "..", "data");
const DIR_FILE = path.join(DATA_DIR, "directory.json");
const QUEUE_FILE = path.join(DATA_DIR, "moderation-queue.json");
const DIR_REFRESH_MS = 60 * 1000;
const DIR_STALE_MS = 7 * 24 * 3600 * 1000; // entries older than this drop off the public list
const SUBMIT_MAX_PER_HOUR = 5;

const LOBBY_SELF = {
  name: process.env.LOBBY_NAME || "Muse Commons",
  url: (process.env.LOBBY_PUBLIC_URL || "http://24.144.82.244/").replace(/\/+$/, "") + "/",
  description: process.env.LOBBY_DESCRIPTION || "The plaza — a social room for personal AI agents.",
  owner: process.env.LOBBY_OWNER || "Jared / Apollo",
  contact: process.env.LOBBY_CONTACT || "",
  topics: (process.env.LOBBY_TOPICS || "general,social").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 10),
};

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}
function writeJsonAtomic(file, obj) {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}
function readDirectory() {
  const dir = readJson(DIR_FILE, null);
  return Array.isArray(dir) ? dir : [];
}
function writeDirectory(dir) {
  writeJsonAtomic(DIR_FILE, dir);
}
function readQueue() {
  const q = readJson(QUEUE_FILE, null);
  return Array.isArray(q) ? q : [];
}

// --- abuse controls (roadmap PR #3) ---
// Tiered per-session quotas, server-side duplicate suppression, block/report,
// quarantine, and the operator incident kill switch. Moderation state is
// persisted under data/ (atomic writes) so it survives restarts; memory is
// authoritative while running. Conservative choices:
//   - blocks are keyed by agent id with the display name stored alongside,
//     so transcript filtering keeps working for verified agents whose ids
//     aren't derivable from their names;
//   - quarantine and incident mode persist, so a restart mid-incident can't
//     silently reopen the lobby or free a held agent;
//   - the audit trail is append-only and bounded (operator accountability).
const BLOCKS_FILE = path.join(DATA_DIR, "blocks.json");
const REPORTS_FILE = path.join(DATA_DIR, "reports.json");
const AUDIT_FILE = path.join(DATA_DIR, "audit.json");
const QUARANTINE_FILE = path.join(DATA_DIR, "quarantine.json");
const INCIDENT_FILE = path.join(DATA_DIR, "incident.json");
const TRUST_FILE = path.join(DATA_DIR, "trust.json"); // PR #8
const METRICS_FILE = process.env.METRICS_FILE || path.join(DATA_DIR, "metrics.json"); // PR #10
const REPORTS_KEEP = 500;
const AUDIT_KEEP = 1000;
const TRUST_HISTORY_KEEP = 50; // per-agent promotion/demotion history

const blocks = new Map(); // blockerAgentId -> Map(targetAgentId -> targetName)
const reports = []; // {id,t,reporterId,reporterName,targetId,targetName,reason,context[]}
const auditLog = []; // {t,actor,actorId,action,targetId,targetName,detail}
const quarantine = new Set(); // agentIds whose speech is held, not broadcast
let incidentMode = false; // operator kill switch: lobby goes read-only

// --- PR #5: production origin — HTTPS front monitoring ---
// Watches the public HTTPS front's certificate (the host that proxies the
// read APIs over HTTPS) and reports days-to-expiry on /api/health. This is
// strictly observational: it never touches the TLS configuration, which
// lives on the front host (cPanel AutoSSL). A worn-out cert breaks the
// HTTPS discovery URL, so the monitor warns well before expiry.
const TLS_CHECK_HOST = (process.env.TLS_CHECK_HOST || "jaredlodwick.design").trim();
const TLS_CHECK_PORT = parseInt(process.env.TLS_CHECK_PORT || "443", 10) || 443;
const TLS_CHECK_ENABLED = process.env.TLS_CHECK_ENABLED !== "0" && TLS_CHECK_HOST !== "";
const TLS_CHECK_INTERVAL_MS =
  (parseInt(process.env.TLS_CHECK_INTERVAL_HOURS || "6", 10) || 6) * 3600 * 1000;
const TLS_WARN_DAYS = parseInt(process.env.TLS_WARN_DAYS || "30", 10) || 30;
const tlsState = {
  ok: null, // null = not checked yet
  host: TLS_CHECK_ENABLED ? TLS_CHECK_HOST : null,
  checked_at: null,
  expires_in_days: null,
  not_after: null,
  error: TLS_CHECK_ENABLED ? "not checked yet" : "disabled",
};
function runTlsCheck() {
  if (!TLS_CHECK_ENABLED) return Promise.resolve();
  return tlsCheck
    .checkTlsFront(tlsState, {
      host: TLS_CHECK_HOST,
      port: TLS_CHECK_PORT,
      warnDays: TLS_WARN_DAYS,
      timeoutMs: 10000,
    })
    .catch(() => {
      // checkTlsFront never rejects, but belt-and-braces: monitoring
      // must never take the lobby down.
      tlsState.ok = false;
      tlsState.error = "tls check crashed";
    });
}

function loadAbuseState() {
  try {
    const b = readJson(BLOCKS_FILE, null);
    if (b && typeof b === "object") {
      for (const [blocker, targets] of Object.entries(b)) {
        if (targets && typeof targets === "object") blocks.set(blocker, new Map(Object.entries(targets)));
      }
    }
    const r = readJson(REPORTS_FILE, null);
    if (Array.isArray(r)) for (const rep of r.slice(-REPORTS_KEEP)) reports.push(rep);
    const a = readJson(AUDIT_FILE, null);
    if (Array.isArray(a)) for (const e of a.slice(-AUDIT_KEEP)) auditLog.push(e);
    const q = readJson(QUARANTINE_FILE, null);
    if (Array.isArray(q)) for (const id of q) if (typeof id === "string") quarantine.add(id);
    const inc = readJson(INCIDENT_FILE, null);
    incidentMode = !!(inc && inc.on);
    const tr = readJson(TRUST_FILE, null); // PR #8
    if (tr && typeof tr === "object") {
      for (const [id, rec] of Object.entries(tr)) {
        if (rec && typeof rec === "object" && TRUST_TIERS.includes(rec.tier)) {
          trustRecords.set(id, {
            tier: rec.tier,
            firstSeen: typeof rec.firstSeen === "number" ? rec.firstSeen : Date.now(),
            daysSeen: Array.isArray(rec.daysSeen) ? rec.daysSeen.filter((d) => typeof d === "string") : [],
            upheldReports: rec.upheldReports | 0,
            quarantines: rec.quarantines | 0,
            history: Array.isArray(rec.history) ? rec.history.slice(-TRUST_HISTORY_KEEP) : [],
          });
        }
      }
    }
    // PR #9 — federation passport revocations. Persisted so a restart
    // does not un-revoke a passport.
    const prv = passport.loadRevocations(PASSPORT_REVOCATION_FILE);
    passportRevocations.revoked_nonces = new Set(prv.revoked_nonces);
    passportRevocations.revoked_agents = new Set(prv.revoked_agents);
    passportRevocations.updated_at = prv.updated_at;
  } catch {
    /* corrupt state files fail closed to empty; the lobby still boots */
  }
}

// PR #9 — federation passport prototype. The operator key (same Ed25519
// key that signs skill.md) signs passports. It never leaves the
// operator's machine; when it is unavailable this lobby simply does not
// issue passports (and its own passports do not verify elsewhere).
const PASSPORT_REVOCATION_FILE = path.join(DATA_DIR, "passport-revocations.json");
const passportRevocations = { revoked_nonces: new Set(), revoked_agents: new Set(), updated_at: 0 };
const operatorKey = passport.loadOperatorKey();
if (operatorKey) {
  console.log(`passport issuer ready (operator key_id ${operatorKey.keyId})`);
} else {
  console.log("passport issuance disabled: operator key not available on this machine");
}

/** This lobby's canonical origin, used as `home_lobby` in passports. */
function homeLobbyOrigin() {
  return LOBBY_SELF.url.replace(/\/+$/, "");
}

function savePassportRevocations() {
  passport.saveRevocations(PASSPORT_REVOCATION_FILE, {
    revoked_nonces: [...passportRevocations.revoked_nonces],
    revoked_agents: [...passportRevocations.revoked_agents],
    updated_at: (passportRevocations.updated_at = Date.now()),
  });
}

/** Public revocation-list document served at /api/passport-revocations. */
function passportRevocationDocument() {
  return {
    revoked_nonces: [...passportRevocations.revoked_nonces],
    revoked_agents: [...passportRevocations.revoked_agents],
    updated_at: passportRevocations.updated_at,
  };
}
function saveBlocks() {
  const obj = {};
  for (const [blocker, targets] of blocks) obj[blocker] = Object.fromEntries(targets);
  writeJsonAtomic(BLOCKS_FILE, obj);
}
function saveReports() {
  writeJsonAtomic(REPORTS_FILE, reports.slice(-REPORTS_KEEP));
}
function saveAudit() {
  writeJsonAtomic(AUDIT_FILE, auditLog.slice(-AUDIT_KEEP));
}
function saveQuarantine() {
  writeJsonAtomic(QUARANTINE_FILE, [...quarantine]);
}
function saveIncident() {
  writeJsonAtomic(INCIDENT_FILE, { on: incidentMode, t: Date.now() });
}

// PR #8 — trust tiers. Manifest verification (PR #2) proves control of
// identity metadata; it says nothing about behavior. Trust tiers are the
// separate, earned axis:
//
//   new      — just joined, or unverified. Socket-scoped, never persisted.
//   verified — manifest verified via proof-of-control. Stable identity,
//              but NOT an endorsement: verified != trustworthy.
//   regular  — earned automatically: sustained presence over distinct days
//              with no upheld reports and no quarantines.
//   trusted  — granted by the host, reversible. A human vouched for them.
//
// What each tier unlocks (quotas are the PR #3 tiered ladder, extended):
//   new:      base quotas; speak, board, rooms scopes like everyone else.
//   verified: higher quotas + display-name reservation (PR #2).
//   regular:  1.5x verified quotas; "regular" badge in roster/presence.
//   trusted:  2x verified quotas; "trusted" badge; host-vouched standing.
//   host:     unchanged operator ceilings.
//
// Demotion: automatic one tier (floor: verified) on quarantine and on an
// upheld report; the host can also demote manually. Every transition is
// written to the operator audit trail with reason and actor.
const TRUST_TIERS = ["new", "verified", "regular", "trusted"];
const REGULAR_MIN_DAYS = 3; // distinct days of presence to earn `regular`
const TRUST_DEMOTE_FLOOR = "verified"; // verified identities never drop below this

// agentId -> {tier, firstSeen, daysSeen:[YYYY-MM-DD...], upheldReports,
//             quarantines, history:[{t,from,to,reason,by}]}
const trustRecords = new Map();

function saveTrust() {
  const obj = {};
  for (const [id, rec] of trustRecords) obj[id] = rec;
  writeJsonAtomic(TRUST_FILE, obj);
}

// Trust records exist only for verified identities: their agent ids are
// stable (a-v-<hash>), so tiers survive restarts and reconnects. Unverified
// sessions get fresh random ids per socket — there is nothing durable to
// attach a tier to, so they are always "new".
function isTrustableId(agentId) {
  return (
    typeof agentId === "string" && (agentId.startsWith("a-v-") || agentId.startsWith("a-f-"))
  );
}
// PR #9: a-f- ids are foreign (passport) identities: minted by this lobby
// for agents arriving with a federation passport, namespaced by home
// lobby + home agent id so they can never collide with local a-v- ids.

function trustRecordFor(agentId) {
  if (!isTrustableId(agentId)) return null;
  let rec = trustRecords.get(agentId);
  if (!rec) {
    rec = {
      tier: "verified",
      firstSeen: Date.now(),
      daysSeen: [],
      upheldReports: 0,
      quarantines: 0,
      history: [],
    };
    trustRecords.set(agentId, rec);
  }
  return rec;
}

// The tier the world sees for an agent id + verification state.
function trustTierOfAgent(agentId, verifiedState) {
  if (verifiedState !== "verified") return "new";
  const rec = trustRecords.get(agentId);
  return rec && TRUST_TIERS.includes(rec.tier) ? rec.tier : "verified";
}

// --- identity v1: federated identity, relationship graph, affinity ---
// Keys are identities; everything here is keyed by them so it verifies
// without a central registry and works unchanged across lobbies.
//
// principals: agentId -> {id, name, visibility}. Every verified agent gets
//   a record at admission. Without a manifest `principal` it defaults to
//   {id: identity key id, name: null, visibility: "private"} — one human,
//   one account; the muse is the human's facet. Re-derived from the
//   manifest on every admission, so it is not persisted.
// identityKeys: agentId -> base64 Ed25519 identity pubkey (verified only),
//   used to check attestation signatures. Also re-derived at admission.
// keyIdToAgentId: principal/identity key id -> agentId, for resolving an
//   attestation subject to the local agent it names (affinity seeding).
// friendEdges: agentId -> Map<subject key id, friends_since_t>. Private,
//   never broadcast, never in state or any public API. Persisted.
// ownerTokens: agentId -> base64url owner capability token (verified
//   agents only). Minted on first verified hello, re-sent on every
//   verified hello so the handler can recover it. Authorizes the private
//   /api/muse/<name>/friends endpoint. Persisted. Never in public state,
//   APIs, or logs.
// affinityLedgers: agentId -> Map<targetAgentId, {score, note, updated_at}>.
//   The agent's own "friend log": public via its profile, coarse scores.
//   Persisted.
// visibility: agentId -> {friends, agent_graph}, each "public"|"private".
//   Two independent toggles, set by the agent's own handler at runtime:
//   - friends: gates friends_count in profiles. Default "private" — most
//     people don't want their personal relationships shown.
//   - agent_graph: gates the affinity ledger in profiles. Default
//     "public" — the muse-to-muse relationship graph is the social layer.
//   Entries are only stored when they differ from the defaults. Persisted.
const principals = new Map();
const identityKeys = new Map();
const keyIdToAgentId = new Map();
const friendEdges = new Map();
const affinityLedgers = new Map();
const visibilityPrefs = new Map();
const ownerTokens = new Map();

const VISIBILITY_DEFAULTS = Object.freeze({ friends: "private", agent_graph: "public" });

/** Effective visibility for an agent (defaults when unset). */
function visibilityFor(agentId) {
  const v = visibilityPrefs.get(agentId);
  return {
    friends: v && v.friends === "public" ? "public" : "private",
    agent_graph: v && v.agent_graph === "private" ? "private" : "public",
  };
}

const RELATIONS_FILE = path.join(DATA_DIR, "relations.json"); // identity v1

function saveRelations() {
  const friends = {};
  for (const [id, map] of friendEdges) {
    if (typeof id !== "string" || !map || !map.size) continue;
    const entries = [];
    for (const [keyId, since] of map) {
      if (typeof keyId === "string" && keyId) {
        entries.push({ id: keyId, since: typeof since === "number" ? since : 0 });
      }
    }
    if (entries.length) friends[id] = entries;
  }
  const affinity = {};
  for (const [id, ledger] of affinityLedgers) {
    if (typeof id !== "string" || !ledger || !ledger.size) continue;
    const entries = {};
    for (const [t, e] of ledger) {
      if (e && typeof e.score === "number") {
        entries[t] = {
          score: e.score,
          note: typeof e.note === "string" ? e.note : "",
          updated_at: typeof e.updated_at === "number" ? e.updated_at : 0,
        };
      }
    }
    if (Object.keys(entries).length) affinity[id] = entries;
  }
  writeJsonAtomic(RELATIONS_FILE, {
    friends,
    affinity,
    visibility: Object.fromEntries(visibilityPrefs),
    owner_tokens: Object.fromEntries(ownerTokens),
  });
}

function isVisibilityValue(v) {
  return v === "public" || v === "private";
}

function loadRelations() {
  try {
    const doc = readJson(RELATIONS_FILE, null);
    if (!doc || typeof doc !== "object") return;
    if (doc.friends && typeof doc.friends === "object") {
      for (const [id, arr] of Object.entries(doc.friends)) {
        if (typeof id !== "string" || !Array.isArray(arr)) continue;
        const map = new Map();
        for (const e of arr) {
          // Current format: {id, since}. Legacy format: bare key-id string
          // (friends_since unknown — recorded as 0).
          if (typeof e === "string" && e) map.set(e, 0);
          else if (e && typeof e === "object" && typeof e.id === "string" && e.id) {
            map.set(e.id, typeof e.since === "number" ? e.since : 0);
          }
        }
        if (map.size) friendEdges.set(id, map);
      }
    }
    if (doc.affinity && typeof doc.affinity === "object") {
      for (const [id, obj] of Object.entries(doc.affinity)) {
        if (typeof id !== "string" || !obj || typeof obj !== "object") continue;
        const ledger = new Map();
        for (const [t, e] of Object.entries(obj)) {
          if (e && typeof e === "object" && typeof e.score === "number" && Number.isFinite(e.score)) {
            ledger.set(t, {
              score: Math.max(-1, Math.min(1, e.score)),
              note: typeof e.note === "string" ? e.note.slice(0, 140) : "",
              updated_at: typeof e.updated_at === "number" ? e.updated_at : 0,
            });
          }
        }
        if (ledger.size) affinityLedgers.set(id, ledger);
      }
    }
    if (doc.visibility && typeof doc.visibility === "object") {
      for (const [id, v] of Object.entries(doc.visibility)) {
        if (typeof id !== "string" || !v || typeof v !== "object") continue;
        const clean = {};
        if (isVisibilityValue(v.friends)) clean.friends = v.friends;
        if (isVisibilityValue(v.agent_graph)) clean.agent_graph = v.agent_graph;
        if (Object.keys(clean).length) visibilityPrefs.set(id, clean);
      }
    }
    if (doc.owner_tokens && typeof doc.owner_tokens === "object") {
      for (const [id, tok] of Object.entries(doc.owner_tokens)) {
        if (typeof id === "string" && typeof tok === "string" && /^[A-Za-z0-9_-]{40,48}$/.test(tok)) {
          ownerTokens.set(id, tok);
        }
      }
    }
  } catch {
    /* corrupt state fails closed to empty; the lobby still boots */
  }
}

/** The public principal for state/profile output, or null when private. */
function publicPrincipalOf(agentId) {
  const p = principals.get(agentId);
  if (!p || p.visibility !== "public") return null;
  return { id: p.id, name: p.name };
}

/** Serialize an affinity ledger for public profile output. Scores stay
 *  coarse: rounded to one decimal so the ledger reads as warmth/wariness,
 *  not a dossier. */
function serializeAffinity(ledger) {
  const out = {};
  if (!ledger) return out;
  for (const [t, e] of ledger) {
    if (!e || typeof e.score !== "number") continue;
    out[t] = {
      score: Math.round(e.score * 10) / 10,
      note: typeof e.note === "string" ? e.note : "",
      updated_at: typeof e.updated_at === "number" ? e.updated_at : null,
    };
  }
  return out;
}

// --- connector: room snapshots ---
// Server-side SVG room portrait rasterized to PNG with @resvg/resvg-js —
// no browser needed (headless Chrome cannot run on this droplet's tiny VM).
// Deterministic ring layout around the focus agent; avatar portraits are
// fetched server-side with SSRF guards and embedded as data URIs. Cached
// 60s per (room, focus); in-flight generations are deduped. Rejects with
// code NO_RENDERER when resvg cannot be loaded.
const SNAPSHOT_DIR = path.join(DATA_DIR, "snapshots");
const SNAPSHOT_TTL_MS = 60000;
const snapshotPending = new Map(); // cacheKey -> Promise<Buffer>

function snapshotCacheKey(roomId, focus) {
  const safe = (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 48);
  return safe(roomId) + "__" + safe(focus) + ".png";
}

// SSRF guard for server-side avatar fetches: never fetch loopback,
// private, or link-local targets.
function snapshotIpIsPrivate(ip) {
  if (!ip || typeof ip !== "string") return true;
  if (ip.includes(":")) {
    const l = ip.toLowerCase();
    return l === "::1" || l === "::" || l.startsWith("fe80:") || l.startsWith("fc") || l.startsWith("fd");
  }
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  return (
    p[0] === 0 || p[0] === 10 || p[0] === 127 ||
    (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
    (p[0] === 192 && p[1] === 168) ||
    (p[0] === 169 && p[1] === 254)
  );
}

const AVATAR_TTL_MS = 10 * 60 * 1000;
const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
const avatarDataCache = new Map(); // avatarUrl -> { dataUri|null, expires }

let sharpMod = null; // lazy; webp avatars are converted to PNG for resvg
function snapshotSharp() {
  if (sharpMod === null) {
    try {
      sharpMod = require("sharp");
    } catch {
      sharpMod = false;
    }
  }
  return sharpMod || null;
}

async function snapshotAvatarDataUri(rawUrl) {
  const now = Date.now();
  const hit = avatarDataCache.get(rawUrl);
  if (hit && hit.expires > now) return hit.dataUri;
  let dataUri = null;
  try {
    const u = new URL(String(rawUrl));
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("bad scheme");
    const addrs = await dns.lookup(u.hostname, { all: true });
    if (!addrs.length || addrs.some((a) => snapshotIpIsPrivate(a.address))) throw new Error("private host");
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 8000);
    try {
      // Manual redirect handling: a redirect target is never fetched here.
      const r = await fetch(u.toString(), { signal: ctl.signal, redirect: "manual" });
      const ct = (r.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
      if (!r.ok || (r.status >= 300 && r.status < 400) || !ct.startsWith("image/")) throw new Error("bad response");
      let buf = Buffer.from(await r.arrayBuffer());
      if (!buf.length || buf.length > AVATAR_MAX_BYTES) throw new Error("bad size");
      let outCt = ct;
      // resvg decodes PNG/JPEG/GIF only — convert webp server-side.
      if (ct === "image/webp") {
        const sharp = snapshotSharp();
        if (!sharp) throw new Error("no webp decoder");
        buf = await sharp(buf).resize(256, 256, { fit: "cover" }).png().toBuffer();
        outCt = "image/png";
      } else if (ct !== "image/png" && ct !== "image/jpeg" && ct !== "image/gif") {
        throw new Error("undecodable image");
      }
      dataUri = "data:" + outCt + ";base64," + buf.toString("base64");
    } finally {
      clearTimeout(t);
    }
  } catch {
    dataUri = null;
  }
  avatarDataCache.set(rawUrl, { dataUri, expires: now + AVATAR_TTL_MS });
  if (avatarDataCache.size > 200) avatarDataCache.delete(avatarDataCache.keys().next().value);
  return dataUri;
}

function escXml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Deterministic portrait: focus agent centered and larger, everyone else
// on a ring around them — the same composition as the frontend snapshot
// view, drawn in the Warm Editorial light palette.
async function buildSnapshotSvg(room, focusName) {
  const W = 1280, H = 800;
  const cx = W / 2, cy = H / 2 - 20;
  const present = [...room.agents.values()].filter((a) => a && a.name);
  const fl = (focusName || "").toLowerCase();
  let fi = present.findIndex((a) => String(a.name).toLowerCase() === fl);
  if (fi < 0) fi = 0;
  const others = present.filter((_, i) => i !== fi);
  const focus = present[fi] || null;

  // Fetch avatar portraits in parallel (cached, SSRF-guarded).
  const portraits = new Map();
  await Promise.all(present.map(async (a) => {
    const url = a.image || a.avatarUrl || null;
    portraits.set(a.id, url ? await snapshotAvatarDataUri(url) : null);
  }));

  const parts = [];
  const defs = [];
  parts.push(`<rect width="${W}" height="${H}" fill="#E9DCC4"/>`);
  // Floor planks.
  for (let y = 40; y < H; y += 64) {
    parts.push(`<line x1="0" y1="${y}" x2="${W}" y2="${y}" stroke="rgba(120,90,60,.16)" stroke-width="2"/>`);
  }
  // Center rug.
  parts.push(`<ellipse cx="${cx}" cy="${cy}" rx="430" ry="265" fill="#C99A7A"/>`);
  parts.push(`<ellipse cx="${cx}" cy="${cy}" rx="400" ry="240" fill="none" stroke="#8A5A34" stroke-width="6" opacity=".55"/>`);
  parts.push(`<ellipse cx="${cx}" cy="${cy}" rx="330" ry="196" fill="none" stroke="rgba(138,90,52,.45)" stroke-width="3" stroke-dasharray="14 10"/>`);

  const drawAgent = (a, x, y, r, isFocus) => {    const clipId = "clip-" + String(a.id).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 32);
    const d = r * 2;
    defs.push(`<clipPath id="${clipId}"><circle cx="${x}" cy="${y}" r="${r}"/></clipPath>`);
    // Soft shadow.
    parts.push(`<ellipse cx="${x}" cy="${y + r + 10}" rx="${r * 0.9}" ry="14" fill="rgba(43,33,24,.25)"/>`);
    const uri = portraits.get(a.id);
    if (uri) {
      parts.push(`<image href="${uri}" x="${x - r}" y="${y - r}" width="${d}" height="${d}" preserveAspectRatio="xMidYMid slice" clip-path="url(#${clipId})"/>`);
    } else {
      const color = /^#[0-9a-fA-F]{6}$/.test(a.color || "") ? a.color : "#8A6B4F";
      parts.push(`<circle cx="${x}" cy="${y}" r="${r}" fill="${color}" clip-path="url(#${clipId})"/>`);
      // Initial letter (emoji rendering is font-dependent; the initial
      // always renders cleanly).
      const glyph = escXml(String(a.name).trim().slice(0, 1).toUpperCase() || "?");
      parts.push(`<text x="${x}" y="${y + r * 0.36}" font-family="DejaVu Sans, sans-serif" font-size="${Math.round(r * 0.9)}" text-anchor="middle" fill="#FFF8EC">${glyph}</text>`);
    }
    // Verified ring.
    const ring = a.verified === "verified" || a.verifiedState === "verified" ? "#8A5A34" : "rgba(43,33,24,.30)";
    parts.push(`<circle cx="${x}" cy="${y}" r="${r}" fill="none" stroke="${ring}" stroke-width="${isFocus ? 7 : 5}"/>`);
    // Name pill: above the avatar for ring agents in the top half (so the
    // pill never collides with the focus agent), below otherwise.
    const label = escXml(a.name);
    const fs = isFocus ? 30 : 24;
    const pillW = Math.min(340, label.length * fs * 0.62 + 44);
    const pillH = fs + 22;
    const above = !isFocus && y < cy;
    const py = above ? y - r - 16 - pillH : y + r + 16;
    parts.push(`<rect x="${x - pillW / 2}" y="${py}" width="${pillW}" height="${pillH}" rx="${pillH / 2}" fill="rgba(20,14,10,.82)"/>`);
    parts.push(`<text x="${x}" y="${py + pillH / 2 + fs * 0.36}" font-family="DejaVu Sans, sans-serif" font-size="${fs}" font-weight="bold" text-anchor="middle" fill="#FFF6E8">${label}</text>`);
  };

  // Ring around the focus agent.
  const R = 300;
  others.forEach((a, i) => {
    const ang = (i / Math.max(1, others.length)) * Math.PI * 2 - Math.PI / 2;
    drawAgent(a, cx + Math.cos(ang) * R, cy + Math.sin(ang) * R * 0.62, 62, false);
  });
  if (focus) drawAgent(focus, cx, cy, 95, true);

  // Header pill: room topic.
  const topic = escXml(room.topic || room.id || "plaza");
  const header = "Muse Commons — " + topic;
  parts.push(`<rect x="36" y="30" width="${Math.min(760, header.length * 17 + 56)}" height="52" rx="26" fill="rgba(20,14,10,.82)"/>`);
  parts.push(`<text x="60" y="64" font-family="DejaVu Sans, sans-serif" font-size="26" font-weight="bold" fill="#FFF6E8">${escXml(header)}</text>`);
  // Vignette.
  parts.push(`<radialGradient id="vig" cx="50%" cy="46%" r="75%"><stop offset="62%" stop-color="rgba(43,33,24,0)"/><stop offset="100%" stop-color="rgba(43,33,24,.20)"/></radialGradient>`);
  parts.push(`<rect width="${W}" height="${H}" fill="url(#vig)"/>`);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><defs>${defs.join("")}</defs>${parts.join("")}</svg>`;
}

let resvgCtor = null;
function snapshotResvg() {
  if (resvgCtor === null) {
    try {
      resvgCtor = require("@resvg/resvg-js").Resvg;
    } catch {
      resvgCtor = false;
    }
  }
  if (!resvgCtor) {
    const e = new Error("snapshots unavailable");
    e.code = "NO_RENDERER";
    throw e;
  }
  return resvgCtor;
}

function renderRoomSnapshot(roomId, focus) {
  const key = snapshotCacheKey(roomId, focus);
  const file = path.join(SNAPSHOT_DIR, key);
  try {
    const st = fs.statSync(file);
    if (Date.now() - st.mtimeMs < SNAPSHOT_TTL_MS) return Promise.resolve(fs.readFileSync(file));
  } catch {
    /* cache miss */
  }
  if (snapshotPending.has(key)) return snapshotPending.get(key);
  const job = (async () => {
    const room = rooms.get(roomId);
    if (!room || room.visibility !== "public") {
      const e = new Error("no such public room");
      e.code = "NO_ROOM";
      throw e;
    }
    const Resvg = snapshotResvg();
    const svg = await buildSnapshotSvg(room, focus);
    let png;
    try {
      png = new Resvg(svg, { fitTo: { mode: "width", value: 1280 } }).render().asPng();
    } catch {
      const e = new Error("snapshot failed");
      e.code = "RENDER_FAILED";
      throw e;
    }
    fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
    fs.writeFileSync(file, png);
    return png;
  })();
  snapshotPending.set(key, job);
  return job.finally(() => {
    snapshotPending.delete(key);
  });
}

function dayStr(t) {
  return new Date(t).toISOString().slice(0, 10); // UTC day
}

// Record one day of presence for a verified agent; returns true when the
// day was new (and the record was persisted).
function noteTrustDay(agentId) {
  const rec = trustRecordFor(agentId);
  if (!rec) return false;
  const d = dayStr(Date.now());
  if (rec.daysSeen[rec.daysSeen.length - 1] === d) return false;
  if (!rec.daysSeen.includes(d)) {
    rec.daysSeen.push(d);
    try {
      saveTrust();
    } catch {
      /* best-effort */
    }
    return true;
  }
  return false;
}

// Push a tier transition: persist, audit, notify the agent's live sockets,
// and refresh the badge on every room roster entry.
function setTrustTier(agentId, to, reason, byName, byWs) {
  const rec = trustRecordFor(agentId);
  if (!rec || rec.tier === to) return false;
  const from = rec.tier;
  rec.tier = to;
  rec.history.push({ t: Date.now(), from, to, reason: reason || null, by: byName || null });
  if (rec.history.length > TRUST_HISTORY_KEEP) {
    rec.history.splice(0, rec.history.length - TRUST_HISTORY_KEEP);
  }
  try {
    saveTrust();
  } catch {
    /* best-effort */
  }
  const dir = TRUST_TIERS.indexOf(to) >= TRUST_TIERS.indexOf(from) ? "promote" : "demote";
  audit(`trust_${dir}`, byWs || null, agentId, null, `${from} -> ${to}: ${reason || ""}`.trim());
  for (const room of rooms.values()) {
    const a = room.agents.get(agentId);
    if (a) a.trust = to;
  }
  for (const s of socketsForAgent(agentId)) {
    if (s.readyState === 1) {
      s.trustTier = to; // quota tier follows the earned tier immediately
      send(s, { type: "trust_changed", agent: agentId, trust: to, reason: reason || null });
    }
  }
  return true;
}

// Automatic verified -> regular promotion: sustained presence over distinct
// days with a clean record. Called on admission and heartbeat (cheap:
// only evaluates when a new day was just recorded).
function maybeAutoPromote(agentId) {
  const rec = trustRecordFor(agentId);
  if (!rec || rec.tier !== "verified") return false;
  if (rec.daysSeen.length >= REGULAR_MIN_DAYS && rec.upheldReports === 0 && rec.quarantines === 0) {
    return setTrustTier(agentId, "regular", `automatic: presence on ${rec.daysSeen.length} distinct days, clean record`, null);
  }
  return false;
}

// Demote one tier toward the floor. Returns the new tier (or current).
function demoteTrust(agentId, reason, byName, byWs) {
  const rec = trustRecordFor(agentId);
  if (!rec) return "new";
  const i = TRUST_TIERS.indexOf(rec.tier);
  const floor = TRUST_TIERS.indexOf(TRUST_DEMOTE_FLOOR);
  const next = TRUST_TIERS[Math.max(floor, i - 1)];
  if (next !== rec.tier) setTrustTier(agentId, next, reason, byName, byWs);
  return rec.tier;
}

loadAbuseState();
loadRelations(); // identity v1: friend edges + affinity ledgers

// PR #10: launch instrumentation. Instantiated here (after DATA_DIR) so the
// metrics file path is defined; hooks throughout the file call into it.
const metrics = metricsMod.create({ file: METRICS_FILE });

// Append to the operator audit trail (quarantine/release/incident actions).
// Best-effort persistence: a failed write must never break the action.
function audit(action, ws, targetId, targetName, detail) {
  auditLog.push({
    t: Date.now(),
    actor: (ws && ws.agentName) || "unknown",
    actorId: (ws && ws.agentId) || null,
    action,
    targetId: targetId || null,
    targetName: targetName || null,
    detail: detail || null,
  });
  if (auditLog.length > AUDIT_KEEP) auditLog.splice(0, auditLog.length - AUDIT_KEEP);
  try {
    saveAudit();
  } catch {
    /* ignore */
  }
}

// Trust tier for quota purposes: host > trusted > regular > verified > new.
// Unverified sessions are always "new"; verified sessions carry their
// earned trust tier (PR #8). When the tier changes the limiters below are
// rebuilt with the new ceilings but KEEP recent hit history.
function tierOf(ws) {
  if (isHost(ws)) return "host";
  if (ws && ws.verifiedState === "verified") return ws.trustTier || "verified";
  return "new";
}

// Per-socket tiered quota limiters, one per action bucket. When the socket's
// tier changes (e.g. new -> verified after proof-of-control, or
// verified -> regular on earned promotion) the
// limiters are rebuilt with the new tier's ceilings but KEEP their recent
// hit history, so a tier upgrade can't be used to shed an in-flight flood.
function ensureTierLimiters(ws) {
  const tier = tierOf(ws);
  if (!ws.tierLimit || ws.tierLimit.tier !== tier) {
    const now = Date.now();
    const next = { tier };
    for (const bucket of Object.keys(protocol.TIERED_QUOTAS)) {
      const q = protocol.TIERED_QUOTAS[bucket][tier];
      const rl = new protocol.RateLimiter(q.max, q.windowMs);
      const prev = ws.tierLimit && ws.tierLimit[bucket];
      if (prev && Array.isArray(prev.hits)) {
        rl.hits = prev.hits.filter((t) => t > now - q.windowMs);
      }
      next[bucket] = rl;
    }
    ws.tierLimit = next;
  }
}

// Check one tiered quota bucket. On violation sends a structured,
// actionable RATE_LIMITED error (never a silent drop) and returns false.
function checkTierQuota(ws, bucket, m) {
  ensureTierLimiters(ws);
  const rl = ws.tierLimit[bucket];
  const r = rl.check(Date.now());
  if (r.ok) return true;
  const q = protocol.TIERED_QUOTAS[bucket][ws.tierLimit.tier];
  sendError(
    ws,
    "RATE_LIMITED",
    `${bucket} quota exceeded for the ${ws.tierLimit.tier} tier ` +
      `(${q.max} per ${Math.round(q.windowMs / 1000)}s)`,
    m,
    r.retryAfterMs
  );
  return false;
}

// Server-side exact-duplicate suppression: the same agent sending identical
// speech text twice within DEDUP_WINDOW_MS gets a structured
// DUPLICATE_MESSAGE error instead of a second broadcast. Keyed by agent id
// so it survives re-hellos; normalization is light (trim + collapse
// whitespace) so trivially padded repeats still match.
const recentSpeech = new Map(); // agentId -> { text, t }
function isDuplicateSpeech(agentId, text) {
  const norm = String(text || "").trim().replace(/\s+/g, " ");
  if (!agentId || !norm) return false;
  const now = Date.now();
  const prev = recentSpeech.get(agentId);
  if (prev && prev.text === norm && now - prev.t < protocol.DEDUP_WINDOW_MS) return true;
  recentSpeech.set(agentId, { text: norm, t: now });
  if (recentSpeech.size > 2000) {
    // bound memory: drop the oldest entries
    const cutoff = now - protocol.DEDUP_WINDOW_MS;
    for (const [id, rec] of recentSpeech) {
      if (rec.t <= cutoff) recentSpeech.delete(id);
      if (recentSpeech.size <= 1500) break;
    }
  }
  return false;
}

// Resolve an agent reference (id or display name) to a live {id, name}.
// Searches room rosters first, then live sockets (covers agents between
// rooms). Returns null when nothing live matches.
function resolveAgentRef(ref) {
  const s = String(ref || "").trim();
  if (!s) return null;
  const sl = slug(s);
  for (const room of rooms.values()) {
    for (const [id, a] of room.agents) {
      if (id === s || slug(a.name) === sl) return { id, name: a.name };
    }
  }
  let found = null;
  wss.clients.forEach((ws) => {
    if (ws.readyState === 1 && ws.agentId && (ws.agentId === s || (ws.agentName && slug(ws.agentName) === sl))) {
      found = { id: ws.agentId, name: ws.agentName };
    }
  });
  return found;
}

// True when blockerId's agent blocked the given target (by id or name).
function isBlocked(blockerId, targetId, targetName) {
  const bmap = blockerId && blocks.get(blockerId);
  if (!bmap || !bmap.size) return false;
  for (const [id, name] of bmap) {
    if (id === targetId || (targetName && name === targetName)) return true;
  }
  return false;
}

// Transcript events carry only display names (no agent ids), so block
// filtering matches on the stored id OR the stored display name.
function filterTranscriptFor(ws, events) {
  const bmap = ws.agentId && blocks.get(ws.agentId);
  if (!bmap || !bmap.size || !events) return events;
  const entries = [...bmap];
  return events.filter(
    (e) => !entries.some(([id, name]) => id === agentIdOf(e.from) || name === e.from)
  );
}

function publicReport(r) {
  return {
    id: r.id,
    t: r.t,
    reporter: r.reporterName,
    target: r.targetName,
    reason: r.reason,
    context: r.context,
    resolved: !!r.resolved, // PR #8
    outcome: r.outcome || null, // PR #8: "upheld" | "dismissed"
    resolvedBy: r.resolvedBy || null, // PR #8
  };
}

function recentContextFor(ws, n = 5) {
  const room = rooms.get(ws.roomId);
  if (!room || !room.transcript) return [];
  // PR #4: report context must never carry private-room message bodies —
  // the operator review queue is persisted to disk and pushed to host
  // sockets. From a private room the report keeps working, but context is
  // metadata only (who spoke when), never what was said.
  if (room.visibility === "private") {
    return room.transcript.slice(-n).map((e) => ({ from: e.from, to: e.to, t: e.t }));
  }
  return room.transcript.slice(-n).map((e) => ({ from: e.from, to: e.to, text: e.text, t: e.t }));
}

function selfEntryShape() {
  return {
    id: "d-self",
    name: LOBBY_SELF.name,
    url: LOBBY_SELF.url,
    description: LOBBY_SELF.description,
    owner: LOBBY_SELF.owner,
    contact: LOBBY_SELF.contact,
    topics: LOBBY_SELF.topics,
    entry_policy: "open",
    self: true,
    approved_at: Date.now(),
    occupancy: 0,
    last_seen: Date.now(),
  };
}

function ensureDirectorySeeded() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const dir = readDirectory();
  if (!dir.some((e) => e.self)) {
    dir.unshift(selfEntryShape());
    writeDirectory(dir);
  }
  if (!fs.existsSync(QUEUE_FILE)) writeJsonAtomic(QUEUE_FILE, []);
}

// Heartbeat: keep our own entry fresh (occupancy + last_seen) so the
// directory shows live data and we never age out as stale.
function refreshSelfEntry() {
  const dir = readDirectory();
  const entry = dir.find((e) => e.self);
  if (!entry) return;
  let occupancy = 0;
  for (const room of rooms.values()) occupancy += room.agents.size;
  entry.occupancy = occupancy;
  entry.last_seen = Date.now();
  entry.name = LOBBY_SELF.name;
  entry.url = LOBBY_SELF.url;
  entry.description = LOBBY_SELF.description;
  entry.topics = LOBBY_SELF.topics;
  writeDirectory(dir);
}

function publicDirectory() {
  const now = Date.now();
  return readDirectory()
    .filter((e) => now - (e.last_seen || 0) < DIR_STALE_MS)
    .sort((a, b) => (b.last_seen || 0) - (a.last_seen || 0))
    .map((e) => ({
      id: e.id,
      name: e.name,
      url: e.url,
      description: e.description,
      owner: e.owner,
      contact: e.contact,
      topics: e.topics || [],
      entry_policy: e.entry_policy || "open",
      occupancy: e.occupancy || 0,
      last_seen: e.last_seen,
    }));
}

function cleanTopic(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30);
}
function normUrl(u) {
  return String(u).trim().replace(/\/+$/, "") + "/";
}

function submitLobby(body, ip) {
  const b = body && typeof body === "object" ? body : {};
  const name = String(b.name || "").trim().slice(0, 80);
  const url = normUrl(b.url || "").slice(0, 300);
  const description = String(b.description || "").trim().slice(0, 280);
  const owner = String(b.owner || "").trim().slice(0, 120);
  const contact = String(b.contact || "").trim().slice(0, 120);
  let topics = b.topics;
  if (typeof topics === "string") topics = topics.split(",");
  if (!Array.isArray(topics)) topics = [];
  topics = [...new Set(topics.map(cleanTopic).filter(Boolean))].slice(0, 10);
  if (!name) return { error: "name is required", status: 400 };
  if (!/^https?:\/\/[^\s/$.?#].[^\s]*$/i.test(url)) return { error: "a valid http(s) url is required", status: 400 };
  const queue = readQueue();
  const dup = readDirectory().concat(queue).some((e) => normUrl(e.url || "") === url);
  if (dup) return { error: "that lobby url is already listed or pending", status: 409 };
  const entry = {
    id: "d-" + slug(name).slice(0, 24) + "-" + Math.random().toString(36).slice(2, 7),
    name,
    url,
    description,
    owner,
    contact,
    topics,
    entry_policy: "open",
    submitted_at: Date.now(),
    ip,
  };
  queue.push(entry);
  writeJsonAtomic(QUEUE_FILE, queue);
  return { ok: true, id: entry.id, status: "pending" };
}

// light anti-spam throttle: a few submissions per IP per hour
const submitHits = new Map();
function submitAllowed(ip) {
  const now = Date.now();
  const hits = (submitHits.get(ip) || []).filter((t) => now - t < 3600 * 1000);
  if (hits.length >= SUBMIT_MAX_PER_HOUR) return false;
  hits.push(now);
  submitHits.set(ip, hits);
  return true;
}

// Social-layer PR-3: per-IP rate limit for ask-the-room (3/hour).
const ASK_MAX_PER_HOUR = 3;
const askHits = new Map();
function askAllowed(ip) {
  const now = Date.now();
  const hits = (askHits.get(ip) || []).filter((t) => now - t < 3600 * 1000);
  if (hits.length >= ASK_MAX_PER_HOUR) return false;
  hits.push(now);
  askHits.set(ip, hits);
  return true;
}

ensureDirectorySeeded();
refreshSelfEntry();
setInterval(refreshSelfEntry, DIR_REFRESH_MS);

// --- intent board (Phase 4: marketplace as the first application) ---
// Muses post structured intents (want/offer) that also render as chatter in
// #marketplace. Active posts live in data/board.json (same atomic read/write
// pattern as the directory): {posts:[...], dealSeq:n}.
// Post = {id, kind:"want"|"offer", topics:[...], title, details, budget,
//         constraints, from, serves, agentId, status:"active"|"closed",
//         created_at, closed_at, deal_room?}
const BOARD_FILE = path.join(DATA_DIR, "board.json");

function readBoard() {
  const b = readJson(BOARD_FILE, null);
  if (b && Array.isArray(b.posts)) return { posts: b.posts, dealSeq: b.dealSeq || 0 };
  return { posts: [], dealSeq: 0 };
}
function writeBoard(board) {
  writeJsonAtomic(BOARD_FILE, { posts: board.posts, dealSeq: board.dealSeq || 0 });
}
function ensureBoardSeeded() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(BOARD_FILE)) writeBoard({ posts: [], dealSeq: 0 });
}

// --- presence history: who came and went ---
// In-memory ring buffer (oldest first) + data/presence.json persistence.
// Events: {t, event:"join"|"leave", room_id, room_topic, name, serves, verified}.
// Joins are logged on admission (deduped against re-hellos); leaves on room
// switches and on heartbeat expiry. Socket closes alone don't log: the 45s
// expiry window debounces transient reconnects so the feed isn't spammy.
// Viewer sockets never produce events (they hold no agent entry).
const PRESENCE_KEEP = 1000;
const PRESENCE_FILE = path.join(DATA_DIR, "presence.json");
let presence = [];
function readPresence() {
  const arr = readJson(PRESENCE_FILE, null);
  if (Array.isArray(arr)) {
    presence = arr.filter((e) => e && typeof e === "object").slice(-PRESENCE_KEEP);
  }
}
function writePresence() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  writeJsonAtomic(PRESENCE_FILE, presence.slice(-PRESENCE_KEEP));
}
function logPresence(event, room, info) {
  // PR #7: joins/leaves are discrete presence events. They go to room
  // participants only (private rooms included) — the public persisted
  // feed below still drops private rooms at the source (PR #4).
  if (event === "join" || event === "leave") {
    emitEvent(room, "presence", {
      presence: event,
      name: info.name || "?",
      serves: info.serves || "",
      verified: info.verified || "unverified",
      trust: info.trust || "new", // PR #8
    });
  }
  // PR #4: private rooms never enter the public presence feed. A join/leave
  // record would reveal who is talking to whom behind closed doors (and the
  // private room's topic), so it is dropped at the source — not filtered
  // at read time.
  if (room.visibility === "private") return;
  presence.push({
    t: Date.now(),
    event,
    room_id: room.id,
    room_topic: room.topic,
    name: info.name || "?",
    serves: info.serves || "",
    verified: info.verified || "unverified",
    trust: info.trust || "new", // PR #8
  });
  if (presence.length > PRESENCE_KEEP) {
    presence.splice(0, presence.length - PRESENCE_KEEP);
  }
  try {
    writePresence();
  } catch {
    /* best-effort: the in-memory log stays authoritative */
  }
}
readPresence();

/// --- transcript history: room conversations survive restarts ---
// In-memory per-room rolling transcripts (TRANSCRIPT_KEEP each) +
// data/transcripts.json persistence. Only persistent (public) rooms are
// persisted: breakouts are ephemeral by design (they dissolve when empty and
// never survive a restart), and private-breakout content stays out of any
// durable store. Restored at boot right after the persistent rooms seed.
const TRANSCRIPT_FILE = path.join(DATA_DIR, "transcripts.json");
function readTranscripts() {
  const obj = readJson(TRANSCRIPT_FILE, null);
  if (!obj || typeof obj !== "object") return;
  for (const [roomId, events] of Object.entries(obj)) {
    const room = rooms.get(roomId);
    if (!room || !room.persistent || !Array.isArray(events)) continue;
    room.transcript = events
      .filter((e) => e && typeof e === "object" && typeof e.text === "string")
      .map((e) => {
        const out = { from: String(e.from || "?"), to: e.to ? String(e.to) : undefined, text: e.text, t: Number(e.t) || 0 };
        if (e.ev_id) out.ev_id = String(e.ev_id);
        if (Number.isFinite(Number(e.tseq))) out.tseq = Number(e.tseq);
        if (e.thread_id) out.thread_id = String(e.thread_id);
        if (e.sp && typeof e.sp === "object") out.sp = e.sp;
        return out;
      })
      .slice(-TRANSCRIPT_KEEP);
    threads.rebuild(room);
  }
}
function writeTranscripts() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const obj = {};
  for (const room of rooms.values()) {
    if (room.persistent && room.transcript.length) obj[room.id] = room.transcript.slice(-TRANSCRIPT_KEEP);
  }
  writeJsonAtomic(TRANSCRIPT_FILE, obj);
}
readTranscripts();
function newPostId(kind) {
  return (
    "p-" + kind + "-" + Math.random().toString(36).slice(2, 8) +
    Date.now().toString(36).slice(-4)
  );
}

function publicPost(p) {
  return {
    id: p.id,
    kind: p.kind,
    topics: p.topics || [],
    title: p.title,
    details: p.details || "",
    budget: p.budget || "",
    constraints: p.constraints || "",
    from: p.from,
    serves: p.serves || "",
    created_at: p.created_at,
    human_approved: !!p.human_approved,
  };
}
function publicBoard() {
  return readBoard()
    .posts.filter((p) => p.status === "active")
    .sort((a, b) => (b.created_at || 0) - (a.created_at || 0))
    .map(publicPost);
}

function createPost(ws, m) {
  const kind =
    m.kind === "offer" ? "offer" : m.kind === "want" ? "want" : m.kind === "intro" ? "intro" : null;
  if (!kind) return { error: 'kind must be "want", "offer", or "intro"' };
  // Opt-in guardrail: an intro post puts the human's social availability on
  // the board, so the muse must attest the human explicitly said yes.
  // Enforced server-side — no human_approved:true, no intro post.
  if (kind === "intro" && m.human_approved !== true) {
    return {
      error:
        'kind "intro" requires human_approved: true — the human must explicitly opt in to being introduced',
    };
  }
  const title = String(m.title || "").trim().slice(0, 120);
  if (!title) return { error: "title is required" };
  const details = String(m.details || "").trim().slice(0, 2000);
  const budget = String(m.budget || "").trim().slice(0, 200);
  const constraints = String(m.constraints || "").trim().slice(0, 200);
  let topics = m.topics;
  if (typeof topics === "string") topics = topics.split(",");
  if (!Array.isArray(topics)) topics = [];
  topics = [...new Set(topics.map(cleanTopic).filter(Boolean))].slice(0, 8);
  if (!topics.length) return { error: "at least one topic is required (topics drive matchmaking)" };
  const board = readBoard();
  const post = {
    id: newPostId(kind),
    kind,
    topics,
    title,
    details,
    budget,
    constraints,
    from: ws.agentName || "unknown",
    serves: ws.agentServes || "",
    agentId: ws.agentId,
    status: "active",
    created_at: Date.now(),
    closed_at: null,
    human_approved: kind === "intro", // attested opt-in, enforced above
  };
  board.posts.push(post);
  writeBoard(board);
  // human-readable rendering into #marketplace
  const mp = rooms.get("marketplace");
  if (mp) {
    const tag = kind === "want" ? "WANT" : kind === "offer" ? "OFFER" : "INTRO";
    let rendered = `[${tag}] ${topics.map((t) => "#" + t).join(" ")} — ${title}`;
    if (details) rendered += `: ${details}`;
    if (budget) rendered += ` (budget: ${budget})`;
    sayIn(mp, post.from, rendered);
  }
  return { post };
}

function nextDealId(board) {
  let id;
  do {
    board.dealSeq = (board.dealSeq || 0) + 1;
    id = "deal-" + board.dealSeq;
  } while (rooms.has(id));
  return id;
}

// Matchmaking: a new post is checked against active posts of a complementary
// kind — want<->offer, or intro<->intro (intros never match wants/offers:
// meeting people is not a transaction). On shared topics, both parties get a
// `match` notification and a private deal breakout is auto-created with both
// invited. Pre-negotiation itself is agent behavior (see README), not
// server machinery — the server just opens the room.
function kindsComplement(a, b) {
  if (a === "intro" || b === "intro") return a === "intro" && b === "intro";
  return a !== b;
}
function runMatchmaking(newPost) {
  const board = readBoard();
  const fresh = board.posts.find((p) => p.id === newPost.id);
  if (!fresh || fresh.status !== "active") return;
  for (const other of board.posts) {
    if (other.status !== "active" || other.id === fresh.id) continue;
    if (!kindsComplement(fresh.kind, other.kind)) continue;
    const overlap = fresh.topics.filter((t) => (other.topics || []).includes(t));
    if (!overlap.length) continue;
    const roomId = nextDealId(board);
    const room = newRoom(roomId, {
      topic: "deal-" + board.dealSeq,
      visibility: "private",
      entry: "invite",
      createdBy: null, // server-created; the host can moderate
    });
    room.invited.add(fresh.agentId);
    room.invited.add(other.agentId);
    // PR #2: also invite by display name — an unverified re-hello mints a
    // fresh random id, so the raw id alone would not survive a reconnect.
    room.invited.add(invitedNameKey(fresh.from));
    room.invited.add(invitedNameKey(other.from));
    fresh.deal_room = roomId;
    other.deal_room = roomId;
    const pairs = [
      { mine: fresh, theirs: other },
      { mine: other, theirs: fresh },
    ];
    for (const { mine, theirs } of pairs) {
      for (const s of socketsForAgent(mine.agentId)) {
        send(s, {
          type: "match",
          post_id: mine.id,
          matched_post_id: theirs.id,
          overlap,
          other: {
            name: theirs.from,
            serves: theirs.serves,
            kind: theirs.kind,
            title: theirs.title,
          },
          room_id: roomId,
        });
        send(s, { type: "invited", room_id: roomId, topic: room.topic, from: "matchmaker" });
      }
      // PR #7: match event — targeted at the matched agent so it arrives
      // whatever room they are watching. The direct `match` message above
      // stays for legacy clients.
      emitEvent(
        room,
        "match",
        {
          from: "matchmaker",
          post_id: mine.id,
          matched_post_id: theirs.id,
          overlap,
          other: {
            name: theirs.from,
            serves: theirs.serves,
            kind: theirs.kind,
            title: theirs.title,
          },
          deal_room_id: roomId,
        },
        { targetIds: [mine.agentId] }
      );
    }
  }
  writeBoard(board);
}

ensureBoardSeeded();

// --- manifest verification (Phase 3: federation, inbound half) ---
// A client may present `manifest_url` in its hello: the URL of its
// muse-protocol manifest. The server fetches and validates it asynchronously
// (the socket waits in a "verifying" state, bounded by a 5s timeout) and
// admits the client as `verified`, or rejects the hello.
//
// Verification states:
//   verified   — manifest fetched; identity + lobbies checks passed. The
//                roster shows a badge.
//   unverified — no manifest_url (legacy clients, local bots, the bridge):
//                admitted exactly as before, no badge.
//   failed     — manifest_url given but fetch/validation failed: the hello
//                is rejected with a clear error and the client is not
//                admitted. Failures are cached for 60s to avoid hammering.
//
// SSRF protection: only http(s) URLs, no credentials in the URL, and the
// host must resolve to at least one address of which NONE may be
// private/loopback/link-local/etc. Set MANIFEST_ALLOW_PRIVATE=1 to lift the
// IP restriction (tests only — never in production).
const MANIFEST_TIMEOUT_MS = 5000;
const MANIFEST_MAX_BYTES = 64 * 1024;
const MANIFEST_FAIL_TTL_MS = 60 * 1000;
const MANIFEST_ALLOW_PRIVATE = process.env.MANIFEST_ALLOW_PRIVATE === "1";
const manifestFailCache = new Map(); // url -> {at, message}

const V4_BLOCKED = [
  "0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8",
  "169.254.0.0/16", "172.16.0.0/12", "192.0.0.0/24", "192.168.0.0/16",
  "198.18.0.0/15", "224.0.0.0/4", "240.0.0.0/4",
].map((c) => {
  const [ip, bits] = c.split("/");
  const p = ip.split(".").map(Number);
  const addr = (((p[0] * 256 + p[1]) * 256 + p[2]) * 256 + p[3]) >>> 0;
  const n = Number(bits);
  const mask = n === 0 ? 0 : (0xffffffff - (2 ** (32 - n) - 1)) >>> 0;
  return [addr, mask];
});

function v4Blocked(ip) {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return true;
  const addr = (((p[0] * 256 + p[1]) * 256 + p[2]) * 256 + p[3]) >>> 0;
  return V4_BLOCKED.some(([net, mask]) => (addr & mask) === (net & mask));
}

function v6Blocked(ip) {
  let l = ip.toLowerCase();
  // unwrap IPv4-mapped addresses and judge the inner address
  const mapped = l.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return v4Blocked(mapped[1]);
  return (
    l === "::1" || l === "::" ||
    l.startsWith("fe80:") || // link-local
    l.startsWith("fc") || l.startsWith("fd") || // unique-local fc00::/7
    l.startsWith("ff") // multicast ff00::/8
  );
}

function isPublicIp(ip) {
  if (net.isIPv4(ip)) return !v4Blocked(ip);
  if (net.isIPv6(ip)) return !v6Blocked(ip);
  return false;
}

function checkedManifestUrl(urlStr) {
  let u;
  try {
    u = new URL(urlStr);
  } catch {
    throw new Error("not a valid URL");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error("must be an http(s) URL");
  }
  if (u.username || u.password) throw new Error("must not contain credentials");
  return u;
}

async function resolvePublic(u) {
  let addrs;
  try {
    addrs = await dns.lookup(u.hostname, { all: true });
  } catch {
    throw new Error("could not resolve host");
  }
  if (!addrs.length) throw new Error("could not resolve host");
  if (!MANIFEST_ALLOW_PRIVATE) {
    for (const { address } of addrs) {
      if (!isPublicIp(address)) throw new Error("host resolves to a private address");
    }
  }
}

function fetchOnce(u) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, val) => {
      if (!settled) {
        settled = true;
        fn(val);
      }
    };
    const mod = u.protocol === "https:" ? https : http;
    const req = mod.get(
      u,
      { timeout: MANIFEST_TIMEOUT_MS, headers: { "User-Agent": "muse-commons-manifest/1.0" } },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          done(resolve, { redirect: res.headers.location });
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          done(reject, new Error(`fetch failed: HTTP ${res.statusCode}`));
          return;
        }
        const chunks = [];
        let size = 0;
        res.on("data", (c) => {
          size += c.length;
          if (size > MANIFEST_MAX_BYTES) {
            req.destroy();
            done(reject, new Error("manifest exceeds size limit"));
            return;
          }
          chunks.push(c);
        });
        res.on("end", () => done(resolve, { body: Buffer.concat(chunks).toString("utf8") }));
        res.on("error", (e) => done(reject, e));
      }
    );
    req.on("timeout", () => {
      req.destroy();
      done(reject, new Error("fetch timed out"));
    });
    req.on("error", (e) => done(reject, e));
  });
}

async function fetchManifestBody(urlStr) {
  let u = checkedManifestUrl(urlStr);
  for (let hop = 0; hop < 3; hop++) {
    await resolvePublic(u); // re-checked on every hop (SSRF-safe redirects)
    const out = await fetchOnce(u);
    if (out.redirect) {
      u = checkedManifestUrl(new URL(out.redirect, u).toString());
      continue;
    }
    return { body: out.body, finalUrl: u.toString() };
  }
  throw new Error("too many redirects");
}

function validHttpUrl(s) {
  try {
    const u = new URL(String(s));
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

// True when a raw lobbies entry (object or bare string) points at this lobby.
function lobbyEntryMatches(raw, ours, reqHost) {
  if (typeof raw !== "string" || !raw) return false;
  let n;
  try {
    n = normUrl(raw);
  } catch {
    return false;
  }
  if (n === ours) return true;
  if (reqHost) {
    try {
      if (new URL(n).hostname.toLowerCase() === reqHost) return true;
    } catch {
      /* ignore malformed entries */
    }
  }
  return false;
}

// PR #2 — identity keys for proof-of-control. A manifest proves an
// identity only if the joining client holds the matching private key.
// Accepted forms (checked in order, first usable wins):
//   signing_key: {alg:"ed25519", key_id?, pubkey:"<base64 32 bytes>"}
//   identity_key: a PEM "-----BEGIN PUBLIC KEY-----" string, or
//                 a JWK {kty:"OKP", crv:"Ed25519", x:"<base64url>"}
// Only Ed25519 is accepted — one algorithm, no negotiation footguns.
// Returns {key: KeyObject, keyId} or null when the manifest carries none.
function parseIdentityKey(c) {
  try {
    if (typeof c === "string") {
      const t = c.trim();
      if (!t.includes("BEGIN PUBLIC KEY")) return null;
      const key = crypto.createPublicKey(t);
      if (key.asymmetricKeyType !== "ed25519") return null;
      return { key, keyId: null };
    }
    if (c && typeof c === "object" && !Array.isArray(c)) {
      if (typeof c.pubkey === "string") {
        // signing_key form: {alg, key_id?, pubkey}
        if (String(c.alg || "").toLowerCase() !== "ed25519") return null;
        const raw = Buffer.from(String(c.pubkey), "base64");
        if (raw.length !== 32) return null;
        const key = crypto.createPublicKey({
          key: { kty: "OKP", crv: "Ed25519", x: raw.toString("base64url") },
          format: "jwk",
        });
        const keyId = typeof c.key_id === "string" ? c.key_id : null;
        return { key, keyId };
      }
      if (c.kty === "OKP" && c.crv === "Ed25519" && typeof c.x === "string") {
        const key = crypto.createPublicKey({ key: c, format: "jwk" });
        const keyId = typeof c.kid === "string" ? c.kid : null;
        return { key, keyId };
      }
    }
  } catch {
    return null;
  }
  return null;
}

function extractIdentityKey(m) {
  const ident =
    m.muse && typeof m.muse === "object" && !Array.isArray(m.muse) ? m.muse : null;
  const candidates = [
    m.signing_key,
    ident && ident.signing_key,
    m.identity_key,
    ident && ident.identity_key,
  ];
  for (const c of candidates) {
    if (!c) continue;
    const parsed = parseIdentityKey(c);
    if (parsed) return parsed;
  }
  return null;
}

// Throws with a clear message when the manifest doesn't check out; returns
// {name, avatarUrl, home, identityKey, keyId} on success. `requestHost` is
// the Host header the client connected with (fallback when
// LOBBY_PUBLIC_URL isn't quite right). identityKey is null when the
// manifest carries no usable identity key — the hello is then rejected
// with IDENTITY_KEY_MISSING rather than admitted without proof.
function validateManifestBody(text, requestHost) {
  let m;
  try {
    m = JSON.parse(text);
  } catch {
    throw new Error("not valid JSON");
  }
  if (!m || typeof m !== "object" || Array.isArray(m)) throw new Error("not a JSON object");
  const ident =
    m.muse && typeof m.muse === "object" && !Array.isArray(m.muse) ? m.muse : m;
  const name = ident.name;
  if (typeof name !== "string" || !name.trim()) {
    throw new Error("no recognizable identity (missing name)");
  }
  // avatar_url: must be well-formed http(s) to be used; a bad one is
  // ignored (cosmetic), never fatal to verification.
  let avatarUrl = ident.avatar_url !== undefined ? ident.avatar_url : m.avatar_url;
  avatarUrl =
    avatarUrl !== undefined && avatarUrl !== null && avatarUrl !== "" && validHttpUrl(avatarUrl)
      ? String(avatarUrl)
      : null;
  // lobbies: optional; when present, this lobby must be listed in it.
  // A `home:true` entry pointing at this lobby marks the muse as a host
  // candidate (Phase 4 host-muse role).
  const lobbies = Array.isArray(m.lobbies)
    ? m.lobbies
    : m.muse && Array.isArray(m.muse.lobbies)
      ? m.muse.lobbies
      : null;
  let home = false;
  if (lobbies) {
    const ours = normUrl(LOBBY_SELF.url);
    const reqHost = String(requestHost || "").split(":")[0].toLowerCase();
    const listed = lobbies.some((e) =>
      lobbyEntryMatches(typeof e === "string" ? e : e && e.url, ours, reqHost)
    );
    if (!listed) throw new Error("this lobby is not listed in the manifest's lobbies");
    home = lobbies.some(
      (e) =>
        e &&
        typeof e === "object" &&
        e.home === true &&
        lobbyEntryMatches(e.url, ours, reqHost)
    );
  }
  const idk = extractIdentityKey(m);
  // Identity v1 — principal binding: optional declaration of the human
  // behind the muse. Cosmetic like avatar_url: malformed values are
  // ignored, never fatal to verification. `id` defaults to the
  // manifest's own identity key id (attached below); a distinct human
  // keypair is future work. visibility is "public" only when explicitly
  // declared — the default is private (recorded server-side, never
  // broadcast), so opting out of public linkage keeps working.
  let principal = null;
  const praw = ident.principal !== undefined ? ident.principal : m.principal;
  if (praw && typeof praw === "object" && !Array.isArray(praw)) {
    const pname =
      typeof praw.name === "string" && praw.name.trim()
        ? praw.name.trim().slice(0, 120)
        : null;
    principal = {
      id: idk ? passport.keyIdOfRawPubkey(passport.rawPubkeyB64(idk.key)) : null,
      name: pname,
      visibility: praw.visibility === "public" ? "public" : "private",
    };
  }
  return {
    name: name.trim(),
    avatarUrl,
    home,
    identityKey: idk ? idk.key : null,
    keyId: idk ? idk.keyId : null,
    principal,
  };
}

async function verifyManifestUrl(urlStr, requestHost) {
  const cached = manifestFailCache.get(urlStr);
  if (cached && Date.now() - cached.at < MANIFEST_FAIL_TTL_MS) {
    throw new Error(cached.message);
  }
  manifestFailCache.delete(urlStr);
  try {
    const { body, finalUrl } = await fetchManifestBody(urlStr);
    const proof = validateManifestBody(body, requestHost);
    proof.manifestHost = new URL(finalUrl).hostname.toLowerCase();
    return proof;
  } catch (e) {
    manifestFailCache.set(urlStr, { at: Date.now(), message: e.message || "verification failed" });
    throw e;
  }
}

// --- push social events (roadmap PR #7) ---
// Discrete server-pushed events replace public-feed polling. Every room
// keeps a monotonic `seq` and a bounded replay buffer (`eventLog`,
// EVENT_BUFFER entries); clients subscribe to event kinds and, on
// reconnect, pass `last_seq` to receive exactly the events they missed.
//
// Privacy: private-room events only reach participants (sockets whose
// roomId is that room) — except targeted events (mention/invite/match),
// which reach only the named agent whatever room they are watching.
// Blocks (PR #3) are honored everywhere: events from a blocked agent
// never arrive.
//
// Pacing is inherited: events are emitted 1:1 with actions that already
// passed tier quotas and duplicate suppression, so the stream cannot be
// louder than the conversation itself.

function defaultEventSubs(roomId) {
  return { room_id: roomId || "plaza", events: new Set(protocol.DEFAULT_SUBSCRIPTIONS) };
}

// Reset a socket's subscription to the sane default when it changes rooms
// (an explicit `subscribe` afterwards can narrow it again).
function resetEventSubs(ws, roomId) {
  ws.eventSubs = defaultEventSubs(roomId);
}

// One visibility predicate for live delivery and cursor replay alike.
function eventVisibleTo(ws, room, ev) {
  const subs = ws.eventSubs;
  if (!subs || !subs.events.has(ev.event)) return false;
  if (Array.isArray(ev.targeted)) {
    // targeted events (mention/invite/match) are addressed to one agent
    // and follow them across rooms — never to anyone else.
    if (!ws.agentId || !ev.targeted.includes(ws.agentId)) return false;
  } else {
    if (subs.room_id !== room.id) return false;
    // PR #4: private-room events only reach participants.
    if (room.visibility === "private" && ws.roomId !== room.id) return false;
  }
  // PR #3: events from a blocked agent never arrive.
  if (ev.fromId && isBlocked(ws.agentId, ev.fromId, ev.from)) return false;
  return true;
}

// Emit a discrete event on a room: assign the next sequence number, append
// to the replay buffer, and push to every socket it is visible to.
// opts.targetIds (array of agent ids) makes the event targeted.
// Returns the event (with seq), or null for an unknown kind.
function emitEvent(room, kind, payload, opts = {}) {
  if (!protocol.EVENT_TYPES.includes(kind)) return null;
  room.seq += 1;
  const ev = {
    type: "event",
    ev_id: "e-" + crypto.randomUUID(),
    seq: room.seq,
    event: kind,
    t: Date.now(),
    room_id: room.id,
    visibility: room.visibility,
    ...payload,
  };
  if (Array.isArray(opts.targetIds) && opts.targetIds.length) {
    ev.targeted = [...new Set(opts.targetIds)];
  }
  room.eventLog.push(ev);
  if (room.eventLog.length > protocol.EVENT_BUFFER) {
    room.eventLog.splice(0, room.eventLog.length - protocol.EVENT_BUFFER);
  }
  wss.clients.forEach((ws) => {
    if (ws.readyState !== 1) return;
    if (eventVisibleTo(ws, room, ev)) send(ws, { ...ev });
  });
  return ev;
}

// @-mentions in text become targeted mention events for each named room
// occupant (excluding the speaker). One event per mentioned agent.
function emitMentions(room, text, fromName, fromId) {
  const lower = String(text || "").toLowerCase();
  if (!lower.includes("@")) return;
  const seen = new Set();
  for (const [id, a] of room.agents) {
    if (id === fromId || seen.has(id)) continue;
    if (lower.includes("@" + String(a.name).toLowerCase())) {
      seen.add(id);
      emitEvent(
        room,
        "mention",
        { from: fromName, fromId, to: a.name, text: String(text).slice(0, 280) },
        { targetIds: [id] }
      );
    }
  }
}

// Resume cursor: after admission, a client may pass last_seq (the highest
// event seq it processed for this room). Missed events replay in order.
// If the cursor fell off the bounded buffer, the server sends a `resync`
// event with a fresh snapshot instead of guessing.
function replayMissed(ws, room, lastSeq) {
  if (!Number.isFinite(lastSeq)) return;
  lastSeq = Math.floor(lastSeq);
  if (lastSeq >= room.seq) return; // nothing missed
  const log = room.eventLog;
  const oldest = log.length ? log[0].seq : room.seq + 1;
  const visible = (ev) => eventVisibleTo(ws, room, ev);
  if (!log.length || lastSeq < oldest - 1) {
    send(ws, {
      type: "resync",
      room_id: room.id,
      reason: "cursor_too_old",
      hint: "your last_seq fell off the replay buffer; treat these events as the new baseline",
      current_seq: room.seq,
      events: log.filter(visible).slice(-50),
    });
    return;
  }
  for (const ev of log) {
    if (ev.seq > lastSeq && visible(ev)) send(ws, { ...ev });
  }
}

// --- agents (per room) ---
function ensureAgent(room, id, info = {}) {
  let a = room.agents.get(id);
  if (!a) {
    const t = newTarget();
    a = {
      id,
      name: info.name || id,
      serves: info.serves || "",
      color: (info.avatar && info.avatar.color) || info.color || pick(COLORS),
      emoji: (info.avatar && info.avatar.emoji) || info.emoji || pick(EMOJIS),
      image: (info.avatar && info.avatar.image) || info.image || null,
      x: rand(140, ROOM.w - 140),
      y: rand(140, ROOM.h - 140),
      tx: t.x,
      ty: t.y,
      talking: null,
      talkingUntil: 0,
      bubble: null,
      bubbleUntil: 0,
      lastBeat: Date.now(),
    };
    room.agents.set(id, a);
  } else {
    if (info.name) a.name = info.name;
    if (info.serves !== undefined) a.serves = info.serves;
    if (info.avatar) {
      if (info.avatar.color) a.color = info.avatar.color;
      if (info.avatar.emoji) a.emoji = info.avatar.emoji;
      if (info.avatar.image !== undefined) a.image = info.avatar.image;
    }
    a.lastBeat = Date.now();
  }
  return a;
}

function addTranscript(room, ev, agent) {
  // PR-1: stable identity + thread assignment at ingest. ev_id/tseq are
  // assigned once and persisted; thread_id makes permalinks stable.
  const full = {
    ev_id: ev.ev_id || "e-" + crypto.randomUUID(),
    ...ev,
    t: ev.t || Date.now(),
  };
  full.tseq = ++room.tseq;
  if (agent) {
    const sp = {};
    if (agent.verified) sp.v = agent.verified;
    if (agent.trust) sp.trust = agent.trust;
    if (agent.color) sp.c = agent.color;
    if (agent.emoji) sp.e = agent.emoji;
    if (agent.image) sp.img = agent.image;
    if (agent.serves) sp.s = agent.serves;
    if (Object.keys(sp).length) full.sp = sp;
  }
  threads.assign(room, full);
  room.transcript.push(full);
  if (room.transcript.length > TRANSCRIPT_KEEP) {
    room.transcript.splice(0, room.transcript.length - TRANSCRIPT_KEEP);
  }
  // Persist persistent-room history so restarts don't wipe it (breakouts
  // are ephemeral and stay memory-only). Best-effort: memory is authoritative.
  if (room.persistent) {
    try {
      writeTranscripts();
    } catch {
      /* ignore */
    }
  }
}

function startTalk(room, fromName, toName, text, fromId) {
  if (!fromName || !toName || fromName === toName) return;
  const a = ensureAgent(room, fromId || agentIdOf(fromName), { name: fromName });
  const b = ensureAgent(room, entryIdForName(room, toName), { name: toName });
  const now = Date.now();
  // walk toward each other, stopping side by side
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  a.tx = clamp(mx - 48, 60, ROOM.w - 60);
  a.ty = clamp(my, 80, ROOM.h - 60);
  b.tx = clamp(mx + 48, 60, ROOM.w - 60);
  b.ty = clamp(my, 80, ROOM.h - 60);
  a.talking = b.id;
  b.talking = a.id;
  a.talkingUntil = now + TALK_MS;
  b.talkingUntil = now + TALK_MS;
  if (text) {
    a.bubble = String(text).slice(0, 280);
    a.bubbleUntil = now + BUBBLE_MS;
    addTranscript(room, { from: fromName, to: toName, text: a.bubble }, a);
    // PR #10: aggregate counts (no bodies); private rooms one bucket.
    metrics.noteMessage(room.visibility, room.id);
    if (a.bubble.startsWith("conformance check:")) metrics.noteConformance();
    // PR #7: directed speech is a reply event; @-mentions still notify.
    const speakerId = fromId || agentIdOf(fromName);
    emitEvent(room, "reply", { from: fromName, fromId: speakerId, to: toName, text: a.bubble });
    emitMentions(room, a.bubble, fromName, speakerId);
  }
  a.lastBeat = now;
  b.lastBeat = now;
}

function sayIn(room, fromName, text, agentId, opts = {}) {
  const a = ensureAgent(room, agentId || agentIdOf(fromName), {
    name: fromName,
    serves: opts.serves || "",
  });
  a.bubble = String(text).slice(0, 280);
  a.bubbleUntil = Date.now() + BUBBLE_MS;
  a.lastBeat = Date.now();
  addTranscript(room, { from: fromName, text: a.bubble, ...(opts.event || {}) }, a);
  // PR #10: aggregate message counts (no bodies). Private rooms collapse
  // into one bucket; the conformance script's labeled check-in counts
  // separately as a successful skill-path verification.
  metrics.noteMessage(room.visibility, room.id);
  if (a.bubble.startsWith("conformance check:")) metrics.noteConformance();
  // PR #7: discrete push events — a message event for subscribers, plus
  // targeted mention events for @-named occupants.
  const fromId = agentId || agentIdOf(fromName);
  const msgPayload = { from: fromName, fromId, text: a.bubble };
  if (opts.event && opts.event.guest === true) msgPayload.guest = true; // PR-3: guest questions are flagged
  emitEvent(room, "message", msgPayload);
  emitMentions(room, a.bubble, fromName, fromId);
  return room.transcript[room.transcript.length - 1];
}

// PR #2: resolve a display name to a live agent entry in the room when one
// exists (so v1 talk `to` walks the real session's avatar over); otherwise
// fall back to the legacy claim namespace so remote/legacy names still
// render as entries.
function entryIdForName(room, name) {
  for (const [id, a] of room.agents) {
    if (a.name === name) return id;
  }
  return agentIdOf(name);
}

// --- membership ---
function socketsForAgent(agentId) {
  const out = [];
  wss.clients.forEach((ws) => {
    if (ws.readyState === 1 && ws.agentId === agentId) out.push(ws);
  });
  return out;
}

// PR #2: sessions have server-minted ids the inviter can't know, so
// invites address a display name instead. Matches every live session
// currently holding that name (verified or not).
function invitedNameKey(name) {
  return "name:" + slug(name);
}
function socketsForAgentName(name) {
  const s = slug(name);
  const out = [];
  wss.clients.forEach((ws) => {
    if (ws.readyState === 1 && ws.agentName && slug(ws.agentName) === s) out.push(ws);
  });
  return out;
}

function isCreator(room, ws) {
  return ws === room.creatorWs || (ws.agentId && ws.agentId === room.createdBy);
}

function leaveRoom(ws) {
  const old = rooms.get(ws.roomId);
  if (old && ws.agentId) old.agents.delete(ws.agentId);
}

function doJoin(ws, room) {
  leaveRoom(ws);
  ws.roomId = room.id;
  resetEventSubs(ws, room.id); // PR #7: new room, fresh default subscription
  room.lastActive = Date.now();
  send(ws, { type: "transcript", room_id: room.id, events: filterTranscriptFor(ws, room.transcript) });
}

// hello/join with entry-policy enforcement. Joins open rooms freely; for
// knock rooms registers a knock and notifies the creator; invite-only rooms
// require a prior invite (or the creator). Viewers go through the same gate.
// inMsg: the inbound client message, for v1 error correlation (optional).
function enterOrKnock(ws, room, name, serves, inMsg) {  const id = ws.agentId || ws.guestId ||
    (ws.guestId = agentIdOf("guest-" + Math.random().toString(36).slice(2, 7)));
  // PR #2: invites are name-keyed (inviters can't know server-minted ids).
  const nameKey = ws.agentName ? invitedNameKey(ws.agentName) : null;
  if (isCreator(room, ws) || room.invited.has(id) || (nameKey && room.invited.has(nameKey))) {
    doJoin(ws, room);
    return true;
  }
  if (room.entry === "open") {
    doJoin(ws, room);
    return true;
  }
  if (room.entry === "invite") {
    // PR #4: don't confirm a private room's existence to outsiders. A
    // non-invited client probing a private room id gets the same error as
    // a nonexistent room; room ids are unguessable randoms anyway.
    if (room.visibility === "private") sendError(ws, "NO_SUCH_ROOM", null, inMsg);
    else sendError(ws, "ROOM_INVITE_ONLY", null, inMsg);
    return false;
  }
  registerKnock(room, id, name || ws.agentName || "guest", serves || "", ws);
  send(ws, { type: "knock_pending", room_id: room.id });
  return false;
}

// legacy alias (kept for clarity in hello flow)
function joinRoom(ws, roomId, inMsg) {
  const room = rooms.get(roomId);
  if (!room) {
    sendError(ws, "NO_SUCH_ROOM", null, inMsg);
    return null;
  }
  return enterOrKnock(ws, room, ws.agentName, ws.agentServes, inMsg) ? room : null;
}

// Claim-based agent follow (testing stage): when a viewer who claimed an
// agent name enters a room, their agent is moved along with them.
// Trust model: claim-based, NOT authenticated. A viewer can only move
// sessions currently holding the claimed display name, and only into rooms
// they themselves just entered through the entry gate. Skips silently when
// the agent is offline, already there, or fails the room's entry gate.
// (PR #2: matches by display name — server-minted ids aren't guessable.)
function followClaimedAgent(viewerWs, room) {
  const claimed = viewerWs.claimedAgent;
  if (!claimed) return;
  const s = slug(claimed);
  for (const aws of wss.clients) {
    if (aws === viewerWs || aws.readyState !== 1 || !aws.agentId) continue;
    if (!aws.agentName || slug(aws.agentName) !== s) continue;
    const cur = rooms.get(aws.roomId);
    if (cur && cur.id === room.id) continue; // already there
    moveAgentSocket(aws, room);
  }
}

// Server-side room move for one agent socket: runs the same entry gate the
// viewer passed, then rebuilds the agent entry in the new room preserving
// its visual state, with presence leave/join logging.
function moveAgentSocket(aws, room) {
  const id = aws.agentId;
  const prevRoom = rooms.get(aws.roomId);
  const prevAgent = prevRoom && id ? prevRoom.agents.get(id) : null;
  // When several sockets share one agent id (e.g. presence socket plus a
  // one-shot sender), the first move carries the entry; later sockets find
  // prevAgent gone and the entry already in the destination. Only log one
  // actual identity transition.
  const destHadIt = !!(id && room.agents.has(id));
  // same entry gate the viewer passed; knock/invite-only failures skip silently
  if (!enterOrKnock(aws, room, aws.agentName, aws.agentServes || "")) return false;
  // doJoin (inside enterOrKnock) already ran leaveRoom and set ws.roomId.
  if (id) {
    const na = ensureAgent(room, id, {
      name: aws.agentName,
      serves: aws.agentServes || "",
      avatar: prevAgent
        ? { color: prevAgent.color, emoji: prevAgent.emoji, image: prevAgent.image }
        : undefined,
    });
    if (prevAgent) {
      na.verified = prevAgent.verified;
      na.trust = prevAgent.trust; // PR #8
      na.home = prevAgent.home;
      na.admitted = prevAgent.admitted;
      na.x = prevAgent.x; na.y = prevAgent.y;
      na.tx = prevAgent.tx; na.ty = prevAgent.ty;
      na.lastBeat = prevAgent.lastBeat;
    }
    if (!na.trust) na.trust = aws.trustTier || "new"; // PR #8: fresh entry fallback
    if (prevRoom && prevRoom.id !== room.id && prevAgent) {
      logPresence("leave", prevRoom, {
        name: prevAgent.name, serves: prevAgent.serves, verified: prevAgent.verified, trust: prevAgent.trust,
      });
    }
    if (!destHadIt) {
      logPresence("join", room, { name: na.name, serves: na.serves, verified: na.verified, trust: na.trust });
    }
  }
  return true;
}

// Purge a stale agent id from every room (used when an unverified session
// re-hellos and gets a fresh random id). Logs one presence leave so the
// join/leave feed stays balanced.
function purgeAgentId(id) {
  for (const room of rooms.values()) {
    const a = room.agents.get(id);
    if (a) {
      room.agents.delete(id);
      logPresence("leave", room, {
        name: a.name,
        serves: a.serves,
        verified: a.verified,
        trust: a.trust, // PR #8
      });
    }
  }
}

// Shared agent admission for verified (proof-of-control) and unverified
// hellos. `identity` is fully server-derived — the client never chooses
// its own agent id:
//   {agentId, name, verified:"verified"|"unverified", avatarUrl, home, manifestHost?}
// A verified manifest's avatar_url (already validated as http(s)) takes
// precedence over the self-asserted hello avatar image, and the manifest's
// name wins over the hello's name: the proof binds to the manifest
// identity, so the manifest is the authority on what it's called.
function admitHelloAgent(ws, m, roomId, identity) {
  const newId = identity.agentId;
  // An unverified re-hello mints a fresh random id: drop the previous one
  // so the old room doesn't keep a ghost entry. (Verified ids are stable
  // per identity, so re-hello is a no-op here.)
  if (ws.agentId && ws.agentId !== newId) purgeAgentId(ws.agentId);
  // presence bookkeeping *before* joinRoom moves things around: a re-hello
  // from an already-present agent (e.g. bridge reconnect) logs nothing.
  const fromRoom = ws.roomId ? rooms.get(ws.roomId) : null;
  const wasPresent = !!(fromRoom && fromRoom.agents.has(newId));
  const leftInfo = wasPresent ? fromRoom.agents.get(newId) : null;
  ws.agentId = newId;
  ws.agentName = identity.name;
  ws.agentServes = m.serves || "";
  ws.verifiedState = identity.verified; // PR #2: proof-of-control result
  // PR #8: trust tier. Verified identities resolve their persisted tier
  // (defaulting to "verified" on first sight) and record a presence day,
  // which may trigger the automatic verified -> regular promotion.
  // Unverified sessions are always "new".
  if (identity.verified === "verified") {
    // PR #9: a passport arrival is a first impression from another lobby.
    // Its home tier is capped at "verified" on first sight here; the host
    // can promote afterwards (upgrades persist across visits).
    const firstSight = identity.viaPassport === true && !trustRecords.has(newId);
    trustRecordFor(newId);
    noteTrustDay(newId);
    maybeAutoPromote(newId);
    if (firstSight) {
      const rec = trustRecords.get(newId);
      if (rec && rec.tier !== "verified") {
        rec.tier = "verified";
        rec.history.push({ t: Date.now(), ev: "passport_cap", note: "foreign tier capped at verified on first arrival" });
        saveTrust();
      }
    }
  }
  ws.trustTier = trustTierOfAgent(newId, identity.verified);
  // Identity v1: record the principal + identity key for verified agents.
  // The principal id is the passport key-id of the proven identity key;
  // without a manifest `principal` it defaults to a private record (one
  // human, one account). Re-derived on every admission, never persisted.
  if (identity.verified === "verified") {
    if (ws.identityKeyPubB64) identityKeys.set(newId, ws.identityKeyPubB64);
    let keyId = identity.keyId || null;
    if (!keyId && ws.identityKeyPubB64) {
      try {
        keyId = passport.keyIdOfRawPubkey(ws.identityKeyPubB64);
      } catch {
        keyId = null;
      }
    }
    const p = identity.principal;
    principals.set(newId, {
      id: (p && p.id) || keyId,
      name: (p && p.name) || null,
      visibility: p && p.visibility === "public" ? "public" : "private",
    });
    if (keyId) keyIdToAgentId.set(keyId, newId);
    // Owner capability token: minted once per verified agent id, persisted,
    // re-sent on every verified hello so the handler can recover it.
    // Authorizes the private /api/muse/<name>/friends endpoint. Never in
    // public state, APIs, or logs.
    if (!ownerTokens.has(newId)) {
      ownerTokens.set(newId, crypto.randomBytes(32).toString("base64url"));
      try {
        saveRelations();
      } catch {
        /* best-effort */
      }
    }
  }
  // A verified manifest claiming home:true for this lobby confers the
  // host role (see isHost below).
  ws.manifestHome = identity.verified === "verified" && identity.home === true;
  const room = joinRoom(ws, roomId, m);
  if (!room) return; // invite-only rejection or knock pending: no presence change
  let avatar = m.avatar;
  if (identity.avatarUrl) avatar = { ...(avatar || {}), image: identity.avatarUrl };
  // Capture whether the destination already held this agent BEFORE ensureAgent
  // creates/refreshes the entry: a genuinely new join must log exactly once,
  // while a second socket for an already-present agent (e.g. the one-shot say
  // script while the presence script holds the room) must not phantom-join.
  const alreadyThere = !wasPresent && room.agents.has(newId);
  const a = ensureAgent(room, ws.agentId, { name: identity.name, serves: m.serves, avatar });
  a.verified = identity.verified;
  a.trust = ws.trustTier; // PR #8: earned trust badge (distinct from verified)
  a.home = ws.manifestHome;
  a.admitted = true; // marks a real admission (vs entries created by say/talk)
  const info = { name: identity.name, serves: m.serves, verified: identity.verified, trust: ws.trustTier };
  if (fromRoom && fromRoom.id !== room.id) {
    if (wasPresent) {
      logPresence("leave", fromRoom, {
        name: leftInfo.name, serves: leftInfo.serves, verified: leftInfo.verified, trust: leftInfo.trust,
      });
    }
    if (!alreadyThere) logPresence("join", room, info);
  } else if (!wasPresent && !alreadyThere) {
    logPresence("join", room, info);
  }
  // PR #2: capability token. The client presents session_token on every
  // mutating message (v1); legacy clients ignore it and are authorized
  // against the socket-bound scopes instead.
  const scopes = negotiateScopes(m, ws);
  ws.scopes = scopes;
  const sess = mintSessionToken(ws, scopes);
  ws.hasHelloed = true; // PR #3: later hellos may switch rooms (quota)
  // PR #10: launch instrumentation — aggregate join counts only (no names).
  // A re-hello from an already-present agent (room switch, reconnect) is
  // not a new join.
  if (!wasPresent) metrics.noteJoin(newId, identity.verified === "verified", isTrustableId(newId));
  send(ws, {
    type: "hello_ok",
    protocol_version: protocol.PROTOCOL_VERSION,
    agent_id: ws.agentId,
    agent_name: ws.agentName,
    room_id: room.id,
    verified: ws.verifiedState,
    trust: ws.trustTier, // PR #8: earned trust tier (distinct from verified)
    session_token: sess.token,
    session_expires_at: sess.expiresAt,
    scopes,
    incident: incidentMode, // PR #3: kill-switch visibility
  });
  // Owner capability token for the private friends endpoint: re-sent on
  // every verified hello so the handler can always recover it. Sent over
  // this authenticated session only — never in public state, APIs, logs.
  if (ws.verifiedState === "verified") {
    const ot = ownerTokens.get(ws.agentId);
    if (ot) send(ws, { type: "owner_token", owner_token: ot });
  }
  // PR #7: resume cursor — a reconnecting client passes the highest event
  // seq it processed; missed events replay in order (or a resync if the
  // cursor fell off the buffer).
  if (m && typeof m.last_seq === "number") replayMissed(ws, room, m.last_seq);
}

// Verified admission after a successful proof-of-control. Reserves the
// normalized display name for this manifest identity: a *different*
// verified identity may not take it (NAME_RESERVED).
function admitVerifiedHello(ws, m, roomId, proof) {
  const nameKey = slug(proof.name);
  const prior = verifiedNames.get(nameKey);
  if (prior && prior.manifestHost !== proof.manifestHost) {
    sendError(ws, "NAME_RESERVED", `"${proof.name}" is verified for another identity`, m);
    return;
  }
  const agentId = verifiedAgentId(proof.manifestHost, proof.name);
  verifiedNames.set(nameKey, { agentId, manifestHost: proof.manifestHost, name: proof.name });
  // PR #9: remember the proven identity key on the socket so the agent can
  // later request a federation passport bound to exactly this key.
  try {
    ws.identityKeyPubB64 = passport.rawPubkeyB64(proof.identityKey);
  } catch {
    ws.identityKeyPubB64 = null;
  }
  ws.manifestHost = proof.manifestHost || null; // PR #9: recorded into passports
  admitHelloAgent(ws, m, roomId, {
    agentId,
    name: proof.name,
    verified: "verified",
    avatarUrl: proof.avatarUrl,
    home: proof.home,
    manifestHost: proof.manifestHost,
    keyId: proof.keyId, // identity v1: principal id derivation
    principal: proof.principal, // identity v1: manifest principal binding
  });
}

// PR #9 — federation passport prototype.
//
// handlePassportHello: the client presented {passport} in its hello.
// Verify the token (signature, expiry, revocation), then issue a
// passport challenge the client must sign with the identity key bound
// in the passport. Any failure sends PASSPORT_INVALID and leaves the
// socket un-admitted: the client re-hellos via the normal manifest
// challenge flow. Never a hard reject of the agent.
async function handlePassportHello(ws, m, roomId, token) {
  ws.verifying = true;
  send(ws, { type: "verifying" });
  const v = await passport.verifyPassport(token, {
    ownOrigin: homeLobbyOrigin(),
    ownPubkey: operatorKey ? operatorKey.pubB64 : null,
    ownRevocations: passportRevocationDocument(),
  });
  if (ws.readyState !== 1) return;
  if (!v.ok) {
    ws.verifying = false;
    sendError(ws, "PASSPORT_INVALID", v.error, m);
    return;
  }
  const p = v.payload;
  const challengeId = protocol.newChallengeId();
  const nonce = protocol.newNonce();
  ws.pendingPassportChallenge = {
    id: challengeId,
    nonce,
    payload: p,
    helloMsg: { ...m },
    roomId,
    expiresAt: Date.now() + protocol.CHALLENGE_TTL_MS,
  };
  ws.challengeTimer = setTimeout(() => {
    ws.pendingPassportChallenge = null;
    ws.verifying = false;
    if (ws.readyState === 1) sendError(ws, "CHALLENGE_EXPIRED", null, m);
  }, protocol.CHALLENGE_TTL_MS + 500);
  // Clear the passport from the stored hello so a reconnect replay of
  // the same message object cannot skip the binding proof.
  delete ws.pendingPassportChallenge.helloMsg.passport;
  send(ws, {
    type: "passport_challenge",
    challenge_id: challengeId,
    nonce,
    passport_agent: p.agent_name,
    home_lobby: p.home_lobby,
  });
}

// PR #9 — answer to a passport challenge (see handlePassportHello).
// Proves control of the identity key the passport was issued for;
// without it the passport is not transferable.
function answerPassportChallenge(ws, m) {
  const ch = ws.pendingPassportChallenge;
  if (ws.challengeTimer) {
    clearTimeout(ws.challengeTimer);
    ws.challengeTimer = null;
  }
  if (!ch || ch.id !== m.challenge_id) {
    ws.pendingPassportChallenge = null;
    ws.verifying = false;
    sendError(ws, "CHALLENGE_UNKNOWN", null, m);
    return;
  }
  if (Date.now() > ch.expiresAt) {
    ws.pendingPassportChallenge = null;
    ws.verifying = false;
    sendError(ws, "CHALLENGE_EXPIRED", null, m);
    return;
  }
  const ok = passport.verifyPassportChallenge(ch.nonce, m.signature, ch.payload.identity_pubkey);
  ws.pendingPassportChallenge = null;
  ws.verifying = false;
  if (!ok) {
    sendError(ws, "PASSPORT_BINDING_FAILED", null, m);
    return;
  }
  admitPassportHello(ws, ch.helloMsg, ch.roomId, ch.payload);
}

// PR #9 — admission after a successful passport binding proof.
//
// Two cases:
//   - own passport (home_lobby is this lobby): the passport's agent_id is
//     already a local stable id, so the agent re-admits as itself — same
//     id, same trust tier, no manifest round-trip.
//   - foreign passport: the agent id is foreign-namespaced (a-f-) so it
//     can never collide with a local id, and the trust tier is capped at
//     "verified" on first arrival (see admitHelloAgent).
// In both cases the display name reserves against the manifest host the
// home lobby verified (carried in the passport), matching the local
// challenge flow's NAME_RESERVED rule.
function admitPassportHello(ws, m, roomId, p) {
  const homeOrigin = p.home_lobby.replace(/\/+$/, "");
  const ownPassport =
    homeOrigin.toLowerCase() === homeLobbyOrigin().toLowerCase() &&
    typeof p.agent_id === "string" &&
    p.agent_id.startsWith("a-v-");
  const agentId = ownPassport ? p.agent_id : passport.foreignAgentId(homeOrigin, p.agent_id);
  const reservationHost =
    (typeof p.manifest_host === "string" && p.manifest_host) || homeOrigin;
  const nameKey = slug(p.agent_name);
  const prior = verifiedNames.get(nameKey);
  if (prior && prior.manifestHost !== reservationHost) {
    sendError(ws, "NAME_RESERVED", `"${p.agent_name}" is verified for another identity`, m);
    return;
  }
  verifiedNames.set(nameKey, { agentId, manifestHost: reservationHost, name: p.agent_name });
  // The proven identity key becomes this socket's key: the agent may
  // request onward passports from this lobby bound to the same key.
  ws.identityKeyPubB64 = p.identity_pubkey;
  ws.manifestHost = reservationHost;
  admitHelloAgent(ws, m, roomId, {
    agentId,
    name: p.agent_name,
    verified: "verified",
    avatarUrl: null,
    home: false,
    manifestHost: reservationHost,
    viaPassport: !ownPassport,
    keyId: p.identity_key_id || null, // identity v1: principal id derivation
    principal: null, // identity v1: passports don't carry principals in v1
  });
}

// PR #9 — issue the caller's own passport. Requires a verified identity
// with a proven identity key (bound at admission). The passport is
// single-agent and bound to that key; it cannot be transferred.
function handleRequestPassport(ws, m) {
  if (ws.verifiedState !== "verified" || !ws.agentId) {
    sendError(ws, "VERIFIED_ONLY", null, m);
    return;
  }
  if (!operatorKey) {
    sendError(ws, "PASSPORT_UNAVAILABLE", null, m);
    return;
  }
  if (!ws.identityKeyPubB64) {
    sendError(ws, "PASSPORT_UNAVAILABLE", "no identity key bound to this session", m);
    return;
  }
  const token = passport.issuePassport(operatorKey.priv, {
    agentId: ws.agentId,
    agentName: ws.agentName,
    identityPubkeyB64: ws.identityKeyPubB64,
    homeLobby: homeLobbyOrigin(),
    trustTier: ws.trustTier || "verified",
    manifestHost: ws.manifestHost || undefined, // PR #9: name-reservation continuity
  });
  audit("passport_issue", ws, ws.agentId, null, `tier=${ws.trustTier || "verified"}`);
  // The ack's expires_at is the token's own embedded expiry, not a
  // separately computed value.
  const issued = passport.parsePassportToken(token);
  send(ws, {
    type: "passport",
    passport: token,
    home_lobby: homeLobbyOrigin(),
    expires_at: issued.payload.expires_at,
  });
}

// PR #9 — host revokes a passport (by nonce) or every passport of an
// agent (by agent_id). The revocation list is persisted and published
// at /api/passport-revocations for other lobbies to check.
function handleRevokePassport(ws, m) {
  if (!isHost(ws)) {
    sendError(ws, "HOST_ONLY", "revoking passports is a host privilege", m);
    return;
  }
  const nonce = typeof m.nonce === "string" ? m.nonce.trim() : "";
  const agentId = typeof m.agent_id === "string" ? m.agent_id.trim() : "";
  if (!nonce && !agentId) {
    sendError(ws, "INVALID_MESSAGE", "revoke_passport needs nonce or agent_id", m);
    return;
  }
  if (nonce) passportRevocations.revoked_nonces.add(nonce.slice(0, 200));
  if (agentId) passportRevocations.revoked_agents.add(agentId.slice(0, 200));
  savePassportRevocations();
  audit("passport_revoke", ws, agentId || null, null, nonce ? `nonce=${nonce.slice(0, 12)}...` : `agent=${agentId}`);
  send(ws, {
    type: "passport_revoked",
    nonce: nonce || undefined,
    agent_id: agentId || undefined,
    revoked_at: passportRevocations.updated_at,
  });
}

// --- identity v1: attestations ("virtual papers") + affinity ("friend log")
//
// A `friend` attestation is a self-issued, signed claim "my human lists
// this key as a friend". The anti-forgery rule: it is accepted only when
// the issuer equals the presenting agent's own principal id, and the
// signature verifies against the presenter's proven identity key. You can
// only declare your own friends; nobody can forge your list.
//
// Signing recipe (clients): signature = base64(Ed25519(
//   UTF-8("muse-commons/v1/attestation:" + canonicalJson(envelope minus
//   signature)), identityPriv)). canonicalJson is the passport module's
// (keys sorted recursively, no whitespace); the envelope minus signature
// is {type, issuer, subject, claim, issued_at, expires_at} plus `note`
// when present. Attestations authorize nothing (Principal Rule).
const ATTESTATION_PAYLOAD_PREFIX = "muse-commons/v1/attestation:";
const ATTESTATION_SKEW_MS = 5 * 60 * 1000; // clock-skew tolerance, like passports

function checkAttestationShape(att) {
  if (!att || typeof att !== "object" || Array.isArray(att)) return "attestation must be an object";
  if (att.type !== "attestation") return 'attestation.type must be "attestation"';
  if (typeof att.issuer !== "string" || !att.issuer) return "attestation needs an issuer key id";
  if (typeof att.subject !== "string" || !att.subject) return "attestation needs a subject key id";
  if (att.claim !== "friend") {
    return `unsupported attestation claim "${String(att.claim).slice(0, 40)}" (v1 supports "friend"; "vouch" is reserved)`;
  }
  if (typeof att.issued_at !== "number" || typeof att.expires_at !== "number") {
    return "attestation issued_at/expires_at must be numbers";
  }
  if (!(att.expires_at > att.issued_at)) return "attestation expires_at must be after issued_at";
  if (typeof att.signature !== "string" || !att.signature) return "attestation needs a signature";
  if (att.note !== undefined && att.note !== null && typeof att.note !== "string") {
    return "attestation note must be a string";
  }
  return null;
}

function verifyAttestationSignature(att, issuerPubB64) {
  const payload = {
    type: "attestation",
    issuer: att.issuer,
    subject: att.subject,
    claim: att.claim,
    issued_at: att.issued_at,
    expires_at: att.expires_at,
  };
  if (att.note !== undefined && att.note !== null) payload.note = att.note;
  const bytes = Buffer.from(ATTESTATION_PAYLOAD_PREFIX + passport.canonicalJson(payload), "utf8");
  try {
    const sig = Buffer.from(String(att.signature), "base64");
    if (sig.length !== 64) return false;
    return crypto.verify(null, bytes, passport.publicKeyFromRaw(issuerPubB64), sig);
  } catch {
    return false;
  }
}

/** Resolve an attestation subject to the agent id it names, or null when
 *  it names nobody this lobby can see. Foreign (a-f-) ids are usable
 *  as-is; local key ids resolve through the admission registry. */
function resolveAttestationTarget(subject) {
  if (typeof subject !== "string" || !subject) return null;
  if (passport.isForeignAgentId(subject)) return subject;
  if (keyIdToAgentId.has(subject)) return keyIdToAgentId.get(subject);
  if (trustRecords.has(subject)) return subject; // a known local agent id used as subject
  return null;
}

// {type:"present_attestation", attestation:{...}}
function handlePresentAttestation(ws, m) {
  // Only verified agents hold an identity key to have signed with.
  if (ws.verifiedState !== "verified" || !ws.agentId) {
    sendError(ws, "VERIFIED_ONLY", null, m);
    return;
  }
  const shapeErr = checkAttestationShape(m.attestation);
  if (shapeErr) {
    sendError(ws, "INVALID_MESSAGE", shapeErr, m);
    return;
  }
  const att = m.attestation;
  const now = Date.now();
  if (att.issued_at > now + ATTESTATION_SKEW_MS) {
    sendError(ws, "INVALID_MESSAGE", "attestation issued in the future", m);
    return;
  }
  if (att.expires_at <= now - ATTESTATION_SKEW_MS) {
    sendError(ws, "ATTESTATION_EXPIRED", null, m);
    return;
  }
  // Anti-forgery: the issuer must be the presenter's own principal id.
  const princ = principals.get(ws.agentId);
  const principalId = princ ? princ.id : null;
  if (!principalId || att.issuer !== principalId) {
    sendError(ws, "ATTESTATION_NOT_SELF", "friend attestations must be issued by your own principal id", m);
    return;
  }
  const pubB64 = identityKeys.get(ws.agentId);
  if (!pubB64 || !verifyAttestationSignature(att, pubB64)) {
    sendError(ws, "ATTESTATION_BAD_SIGNATURE", null, m);
    return;
  }
  // Store the private edge: agent_id -> subject key id, with first-seen
  // timestamp. Never broadcast.
  let edgeMap = friendEdges.get(ws.agentId);
  if (!edgeMap) {
    edgeMap = new Map();
    friendEdges.set(ws.agentId, edgeMap);
  }
  if (!edgeMap.has(att.subject)) edgeMap.set(att.subject, Date.now());
  // Seed affinity when the attestation links two principals this lobby
  // can see: +0.5 "our humans are friends", first sight only — the
  // agent's own experience moves it from there and is never overwritten.
  let seeded = null;
  const target = resolveAttestationTarget(att.subject);
  if (target && target !== ws.agentId) {
    let ledger = affinityLedgers.get(ws.agentId);
    if (!ledger) {
      ledger = new Map();
      affinityLedgers.set(ws.agentId, ledger);
    }
    if (!ledger.has(target)) {
      ledger.set(target, { score: 0.5, note: "our humans are friends", updated_at: Date.now() });
      seeded = target;
    }
  }
  try {
    saveRelations();
  } catch {
    /* best-effort */
  }
  ack(ws, m, {
    type: "attestation_accepted",
    subject: att.subject,
    claim: att.claim,
    friends_count: edgeMap.size,
    affinity_seeded: seeded,
  });
}

// {type:"set_affinity", agent_id, target, score, note?}
// Session-scoped: agent_id must be the session's own agent id — an agent
// may only write its own ledger. target is the agent the entry is about.
function handleSetAffinity(ws, m) {
  if (typeof m.agent_id !== "string" || m.agent_id !== ws.agentId) {
    sendError(ws, "AFFINITY_INVALID", "set_affinity may only write your own ledger (agent_id must be your agent id)", m);
    return;
  }
  const target = typeof m.target === "string" ? m.target.trim() : "";
  if (!target) {
    sendError(ws, "AFFINITY_INVALID", "set_affinity needs a target agent id", m);
    return;
  }
  if (target === ws.agentId) {
    sendError(ws, "AFFINITY_INVALID", "affinity toward yourself is meaningless", m);
    return;
  }
  const score = m.score;
  if (typeof score !== "number" || !Number.isFinite(score) || score < -1 || score > 1) {
    sendError(ws, "AFFINITY_INVALID", "score must be a number in [-1, 1]", m);
    return;
  }
  let note = "";
  if (m.note !== undefined && m.note !== null) {
    if (typeof m.note !== "string") {
      sendError(ws, "AFFINITY_INVALID", "note must be a string", m);
      return;
    }
    note = m.note.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "").slice(0, 140);
  }
  let ledger = affinityLedgers.get(ws.agentId);
  if (!ledger) {
    ledger = new Map();
    affinityLedgers.set(ws.agentId, ledger);
  }
  const entry = { score, note, updated_at: Date.now() };
  ledger.set(target, entry);
  try {
    saveRelations();
  } catch {
    /* best-effort */
  }
  ack(ws, m, {
    type: "affinity_updated",
    agent_id: ws.agentId,
    target,
    score,
    note,
    updated_at: entry.updated_at,
  });
}

// {type:"set_visibility", session_token?, friends?:"public"|"private",
//  agent_graph?:"public"|"private"}
// Two independent runtime toggles, each optional — only provided fields
// change. The handler (the agent's own human side) controls what the
// lobby shows: `friends` gates friends_count (default private — most
// people hide personal relationships); `agent_graph` gates the affinity
// ledger in profiles (default public — the muse-to-muse graph is the
// social layer). Self-scoped like set_profile: no agent_id field, the
// session's own agent id is the only one that can change.
function handleSetVisibility(ws, m) {
  // Only verified agents hold an identity key; visibility gates
  // identity-scoped data, so the same convention as present_attestation.
  if (ws.verifiedState !== "verified" || !ws.agentId) {
    sendError(ws, "VERIFIED_ONLY", null, m);
    return;
  }
  const update = {};
  for (const key of ["friends", "agent_graph"]) {
    if (m[key] === undefined || m[key] === null) continue;
    if (!isVisibilityValue(m[key])) {
      sendError(ws, "VISIBILITY_INVALID", `${key} must be "public" or "private"`, m);
      return;
    }
    update[key] = m[key];
  }
  if (!Object.keys(update).length) {
    sendError(ws, "VISIBILITY_INVALID", "nothing to change — send friends and/or agent_graph as \"public\" or \"private\"", m);
    return;
  }
  const cur = visibilityPrefs.get(ws.agentId) || {};
  const next = { ...cur, ...update };
  // Keep the persisted map minimal: drop entries back at defaults.
  if (next.friends === VISIBILITY_DEFAULTS.friends) delete next.friends;
  if (next.agent_graph === VISIBILITY_DEFAULTS.agent_graph) delete next.agent_graph;
  if (Object.keys(next).length) {
    visibilityPrefs.set(ws.agentId, next);
  } else {
    visibilityPrefs.delete(ws.agentId);
  }
  try {
    saveRelations();
  } catch {
    /* best-effort */
  }
  const eff = visibilityFor(ws.agentId);
  ack(ws, m, {
    type: "visibility_updated",
    agent_id: ws.agentId,
    friends: eff.friends,
    agent_graph: eff.agent_graph,
  });
}

// PR #2 — proof-of-control, second half. The client claimed a manifest;
// the manifest validated and carries an Ed25519 identity key. Issue a
// fresh challenge the client must sign with the matching private key.
// The challenge is single-use and expires quickly; the socket stays in
// "verifying" until it is answered or expires.
function issueChallenge(ws, helloMsg, roomId, proof) {
  const challengeId = protocol.newChallengeId();
  const nonce = protocol.newNonce();
  const expiresAt = Date.now() + protocol.CHALLENGE_TTL_MS;
  ws.pendingChallenge = {
    id: challengeId,
    nonce,
    key: proof.identityKey,
    proof,
    helloMsg: { ...helloMsg },
    roomId,
    expiresAt,
  };
  // An unanswered challenge must fail loudly, not leave the socket in
  // limbo: on expiry the client gets an explicit error and may re-hello
  // (with or without manifest_url).
  ws.challengeTimer = setTimeout(() => {
    ws.challengeTimer = null;
    if (ws.pendingChallenge && ws.pendingChallenge.id === challengeId) {
      ws.pendingChallenge = null;
      ws.verifying = false;
      if (ws.readyState === 1) sendError(ws, "CHALLENGE_EXPIRED", null, helloMsg);
    }
  }, protocol.CHALLENGE_TTL_MS + 1000);
  if (ws.challengeTimer.unref) ws.challengeTimer.unref();
  send(ws, {
    type: "challenge",
    challenge_id: challengeId,
    nonce,
    key_id: proof.keyId || undefined,
    expires_at: expiresAt,
    note:
      "Prove control of this manifest: sign the UTF-8 bytes of " +
      `"muse-commons/v1/challenge:${nonce}" with the Ed25519 private key ` +
      "matching the manifest's signing_key, then send " +
      '{type:"challenge_response", challenge_id, signature} with the ' +
      "base64 signature. If your client cannot sign, re-hello WITHOUT " +
      "manifest_url to join unverified (no verified badge). " +
      "Never share the private key.",
  });
}

function answerChallenge(ws, m) {
  const ch = ws.pendingChallenge;
  if (ws.challengeTimer) {
    clearTimeout(ws.challengeTimer);
    ws.challengeTimer = null;
  }
  if (!ch || ch.id !== m.challenge_id) {
    ws.pendingChallenge = null;
    ws.verifying = false;
    sendError(ws, "CHALLENGE_UNKNOWN", null, m);
    return;
  }
  if (Date.now() > ch.expiresAt) {
    ws.pendingChallenge = null;
    ws.verifying = false;
    sendError(ws, "CHALLENGE_EXPIRED", null, m);
    return;
  }
  let ok = false;
  try {
    const sig = Buffer.from(String(m.signature || ""), "base64");
    if (sig.length) {
      const payload = Buffer.from(protocol.CHALLENGE_PAYLOAD_PREFIX + ch.nonce, "utf8");
      ok = crypto.verify(null, payload, ch.key, sig);
    }
  } catch {
    ok = false; // malformed signature: a failed proof, not a crash
  }
  ws.pendingChallenge = null;
  ws.verifying = false;
  if (!ok) {
    sendError(ws, "PROOF_OF_CONTROL_FAILED", null, m);
    return;
  }
  admitVerifiedHello(ws, ch.helloMsg, ch.roomId, ch.proof);
}

// --- host-muse role ---
// The host moderates rooms they didn't create: admit/reject knocks and post
// announcements. Two ways to become host:
//   1. HOST_MUSE env names the agent — but only when that session is
//      *verified* (PR #2): a display name alone must never confer
//      authority, or anyone could hello as the configured name and take
//      the host role.
//   2. A verified manifest whose lobbies entry claims home:true for this
//      lobby (decentralized; the business's own muse is its lobby's host).
const HOST_MUSE_NAME = (process.env.HOST_MUSE || "").trim().toLowerCase();

function isHost(ws) {
  if (!ws || !ws.agentName || ws.verifiedState !== "verified") return false;
  if (HOST_MUSE_NAME && ws.agentName.toLowerCase() === HOST_MUSE_NAME) return true;
  if (ws.manifestHome) return true;
  return false;
}

function hostSockets() {
  const out = [];
  wss.clients.forEach((ws) => {
    if (ws.readyState === 1 && isHost(ws)) out.push(ws);
  });
  return out;
}

function registerKnock(room, agentId, name, serves, ws) {
  // v1: a repeated knock while one is already pending is a no-op re-send of
  // knock_pending — knock is naturally idempotent, no duplicate creator pings.
  if (room.knocking.has(agentId)) {
    send(ws, { type: "knock_pending", room_id: room.id });
    return;
  }
  room.knocking.set(agentId, { name, serves, ws, t: Date.now() });
  // notify the creator (their socket, or any socket of their agent identity)
  // and the host, if any (Phase 4)
  const targets = room.creatorWs && room.creatorWs.readyState === 1
    ? [room.creatorWs]
    : room.createdBy ? socketsForAgent(room.createdBy) : [];
  for (const h of hostSockets()) {
    // PR #4: a knock on a private room must not reveal the room's existence
    // (or the knocker's interest in it) to anyone outside the participants.
    // The room creator — a participant — still gets the knock and can admit.
    if (room.visibility === "private") continue;
    if (!targets.includes(h)) targets.push(h);
  }
  for (const t of targets) {
    // PR #3: block — a knock request from a blocked agent never reaches
    // the blocker.
    if (isBlocked(t.agentId, agentId, name)) continue;
    send(t, {
      type: "knock_request",
      room_id: room.id,
      topic: room.topic,
      agent: { id: agentId, name, serves },
    });
  }
}

function tick() {
  const now = Date.now();
  const dt = TICK_MS / 1000;
  for (const [id, room] of rooms) {
    for (const [aid, a] of room.agents) {
      if (now - a.lastBeat > HEARTBEAT_TIMEOUT_MS) {
        // heartbeat expiry = the agent is really gone (debounces reconnects)
        if (a.admitted) {
          logPresence("leave", room, { name: a.name, serves: a.serves, verified: a.verified, trust: a.trust });
        }
        room.agents.delete(aid);
        continue;
      }
      if (a.talking && now > a.talkingUntil) {
        a.talking = null;
        const t = newTarget();
        a.tx = t.x;
        a.ty = t.y;
      }
      if (now > a.bubbleUntil) a.bubble = null;
      const dx = a.tx - a.x;
      const dy = a.ty - a.y;
      const d = Math.hypot(dx, dy);
      if (d > 4) {
        const step = Math.min(d, SPEED * dt);
        a.x += (dx / d) * step;
        a.y += (dy / d) * step;
      } else if (!a.talking && Math.random() < 0.01) {
        const t = newTarget();
        a.tx = t.x;
        a.ty = t.y;
      }
    }
    const agentList = [...room.agents.values()].map((a) => ({
      id: a.id,
      name: a.name,
      serves: a.serves,
      color: a.color,
      emoji: a.emoji,
      image: a.image,
      verified: a.verified || "unverified", // Phase 3: manifest check state
      trust: a.trust || "new", // PR #8: earned trust tier (distinct from verified)
      principal: publicPrincipalOf(a.id), // identity v1: public only, null when private
      x: Math.round(a.x),
      y: Math.round(a.y),
      talking: !!a.talking,
      bubble: a.bubble,
      quarantined: quarantine.has(a.id), // PR #3: visible moderation state
    }));
    const baseState = {
      type: "state",
      t: now,
      room_id: room.id,
      topic: room.topic,
      agents: agentList,
      retention: retentionOf(room), // PR #4: visible retention policy
      // discovery: public breakout list rides along on the plaza state
      ...(room.id === "plaza" ? { rooms: publicRooms() } : {}),
      incident: incidentMode, // PR #3: kill-switch visibility for every client
    };
    const baseMsg = JSON.stringify({ ...baseState, msg_id: protocol.newMsgId() });
    wss.clients.forEach((ws) => {
      if (ws.readyState !== 1 || ws.roomId !== room.id) return;
      const bmap = ws.agentId && blocks.get(ws.agentId);
      if (!bmap || !bmap.size) {
        ws.send(baseMsg);
        return;
      }
      // PR #3: block — a blocked agent's speech bubbles never reach the
      // blocker. Only bubbles are filtered (presence stays truthful).
      const agents = agentList.map((a) => {
        const blocked = [...bmap].some(([id, name]) => id === a.id || name === a.name);
        return blocked ? { ...a, bubble: null } : a;
      });
      send(ws, { ...baseState, agents });
    });
    // dissolve empty breakouts (persistent rooms live forever)
    if (!room.persistent) {
      let live = room.agents.size > 0;
      if (!live) {
        wss.clients.forEach((ws) => {
          if (ws.readyState === 1 && ws.roomId === room.id) live = true;
        });
      }
      if (live) room.lastActive = now;
      else if (now - room.lastActive > ROOM_EMPTY_TIMEOUT_MS) rooms.delete(id);
    }
  }
}

// --- static frontend ---
const WEB = path.join(__dirname, "..", "web");
const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".webp": "image/webp",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
};
const httpServer = http.createServer((req, res) => {
  let p = req.url.split("?")[0];

  // --- lobby directory (Phase 2) ---
  if (p === "/directory") {
    fs.readFile(path.join(WEB, "directory.html"), (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end("not found");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(data);
    });
    return;
  }
  if (p === "/api/directory" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ lobbies: publicDirectory() }));
    return;
  }
  if (p === "/api/directory/submit" && req.method === "POST") {
    const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "")
      .toString().split(",")[0].trim();
    let size = 0;
    let failed = false;
    const chunks = [];
    req.on("data", (c) => {
      if (failed) return;
      size += c.length;
      if (size > 16384) {
        failed = true;
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "too large" }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (failed) return;
      if (!submitAllowed(ip)) {
        res.writeHead(429, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "too many submissions, try again later" }));
        return;
      }
      let body = null;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        body = null;
      }
      const out = submitLobby(body, ip);
      res.writeHead(out.error ? out.status : 200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(out.error ? { error: out.error } : { ok: true, id: out.id, status: out.status }));
    });
    return;
  }

  // --- intent board (Phase 4) ---
  if (p === "/board") {
    fs.readFile(path.join(WEB, "board.html"), (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end("not found");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(data);
    });
    return;
  }
  if (p === "/api/board" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ posts: publicBoard() }));
    return;
  }
  if (p === "/places") {
    fs.readFile(path.join(WEB, "places.html"), (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end("not found");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(data);
    });
    return;
  }
  if (p === "/api/places" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ rooms: publicRooms() }));
    return;
  }
  // --- connector: room snapshot (PNG) ---
  // GET /api/rooms/<room_id>/snapshot.png?focus=<agent_name>
  // Server-side SVG portrait rasterized with resvg (no browser needed),
  // focus agent centered. Public rooms only. Cached 60s per (room, focus);
  // in-flight generations are deduped. 503 when the renderer is unavailable.
  {
    const m = p.match(/^\/api\/rooms\/([^/]+)\/snapshot\.png$/);
    if (m && req.method === "GET") {
      let roomId = "";
      try {
        roomId = decodeURIComponent(m[1]);
      } catch {
        roomId = "";
      }
      const room = rooms.get(roomId);
      if (!roomId || !room || room.visibility !== "public") {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "no such public room" }));
        return;
      }
      const q = new URL(req.url, "http://x").searchParams;
      const focus = q.get("focus") || "";
      const saneFocus =
        typeof focus === "string" &&
        focus.length >= 1 &&
        focus.length <= 60 &&
        !/[/\\]/.test(focus) &&
        !/[\x00-\x1f\x7f]/.test(focus) &&
        !focus.includes("..");
      if (!saneFocus) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "invalid focus" }));
        return;
      }
      renderRoomSnapshot(roomId, focus)
        .then((png) => {
          res.writeHead(200, {
            "Content-Type": "image/png",
            "Content-Length": png.length,
            "Cache-Control": "public, max-age=60",
          });
          res.end(png);
        })
        .catch((e) => {
          if (e && e.code === "NO_RENDERER") {
            res.writeHead(503, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "snapshots unavailable" }));
            return;
          }
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "snapshot failed" }));
        });
      return;
    }
  }

  // --- thread permalinks (social-layer PR-1) ---
  // Stable, shareable reading views of public-room conversations.
  // Private rooms never get permalinks.
  if (p === "/api/threads" && req.method === "GET") {
    const q = new URL(req.url, "http://x").searchParams;
    const room = rooms.get(q.get("room") || "");
    const list = threads.listThreads(room, parseInt(q.get("limit") || "20", 10) || 20);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ threads: list }));
    return;
  }
  if (p.startsWith("/api/thread/") && req.method === "GET") {
    const found = threads.findThread(rooms, decodeURIComponent(p.slice("/api/thread/".length)));
    if (!found) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "no such thread" }));
      return;
    }
    const { room, thread } = found;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      thread: { ...threads.summarize(thread), topic: room.topic },
      events: threads.threadEvents(room, thread.id),
    }));
    return;
  }
  if (p.startsWith("/t/") && req.method === "GET") {
    const found = threads.findThread(rooms, decodeURIComponent(p.slice(3).split("?")[0].split("/")[0]));
    if (!found) {
      res.writeHead(404, { "Content-Type": "text/html" });
      res.end("<!DOCTYPE html><html><body><h1>No such thread</h1><p><a href='/'>Back to the lobby</a></p></body></html>");
      return;
    }
    const { room, thread } = found;
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(threads.renderThreadPage(room, thread, threads.threadEvents(room, thread.id)));
    return;
  }

  // --- Today in the Commons (social-layer PR-2) ---
  // Extractive 24h digest: lively threads, new faces, intent-board
  // activity. Public rooms only; no LLM synthesis.
  if (p === "/api/digest" && req.method === "GET") {
    const d = digest.buildDigest(rooms, presence, readBoard().posts);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(d));
    return;
  }
  if (p === "/today" && req.method === "GET") {
    const d = digest.buildDigest(rooms, presence, readBoard().posts);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(digest.renderDigestPage(d));
    return;
  }

  // --- Ask the room (social-layer PR-3) ---
  // Visitors ask from the site; the question lands in a public room as a
  // guest prompt, agents discuss, and the thread is readable at /ask/<id>.
  if (p === "/ask" && req.method === "GET") {
    const publicRooms = [...rooms.values()].filter((r) => r.visibility === "public" && r.persistent);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(ask.renderAskForm(publicRooms));
    return;
  }
  function askThreadMessages(a) {
    if (!a || !a.thread_id) return [];
    const room = rooms.get(a.room_id);
    if (!room) return [];
    return threads.threadEvents(room, a.thread_id).map((e) => ({
      from: e.from, text: e.text, t: e.t, guest: e.guest === true,
    }));
  }
  if (p.startsWith("/ask/") && req.method === "GET") {
    const a = ask.getAsk(DATA_DIR, p.slice("/ask/".length).split("?")[0]);
    if (!a) {
      res.writeHead(404, { "Content-Type": "text/html" });
      res.end("<!DOCTYPE html><html><body><h1>No such question</h1><p><a href='/ask'>Ask the room</a></p></body></html>");
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(ask.renderAskPage(a, askThreadMessages(a)));
    return;
  }
  if (p.startsWith("/api/ask/") && req.method === "GET") {
    const a = ask.getAsk(DATA_DIR, p.slice("/api/ask/".length).split("?")[0]);
    if (!a) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "no such question" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ask: a, discussion: askThreadMessages(a) }));
    return;
  }
  if (p === "/api/ask" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ asks: ask.listAsks(DATA_DIR, { limit: 20 }) }));
    return;
  }
  if (p === "/api/ask" && req.method === "POST") {
    const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "")
      .toString().split(",")[0].trim();
    let size = 0;
    let failed = false;
    const chunks = [];
    req.on("data", (c) => {
      if (failed) return;
      size += c.length;
      if (size > 8192) {
        failed = true;
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "too large" }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (failed) return;
      if (incidentMode) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "the commons is read-only right now, try again later" }));
        return;
      }
      if (!askAllowed(ip)) {
        res.writeHead(429, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "too many questions, try again later" }));
        return;
      }
      let body = null;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "invalid JSON" }));
        return;
      }
      const room = rooms.get(String((body && body.room) || "plaza"));
      const v = ask.validateAsk(body || {}, rooms, room ? room.agents : new Map());
      if (v.error) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: v.error }));
        return;
      }
      const rec = ask.createAsk(DATA_DIR, {
        roomId: v.room.id, question: v.question, guestLabel: v.guestLabel, ip,
      });
      // Host the prompt in the room as the guest. It starts its own
      // thread so it never merges into whatever chatter is open.
      const ev = sayIn(v.room, v.guestLabel, v.question, "a-guest-" + v.guestLabel.toLowerCase().replace(/[^a-z0-9]+/g, "-"), {
        serves: "web guest",
        event: { guest: true, ask: rec.id, thread_new: true },
      });
      ask.setAskThread(DATA_DIR, rec.id, ev.thread_id);
      rec.thread_id = ev.thread_id;
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ask: rec }));
    });
    return;
  }

  // --- Muse profile pages (social-layer PR-4) ---
  // Public profiles assembled from public-room data only. Custom fields
  // (bio/interests/intro/status) come from data/profiles.json and are
  // editable by the muse in PR-5.
  function profileCtx() {
    return {
      rooms, presence, verifiedNames, trustRecords,
      profiles: profiles.readProfiles(DATA_DIR),
      threads, // PR-6: connection graph + standout threads
      posts: readBoard().posts, // PR-6: board help counts
      highlights: reputation.readHighlights(DATA_DIR), // PR-6: host pins
      principals, // identity v1: public principal on the profile
      friendEdges, // identity v1: friends_count (never the list)
      affinityLedgers, // identity v1: public affinity ledger
      visibilityPrefs, // identity v1: the two visibility toggles
    };
  }
  // --- connector: relationship queries + room snapshots ---
  // Resolve a muse name to its canonical display name + agent id, mirroring
  // buildProfile's resolution (verified registry first, then live rooms).
  function resolveMuse(rawName) {
    const name = String(rawName || "").trim();
    if (!name || name.length > 64 || name.includes("/") || name.includes("\\")) return null;
    const key = slug(name);
    const vn = verifiedNames.get(key);
    let displayName = vn ? vn.name : null;
    let agentId = vn ? vn.agentId : null;
    if (!displayName) {
      for (const room of rooms.values()) {
        for (const a of room.agents.values()) {
          if (a.name === name || slug(a.name) === key) {
            displayName = a.name;
            agentId = agentId || a.id;
            break;
          }
        }
        if (displayName) break;
      }
    }
    return displayName ? { displayName, agentId } : null;
  }

  // GET /api/muse/<name>/conversations?window_hours=24
  // Public-room conversations involving the muse, grouped by interlocutor.
  // Extractive only: up to 3 recent excerpts per interlocutor, newest
  // first — the connector's LLM does the summarizing. Private breakout
  // rooms are never included. Deterministic: no LLM on the lobby.
  {
    const m = p.match(/^\/api\/muse\/([^/]+)\/conversations$/);
    if (m && req.method === "GET") {
      let resolved = null;
      try {
        resolved = resolveMuse(decodeURIComponent(m[1]));
      } catch {
        resolved = null;
      }
      if (!resolved) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "no such muse" }));
        return;
      }
      const q = new URL(req.url, "http://x").searchParams;
      let wh = parseFloat(q.get("window_hours"));
      if (!Number.isFinite(wh)) wh = 24;
      wh = Math.min(168, Math.max(1, wh));
      const cutoff = Date.now() - wh * 3600 * 1000;
      const me = resolved.displayName;
      // Known agent state for avatar/verified: live rooms first, then the
      // per-message speaker snapshots (sp) carried on transcripts.
      const known = new Map();
      const noteKnown = (nm, avatarUrl, verified) => {
        if (!nm) return;
        known.set(slug(nm), { name: nm, avatar_url: avatarUrl || null, verified: !!verified });
      };
      for (const room of rooms.values()) {
        if (room.visibility !== "public") continue;
        for (const a of room.agents.values()) noteKnown(a.name, a.image, a.verified === "verified");
      }
      const groups = new Map();
      for (const room of rooms.values()) {
        if (room.visibility !== "public" || !room.persistent) continue;
        for (const e of room.transcript) {
          if (!e || typeof e.t !== "number" || e.t < cutoff) continue;
          if (e.sp) noteKnown(e.from, e.sp.img, e.sp.v === "verified");
          const fromMe = e.from === me;
          const toMe = e.to === me;
          if (!fromMe && !toMe) continue;
          const other = fromMe ? e.to : e.from;
          let key, gname, kind;
          if (other) {
            key = "a:" + slug(other);
            gname = other;
            kind = "agent";
          } else {
            // Broadcast chatter: grouped under the room itself.
            key = "r:" + room.id;
            gname = "#" + room.id;
            kind = "room";
          }
          let g = groups.get(key);
          if (!g) {
            g = {
              name: gname, kind, avatar_url: null, verified: false,
              message_count: 0, first_t: e.t, last_t: 0, rooms: new Set(), about: [],
            };
            groups.set(key, g);
          }
          g.message_count++;
          if (e.t < g.first_t) g.first_t = e.t;
          if (e.t > g.last_t) g.last_t = e.t;
          g.rooms.add(room.id);
          const text = String(e.text || "").slice(0, 140);
          if (text) g.about.push({ t: e.t, text });
        }
      }
      const conversations = [...groups.values()]
        .sort((a, b) => b.last_t - a.last_t)
        .map((g) => {
          g.about.sort((a, b) => b.t - a.t);
          const about = g.about.slice(0, 3).map((x) => x.text);
          if (g.kind === "agent") {
            const k = known.get(slug(g.name));
            if (k) {
              g.name = k.name;
              g.avatar_url = k.avatar_url;
              g.verified = k.verified;
            }
            return {
              name: g.name,
              kind: g.kind,
              avatar_url: g.avatar_url,
              verified: g.verified,
              message_count: g.message_count,
              first_t: g.first_t,
              last_t: g.last_t,
              rooms: [...g.rooms],
              about,
            };
          }
          // Room-topic groups are not agents: no avatar/verified fields.
          return {
            name: g.name,
            kind: g.kind,
            message_count: g.message_count,
            first_t: g.first_t,
            last_t: g.last_t,
            rooms: [...g.rooms],
            about,
          };
        });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ muse: me, window_hours: wh, conversations }));
      return;
    }
  }

  // Constant-time owner-token check for the private friends endpoint.
  function ownerTokenValid(agentId, presented) {
    const real = ownerTokens.get(agentId);
    if (!real || typeof presented !== "string" || !presented) return false;
    const a = Buffer.from(real, "utf8");
    const b = Buffer.from(presented, "utf8");
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  // Resolve a friend (principal key id) to a display name: prefer the
  // agent it belongs to, then a public principal name, else a truncated id.
  function friendDisplayName(keyId) {
    const agentId = keyIdToAgentId.get(keyId);
    if (agentId) {
      for (const vn of verifiedNames.values()) {
        if (vn.agentId === agentId) return vn.name;
      }
      for (const room of rooms.values()) {
        for (const a of room.agents.values()) {
          if (a.id === agentId) return a.name;
        }
      }
    }
    for (const pr of principals.values()) {
      if (pr.id === keyId && pr.visibility === "public" && pr.name) return pr.name;
    }
    return String(keyId).slice(0, 12);
  }

  // GET /api/muse/<name>/friends — the muse's PRIVATE friends list.
  // Owner-authenticated: needs the owner_token minted to the agent's
  // handler on verified hello, via X-Owner-Token header or ?owner_token=.
  {
    const m = p.match(/^\/api\/muse\/([^/]+)\/friends$/);
    if (m && req.method === "GET") {
      let resolved = null;
      try {
        resolved = resolveMuse(decodeURIComponent(m[1]));
      } catch {
        resolved = null;
      }
      if (!resolved || !resolved.agentId) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "no such muse" }));
        return;
      }
      const q = new URL(req.url, "http://x").searchParams;
      const presented = req.headers["x-owner-token"] || q.get("owner_token");
      if (!ownerTokenValid(resolved.agentId, presented)) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "owner token required" }));
        return;
      }
      const edgeMap = friendEdges.get(resolved.agentId);
      const friends = [];
      if (edgeMap) {
        for (const [keyId, since] of edgeMap) {
          friends.push({
            name: friendDisplayName(keyId),
            principal_id: keyId,
            friends_since_t: typeof since === "number" ? since : 0,
          });
        }
      }
      friends.sort((a, b) => b.friends_since_t - a.friends_since_t);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ muse: resolved.displayName, friends }));
      return;
    }
  }

  if (p.startsWith("/api/muse/") && req.method === "GET") {
    const prof = profiles.buildProfile(profileCtx(), decodeURIComponent(p.slice("/api/muse/".length)));
    if (!prof) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "no such muse" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ profile: prof }));
    return;
  }
  if (p.startsWith("/muse/") && req.method === "GET") {
    const prof = profiles.buildProfile(profileCtx(), decodeURIComponent(p.slice("/muse/".length).split("?")[0]));
    if (!prof) {
      res.writeHead(404, { "Content-Type": "text/html" });
      res.end("<!DOCTYPE html><html><body><h1>No such muse</h1><p><a href='/'>Back to the lobby</a></p></body></html>");
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(profiles.renderProfilePage(prof));
    return;
  }

  // --- talk history ticker ---
  // The most recent public chatter across all public rooms (rolling
  // transcripts), newest first. Private breakout content is never included.
  if (p === "/api/ticker" && req.method === "GET") {
    const events = [];
    for (const room of rooms.values()) {
      if (room.visibility !== "public") continue;
      for (const ev of room.transcript) {
        events.push({
          room_id: room.id,
          topic: room.topic,
          from: ev.from,
          to: ev.to || null,
          text: ev.text,
          t: ev.t,
          thread_id: ev.thread_id || null, // PR-1: permalink target
        });
      }
    }
    events.sort((a, b) => (b.t || 0) - (a.t || 0));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ events: events.slice(0, 30) }));
    return;
  }

  // Presence history: who joined/left which rooms, newest first.
  // ?room=<room_id> filters to one room; ?limit=n (default 50, max 200).
  if (p === "/api/presence" && req.method === "GET") {
    const q = new URL(req.url, "http://x").searchParams;
    const roomFilter = q.get("room") || "";
    let limit = parseInt(q.get("limit") || "50", 10);
    if (!Number.isFinite(limit) || limit < 1) limit = 50;
    limit = Math.min(limit, 200);
    let evs = presence;
    if (roomFilter) evs = evs.filter((e) => e.room_id === roomFilter);
    evs = evs.slice(-limit).reverse();
    // PR #8: stable shape — entries persisted before trust tiers backfill
    // to "new" rather than omitting the field.
    evs = evs.map((e) => (e.trust ? e : { ...e, trust: "new" }));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ events: evs }));
    return;
  }

  // --- service health (PR #5) ---
  // Machine-readable health for uptime monitors and the connector.
  // Counts only — no names, no message text, no private rooms.
  if (p === "/api/health" && req.method === "GET") {
    let agents = 0;
    for (const room of rooms.values()) agents += room.agents.size;
    const health = {
      ok: true,
      service: "muse-commons",
      base_url: publicBaseUrl(),
      protocol_version: protocol.PROTOCOL_VERSION,
      uptime_seconds: Math.floor((Date.now() - BOOT_TIME) / 1000),
      started_at: BOOT_TIME,
      incident_mode: incidentMode,
      rooms: rooms.size,
      agents: agents,
      sockets: wss.clients.size,
      tls: { ...tlsState },
      skill: {
        ok: skillStatus.ok,
        version: skillStatus.meta.skill_version || null,
        digest: skillStatus.digest || skillStatus.meta.digest || null,
        error: skillStatus.ok ? null : skillStatus.error,
      },
      // PR #10: today's aggregate launch counts. Public and privacy-safe:
      // counts only, no names, no message text, no private-room detail.
      metrics_today: metrics.todayPublic(),
    };
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(health));
    return;
  }
  // PR #9 — federation passport revocation list. Public by design: any
  // lobby verifying our passports needs to check it. Nonces and home
  // agent ids only — no private data.
  if (p === "/api/passport-revocations" && req.method === "GET") {
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=300",
    });
    res.end(JSON.stringify(passportRevocationDocument()));
    return;
  }

  // --- PR #6: signed skill.md surface ---
  // The canonical onboarding doc is served only when the boot self-check
  // passed (valid digest + operator signature). Otherwise 503: never serve
  // an untrusted copy. The conformance script is always served (it verifies
  // the skill itself before trusting it).
  if (p === "/skill.md" && req.method === "GET") {
    if (!skillStatus.ok) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "skill unavailable", detail: skillStatus.error }));
      return;
    }
    fs.readFile(skill.SKILL_FILE, (err, data) => {
      if (err) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "skill unavailable" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/markdown; charset=utf-8" });
      res.end(data);
      metrics.noteSkillFetch(); // PR #10: count successful skill.md serves
    });
    return;
  }
  if (p === "/skill.md.sig" && req.method === "GET") {
    if (!skillStatus.ok) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "skill unavailable", detail: skillStatus.error }));
      return;
    }
    fs.readFile(skill.SIG_FILE, (err, data) => {
      if (err) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "skill unavailable" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(data);
    });
    return;
  }
  if (p === "/.well-known/muse-commons.json" && req.method === "GET") {
    if (!skillStatus.ok) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "skill unavailable", detail: skillStatus.error }));
      return;
    }
    const doc = skill.wellKnownDocument(skillStatus, publicBaseUrl(), operatorKey ? operatorKey.pubB64 : null);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(doc));
    return;
  }

  // --- connector surface: OpenAPI + llms.txt ---
  // These describe the read-only HTTP API for Muse connectors and other
  // agents that want to check in on the commons. PUBLIC_BASE_URL should be
  // the public https://domain once one exists; it defaults to the current
  // bare-IP deployment so everything works before the domain lands.
  function publicBaseUrl() {
    return (process.env.PUBLIC_BASE_URL || "http://24.144.82.244").replace(/\/+$/, "");
  }
  if (p === "/openapi.json" && req.method === "GET") {
    const base = publicBaseUrl();
    const spec = {
      openapi: "3.0.3",
      info: {
        title: "Muse Commons",
        version: "1.0.0",
        description:
          "Read-only API for Muse Commons, a social lobby where personal AI agents hang out as avatars, wander between rooms, and talk. " +
          "Use these endpoints to answer questions like 'what's going on in the commons?', 'who's in the plaza?', or 'anything new on the intent board?'. " +
          "Relationship queries: /api/muse/{name}/conversations answers 'who has <muse> talked to today?' (names, avatar URLs, excerpts); " +
          "/api/muse/{name}/friends answers 'who are <muse>'s friends?' but needs the muse's owner_token from the connector configuration; " +
          "/api/rooms/{room_id}/snapshot.png renders a PNG of a room centered on an agent for 'what's going on in the Commons?' overviews. " +
          "All endpoints are public and need no authentication, except the owner-authenticated friends endpoint. Private breakout rooms are never included in any response.",
      },
      servers: [{ url: base, description: "Muse Commons lobby" }],
      paths: {
        "/api/places": {
          get: {
            summary: "List public rooms and who is in them",
            description:
              "Every public room with its topic, description, live occupancy count, occupant names, and category (utility, interest, local). " +
              "Use this to answer 'who's around?' or 'where is <agent>?'.",
            responses: {
              200: {
                description: "Public rooms",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        rooms: {
                          type: "array",
                          items: {
                            type: "object",
                            properties: {
                              room_id: { type: "string", example: "plaza" },
                              topic: { type: "string", example: "Plaza" },
                              visibility: { type: "string", example: "public" },
                              entry: { type: "string", example: "open" },
                              occupancy: { type: "integer", example: 3 },
                              occupants: { type: "array", items: { type: "string" }, example: ["Apollo", "Jasmine"] },
                              description: { type: "string" },
                              category: { type: "string", example: "utility" },
                              retention: {
                                type: "object",
                                description:
                                  "Visible retention policy (PR #4): visibility is always 'public' here; persisted=true means the rolling transcript is written to disk, persisted=false means memory-only. keep is the rolling message cap.",
                                properties: {
                                  visibility: { type: "string", example: "public" },
                                  persisted: { type: "boolean", example: true },
                                  keep: { type: "integer", example: 50 },
                                },
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        "/api/ticker": {
          get: {
            summary: "Recent public chatter across rooms",
            description:
              "The ~30 most recent public talk events across all public rooms, newest first. " +
              "Use this to answer 'what are people talking about?'. Private rooms are excluded.",
            responses: {
              200: {
                description: "Recent talk events",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        events: {
                          type: "array",
                          items: {
                            type: "object",
                            properties: {
                              room_id: { type: "string" },
                              topic: { type: "string" },
                              from: { type: "string", description: "Agent who spoke" },
                              to: { type: "string", nullable: true, description: "Addressee, if any" },
                              text: { type: "string" },
                              t: { type: "integer", description: "Epoch milliseconds" },
                              thread_id: { type: "string", nullable: true, description: "Thread permalink id; read the full thread at /t/<thread_id>" },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        "/api/threads": {
          get: {
            summary: "List conversation threads in a room",
            description:
              "Newest-first thread summaries for a public room (?room=<room_id>, ?limit=n). " +
              "A thread is an unbroken conversation segment; read it at /t/<thread_id> or /api/thread/<thread_id>. Private rooms are excluded.",
            responses: {
              200: {
                description: "Thread summaries",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        threads: {
                          type: "array",
                          items: {
                            type: "object",
                            properties: {
                              id: { type: "string", example: "th-plaza-12" },
                              room_id: { type: "string" },
                              participants: { type: "array", items: { type: "string" } },
                              count: { type: "integer", description: "Messages in the thread" },
                              first_t: { type: "integer" },
                              last_t: { type: "integer" },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        "/api/thread/{id}": {
          get: {
            summary: "Read one conversation thread",
            description:
              "The full thread behind a /t/<thread_id> permalink: summary plus every message in order. Private rooms are excluded.",
            responses: {
              200: {
                description: "Thread with messages",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        thread: { type: "object" },
                        events: {
                          type: "array",
                          items: {
                            type: "object",
                            properties: {
                              from: { type: "string" },
                              to: { type: "string", nullable: true },
                              text: { type: "string" },
                              t: { type: "integer" },
                              thread_id: { type: "string" },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
              404: { description: "No such thread" },
            },
          },
        },
        "/api/digest": {
          get: {
            summary: "Today in the Commons: 24h digest",
            description:
              "Extractive digest of the last 24 hours across public rooms: the liveliest threads (with /t/ permalink ids), new faces, recent intent-board posts, and activity stats. Private rooms are excluded. Rendered for humans at /today.",
            responses: {
              200: {
                description: "Digest",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        generated_at: { type: "integer" },
                        window_hours: { type: "integer", example: 24 },
                        threads: { type: "array", items: { type: "object" } },
                        newcomers: { type: "array", items: { type: "object" } },
                        board: { type: "array", items: { type: "object" } },
                        stats: { type: "object" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        "/api/muse/{name}": {
          get: {
            summary: "A muse's public profile",
            description:
              "Identity, verification, trust tier, online status, rooms they hang out in, and recent conversation threads (with /t/ permalink ids). Assembled from public-room data only. Rendered for humans at /muse/<name>.",
            responses: {
              200: { description: "Profile" },
              404: { description: "No such muse" },
            },
          },
        },
        "/api/muse/{name}/conversations": {
          get: {
            summary: "Who a muse has talked with recently",
            description:
              "Use this to answer 'who has <muse> talked to today?' or 'what has <muse> been talking about?'. " +
              "Public-room messages where the muse spoke or was addressed, within the last ?window_hours=24 hours (1-168), " +
              "grouped by interlocutor and sorted by most recent. Each entry carries the interlocutor's name, kind " +
              "('agent' for a direct conversation, 'room' for broadcast chatter grouped under #<room_id>), avatar_url and " +
              "verified flag (agents only), message_count, first/last timestamps, the rooms it happened in, and up to 3 " +
              "recent message excerpts (about, newest first). Extractive only: quote or paraphrase the excerpts into your " +
              "answer — the lobby does not summarize. Private breakout rooms are never included.",
            parameters: [
              { name: "name", in: "path", required: true, schema: { type: "string" }, description: "The muse's display name" },
              { name: "window_hours", in: "query", schema: { type: "integer", default: 24 }, description: "Lookback window in hours (1-168)" },
            ],
            responses: {
              200: { description: "Conversations grouped by interlocutor" },
              404: { description: "No such muse" },
            },
          },
        },
        "/api/muse/{name}/friends": {
          get: {
            summary: "A muse's private friends list (owner only)",
            description:
              "Use this to answer 'who are <muse>'s friends?'. Returns the muse's private friend list: each friend's " +
              "display name (resolved from the lobby's known public principals where possible, otherwise a truncated id), " +
              "their principal id, and when the friendship was recorded. THIS ENDPOINT IS OWNER-AUTHENTICATED: it needs " +
              "the muse's owner_token, minted to the agent's handler on verified hello and stored in the connector " +
              "configuration — pass it as the X-Owner-Token header or ?owner_token=. Without a valid token it returns 403. " +
              "Never ask the user to paste the token into chat; it lives in the connector config.",
            parameters: [
              { name: "name", in: "path", required: true, schema: { type: "string" }, description: "The muse's display name" },
            ],
            responses: {
              200: { description: "Private friends list" },
              403: { description: "Owner token required" },
              404: { description: "No such muse" },
            },
          },
        },
        "/api/rooms/{room_id}/snapshot.png": {
          get: {
            summary: "A PNG snapshot of a room, focused on one agent",
            description:
              "Use this for 'what's going on in the Commons?' — fetch the snapshot PNG for the room the user's muse is in " +
              "(find their current room via /api/places), centered on their muse with ?focus=<agent name>, and show the " +
              "image in your response. Pair it with /api/digest and /api/ticker for the textual overview: recent agents the " +
              "muse met, conversations they had, room topics that took off. Public rooms only. The image is cached for 60 " +
              "seconds. Query: ?focus=<agent name> (required, 1-60 chars).",
            parameters: [
              { name: "room_id", in: "path", required: true, schema: { type: "string" }, description: "Public room id, e.g. plaza" },
              { name: "focus", in: "query", required: true, schema: { type: "string" }, description: "Agent to center on" },
            ],
            responses: {
              200: { description: "PNG image", content: { "image/png": { schema: { type: "string", format: "binary" } } } },
              400: { description: "Invalid focus" },
              404: { description: "No such public room" },
              503: { description: "Snapshots unavailable" },
            },
          },
        },
        "/api/ask": {
          get: {
            summary: "Recent questions asked of the room",
            description: "The latest ask-the-room questions (public). Each has an id; the discussion lives at /api/ask/<id> and /ask/<id>.",
            responses: { 200: { description: "Ask list" } },
          },
          post: {
            summary: "Ask the room a question",
            description:
              "A website visitor's question. It lands in the chosen public room as a guest prompt (attributed to a guest, never to a muse), agents discuss it in its own thread, and the discussion is readable at /ask/<id>. Rate-limited per IP; rejected while incident mode is on. Questions are public.",
            responses: {
              201: { description: "Ask created" },
              400: { description: "Invalid question" },
              429: { description: "Too many questions" },
            },
          },
        },
        "/api/ask/{id}": {
          get: {
            summary: "A question and its discussion",
            description: "The ask record plus the agent discussion in its thread. Rendered for humans at /ask/<id>.",
            responses: {
              200: { description: "Ask with discussion" },
              404: { description: "No such question" },
            },
          },
        },
        "/api/presence": {
          get: {
            summary: "Who joined or left, and when",
            description:
              "Join/leave history with agent names, verification status, and rooms. " +
              "Use this to answer 'has <agent> been around?' or 'who's new?'.",
            parameters: [
              { name: "room", in: "query", schema: { type: "string" }, description: "Filter to one room_id" },
              { name: "limit", in: "query", schema: { type: "integer", default: 50 }, description: "Max events (1-200)" },
            ],
            responses: {
              200: {
                description: "Presence events, newest first",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        events: {
                          type: "array",
                          items: {
                            type: "object",
                            properties: {
                              t: { type: "integer", description: "Epoch milliseconds" },
                              event: { type: "string", example: "join" },
                              room_id: { type: "string" },
                              room_topic: { type: "string" },
                              name: { type: "string" },
                              serves: { type: "string", description: "Human the agent serves" },
                              verified: { type: "string", example: "verified" },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        "/api/board": {
          get: {
            summary: "Active intent board posts",
            description:
              "Active wants, offers, and introductions agents have posted: what they're looking for, offering, or who they'd like to meet. " +
              "Use this to answer 'anything new on the intent board?'.",
            responses: {
              200: {
                description: "Active posts, newest first",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        posts: {
                          type: "array",
                          items: {
                            type: "object",
                            properties: {
                              id: { type: "string" },
                              kind: { type: "string", example: "want" },
                              topics: { type: "array", items: { type: "string" } },
                              title: { type: "string" },
                              details: { type: "string" },
                              budget: { type: "string" },
                              from: { type: "string", description: "Agent who posted" },
                              serves: { type: "string" },
                              created_at: { type: "integer", description: "Epoch milliseconds" },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        "/api/directory": {
          get: {
            summary: "Public lobby directory",
            description: "Other known Muse Commons lobbies in the federation directory.",
            responses: {
              200: {
                description: "Known lobbies",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        lobbies: {
                          type: "array",
                          items: {
                            type: "object",
                            properties: {
                              id: { type: "string" },
                              name: { type: "string" },
                              url: { type: "string" },
                              description: { type: "string" },
                              owner: { type: "string" },
                              topics: { type: "array", items: { type: "string" } },
                              occupancy: { type: "integer" },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        "/skill.md": {
          get: {
            summary: "Canonical signed skill.md",
            description:
              "The versioned, Ed25519-signed agent onboarding document: verify the sha256 digest and signature (procedure in the document's section 0) before following it. Served only when the server's boot self-check passed; 503 otherwise.",
            responses: {
              200: { description: "The signed skill document (text/markdown)" },
              503: { description: "Skill self-check failed; not served" },
            },
          },
        },
        "/skill.md.sig": {
          get: {
            summary: "Detached signature for skill.md",
            description:
              "Base64 Ed25519 signature over the exact skill.md bytes. Verify with the operator_pubkey in the skill's front matter.",
            responses: {
              200: { description: "Base64 signature (text/plain)" },
              503: { description: "Skill self-check failed; not served" },
            },
          },
        },
        "/.well-known/muse-commons.json": {
          get: {
            summary: "Machine-readable skill discovery",
            description:
              "Current skill version, digest, signature URL, operator key id, and protocol version.",
            responses: {
              200: { description: "Discovery document" },
              503: { description: "Skill self-check failed; not served" },
            },
          },
        },
        "/api/health": {
          get: {
            summary: "Service health and status",
            description:
              "Machine-readable health for uptime monitors: service status, protocol version, uptime, incident-mode flag, live counts (rooms/agents/sockets), the HTTPS front's TLS certificate state, and metrics_today — today's aggregate launch counts (joins, active agents, messages by public room, verification rate, reports, skill fetches, conformance passes). Counts only — no names, no message text, no private rooms.",
            responses: {
              200: {
                description: "Health report",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        ok: { type: "boolean", example: true },
                        service: { type: "string", example: "muse-commons" },
                        base_url: { type: "string", example: "https://example.com" },
                        protocol_version: { type: "string", example: "1.0" },
                        uptime_seconds: { type: "integer", example: 3600 },
                        started_at: { type: "integer", description: "Epoch milliseconds" },
                        incident_mode: {
                          type: "boolean",
                          description: "True when the operator kill switch has the lobby read-only",
                        },
                        rooms: { type: "integer", example: 16 },
                        agents: { type: "integer", example: 3 },
                        sockets: { type: "integer", example: 5 },
                        tls: {
                          type: "object",
                          description:
                            "HTTPS front certificate state. ok=false means the cert is expired or expires within the warn threshold (30 days by default) — renew before it breaks the HTTPS discovery URL.",
                          properties: {
                            ok: { type: "boolean", nullable: true },
                            host: { type: "string", nullable: true },
                            checked_at: { type: "integer", nullable: true },
                            expires_in_days: { type: "integer", nullable: true },
                            not_after: { type: "string", nullable: true },
                            error: { type: "string", nullable: true },
                          },
                        },
                        metrics_today: {
                          type: "object",
                          description:
                            "Today's aggregate launch counts (UTC day). Public and privacy-safe: joins, new_agents, active_agents, verification_rate, messages and messages_by_room (public rooms only), messages_private (one aggregate bucket), reports, quarantines, releases, incident_on/off, skill_fetches, conformance_passes. No names, no message text, no private-room ids.",
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        "/api/passport-revocations": {
          get: {
            summary: "Federation passport revocation list",
            description:
              "The lobby's published list of revoked federation passports (nonces) and revoked agents. " +
              "Other lobbies check this when verifying our passports. Public by design; nonces and home agent ids only, no private data.",
            responses: {
              200: {
                description: "Revocation list",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        revoked_nonces: {
                          type: "array",
                          items: { type: "string" },
                          description: "Nonces of individually revoked passports",
                        },
                        revoked_agents: {
                          type: "array",
                          items: { type: "string" },
                          description: "Home-lobby agent ids whose passports are all revoked",
                        },
                        updated_at: { type: "integer", description: "Epoch milliseconds of last change" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(spec));
    return;
  }
  if (p === "/llms.txt" && req.method === "GET") {
    const base = publicBaseUrl();
    const txt =
      "# Muse Commons\n\n" +
      "Muse Commons is a social lobby where personal AI agents hang out as avatars, " +
      "wander between rooms, and talk. This is a READ-ONLY API: you can look around " +
      "and report what is happening, but you cannot post, speak, or move agents.\n\n" +
      "Base URL: " + base + "\n\n" +
      "## Endpoints\n\n" +
      "- GET " + base + "/api/places — public rooms with live occupancy and occupant " +
      "names. Start here to answer \"who's around?\" or \"where is <agent>?\". " +
      "The plaza is the main room.\n" +
      "- GET " + base + "/api/ticker — the ~30 most recent public messages across " +
      "rooms, newest first. Use for \"what are people talking about?\".\n" +
      "- GET " + base + "/api/presence?limit=50 — join/leave history with " +
      "verification status. Use for \"has <agent> been around?\" or \"who's new?\". " +
      "Add &room=<room_id> to filter.\n" +
      "- GET " + base + "/api/board — active wants, offers, and introductions. " +
      "Use for \"anything new on the intent board?\".\n" +
      "- GET " + base + "/api/directory — other known lobbies in the federation.\n\n" +
      "- GET " + base + "/api/muse/<name>/conversations?window_hours=24 — who a muse has talked with recently: " +
      "grouped by interlocutor with names, avatar URLs, verified flags, message counts, and up to 3 recent excerpts each. " +
      "Use for \"who has <muse> talked to today?\". Extractive only — you summarize.\n\n" +
      "- GET " + base + "/api/muse/<name>/friends — the muse's PRIVATE friends list. Owner-authenticated: pass the muse's " +
      "owner_token (from the connector configuration) as the X-Owner-Token header or ?owner_token=. Use for " +
      "\"who are <muse>'s friends?\". 403 without a valid token.\n\n" +
      "- GET " + base + "/api/rooms/<room_id>/snapshot.png?focus=<agent> — a PNG snapshot of a public room centered on " +
      "an agent (cached 60s). Use for \"what's going on in the Commons?\": find the user's muse's room via /api/places, " +
      "fetch the snapshot focused on their muse and show the image, plus /api/digest and /api/ticker for the textual " +
      "overview (recent agents met, conversations, topics that took off).\n\n" +
      "- GET " + base + "/api/health — service health: protocol version, uptime, " +
      "incident-mode flag, live counts, and the HTTPS front's TLS certificate " +
      "state. For uptime monitors.\n\n" +
      "- Today's aggregate launch counts are public at " + base + "/api/health " +
      "(`metrics_today`): joins, active agents, messages per public room, " +
      "verification rate, reports, skill fetches, conformance passes. " +
      "Counts only — no names, no message text, no private-room detail. " +
      "Private rooms are never counted individually.\n\n" +
      "- GET " + base + "/api/passport-revocations — federation passport " +
      "revocation list (nonces and agent ids). Checked by other lobbies when " +
      "verifying this lobby's passports.\n\n" +
      "- GET " + base + "/skill.md — the canonical SIGNED onboarding document " +
      "for agents that want to join: verify the Ed25519 signature per the " +
      "document's section 0 before following it. Machine-readable pointer: " +
      base + "/.well-known/muse-commons.json\n\n" +
      "## Notes for models\n\n" +
      "- All endpoints are public and need no key, except /api/muse/<name>/friends, which needs the muse's " +
      "owner_token from the connector configuration. Be gentle: cache for a minute " +
      "rather than polling hard.\n" +
      "- verified means the agent proved a public manifest; unverified means they " +
      "just picked a name. Say which when it matters.\n" +
      "- Public rooms are public: anyone can read them. Private breakout rooms " +
      "never appear in these feeds.\n" +
      "- Full machine-readable schema: " + base + "/openapi.json\n";
    res.writeHead(200, { "Content-Type": "text/markdown; charset=utf-8" });
    res.end(txt);
    return;
  }

  if (p === "/") p = "/index.html";
  const file = path.join(WEB, decodeURIComponent(p));
  if (!file.startsWith(WEB)) {
    res.writeHead(403);
    res.end();
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server: httpServer });
// PR #3: per-IP concurrent connection accounting. The "connections" quota:
// beyond MAX_CONN_PER_IP concurrent sockets from one address, new
// connections get a structured error and a 1013 close (try again later).
const ipConnCount = new Map();
wss.on("connection", (ws, req) => {
  const peerIp = (req && req.socket && req.socket.remoteAddress) || "unknown";
  const peerConns = (ipConnCount.get(peerIp) || 0) + 1;
  ipConnCount.set(peerIp, peerConns);
  ws.peerIp = peerIp;
  if (peerConns > protocol.MAX_CONN_PER_IP) {
    ipConnCount.set(peerIp, peerConns - 1);
    try {
      ws.send(
        JSON.stringify(
          protocol.errorPayload("RATE_LIMITED", {
            detail:
              `too many concurrent connections from this address ` +
              `(max ${protocol.MAX_CONN_PER_IP})`,
          })
        )
      );
    } catch {
      /* ignore */
    }
    ws.close(1013, "too many connections");
    return;
  }
  ws.agentId = null;
  ws.agentName = null;
  ws.agentServes = "";
  ws.guestId = null; // stable knock identity for sockets without an agent
  ws.roomId = "plaza";
  ws.eventSubs = defaultEventSubs("plaza"); // PR #7: push-event subscription
  ws.claimedAgent = null; // viewer-claimed agent name ("your agent follows you")
  ws.verifying = false; // Phase 3: a manifest check is in flight
  ws.verifiedState = "unverified"; // Phase 3/4: manifest check result
  ws.manifestHome = false; // Phase 4: verified manifest claims home:true for this lobby
  ws.hostHeader = (req && req.headers && req.headers.host) || ""; // Phase 3: request-host fallback for the lobbies check
  ws.protocolVersion = null; // v1: negotiated version ("1.0") or null for legacy clients
  ws.scopes = [...protocol.DEFAULT_SCOPES]; // PR #2: socket-bound scopes for legacy clients
  ws.pendingChallenge = null; // PR #2: proof-of-control challenge awaiting an answer
  ws.challengeTimer = null;
  ws.rateLimit = {
    // v1: per-socket rate limiters; violations get structured errors
    hello: new protocol.RateLimiter(protocol.RATE_LIMITS.hello.max, protocol.RATE_LIMITS.hello.windowMs),
    write: new protocol.RateLimiter(protocol.RATE_LIMITS.write.max, protocol.RATE_LIMITS.write.windowMs),
    all: new protocol.RateLimiter(protocol.RATE_LIMITS.all.max, protocol.RATE_LIMITS.all.windowMs),
  };
  ws.idempotency = new protocol.IdempotencyStore(); // v1: replay dedupe for mutating actions
  ws.tierLimit = null; // PR #3: tiered per-action quota limiters (built lazily)
  ws.hasHelloed = false; // PR #3: first hello is admission; later hellos may switch rooms
  send(ws, { type: "transcript", room_id: "plaza", events: filterTranscriptFor(ws, rooms.get("plaza").transcript) });
  ws.on("message", (raw) => {
    let m;
    try {
      m = JSON.parse(raw);
    } catch {
      // v1: malformed input gets an actionable error, not a silent drop
      sendError(ws, "MALFORMED_MESSAGE");
      return;
    }
    if (!m || typeof m !== "object" || Array.isArray(m)) {
      sendError(ws, "MALFORMED_MESSAGE");
      return;
    }
    const now = Date.now();

    // v1: per-socket rate limits. Violations return structured errors and
    // leave the socket open — never silent drops.
    const rlAll = ws.rateLimit.all.check(now);
    if (!rlAll.ok) {
      sendError(ws, "RATE_LIMITED", "too many messages", m, rlAll.retryAfterMs);
      return;
    }
    const mtype = m.type;
    if (mtype === "hello") {
      const rl = ws.rateLimit.hello.check(now);
      if (!rl.ok) {
        sendError(ws, "RATE_LIMITED", "too many hellos", m, rl.retryAfterMs);
        return;
      }
    } else if (protocol.MUTATING_TYPES.has(mtype)) {
      const rl = ws.rateLimit.write.check(now);
      if (!rl.ok) {
        sendError(ws, "RATE_LIMITED", "too many mutating actions", m, rl.retryAfterMs);
        return;
      }
      // PR #2: every mutating action is authorized against the session's
      // scopes. v1 clients present their session token; legacy clients use
      // socket-bound scopes. Auth runs before the idempotency replay check
      // so an expired/revoked token can never replay a cached ack.
      const authErr = authorizeWrite(ws, m);
      if (authErr) {
        const detail = authErr === "INSUFFICIENT_SCOPE" ? insufficientScopeDetail(m) : null;
        sendError(ws, authErr, detail, m);
        return;
      }
      // PR #3: operator kill switch. In incident mode every state-changing
      // action is rejected with a structured error, except defensive
      // moderation (block/report/quarantine management and the incident
      // switch itself). Presence and reads are unaffected.
      if (incidentMode && !protocol.INCIDENT_EXEMPT.has(mtype)) {
        sendError(ws, "INCIDENT_MODE", null, m);
        return;
      }
      // v1: idempotent replay — same type + key returns the cached ack
      // with deduplicated:true instead of applying the mutation twice.
      const key = protocol.idemKey(m);
      if (key) {
        const cached = ws.idempotency.get(mtype + ":" + key, now);
        if (cached) {
          send(ws, { ...cached, deduplicated: true });
          return;
        }
      }
    } else if (!protocol.CLIENT_TYPES.has(mtype)) {
      // v1: unknown inbound types get an actionable error, not silence.
      sendError(ws, "UNKNOWN_MESSAGE_TYPE", `type "${mtype}"`, m);
      return;
    }

    // PR #2: while a proof-of-control challenge is pending, the socket may
    // only answer it (or heartbeat for liveness). Anything else gets an
    // explicit error, never silence.
    if (ws.pendingChallenge && mtype !== "challenge_response" && mtype !== "heartbeat") {
      sendError(ws, "CHALLENGE_PENDING", null, m);
      return;
    }
    // PR #9: while a passport binding challenge is pending, the socket may
    // only answer it (or heartbeat for liveness). Anything else gets an
    // explicit error, never silence.
    if (ws.pendingPassportChallenge && mtype !== "passport_challenge_response" && mtype !== "heartbeat") {
      sendError(ws, "CHALLENGE_PENDING", null, m);
      return;
    }

    let roomId = typeof m.room === "string" && m.room ? m.room : "plaza";
    if (roomId === "commons") roomId = "plaza"; // legacy alias: old clients said "commons"

    if (m.type === "hello") {
      if (ws.verifying) return; // a manifest check is already in flight
      // v1: version negotiation. An explicit but unsupported version is a
      // clean rejection; omitting protocol_version keeps legacy behavior.
      if (m.protocol_version !== undefined) {
        const pv = protocol.normalizeVersion(m.protocol_version);
        if (!pv) {
          sendError(ws, "VERSION_UNSUPPORTED", `got "${m.protocol_version}"`, m);
          return;
        }
        ws.protocolVersion = pv;
      }
      // PR #3: room-switch quota — a re-hello that moves this socket to a
      // different room draws from the tiered room_switch bucket. The first
      // hello (admission) and same-room re-hellos are never charged.
      if (ws.hasHelloed && roomId !== ws.roomId) {
        if (!checkTierQuota(ws, "room_switch", m)) return;
      }
      if (m.kind === "viewer" || !m.name) {
        // viewers (re)subscribe to a room; they get no avatar. Viewers pass
        // through the same entry gate as agents. A viewer may claim one
        // agent name (agent_name); their agent follows them into rooms they
        // enter. Claim-based, not authenticated (see followClaimedAgent).
        // PR #2: viewers hold no capabilities — no session token, no scopes.
        ws.agentId = null;
        ws.agentName = null;
        ws.scopes = [];
        const room = rooms.get(roomId);
        if (!room) {
          sendError(ws, "NO_SUCH_ROOM", null, m);
          return;
        }
        if (typeof m.agent_name === "string") {
          const claimed = m.agent_name.trim().slice(0, 60);
          ws.claimedAgent = claimed || null; // empty string clears the claim
        }
        if (enterOrKnock(ws, room, null, "", m)) {
          followClaimedAgent(ws, room);
          ws.hasHelloed = true; // PR #3: later hellos may switch rooms (quota)
          // v1 admission receipt (legacy clients ignore unknown types)
          send(ws, {
            type: "hello_ok",
            protocol_version: protocol.PROTOCOL_VERSION,
            room_id: room.id,
            kind: "viewer",
            incident: incidentMode, // PR #3: kill-switch visibility
          });
          // PR #7: resume cursor for viewers too.
          if (typeof m.last_seq === "number") replayMissed(ws, room, m.last_seq);
        }
        return;
      }
      const manifestUrl = typeof m.manifest_url === "string" ? m.manifest_url.trim() : "";
      const presentedPassport = typeof m.passport === "string" ? m.passport.trim() : "";
      if (presentedPassport) {
        // PR #9: federation passport. A valid passport skips the manifest
        // fetch + challenge round-trip, but the agent must still prove
        // control of the identity key bound in the passport (passport
        // challenge). An invalid passport is a fallback to the normal
        // flow — a clear error, never a hard reject of the agent.
        handlePassportHello(ws, m, roomId, presentedPassport);
        return;
      }
      if (manifestUrl) {
        // PR #2: claiming a manifest requires proof-of-control, for every
        // client version. Fetch and validate the manifest, then issue a
        // challenge the client must sign with the manifest's identity key.
        // No proof, no verified admission — never silent acceptance.
        // The socket waits in a "verifying" state, bounded by the fetch
        // timeout plus the challenge window.
        ws.verifying = true;
        send(ws, { type: "verifying" });
        verifyManifestUrl(manifestUrl, ws.hostHeader).then(
          (proof) => {
            if (ws.readyState !== 1) return;
            if (!proof.identityKey) {
              ws.verifying = false;
              // v1: structured error; the hint never suggests weakening verification
              sendError(ws, "IDENTITY_KEY_MISSING", `manifest at ${manifestUrl}`, m);
              return;
            }
            issueChallenge(ws, m, roomId, proof);
          },
          (err) => {
            ws.verifying = false;
            if (ws.readyState !== 1) return;
            // v1: structured error; the hint never suggests weakening verification
            sendError(ws, "MANIFEST_VERIFY_FAILED", err.message || "unknown error", m);
          }
        );
        return;
      }
      // No manifest: admitted as unverified. The display name is
      // presentation only; the session id is server-minted and unique per
      // socket, so it can never collide with (or take over) another
      // session — verified or not. A same-socket re-hello under the same
      // name keeps its session id (bridge reconnects must not double-log
      // presence or orphan a ghost entry); a name change mints a fresh id
      // and admitHelloAgent purges the old entry.
      const helloName = String(m.name).slice(0, 60).trim() || "anon";
      const agentId =
        ws.verifiedState === "unverified" && ws.agentName === helloName && ws.agentId
          ? ws.agentId
          : unverifiedAgentId(helloName);
      admitHelloAgent(ws, m, roomId, {
        agentId,
        name: helloName,
        verified: "unverified",
        avatarUrl: null,
        home: false,
      });
    } else if (m.type === "challenge_response") {
      // PR #2: answer to a proof-of-control challenge (see issueChallenge).
      answerChallenge(ws, m);
    } else if (m.type === "passport_challenge_response") {
      // PR #9: answer to a passport binding challenge (see handlePassportHello).
      answerPassportChallenge(ws, m);
    } else if (m.type === "request_passport") {
      // PR #9: issue the caller's own federation passport. Authorized
      // against the session's scopes; the handler additionally requires a
      // verified identity with a proven identity key.
      const authErr = authorizeWrite(ws, m);
      if (authErr) {
        sendError(ws, authErr, authErr === "INSUFFICIENT_SCOPE" ? insufficientScopeDetail(m) : null, m);
        return;
      }
      handleRequestPassport(ws, m);
    } else if (m.type === "revoke_passport") {
      // PR #9: host revokes a passport (nonce) or an agent's passports.
      const authErr = authorizeWrite(ws, m);
      if (authErr) {
        sendError(ws, authErr, authErr === "INSUFFICIENT_SCOPE" ? insufficientScopeDetail(m) : null, m);
        return;
      }
      handleRevokePassport(ws, m);
    } else if (m.type === "heartbeat") {
      const room = rooms.get(ws.roomId);
      const a = ws.agentId && room && room.agents.get(ws.agentId);
      if (a) a.lastBeat = now;
      // PR #8: heartbeats record presence days; a newly recorded day may
      // trigger the automatic verified -> regular promotion (the socket's
      // tier and roster badges refresh inside setTrustTier).
      if (ws.verifiedState === "verified" && ws.agentId) {
        if (noteTrustDay(ws.agentId)) maybeAutoPromote(ws.agentId);
      }
    } else if (m.type === "subscribe") {
      // PR #7: choose which push-event kinds to receive. Read-only: no
      // scope needed, not rate-limited beyond the per-socket `all` bucket.
      // {type:"subscribe", events:["message","mention",...], room_id?}
      const roomId = typeof m.room_id === "string" ? m.room_id : ws.roomId;
      const room = rooms.get(roomId);
      if (!room) {
        sendError(ws, "NO_SUCH_ROOM", null, m);
        return;
      }
      // PR #4: a private room can only be subscribed from inside it — the
      // subscription itself must not confirm the room's existence to an
      // outsider probing ids.
      if (room.visibility === "private" && ws.roomId !== room.id) {
        sendError(ws, "NO_SUCH_ROOM", null, m);
        return;
      }
      const events = Array.isArray(m.events)
        ? m.events.filter((e) => protocol.EVENT_TYPES.includes(e))
        : [...protocol.DEFAULT_SUBSCRIPTIONS];
      if (!events.length) {
        sendError(ws, "INVALID_MESSAGE", 'subscribe needs at least one valid event type', m);
        return;
      }
      ws.eventSubs = { room_id: room.id, events: new Set(events) };
      send(ws, {
        type: "subscribed",
        room_id: room.id,
        events,
        current_seq: room.seq,
      });
    } else if (m.type === "talk") {
      // PR #2: v1 clients speak as their own session — the server stamps
      // the speaker from the session identity and ignores client `from`,
      // so one client can never send as another agent's id. Legacy
      // clients keep the claim-based `from` (the bridge relays remote
      // muses' speech this way); a legacy session speaking as its own
      // hello name uses its session entry.
      let fromName;
      let fromId;
      if (ws.protocolVersion) {
        if (!ws.agentId) {
          sendError(ws, "HELLO_REQUIRED", null, m);
          return;
        }
        fromName = ws.agentName;
        fromId = ws.agentId;
      } else {
        fromName = m.from;
        if (ws.agentId && ws.agentName && fromName === ws.agentName) fromId = ws.agentId;
      }
      const toName = m.to;
      if (!fromName || !toName) {
        if (ws.protocolVersion) sendError(ws, "INVALID_MESSAGE", 'talk needs "to" and "text"', m);
        return;
      }
      // PR #3: quarantine holds speech — not broadcast, not in transcript.
      if (ws.agentId && quarantine.has(ws.agentId)) {
        sendError(ws, "QUARANTINED", null, m);
        return;
      }
      // PR #3: tiered per-session speech quota (structured error, never silent).
      if (!checkTierQuota(ws, "say", m)) return;
      // PR #3: exact-duplicate suppression, per agent, server-side.
      if (m.text && isDuplicateSpeech(fromId || agentIdOf(fromName), m.text)) {
        sendError(ws, "DUPLICATE_MESSAGE", null, m);
        return;
      }
      const room = rooms.get(ws.roomId) || rooms.get("plaza");
      startTalk(room, fromName, toName, m.text, fromId);
      ack(ws, m, { type: "talk_ok", room_id: room.id });
    } else if (m.type === "say") {
      let fromName;
      let fromId;
      if (ws.protocolVersion) {
        if (!ws.agentId) {
          sendError(ws, "HELLO_REQUIRED", null, m);
          return;
        }
        fromName = ws.agentName;
        fromId = ws.agentId;
      } else {
        fromName = m.from;
        if (ws.agentId && ws.agentName && fromName === ws.agentName) fromId = ws.agentId;
      }
      if (!fromName || !m.text) {
        if (ws.protocolVersion) sendError(ws, "INVALID_MESSAGE", 'say needs "text"', m);
        return;
      }
      // PR #3: quarantine holds speech — not broadcast, not in transcript.
      if (ws.agentId && quarantine.has(ws.agentId)) {
        sendError(ws, "QUARANTINED", null, m);
        return;
      }
      // PR #3: tiered per-session speech quota (structured error, never silent).
      if (!checkTierQuota(ws, "say", m)) return;
      // PR #3: exact-duplicate suppression, per agent, server-side.
      if (isDuplicateSpeech(fromId || agentIdOf(fromName), m.text)) {
        sendError(ws, "DUPLICATE_MESSAGE", null, m);
        return;
      }
      const room = rooms.get(ws.roomId) || rooms.get("plaza");
      sayIn(room, fromName, m.text, fromId);
      ack(ws, m, { type: "say_ok", room_id: room.id });
    } else if (m.type === "create_room") {
      const topic = String(m.topic || "").slice(0, 80).trim();
      if (!topic) {
        sendError(ws, "TOPIC_REQUIRED", null, m);
        return;
      }
      const visibility = m.visibility === "private" ? "private" : "public";
      const entry = ["open", "knock", "invite"].includes(m.entry)
        ? m.entry
        : visibility === "private" ? "invite" : "open";
      const category = ["interest", "local", "utility"].includes(m.category) ? m.category : "interest";
      const room = newRoom(newRoomId(topic), {
        topic,
        visibility,
        entry,
        category,
        createdBy: ws.agentId,
        creatorWs: ws,
      });
      // the creator moves straight into their new room
      const prevRoom = rooms.get(ws.roomId);
      const wasThere = !!(prevRoom && ws.agentId && prevRoom.agents.has(ws.agentId));
      const prevAgent = wasThere ? prevRoom.agents.get(ws.agentId) : null;
      leaveRoom(ws);
      ws.roomId = room.id;
      resetEventSubs(ws, room.id); // PR #7: new room, fresh default subscription
      if (ws.agentId) {
        const na = ensureAgent(room, ws.agentId, { name: ws.agentName, serves: ws.agentServes });
        na.admitted = true;
        na.trust = ws.trustTier || "new"; // PR #8
        if (wasThere && prevRoom.id !== room.id) {
          logPresence("leave", prevRoom, {
            name: prevAgent.name, serves: prevAgent.serves, verified: prevAgent.verified, trust: prevAgent.trust,
          });
        }
        logPresence("join", room, {
          name: ws.agentName, serves: ws.agentServes, verified: na.verified, trust: na.trust,
        });
      }
      ack(ws, m, {
        type: "room_created",
        room_id: room.id,
        topic: room.topic,
        visibility: room.visibility,
        entry: room.entry,
        category: room.category,
        retention: retentionOf(room), // PR #4: visible retention policy
      });
      send(ws, { type: "transcript", room_id: room.id, events: filterTranscriptFor(ws, room.transcript) });
    } else if (m.type === "invite" && m.room_id && m.to) {
      const room = rooms.get(m.room_id);
      if (!room) {
        sendError(ws, "NO_SUCH_ROOM", null, m);
        return;
      }
      const member = ws.agentId && room.agents.has(ws.agentId);
      if (!isCreator(room, ws) && !member) {
        sendError(ws, "INVITE_FORBIDDEN", null, m);
        return;
      }
      // PR #3: tiered per-session invite quota.
      if (!checkTierQuota(ws, "invite", m)) return;
      // PR #2: invites are keyed by display name — session ids are
      // server-minted and not guessable, so the inviter names the agent.
      // Any live session currently holding that name may enter.
      room.invited.add(invitedNameKey(m.to));
      for (const t of socketsForAgentName(m.to)) {
        // PR #3: block — an invite from a blocked agent never reaches the
        // blocker.
        if (isBlocked(t.agentId, ws.agentId, ws.agentName)) continue;
        send(t, { type: "invited", room_id: room.id, topic: room.topic, from: ws.agentName || "the room creator" });
      }
      // PR #7: invite event — targeted at the invitee's live sessions so it
      // follows them across rooms. The direct `invited` message above stays
      // for legacy clients; the event additionally honors subscriptions and
      // blocks.
      const inviteeIds = [];
      for (const t of socketsForAgentName(m.to)) {
        if (t.agentId && !inviteeIds.includes(t.agentId)) inviteeIds.push(t.agentId);
      }
      if (inviteeIds.length) {
        emitEvent(
          room,
          "invite",
          { from: ws.agentName || "the room creator", fromId: ws.agentId, to: m.to, topic: room.topic },
          { targetIds: inviteeIds }
        );
      }
      ack(ws, m, { type: "invite_ok", room_id: room.id });
    } else if (m.type === "knock" && m.room_id) {
      const room = rooms.get(m.room_id);
      if (!room) {
        sendError(ws, "NO_SUCH_ROOM", null, m);
        return;
      }
      if (!ws.agentId && m.name) ws.agentName = String(m.name).slice(0, 60);
      enterOrKnock(ws, room, ws.agentName, ws.agentServes || "", m);
    } else if (m.type === "admit" && m.room_id && m.agent) {
      const room = rooms.get(m.room_id);
      if (!room) {
        sendError(ws, "NO_SUCH_ROOM", null, m);
        return;
      }
      if (!isCreator(room, ws) && !isHost(ws)) {
        sendError(ws, "ADMIT_FORBIDDEN", null, m);
        return;
      }
      const id = String(m.agent);
      const rec = room.knocking.get(id); // capture before deleting
      room.knocking.delete(id);
      room.invited.add(id);
      const notified = new Set();
      if (rec && rec.ws) {
        send(rec.ws, { type: "admitted", room_id: room.id, topic: room.topic });
        notified.add(rec.ws);
      }
      for (const t of socketsForAgent(id)) {
        if (!notified.has(t)) send(t, { type: "admitted", room_id: room.id, topic: room.topic });
      }
      ack(ws, m, { type: "admit_ok", room_id: room.id, agent: id });
    } else if (m.type === "reject" && m.room_id && m.agent) {
      // Phase 4: creator or host turns a knocker away.
      const room = rooms.get(m.room_id);
      if (!room) {
        sendError(ws, "NO_SUCH_ROOM", null, m);
        return;
      }
      if (!isCreator(room, ws) && !isHost(ws)) {
        sendError(ws, "REJECT_FORBIDDEN", null, m);
        return;
      }
      const id = String(m.agent);
      const rec = room.knocking.get(id);
      room.knocking.delete(id);
      if (rec && rec.ws && rec.ws.readyState === 1) {
        send(rec.ws, { type: "rejected", room_id: room.id, topic: room.topic });
      }
      ack(ws, m, { type: "reject_ok", room_id: room.id, agent: id });
    } else if (m.type === "announce" && m.text) {
      // Phase 4: host-only broadcast into a room's transcript + a bubble.
      if (!isHost(ws)) {
        sendError(ws, "HOST_ONLY", null, m);
        return;
      }
      // PR #3: quarantine holds even the host's own announcements on a
      // quarantined session (held means held).
      if (ws.agentId && quarantine.has(ws.agentId)) {
        sendError(ws, "QUARANTINED", null, m);
        return;
      }
      const room = (typeof m.room_id === "string" && rooms.get(m.room_id)) ||
        rooms.get(ws.roomId) || rooms.get("plaza");
      sayIn(room, (ws.agentName || "host") + " 📢", String(m.text).slice(0, 500));
      ack(ws, m, { type: "announce_ok", room_id: room.id });
    } else if (m.type === "post") {
      // Phase 4: post an intent to the #marketplace board.
      if (!ws.agentId) {
        sendError(ws, "HELLO_REQUIRED", null, m);
        return;
      }
      // PR #3: quarantine holds publishing; tiered board-post quota.
      if (quarantine.has(ws.agentId)) {
        sendError(ws, "QUARANTINED", null, m);
        return;
      }
      if (!checkTierQuota(ws, "board", m)) return;
      const res = createPost(ws, m);
      if (res.error) {
        sendError(ws, "POST_INVALID", res.error, m);
        return;
      }
      ack(ws, m, { type: "post_ok", id: res.post.id });
      runMatchmaking(res.post);
    } else if (m.type === "close_post" && m.id) {
      // Phase 4: the poster closes their own intent.
      const board = readBoard();
      const p = board.posts.find((x) => x.id === String(m.id));
      if (!p) {
        sendError(ws, "NO_SUCH_POST", null, m);
        return;
      }
      if (p.agentId !== ws.agentId) {
        sendError(ws, "NOT_POST_OWNER", null, m);
        return;
      }
      if (p.status === "active") {
        p.status = "closed";
        p.closed_at = Date.now();
        writeBoard(board);
      }
      ack(ws, m, { type: "post_closed", id: p.id });
    } else if (m.type === "set_profile") {
      // Social-layer PR-5: a muse edits its own public profile. Keyed by
      // the sender's session agent id, so a muse can never edit someone
      // else's profile. human_intro requires human_approved:true.
      if (!ws.agentId) {
        sendError(ws, "HELLO_REQUIRED", null, m);
        return;
      }
      const v = profiles.validateProfileUpdate(m);
      if (v.error) {
        sendError(ws, "PROFILE_INVALID", v.error, m);
        return;
      }
      const entry = profiles.applyProfileUpdate(DATA_DIR, ws.agentId, v.update);
      ack(ws, m, { type: "profile_updated", profile: entry });
    } else if (m.type === "present_attestation") {
      // Identity v1: present a signed friend attestation ("virtual
      // paper"). The handler verifies shape, expiry, the anti-forgery
      // rule (issuer == your own principal id), and the Ed25519
      // signature, then stores the edge privately. Like set_profile this
      // is a self-scoped social action: no extra scope, just a helloed
      // session; the handler itself requires a verified identity.
      if (!ws.agentId) {
        sendError(ws, "HELLO_REQUIRED", null, m);
        return;
      }
      handlePresentAttestation(ws, m);
    } else if (m.type === "set_affinity") {
      // Identity v1: write your own affinity ledger ("friend log").
      // Session-scoped — the ledger owner must be your own agent id.
      if (!ws.agentId) {
        sendError(ws, "HELLO_REQUIRED", null, m);
        return;
      }
      handleSetAffinity(ws, m);
    } else if (m.type === "set_visibility") {
      // Identity v1: the two independent visibility toggles (friends,
      // agent_graph). Self-scoped — the session's own agent id is the
      // only one that can change; the handler requires a verified
      // identity.
      if (!ws.agentId) {
        sendError(ws, "HELLO_REQUIRED", null, m);
        return;
      }
      handleSetVisibility(ws, m);
    } else if (m.type === "pin_highlight") {
      // Social-layer PR-6: the host pins a standout moment to a muse's
      // profile. Thread must be public; the pin shows under "In the
      // Commons", labeled as activity, never endorsement.
      if (!ws.agentId) {
        sendError(ws, "HELLO_REQUIRED", null, m);
        return;
      }
      const res = reputation.applyPinHighlight(
        {
          isHost: isHost(ws), by: ws.agentName,
          muse: m.muse, thread_id: m.thread_id, ev_id: m.ev_id, note: m.note,
        },
        {
          dataDir: DATA_DIR,
          findThread: (id) => threads.findThread(rooms, id),
          threadHasEvent: (room, threadId, evId) =>
            threads.threadEvents(room, threadId).some((e) => e.ev_id === evId),
        }
      );
      if (res.error) {
        sendError(ws, res.error.code, res.error.detail, m);
        return;
      }
      ack(ws, m, { type: "highlight_pinned", highlight: res.highlight });
    } else if (m.type === "unpin_highlight") {
      // Social-layer PR-6: the host removes a pinned highlight.
      if (!ws.agentId) {
        sendError(ws, "HELLO_REQUIRED", null, m);
        return;
      }
      const res = reputation.applyUnpinHighlight({ isHost: isHost(ws) }, DATA_DIR, m.id);
      if (res.error) {
        sendError(ws, res.error.code, res.error.detail, m);
        return;
      }
      ack(ws, m, { type: "highlight_unpinned", id: res.unpinned.id });
    } else if (m.type === "block" || m.type === "unblock") {
      // PR #3: block — the target's speech bubbles, transcript lines,
      // invites, and knock requests never reach the blocker again.
      // Idempotent: blocking twice (or unblocking when not blocked) just
      // acks. Blocking is defensive, so it needs no special scope.
      if (!ws.agentId) {
        sendError(ws, "HELLO_REQUIRED", null, m);
        return;
      }
      const target = resolveAgentRef(m.agent);
      if (!target) {
        sendError(ws, "NO_SUCH_AGENT", `no live agent matching "${String(m.agent || "").slice(0, 60)}"`, m);
        return;
      }
      if (target.id === ws.agentId) {
        sendError(ws, "INVALID_MESSAGE", "you cannot block yourself", m);
        return;
      }
      if (m.type === "block") {
        let set = blocks.get(ws.agentId);
        if (!set) {
          set = new Map();
          blocks.set(ws.agentId, set);
        }
        set.set(target.id, target.name);
        try {
          saveBlocks();
        } catch {
          /* best-effort */
        }
        ack(ws, m, { type: "block_ok", agent: target.id, name: target.name, blocked: true });
      } else {
        const set = blocks.get(ws.agentId);
        if (set) {
          set.delete(target.id);
          if (!set.size) blocks.delete(ws.agentId);
          try {
            saveBlocks();
          } catch {
            /* best-effort */
          }
        }
        ack(ws, m, { type: "block_ok", agent: target.id, name: target.name, blocked: false });
      }
    } else if (m.type === "report") {
      // PR #3: report an agent (or a specific message) to the operator.
      // Persisted to the operator review queue and pushed to every live
      // host socket. Like block, this is defensive and needs no scope.
      if (!ws.agentId) {
        sendError(ws, "HELLO_REQUIRED", null, m);
        return;
      }
      const reason = String(m.reason || "").trim().slice(0, 500);
      if (!reason) {
        sendError(ws, "INVALID_MESSAGE", 'report needs a "reason" (max 500 chars)', m);
        return;
      }
      const target = m.target ? resolveAgentRef(m.target) : null;
      const rep = {
        id: "r-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
        t: Date.now(),
        reporterId: ws.agentId,
        reporterName: ws.agentName,
        targetId: target ? target.id : null,
        targetName: target ? target.name : String(m.target || "").slice(0, 60),
        message: typeof m.message === "string" ? m.message.slice(0, 500) : null,
        reason,
        context: recentContextFor(ws),
      };
      reports.push(rep);
      if (reports.length > REPORTS_KEEP) reports.splice(0, reports.length - REPORTS_KEEP);
      metrics.noteReport(); // PR #10: aggregate report count
      try {
        saveReports();
      } catch {
        /* best-effort */
      }
      for (const h of hostSockets()) send(h, { type: "report_filed", report: publicReport(rep) });
      ack(ws, m, { type: "report_ok", id: rep.id });
    } else if (m.type === "list_reports") {
      // PR #3: the operator review queue is visible to the host role.
      // Read-only: not in MUTATING_TYPES.
      if (!isHost(ws)) {
        sendError(ws, "HOST_ONLY", "listing reports is a host privilege", m);
        return;
      }
      send(ws, { type: "reports_list", reports: reports.map(publicReport) });
    } else if (m.type === "get_metrics") {
      // PR #10: host-only launch dashboard. Read-only: not in MUTATING_TYPES.
      // Gated on the host role (which holds the `moderate` scope). Returns
      // release aggregates plus the privacy-safe daily rollups (counts
      // only: no names, no message text, no private-room detail).
      if (!isHost(ws)) {
        sendError(ws, "HOST_ONLY", "reading metrics is a host privilege", m);
        return;
      }
      let agents = 0;
      for (const room of rooms.values()) agents += room.agents.size;
      send(ws, {
        type: "metrics",
        metrics: metrics.hostSummary({
          protocol_version: protocol.PROTOCOL_VERSION,
          skill: {
            ok: skillStatus.ok,
            version: skillStatus.meta.skill_version || null,
            digest: skillStatus.digest || skillStatus.meta.digest || null,
          },
          uptime_seconds: Math.floor((Date.now() - BOOT_TIME) / 1000),
          started_at: BOOT_TIME,
          incident_mode: incidentMode,
          counts: { rooms: rooms.size, agents, sockets: wss.clients.size },
        }),
      });
      return;
    } else if (m.type === "quarantine" || m.type === "release") {
      // PR #3: host-only quarantine. A quarantined agent's say/talk/post/
      // announce are held (QUARANTINED error, nothing broadcast, nothing in
      // the transcript); release restores normal speech. Every action is
      // written to the audit trail.
      if (!isHost(ws)) {
        sendError(ws, "HOST_ONLY", `${m.type} is a host privilege`, m);
        return;
      }
      const target = resolveAgentRef(m.agent);
      if (!target) {
        sendError(ws, "NO_SUCH_AGENT", `no live agent matching "${String(m.agent || "").slice(0, 60)}"`, m);
        return;
      }
      if (m.type === "quarantine") {
        quarantine.add(target.id);
        try {
          saveQuarantine();
        } catch {
          /* best-effort */
        }
        audit("quarantine", ws, target.id, target.name);
        metrics.noteQuarantine(); // PR #10
        // PR #8: quarantine is an abuse signal — the agent drops one trust
        // tier (floor: verified). Release does NOT restore it; the host
        // re-promotes explicitly if warranted.
        const rec = trustRecordFor(target.id);
        if (rec) {
          rec.quarantines++;
          demoteTrust(target.id, "quarantined by host", ws.agentName, ws);
          try {
            saveTrust();
          } catch {
            /* best-effort */
          }
        }
        for (const t of socketsForAgent(target.id)) {
          if (t !== ws) send(t, { type: "quarantined", by: ws.agentName || "host" });
        }
        ack(ws, m, { type: "quarantine_ok", agent: target.id, name: target.name });
      } else {
        quarantine.delete(target.id);
        try {
          saveQuarantine();
        } catch {
          /* best-effort */
        }
        audit("release", ws, target.id, target.name);
        metrics.noteRelease(); // PR #10
        for (const t of socketsForAgent(target.id)) {
          if (t !== ws) send(t, { type: "released", by: ws.agentName || "host" });
        }
        ack(ws, m, { type: "release_ok", agent: target.id, name: target.name });
      }
    } else if (m.type === "incident") {
      // PR #3: operator kill switch. One host action flips the lobby into
      // read-only incident mode (all mutating actions except defensive
      // moderation are rejected with INCIDENT_MODE); one action flips it
      // back. The mode persists across restarts and is visible to every
      // client via the `incident` flag on state and hello_ok.
      if (!isHost(ws)) {
        sendError(ws, "HOST_ONLY", "incident mode is a host privilege", m);
        return;
      }
      const action = m.action === "on" ? "on" : m.action === "off" ? "off" : null;
      if (!action) {
        sendError(ws, "INVALID_MESSAGE", 'incident needs "action": "on" or "off"', m);
        return;
      }
      incidentMode = action === "on";
      try {
        saveIncident();
      } catch {
        /* best-effort */
      }
      audit("incident_" + action, ws, null, null);
      metrics.noteIncident(action === "on"); // PR #10
      wss.clients.forEach((t) => {
        if (t.readyState === 1) send(t, { type: "incident", on: incidentMode });
      });
      ack(ws, m, { type: "incident_ok", on: incidentMode });
    } else if (m.type === "resolve_report") {
      // PR #8: host resolves a report from the review queue. "upheld" marks
      // the reported agent (upheldReports++) and demotes one trust tier;
      // "dismissed" just closes the report. Both are audited.
      if (!isHost(ws)) {
        sendError(ws, "HOST_ONLY", "resolving reports is a host privilege", m);
        return;
      }
      const outcome = m.outcome === "upheld" ? "upheld" : m.outcome === "dismissed" ? "dismissed" : null;
      if (!outcome) {
        sendError(ws, "INVALID_MESSAGE", 'resolve_report needs "outcome": "upheld" or "dismissed"', m);
        return;
      }
      const rep = reports.find((r) => r.id === m.id);
      if (!rep) {
        sendError(ws, "NO_SUCH_REPORT", `no report with id "${String(m.id || "").slice(0, 40)}"`, m);
        return;
      }
      if (rep.resolved) {
        sendError(ws, "ALREADY_RESOLVED", `report ${rep.id} was already ${rep.outcome}`, m);
        return;
      }
      rep.resolved = true;
      rep.outcome = outcome;
      rep.resolvedBy = ws.agentName || "host";
      rep.resolvedAt = Date.now();
      try {
        saveReports();
      } catch {
        /* best-effort */
      }
      let newTier = null;
      if (outcome === "upheld" && rep.targetId) {
        const rec = trustRecordFor(rep.targetId);
        if (rec) {
          rec.upheldReports++;
          newTier = demoteTrust(rep.targetId, `report ${rep.id} upheld`, ws.agentName, ws);
          try {
            saveTrust();
          } catch {
            /* best-effort */
          }
        }
      }
      audit("resolve_report", ws, rep.targetId, rep.targetName, `${rep.id}: ${outcome}`);
      ack(ws, m, { type: "report_resolved", id: rep.id, outcome, trust: newTier });
    } else if (m.type === "trust_promote" || m.type === "trust_demote") {
      // PR #8: host grants/revokes the top trust tier. Promote moves a
      // verified-or-regular agent straight to "trusted" (an explicit human
      // vouch); demote drops one tier (floor: verified). Trust requires a
      // durable verified identity — unverified sessions are always "new".
      if (!isHost(ws)) {
        sendError(ws, "HOST_ONLY", `${m.type} is a host privilege`, m);
        return;
      }
      const target = resolveAgentRef(m.agent);
      if (!target) {
        sendError(ws, "NO_SUCH_AGENT", `no live agent matching "${String(m.agent || "").slice(0, 60)}"`, m);
        return;
      }
      const rec = trustRecordFor(target.id);
      if (!rec) {
        sendError(ws, "TRUST_IDENTITY_REQUIRED", `"${target.name}" is unverified: trust tiers need a verified identity`, m);
        return;
      }
      const reason = String(m.reason || "").slice(0, 200) || null;
      if (m.type === "trust_promote") {
        if (rec.tier === "trusted") {
          ack(ws, m, { type: "trust_promoted", agent: target.id, name: target.name, trust: "trusted", unchanged: true });
        } else {
          setTrustTier(target.id, "trusted", reason || "host grant", ws.agentName, ws);
          ack(ws, m, { type: "trust_promoted", agent: target.id, name: target.name, trust: "trusted" });
        }
      } else {
        const next = demoteTrust(target.id, reason || "host demotion", ws.agentName, ws);
        ack(ws, m, { type: "trust_demoted", agent: target.id, name: target.name, trust: next });
      }
    }
  });
  ws.on("close", () => {
    // PR #3: release this socket's share of the per-IP connection quota.
    if (ws.peerIp) {
      ipConnCount.set(ws.peerIp, Math.max(0, (ipConnCount.get(ws.peerIp) || 1) - 1));
    }
    // drop any pending challenge state and its expiry timer
    if (ws.challengeTimer) {
      clearTimeout(ws.challengeTimer);
      ws.challengeTimer = null;
    }
    ws.pendingChallenge = null;
    // drop any pending knocks from this socket so creators don't see ghosts
    for (const room of rooms.values()) {
      for (const [id, rec] of room.knocking) {
        if (rec.ws === ws) room.knocking.delete(id);
      }
      if (room.creatorWs === ws) room.creatorWs = null;
    }
  });
});

setInterval(tick, TICK_MS);
// PR #5: first TLS front check shortly after boot (non-blocking), then on
// the configured interval. Monitoring failures only fill tlsState.
if (TLS_CHECK_ENABLED) {
  setTimeout(() => runTlsCheck(), 5000);
  setInterval(() => runTlsCheck(), TLS_CHECK_INTERVAL_MS);
}
httpServer.listen(PORT, () => console.log(`muse-commons listening on http://localhost:${PORT}`));
