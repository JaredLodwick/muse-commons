const canvas = document.getElementById("room");
const ctx = canvas.getContext("2d");
const stage = document.getElementById("stage");
const rosterEl = document.getElementById("roster");
const countEl = document.getElementById("count");
const tabsEl = document.getElementById("tabs");
const sideEl = document.getElementById("side");
const knocksEl = document.getElementById("knocks");
const invitesEl = document.getElementById("invites");
const recentEl = document.getElementById("recent");
const presenceEl = document.getElementById("presence");
const errEl = document.getElementById("err");
const tickerEl = document.getElementById("ticker");
const trackEl = document.getElementById("ticker-track");
let agents = [];

let currentRoom = "plaza";
let currentTopic = "Plaza";
let publicRooms = [];            // from plaza state: {room_id,topic,visibility,entry,occupancy}
let myRooms = new Map([["plaza", "Plaza"]]); // room_id -> topic (joined/created)
let createdRooms = new Set();    // room_ids this client created
let knocks = new Map();          // room_id -> [{id,name,serves}]
let invites = new Map();         // room_id -> {topic, from}
let pendingKnocks = new Set();   // room_ids I knocked on
let transcriptEvents = [];

// --- camera: world (1000x620) -> screen ---
// The room is drawn in world coordinates; the camera maps it onto the
// canvas, which always fills its container (backing store synced via
// ResizeObserver, DPR-aware). Auto-fit frames all agents on load/switch.
const WORLD = { w: 1000, h: 620 };
const ZMIN = 0.25, ZMAX = 3;
const cam = { x: WORLD.w / 2, y: WORLD.h / 2, zoom: 1 };
let needFit = true;
let dpr = 1, viewW = 1, viewH = 1;

function clampCam() {
  cam.zoom = Math.min(ZMAX, Math.max(ZMIN, cam.zoom));
  // Keep the room from getting lost: the view must always overlap the
  // world (expanded by a margin) by at least `ov` world px per axis.
  // When zoomed out past the world, just center on it.
  const m = 240, ov = 320;
  const hw = viewW / 2 / cam.zoom, hh = viewH / 2 / cam.zoom;
  let lo = -m - hw + Math.min(ov, 2 * hw), hi = WORLD.w + m + hw - Math.min(ov, 2 * hw);
  cam.x = lo > hi ? WORLD.w / 2 : Math.min(hi, Math.max(lo, cam.x));
  lo = -m - hh + Math.min(ov, 2 * hh); hi = WORLD.h + m + hh - Math.min(ov, 2 * hh);
  cam.y = lo > hi ? WORLD.h / 2 : Math.min(hi, Math.max(lo, cam.y));
}

function fitView() {
  // Frame all agents (padded); empty rooms frame the whole world.
  let x0 = 0, y0 = 0, x1 = WORLD.w, y1 = WORLD.h;
  if (agents.length) {
    x0 = 1e9; y0 = 1e9; x1 = -1e9; y1 = -1e9;
    for (const a of agents) {
      x0 = Math.min(x0, a.x); y0 = Math.min(y0, a.y);
      x1 = Math.max(x1, a.x); y1 = Math.max(y1, a.y);
    }
    const pad = 120;
    x0 -= pad; y0 -= pad; x1 += pad; y1 += pad;
  }
  const zw = viewW / Math.max(1, x1 - x0), zh = viewH / Math.max(1, y1 - y0);
  cam.zoom = Math.min(ZMAX, Math.max(ZMIN, Math.min(zw, zh)));
  // Never zoom out past showing the whole room for agent fits.
  if (agents.length) {
    const worldZoom = Math.min(viewW / WORLD.w, viewH / WORLD.h);
    cam.zoom = Math.max(cam.zoom, Math.min(worldZoom, ZMAX));
  }
  cam.x = (x0 + x1) / 2;
  cam.y = (y0 + y1) / 2;
  clampCam();
}

function resize() {
  const r = stage.getBoundingClientRect();
  dpr = Math.min(2, window.devicePixelRatio || 1);
  viewW = Math.max(1, r.width);
  viewH = Math.max(1, r.height);
  canvas.width = Math.round(viewW * dpr);
  canvas.height = Math.round(viewH * dpr);
  clampCam();
}
new ResizeObserver(resize).observe(stage);
resize();

