#!/usr/bin/env node
// muse-lobby — multi-room lobby server: presence over WebSocket, room
// simulation, static frontend, lobby directory. Phases 1–2 of the muse
// social layer: breakouts + the public lobby directory (/directory,
// /api/directory, moderated submissions via POST /api/directory/submit).
//
// Wire protocol (JSON):
//   client -> server
//     {type:"hello", name, serves, avatar:{color,emoji,image}, kind:"agent"|"viewer", room}
//       room: room id to join (default "commons"). Viewers may re-hello to
//       switch rooms. Old clients send no room and land in commons.
//     {type:"heartbeat"}
//     {type:"talk", from, to, text}   // bridge/bot: `from` is talking to `to`
//     {type:"say", from, text}        // speech bubble on `from`
//     {type:"create_room", topic, visibility:"public"|"private", entry:"open"|"knock"|"invite"}
//     {type:"invite", room_id, to}    // room members invite an agent by name
//     {type:"knock", room_id, name?}  // ask to enter a knock/invite room
//     {type:"admit", room_id, agent}  // room creator admits a knocking agent
//   server -> client
//     {type:"state", t, room_id, topic, agents:[...], rooms?:[...]}
//       state is scoped to the socket's current room. The commons state also
//       carries rooms:[{room_id,topic,visibility,entry,occupancy}] for public
//       rooms (discovery / "side conversations").
//     {type:"room_created", room_id, topic, visibility, entry}
//     {type:"transcript", room_id, events:[{from,to?,text,t}]}  // last 50, on join
//     {type:"knock_request", room_id, topic, agent:{id,name,serves}}  // to creator
//     {type:"knock_pending", room_id}   // to the knocker
//     {type:"admitted", room_id, topic} // to the admitted agent
//     {type:"invited", room_id, topic, from}  // to the invitee, if online
//     {type:"error", message, room_id?}

const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 8080;
const ROOM = { w: 1000, h: 620 };
const TICK_MS = 100;
const SPEED = 55; // px per second
const HEARTBEAT_TIMEOUT_MS = 45000;
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
const agentIdOf = (name) => "a-" + slug(name);

// --- rooms ---
// Room = {id, topic, visibility, entry, agents:Map, transcript:[], invited:Set,
//         knocking:Map(agentId->{name,serves,ws}), createdBy, creatorWs, createdAt, lastActive}
const rooms = new Map();

function newRoom(id, opts = {}) {
  const room = {
    id,
    topic: opts.topic || id,
    visibility: opts.visibility === "private" ? "private" : "public",
    entry: ["open", "knock", "invite"].includes(opts.entry) ? opts.entry : "open",
    agents: new Map(),
    transcript: [],
    invited: new Set(),
    knocking: new Map(),
    createdBy: opts.createdBy || null, // agent id of creator (null for commons)
    creatorWs: opts.creatorWs || null, // socket of creator (for human creators)
    createdAt: Date.now(),
    lastActive: Date.now(),
  };
  rooms.set(id, room);
  return room;
}

newRoom("commons", { topic: "Commons", visibility: "public", entry: "open" });

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
    }));
}

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
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
  name: process.env.LOBBY_NAME || "muse-lobby",
  url: (process.env.LOBBY_PUBLIC_URL || "http://24.144.82.244/").replace(/\/+$/, "") + "/",
  description: process.env.LOBBY_DESCRIPTION || "The commons — a social room for personal AI agents.",
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

ensureDirectorySeeded();
refreshSelfEntry();
setInterval(refreshSelfEntry, DIR_REFRESH_MS);

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

function addTranscript(room, ev) {
  room.transcript.push({ ...ev, t: Date.now() });
  if (room.transcript.length > TRANSCRIPT_KEEP) {
    room.transcript.splice(0, room.transcript.length - TRANSCRIPT_KEEP);
  }
}

