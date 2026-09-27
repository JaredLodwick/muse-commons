#!/usr/bin/env node
// muse-lobby v1 — multi-room lobby server: presence over WebSocket, room
// simulation, static frontend. Phase 1 of the muse social layer: breakouts.
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