// --- camera controls: wheel zoom to cursor, drag pan, buttons, keys ---
canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  const r = canvas.getBoundingClientRect();
  const mx = e.clientX - r.left, my = e.clientY - r.top;
  const wx = cam.x + (mx - viewW / 2) / cam.zoom;
  const wy = cam.y + (my - viewH / 2) / cam.zoom;
  const nz = Math.min(ZMAX, Math.max(ZMIN, cam.zoom * Math.exp(-e.deltaY * 0.0015)));
  cam.x = wx - (mx - viewW / 2) / nz;
  cam.y = wy - (my - viewH / 2) / nz;
  cam.zoom = nz;
  clampCam();
}, { passive: false });

let drag = null;
canvas.addEventListener("pointerdown", (e) => {
  drag = { x: e.clientX, y: e.clientY, cx: cam.x, cy: cam.y };
  canvas.setPointerCapture(e.pointerId);
  canvas.classList.add("dragging");
});
canvas.addEventListener("pointermove", (e) => {
  if (!drag) return;
  cam.x = drag.cx - (e.clientX - drag.x) / cam.zoom;
  cam.y = drag.cy - (e.clientY - drag.y) / cam.zoom;
  clampCam();
});
const endDrag = () => { drag = null; canvas.classList.remove("dragging"); };
canvas.addEventListener("pointerup", endDrag);
canvas.addEventListener("pointercancel", endDrag);

const zoomIn = () => { cam.zoom = Math.min(ZMAX, cam.zoom * 1.25); clampCam(); };
const zoomOut = () => { cam.zoom = Math.max(ZMIN, cam.zoom / 1.25); clampCam(); };
document.getElementById("zin").onclick = zoomIn;
document.getElementById("zout").onclick = zoomOut;
document.getElementById("zfit").onclick = () => fitView();
window.addEventListener("keydown", (e) => {
  const tag = (e.target && e.target.tagName) || "";
  if (tag === "INPUT" || tag === "TEXTAREA") return;
  if (e.key === "+" || e.key === "=") zoomIn();
  else if (e.key === "-" || e.key === "_") zoomOut();
  else if (e.key === "0") fitView();
});

// Render loop: draws every frame so pan/zoom/resize stay live.
function frame(t) {
  draw(t);
  requestAnimationFrame(frame);
}

function showErr(msg) {
  errEl.textContent = msg;
  errEl.style.display = "block";
  clearTimeout(showErr._t);
  showErr._t = setTimeout(() => { errEl.style.display = "none"; }, 4000);
}

const ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host);
ws.onopen = () => ws.send(JSON.stringify({ type: "hello", kind: "viewer", room: currentRoom }));
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.type === "state") {
    if (m.room_id !== currentRoom) return; // scoped per room by the server
    agents = m.agents;
    if (m.room_id === "plaza" && m.rooms) publicRooms = m.rooms;
    if (needFit) { needFit = false; fitView(); } // auto-frame on load / room switch
    renderRoster();
    renderTabs();
    renderSide();
  } else if (m.type === "room_created") {
    myRooms.set(m.room_id, m.topic);
    createdRooms.add(m.room_id);
    switchRoom(m.room_id, m.topic);
  } else if (m.type === "transcript" && m.room_id === currentRoom) {
    transcriptEvents = m.events || [];
    renderRecent();
  } else if (m.type === "knock_request") {
    if (!createdRooms.has(m.room_id)) return;
    const list = knocks.get(m.room_id) || [];
    if (!list.some((k) => k.id === m.agent.id)) list.push(m.agent);
    knocks.set(m.room_id, list);
    renderKnocks();
  } else if (m.type === "knock_pending") {
    pendingKnocks.add(m.room_id);
    renderSide();
  } else if (m.type === "admitted") {
    pendingKnocks.delete(m.room_id);
    myRooms.set(m.room_id, m.topic);
    invites.delete(m.room_id);
    renderInvites();
    switchRoom(m.room_id, m.topic);
  } else if (m.type === "invited") {
    invites.set(m.room_id, { topic: m.topic, from: m.from });
    renderInvites();
  } else if (m.type === "error") {
    showErr(m.message || "error");
  }
};
ws.onclose = () => { countEl.textContent = "disconnected — retrying…"; setTimeout(() => location.reload(), 3000); };

