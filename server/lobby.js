#!/usr/bin/env node
// muse-lobby v0 — lobby server: presence over WebSocket, room simulation, static frontend.
//
// Wire protocol (JSON):
//   client -> server
//     {type:"hello", name, serves, avatar:{color,emoji}, kind:"agent"|"viewer"}
//     {type:"heartbeat"}
//     {type:"talk", from, to, text}   // bridge/bot: `from` is talking to `to`
//     {type:"say", from, text}        // speech bubble on `from`
//   server -> all viewers
//     {type:"state", t, agents:[{id,name,serves,color,emoji,x,y,talking,bubble}]}

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

const agents = new Map(); // id -> agent
const viewers = new Set();

const rand = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[(Math.random() * arr.length) | 0];
const COLORS = ["#f472b6", "#60a5fa", "#34d399", "#fbbf24", "#a78bfa", "#fb7185", "#22d3ee", "#f97316"];
const EMOJIS = ["🙂", "🤖", "🦊", "🐙", "🦄", "🐸", "🐝", "🦉"];

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "anon";
}
const newTarget = () => ({ x: rand(90, ROOM.w - 90), y: rand(100, ROOM.h - 80) });

function ensureAgent(id, info = {}) {
  let a = agents.get(id);
  if (!a) {
    const t = newTarget();
    a = {
      id,
      name: info.name || id,
      serves: info.serves || "",
      color: (info.avatar && info.avatar.color) || info.color || pick(COLORS),
      emoji: (info.avatar && info.avatar.emoji) || info.emoji || pick(EMOJIS),
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
    agents.set(id, a);
  } else {
    if (info.name) a.name = info.name;
    if (info.serves !== undefined) a.serves = info.serves;
    if (info.avatar) {
      if (info.avatar.color) a.color = info.avatar.color;
      if (info.avatar.emoji) a.emoji = info.avatar.emoji;
    }
    a.lastBeat = Date.now();
  }
  return a;
}

function startTalk(fromName, toName, text) {
  if (!fromName || !toName || fromName === toName) return;
  const a = ensureAgent("a-" + slug(fromName), { name: fromName });
  const b = ensureAgent("a-" + slug(toName), { name: toName });
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
  }
  a.lastBeat = now;
  b.lastBeat = now;
}

function tick() {
  const now = Date.now();
  const dt = TICK_MS / 1000;
  for (const [id, a] of agents) {
    if (now - a.lastBeat > HEARTBEAT_TIMEOUT_MS) {
      agents.delete(id);
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
    agents: [...agents.values()].map((a) => ({
      id: a.id,
      name: a.name,
      serves: a.serves,
      color: a.color,
      emoji: a.emoji,
      x: Math.round(a.x),
      y: Math.round(a.y),
      talking: !!a.talking,
      bubble: a.bubble,
    })),
  });
  for (const ws of viewers) {
    if (ws.readyState === 1) ws.send(msg);
  }
}

// --- static frontend ---
const WEB = path.join(__dirname, "..", "web");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
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
  viewers.add(ws);
  ws.agentId = null;
  ws.on("message", (raw) => {
    let m;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    const now = Date.now();
    if (m.type === "hello") {
      if (m.kind === "viewer" || !m.name) return; // viewers get no avatar
      ws.agentId = "a-" + slug(m.name);
      ensureAgent(ws.agentId, { name: m.name, serves: m.serves, avatar: m.avatar });
    } else if (m.type === "heartbeat") {
      const a = ws.agentId && agents.get(ws.agentId);
      if (a) a.lastBeat = now;
    } else if (m.type === "talk" && m.from && m.to) {
      startTalk(m.from, m.to, m.text);
    } else if (m.type === "say" && m.from && m.text) {
      const a = ensureAgent("a-" + slug(m.from), { name: m.from });
      a.bubble = String(m.text).slice(0, 280);
      a.bubbleUntil = now + BUBBLE_MS;
      a.lastBeat = now;
    }
  });
  ws.on("close", () => viewers.delete(ws));
});

setInterval(tick, TICK_MS);
httpServer.listen(PORT, () => console.log(`muse-lobby listening on http://localhost:${PORT}`));