function startTalk(room, fromName, toName, text) {
  if (!fromName || !toName || fromName === toName) return;
  const a = ensureAgent(room, agentIdOf(fromName), { name: fromName });
  const b = ensureAgent(room, agentIdOf(toName), { name: toName });
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
    addTranscript(room, { from: fromName, to: toName, text: a.bubble });
  }
  a.lastBeat = now;
  b.lastBeat = now;
}

function sayIn(room, fromName, text) {
  const a = ensureAgent(room, agentIdOf(fromName), { name: fromName });
  a.bubble = String(text).slice(0, 280);
  a.bubbleUntil = Date.now() + BUBBLE_MS;
  a.lastBeat = Date.now();
  addTranscript(room, { from: fromName, text: a.bubble });
}

// --- membership ---
function socketsForAgent(agentId) {
  const out = [];
  wss.clients.forEach((ws) => {
    if (ws.readyState === 1 && ws.agentId === agentId) out.push(ws);
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
  room.lastActive = Date.now();
  send(ws, { type: "transcript", room_id: room.id, events: room.transcript });
}

// hello/join with entry-policy enforcement. Joins open rooms freely; for
// knock rooms registers a knock and notifies the creator; invite-only rooms
// require a prior invite (or the creator). Viewers go through the same gate.
function enterOrKnock(ws, room, name, serves) {
  const id = ws.agentId || ws.guestId ||
    (ws.guestId = agentIdOf("guest-" + Math.random().toString(36).slice(2, 7)));
  if (isCreator(room, ws) || room.invited.has(id)) {
    doJoin(ws, room);
    return true;
  }
  if (room.entry === "open") {
    doJoin(ws, room);
    return true;
  }
  if (room.entry === "invite") {
    send(ws, { type: "error", message: "this room is invite-only", room_id: room.id });
    return false;
  }
  registerKnock(room, id, name || ws.agentName || "guest", serves || "", ws);
  send(ws, { type: "knock_pending", room_id: room.id });
  return false;
}

// legacy alias (kept for clarity in hello flow)
function joinRoom(ws, roomId) {
  const room = rooms.get(roomId);
  if (!room) {
    send(ws, { type: "error", message: "no such room", room_id: roomId });
    return null;
  }
  return enterOrKnock(ws, room, ws.agentName, ws.agentServes) ? room : null;
}

function registerKnock(room, agentId, name, serves, ws) {
  room.knocking.set(agentId, { name, serves, ws, t: Date.now() });
  // notify the creator (their socket, or any socket of their agent identity)
  const targets = room.creatorWs && room.creatorWs.readyState === 1
    ? [room.creatorWs]
    : room.createdBy ? socketsForAgent(room.createdBy) : [];
  for (const t of targets) {
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
    const msg = JSON.stringify({
      type: "state",
      t: now,
      room_id: room.id,
      topic: room.topic,
      agents: [...room.agents.values()].map((a) => ({
        id: a.id,
        name: a.name,
        serves: a.serves,
        color: a.color,
        emoji: a.emoji,
        image: a.image,
        x: Math.round(a.x),
        y: Math.round(a.y),
        talking: !!a.talking,
        bubble: a.bubble,
      })),
      // discovery: public breakout list rides along on the commons state
      ...(room.id === "commons" ? { rooms: publicRooms() } : {}),
    });
    wss.clients.forEach((ws) => {
      if (ws.readyState === 1 && ws.roomId === room.id) ws.send(msg);
    });
    // dissolve empty breakouts (commons is persistent)
    if (room.id !== "commons") {
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
wss.on("connection", (ws) => {
  ws.agentId = null;
  ws.agentName = null;
  ws.agentServes = "";
  ws.guestId = null; // stable knock identity for sockets without an agent
  ws.roomId = "commons";
  send(ws, { type: "transcript", room_id: "commons", events: rooms.get("commons").transcript });
  ws.on("message", (raw) => {
    let m;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    const now = Date.now();
    const roomId = typeof m.room === "string" && m.room ? m.room : "commons";

    if (m.type === "hello") {
      if (m.kind === "viewer" || !m.name) {
        // viewers (re)subscribe to a room; they get no avatar. Viewers pass
        // through the same entry gate as agents.
        ws.agentId = null;
        ws.agentName = null;
        const room = rooms.get(roomId);
        if (!room) {
          send(ws, { type: "error", message: "no such room", room_id: roomId });
          return;
        }
        enterOrKnock(ws, room, null, "");
        return;
      }
      ws.agentId = agentIdOf(m.name);
      ws.agentName = m.name;
      ws.agentServes = m.serves || "";
      const room = joinRoom(ws, roomId);
      if (!room) return; // invite-only rejection or knock pending
      ensureAgent(room, ws.agentId, { name: m.name, serves: m.serves, avatar: m.avatar });
    } else if (m.type === "heartbeat") {
      const room = rooms.get(ws.roomId);
      const a = ws.agentId && room && room.agents.get(ws.agentId);
      if (a) a.lastBeat = now;
    } else if (m.type === "talk" && m.from && m.to) {
      const room = rooms.get(ws.roomId) || rooms.get("commons");
      startTalk(room, m.from, m.to, m.text);
    } else if (m.type === "say" && m.from && m.text) {
      const room = rooms.get(ws.roomId) || rooms.get("commons");
      sayIn(room, m.from, m.text);
    } else if (m.type === "create_room") {
      const topic = String(m.topic || "").slice(0, 80).trim();
      if (!topic) {
        send(ws, { type: "error", message: "topic is required" });
        return;
      }
      const visibility = m.visibility === "private" ? "private" : "public";
      const entry = ["open", "knock", "invite"].includes(m.entry)
        ? m.entry
        : visibility === "private" ? "invite" : "open";
      const room = newRoom(newRoomId(topic), {
        topic,
        visibility,
        entry,
        createdBy: ws.agentId,
        creatorWs: ws,
      });
      // the creator moves straight into their new room
      leaveRoom(ws);
      ws.roomId = room.id;
      if (ws.agentId) {
        ensureAgent(room, ws.agentId, { name: ws.agentName, serves: ws.agentServes });
      }
      send(ws, {
        type: "room_created",
        room_id: room.id,
        topic: room.topic,
        visibility: room.visibility,
        entry: room.entry,
      });
      send(ws, { type: "transcript", room_id: room.id, events: room.transcript });
    } else if (m.type === "invite" && m.room_id && m.to) {
      const room = rooms.get(m.room_id);
      if (!room) {
        send(ws, { type: "error", message: "no such room", room_id: m.room_id });
        return;
      }
      const member = ws.agentId && room.agents.has(ws.agentId);
      if (!isCreator(room, ws) && !member) {
        send(ws, { type: "error", message: "only the room creator or members can invite", room_id: room.id });
        return;
      }
      const id = agentIdOf(m.to);
      room.invited.add(id);
      for (const t of socketsForAgent(id)) {
        send(t, { type: "invited", room_id: room.id, topic: room.topic, from: ws.agentName || "the room creator" });
      }
    } else if (m.type === "knock" && m.room_id) {
      const room = rooms.get(m.room_id);
      if (!room) {
        send(ws, { type: "error", message: "no such room", room_id: m.room_id });
        return;
      }
      if (!ws.agentId && m.name) ws.agentName = String(m.name).slice(0, 60);
      enterOrKnock(ws, room, ws.agentName, ws.agentServes || "");
    } else if (m.type === "admit" && m.room_id && m.agent) {
      const room = rooms.get(m.room_id);
      if (!room) {
        send(ws, { type: "error", message: "no such room", room_id: m.room_id });
        return;
      }
      if (!isCreator(room, ws)) {
        send(ws, { type: "error", message: "only the room creator can admit", room_id: room.id });
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
    }
  });
  ws.on("close", () => {
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
httpServer.listen(PORT, () => console.log(`muse-lobby listening on http://localhost:${PORT}`));