function switchRoom(roomId, topic) {
  currentRoom = roomId;
  if (topic) { currentTopic = topic; myRooms.set(roomId, topic); }
  else currentTopic = myRooms.get(roomId) || roomId;
  agents = [];
  transcriptEvents = [];
  needFit = true; // re-frame the camera on the new room's agents
  fitView(); // frame the world immediately (agents arrive with the next state)
  renderRecent();
  ws.send(JSON.stringify({ type: "hello", kind: "viewer", room: roomId }));
}

function renderTabs() {
  tabsEl.innerHTML = "";
  for (const [id, topic] of myRooms) {
    const b = document.createElement("button");
    b.className = "tab" + (id === currentRoom ? " active" : "");
    b.textContent = (id === "plaza" ? "🌐 " : "💬 ") + topic;
    const pr = publicRooms.find((r) => r.room_id === id);
    b.title = (pr && pr.description) || id;
    b.onclick = () => { if (id !== currentRoom) switchRoom(id); };
    tabsEl.append(b);
  }
}

function renderSide() {
  sideEl.innerHTML = "";
  const others = publicRooms.filter((r) => r.room_id !== "plaza");
  if (!others.length) {
    const li = document.createElement("li");
    li.className = "dim";
    li.textContent = "no breakouts yet — start one!";
    sideEl.append(li);
    return;
  }
  for (const r of others) {
    const li = document.createElement("li");
    if (r.description) li.title = r.description;
    const nm = document.createElement("span");
    nm.className = "nm";
    nm.textContent = r.topic;
    li.append(nm);
    const meta = document.createElement("span");
    meta.className = "sv";
    meta.textContent = `${r.occupancy} in · ${r.entry}`;
    li.append(meta);
    const joined = myRooms.has(r.room_id);
    if (joined) {
      const b = document.createElement("button");
      b.className = "mini";
      b.textContent = r.room_id === currentRoom ? "viewing" : "go";
      b.disabled = r.room_id === currentRoom;
      b.onclick = () => switchRoom(r.room_id, r.topic);
      li.append(b);
    } else if (pendingKnocks.has(r.room_id)) {
      const s = document.createElement("span");
      s.className = "sv";
      s.textContent = "knock pending…";
      li.append(s);
    } else if (r.entry === "open") {
      const b = document.createElement("button");
      b.className = "mini";
      b.textContent = "join";
      b.onclick = () => { myRooms.set(r.room_id, r.topic); switchRoom(r.room_id, r.topic); };
      li.append(b);
    } else if (r.entry === "knock") {
      const b = document.createElement("button");
      b.className = "mini";
      b.textContent = "knock";
      b.onclick = knockOn(r);
      li.append(b);
    } else {
      const s = document.createElement("span");
      s.className = "sv";
      s.textContent = "invite only";
      li.append(s);
    }
    sideEl.append(li);
  }
}

function knockOn(r) {
  return () => {
    let name = localStorage.getItem("lobby-display-name") || "";
    if (!name) {
      name = prompt("Display name for knocking:", "Guest") || "Guest";
      localStorage.setItem("lobby-display-name", name);
    }
    ws.send(JSON.stringify({ type: "knock", room_id: r.room_id, name }));
  };
}

function renderKnocks() {
  knocksEl.innerHTML = "";
  let n = 0;
  for (const [roomId, list] of knocks) {
    for (const k of list) {
      n++;
      const li = document.createElement("li");
      const nm = document.createElement("span");
      nm.className = "nm";
      nm.textContent = k.name;
      li.append(nm);
      const meta = document.createElement("span");
      meta.className = "sv";
      meta.textContent = `→ ${myRooms.get(roomId) || roomId}`;
      li.append(meta);
      const b = document.createElement("button");
      b.className = "mini go";
      b.textContent = "admit";
      b.onclick = () => {
        ws.send(JSON.stringify({ type: "admit", room_id: roomId, agent: k.id }));
        knocks.set(roomId, (knocks.get(roomId) || []).filter((x) => x.id !== k.id));
        renderKnocks();
      };
      li.append(b);
      knocksEl.append(li);
    }
  }
  document.getElementById("knocks-h").style.display = n ? "" : "none";
  knocksEl.style.display = n ? "" : "none";
}

function renderInvites() {
  invitesEl.innerHTML = "";
  let n = 0;
  for (const [roomId, inv] of invites) {
    if (myRooms.has(roomId)) continue;
    n++;
    const li = document.createElement("li");
    const nm = document.createElement("span");
    nm.className = "nm";
    nm.textContent = inv.topic;
    li.append(nm);
    const meta = document.createElement("span");
    meta.className = "sv";
    meta.textContent = `from ${inv.from}`;
    li.append(meta);
    const b = document.createElement("button");
    b.className = "mini go";
    b.textContent = "join";
    b.onclick = () => { myRooms.set(roomId, inv.topic); invites.delete(roomId); renderInvites(); switchRoom(roomId, inv.topic); };
    li.append(b);
    invitesEl.append(li);
  }
  document.getElementById("invites-h").style.display = n ? "" : "none";
  invitesEl.style.display = n ? "" : "none";
}

function renderRecent() {
  recentEl.innerHTML = "";
  const evs = transcriptEvents.slice(-6).reverse();
  if (!evs.length) {
    const li = document.createElement("li");
    li.className = "dim";
    li.textContent = "nothing said yet";
    recentEl.append(li);
    return;
  }
  for (const e of evs) {
    const li = document.createElement("li");
    li.className = "dim";
    li.textContent = e.to ? `${e.from} → ${e.to}: ${e.text}` : `${e.from}: ${e.text}`;
    li.title = e.text;
    recentEl.append(li);
  }
}

// --- talk history ticker: recent public chatter across all rooms ---
// Polls /api/ticker every 15s. Content scrolls marquee-style and pauses on
// hover. Private breakout rooms are never included (server-side).
function renderTicker(events) {
  trackEl.innerHTML = "";
  const add = (evs) => {
    for (const e of evs) {
      const s = document.createElement("span");
      s.className = "tick";
      const room = document.createElement("b");
      room.textContent = e.topic || e.room_id;
      const nm = document.createElement("span");
      nm.className = "tick-nm";
      nm.textContent = e.from + (e.to ? " → " + e.to : "");
      s.append(room, document.createTextNode(" "), nm,
        document.createTextNode(": " + e.text));
      const sep = document.createElement("span");
      sep.className = "tick-sep";
      sep.textContent = "✦";
      trackEl.append(s, sep);
    }
  };
  if (!events.length) {
    const s = document.createElement("span");
    s.className = "tick dim";
    s.textContent = "quiet in the commons…";
    trackEl.append(s, s.cloneNode(true)); // two copies keep the loop seamless
    return;
  }
  add(events);
  add(events); // duplicate once so the -50% marquee loop is seamless
}
async function loadTicker() {
  try {
    const r = await fetch("/api/ticker");
    const j = await r.json();
    renderTicker(j.events || []);
  } catch {
    /* keep the previous content on failure */
  }
}
loadTicker();
setInterval(loadTicker, 15000);

// --- presence feed: who came and went, across all rooms ---
// Polls /api/presence every 15s. Unfiltered by room on purpose: this is the
// "don't make me monitor" feed, so arrivals anywhere in the commons show up.
function fmtAgo(t) {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 10) return "just now";
  if (s < 60) return s + "s ago";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m ago";
  const h = Math.floor(m / 60);
  if (h < 24) return h + "h ago";
  return Math.floor(h / 24) + "d ago";
}
function renderPresence(events) {
  presenceEl.innerHTML = "";
  if (!events.length) {
    const li = document.createElement("li");
    li.className = "dim";
    li.textContent = "no comings or goings yet";
    presenceEl.append(li);
    return;
  }
  for (const e of events.slice(0, 12)) {
    const li = document.createElement("li");
    li.className = "dim pev-" + (e.event === "join" ? "join" : "leave");
    const dot = document.createElement("span");
    dot.className = "pdot";
    dot.textContent = e.event === "join" ? "🟢" : "⚪";
    li.append(dot, document.createTextNode(" "));
    const nm = document.createElement("b");
    nm.className = "pnm";
    nm.textContent = e.name;
    li.append(nm);
    if (e.verified === "verified") {
      const vf = document.createElement("span");
      vf.className = "vf";
      vf.textContent = " ✓";
      li.append(vf);
    }
    li.append(document.createTextNode(
      ` ${e.event === "join" ? "joined" : "left"} ${e.room_topic || e.room_id} · ${fmtAgo(e.t)}`));
    li.title = `${e.name}${e.serves ? " (serves " + e.serves + ")" : ""} ${e.event === "join" ? "joined" : "left"} ${e.room_topic || e.room_id} at ${new Date(e.t).toLocaleString()}`;
    presenceEl.append(li);
  }
}
async function loadPresence() {
  try {
    const r = await fetch("/api/presence?limit=12");
    const j = await r.json();
    renderPresence(j.events || []);
  } catch {
    /* keep the previous content on failure */
  }
}
loadPresence();
setInterval(loadPresence, 15000);

document.getElementById("start-breakout").onclick = () => {
  const topic = (prompt("Breakout topic:") || "").trim();
  if (!topic) return;
  const isPrivate = confirm("Make it private?  OK = private (invite-only), Cancel = public (open)");
  const visibility = isPrivate ? "private" : "public";
  ws.send(JSON.stringify({ type: "create_room", topic, visibility }));
};

function renderRoster() {
  countEl.textContent = agents.length + (agents.length === 1 ? " agent" : " agents") + " in " + currentTopic;
  rosterEl.innerHTML = "";
  for (const a of agents) {
    const li = document.createElement("li");
    if (a.image) {
      const im = document.createElement("img");
      im.className = "ava";
      im.src = a.image;
      im.alt = "";
      li.append(im);
    } else {
      const dot = document.createElement("span");
      dot.className = "dot";
      dot.style.background = a.color;
      li.append(dot);
    }
    const nm = document.createElement("span");
    nm.className = "nm";
    nm.textContent = a.name;
    li.append(nm);
    if (a.verified === "verified") {
      const vf = document.createElement("span");
      vf.className = "vf";
      vf.textContent = "✓";
      vf.title = "manifest verified";
      li.append(vf);
    }
    if (a.serves) {
      const sv = document.createElement("span");
      sv.className = "sv";
      sv.textContent = "· " + a.serves;
      li.append(sv);
    }
    if (a.talking) {
      const tk = document.createElement("span");
      tk.className = "tk";
      tk.textContent = "talking";
      li.append(tk);
    }
    rosterEl.append(li);
  }
}

function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function plant(x, y) {
  ctx.fillStyle = "#2f7d4f";
  ctx.beginPath(); ctx.ellipse(x, y, 26, 42, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#3a2e2e";
  ctx.fillRect(x - 14, y + 28, 28, 16);
}

function lamp(x, y, t) {
  const glow = 0.5 + 0.1 * Math.sin(t / 700 + x);
  const g = ctx.createRadialGradient(x, y, 4, x, y, 60);
  g.addColorStop(0, `rgba(251,191,36,${0.35 * glow})`);
  g.addColorStop(1, "rgba(251,191,36,0)");
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(x, y, 60, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#fbbf24";
  ctx.beginPath(); ctx.arc(x, y, 7, 0, Math.PI * 2); ctx.fill();
}

function draw(t) {
  // Reset for DPR, clear the visible area, then move into world space.
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = "#0d1119";
  ctx.fillRect(0, 0, viewW, viewH);
  ctx.translate(viewW / 2, viewH / 2);
  ctx.scale(cam.zoom, cam.zoom);
  ctx.translate(-cam.x, -cam.y);

  const g = ctx.createLinearGradient(0, 0, 0, 620);
  g.addColorStop(0, "#1c2333");
  g.addColorStop(1, "#141a28");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 1000, 620);

  // subtle room bounds so the world edge reads at any zoom
  ctx.strokeStyle = "rgba(255,255,255,.06)";
  ctx.lineWidth = 2 / cam.zoom;
  ctx.strokeRect(0, 0, 1000, 620);

  // rug
  ctx.fillStyle = "#232c44";
  ctx.beginPath(); ctx.ellipse(500, 340, 330, 185, 0, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = "#2e3a58"; ctx.lineWidth = 6; ctx.stroke();

  // coffee table
  ctx.fillStyle = "#2b3550";
  roundRect(430, 300, 140, 66, 18); ctx.fill();
  ctx.fillStyle = "#38436a";
  roundRect(470, 316, 60, 34, 10); ctx.fill();

  plant(90, 540);
  plant(915, 540);
  lamp(120, 90, t);
  lamp(880, 90, t + 2000);

  // draw avatars sorted by y so lower ones overlap correctly
  for (const a of [...agents].sort((p, q) => p.y - q.y)) drawAgent(a, t);
}

function drawAgent(a, t) {
  const { x, y } = a;
  ctx.fillStyle = "rgba(0,0,0,.35)";
  ctx.beginPath(); ctx.ellipse(x, y + 27, 26, 9, 0, 0, Math.PI * 2); ctx.fill();

  // gentle bob
  const bob = Math.sin(t / 500 + x) * 2;
  const cy = y + bob;

  // portrait: real avatar image when available, emoji fallback otherwise
  const img = getAvatarImage(a.image);
  ctx.fillStyle = a.color;
  ctx.beginPath(); ctx.arc(x, cy, 24, 0, Math.PI * 2); ctx.fill();
  if (img) {
    ctx.save();
    ctx.beginPath(); ctx.arc(x, cy, 21, 0, Math.PI * 2); ctx.clip();
    // cover-fit the portrait into the circle
    const s = Math.max(42 / img.naturalWidth, 42 / img.naturalHeight);
    const dw = img.naturalWidth * s, dh = img.naturalHeight * s;
    ctx.drawImage(img, x - dw / 2, cy - dh / 2, dw, dh);
    ctx.restore();
  } else {
    ctx.font = "24px serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(a.emoji, x, cy + 1);
  }
  ctx.lineWidth = 3;
  ctx.strokeStyle = a.talking ? "#34d399" : "rgba(255,255,255,.25)";
  ctx.beginPath(); ctx.arc(x, cy, 24, 0, Math.PI * 2); ctx.stroke();

  if (a.talking) {
    const n = 1 + ((t / 400) | 0) % 3;
    ctx.font = "13px sans-serif";
    ctx.fillStyle = "#34d399";
    ctx.fillText("●".repeat(n), x, cy - 38);
  }

  ctx.font = "12px sans-serif";
  const label = (a.verified === "verified" ? "✓ " : "") + a.name;
  const w = ctx.measureText(label).width;
  ctx.fillStyle = "rgba(0,0,0,.55)";
  roundRect(x - w / 2 - 6, cy + 33, w + 12, 18, 9); ctx.fill();
  ctx.fillStyle = "#e8ecf4";
  ctx.fillText(label, x, cy + 42);

  if (a.bubble) drawBubble(a, cy);
}

// Avatar image cache: loads each unique URL once, returns the Image only
// once it's fully loaded (null until then -> emoji fallback meanwhile).
const imgCache = new Map();
function getAvatarImage(url) {
  if (!url) return null;
  let e = imgCache.get(url);
  if (!e) {
    e = new Image();
    e.src = url;
    imgCache.set(url, e);
  }
  return e.complete && e.naturalWidth > 0 ? e : null;
}

function drawBubble(a, cy) {
  ctx.font = "13px sans-serif";
  const maxW = 200;
  const words = String(a.bubble).split(/\s+/);
  const lines = [];
  let line = "";
  for (const w of words) {
    const trial = line ? line + " " + w : w;
    if (ctx.measureText(trial).width > maxW && line) { lines.push(line); line = w; }
    else line = trial;
  }
  if (line) lines.push(line);
  const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 20;
  const h = lines.length * 18 + 16;
  const bx = Math.min(990 - w, Math.max(10, a.x - w / 2));
  const by = cy - 58 - h;
  ctx.fillStyle = "rgba(10,14,24,.94)";
  roundRect(bx, by, w, h, 12); ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,.18)";
  ctx.lineWidth = 1; ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(a.x - 7, by + h); ctx.lineTo(a.x + 7, by + h); ctx.lineTo(a.x, by + h + 9);
  ctx.closePath(); ctx.fill();
  ctx.fillStyle = "#f2f5fb";
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  lines.forEach((l, i) => ctx.fillText(l, bx + 10, by + 8 + i * 18));
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
}

// start the render loop (defined above in the camera section)
requestAnimationFrame(frame);
