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
let agents = [];

let currentRoom = "plaza";
let currentTopic = "Plaza";
let publicRooms = [];            // from plaza state: {room_id,topic,visibility,entry,occupancy}
let myRooms = new Map([["plaza", "Plaza"]]); // room_id -> topic (joined/created)
let createdRooms = new Set();    // room_ids this client created
let knocks = new Map();          // room_id -> [{id,name,serves}]
let invites = new Map();         // room_id -> {topic, from}
let pendingKnocks = new Set();   // room_ids I knocked on

// --- render diffing ---
// The server broadcasts a full `state` message ~10x/sec. The canvas needs
// fresh agent positions every time, but rebuilding the sidebar DOM at that
// rate strobes hover state and replaces buttons between pointerdown and
// click, so Join clicks never land. Each list below renders only when a
// cheap signature of its underlying data actually changes.
let rosterSig = "\0", tabsSig = "\0", sideSig = "\0";
function agentSig(a) {
  return [a.id, a.name, a.serves, a.verified, a.talking, a.image, a.emoji, a.color].join("|");
}
function renderRosterIfChanged() {
  const s = agents.map(agentSig).join(",");
  if (s === rosterSig) return;
  rosterSig = s;
  renderRoster();
}
function renderTabsIfChanged() {
  let s = currentRoom + "\n";
  for (const [id, topic] of myRooms) s += id + "\n" + topic + "\n";
  const pr = publicRooms.find((r) => r.room_id === currentRoom);
  if (pr && pr.description) s += pr.description;
  if (s === tabsSig) return;
  tabsSig = s;
  renderTabs();
}
function renderSideIfChanged() {
  let s = "";
  for (const r of publicRooms) {
    s += [r.room_id, r.topic, r.occupancy, r.entry, r.visibility, r.description].join("|") + ";";
  }
  s += "#" + [...myRooms.keys()].join(",") + "#" + [...pendingKnocks].join(",");
  if (s === sideSig) return;
  sideSig = s;
  renderSide();
}

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

let vignetteGrad = null;
function buildVignette() {
  const cxp = viewW / 2, cyp = viewH / 2;
  const r0 = Math.min(viewW, viewH) * 0.40;
  const r1 = Math.max(viewW, viewH) * 0.72;
  vignetteGrad = ctx.createRadialGradient(cxp, cyp, r0, cxp, cyp, r1);
  vignetteGrad.addColorStop(0, "rgba(4,3,7,0)");
  vignetteGrad.addColorStop(1, "rgba(4,3,7,.48)");
}

function resize() {
  const r = stage.getBoundingClientRect();
  dpr = Math.min(2, window.devicePixelRatio || 1);
  viewW = Math.max(1, r.width);
  viewH = Math.max(1, r.height);
  canvas.width = Math.round(viewW * dpr);
  canvas.height = Math.round(viewH * dpr);
  buildVignette();
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
    agents = m.agents; // canvas always needs the fresh positions
    if (m.room_id === "plaza" && m.rooms) publicRooms = m.rooms;
    if (needFit) { needFit = false; fitView(); } // auto-frame on load / room switch
    // Sidebar lists re-render only when their data actually changed;
    // rebuilding them 10x/sec strobes hover and eats button clicks.
    renderRosterIfChanged();
    renderTabsIfChanged();
    renderSideIfChanged();
  } else if (m.type === "room_created") {
    myRooms.set(m.room_id, m.topic);
    createdRooms.add(m.room_id);
    switchRoom(m.room_id, m.topic);
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
ws.onclose = () => { countEl.textContent = "disconnected, retrying…"; setTimeout(() => location.reload(), 3000); };

function switchRoom(roomId, topic) {
  currentRoom = roomId;
  if (topic) { currentTopic = topic; myRooms.set(roomId, topic); }
  else currentTopic = myRooms.get(roomId) || roomId;
  agents = [];
  needFit = true; // re-frame the camera on the new room's agents
  fitView(); // frame the world immediately (agents arrive with the next state)
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
    li.textContent = "no breakouts yet, start one!";
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

// --- recent chatter: latest public messages across all rooms ---
// Polls /api/ticker every 15s and renders the newest few quietly in place.
// Private breakout rooms are never included (server-side). No marquee.
function renderRecent(events) {
  recentEl.innerHTML = "";
  const evs = (events || []).slice(0, 5);
  if (!evs.length) {
    const li = document.createElement("li");
    li.className = "dim";
    li.textContent = "nothing said yet";
    recentEl.append(li);
    return;
  }
  for (const e of evs) {
    const li = document.createElement("li");
    li.className = "rc";
    const head = document.createElement("div");
    head.className = "rc-head";
    const room = document.createElement("span");
    room.className = "rc-room";
    room.textContent = e.topic || e.room_id;
    const nm = document.createElement("b");
    nm.className = "rc-nm";
    nm.textContent = e.from + (e.to ? " → " + e.to : "");
    head.append(room, nm);
    const tx = document.createElement("div");
    tx.className = "rc-tx";
    tx.textContent = e.text;
    li.append(head, tx);
    li.title = `${e.from}${e.to ? " to " + e.to : ""} in ${e.topic || e.room_id}: ${e.text}`;
    recentEl.append(li);
  }
}
async function loadChatter() {
  try {
    const r = await fetch("/api/ticker?limit=10");
    const j = await r.json();
    renderRecent(j.events || []);
  } catch {
    /* keep the previous content on failure */
  }
}
loadChatter();
setInterval(loadChatter, 15000);

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

// ---------- canvas helpers ----------
function rr(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}
function roundRect(x, y, w, h, r) { rr(ctx, x, y, w, h, r); }

// deterministic pseudo-random in [0,1) for stable procedural detail
function prand(n) {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}
function hexA(hex, a) {
  try {
    let h = String(hex).replace("#", "");
    if (h.length === 3) h = h.split("").map((ch) => ch + ch).join("");
    const n = parseInt(h, 16);
    if (Number.isNaN(n)) return `rgba(255,255,255,${a})`;
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  } catch {
    return `rgba(255,255,255,${a})`;
  }
}

// ---------- static room ----------
// Rendered once to an offscreen canvas (2x) so each frame costs one
// drawImage. Only lamp flicker and dust motes are drawn live.
const roomStatic = document.createElement("canvas");
roomStatic.width = WORLD.w * 2;
roomStatic.height = WORLD.h * 2;
// Near-top-down lounge: the wooden floor fills the world and the wall is
// only a thin strip along the top edge, so agents always read as walking
// on the floor, never on walls. Furniture is drawn from above.
const LAMPS = [230, 770];
const POOL_Y = 300;
const WALL_H = 64;

function pictureFrame(c, x, y, w, h, seed) {
  c.fillStyle = "#4a3826";
  c.fillRect(x - 8, y - 8, w + 16, h + 16);
  c.fillStyle = "rgba(255,225,180,.18)";
  c.fillRect(x - 8, y - 8, w + 16, 3);
  c.fillStyle = "#241d2e";
  c.fillRect(x, y, w, h);
  const cols = ["#7a5a8a", "#4a7a8a", "#8a6a4a", "#5a8a6a"];
  for (let i = 0; i < 3; i++) {
    const ax = x + prand(seed + i * 3) * w;
    const ay = y + prand(seed + i * 3 + 1) * h;
    const ar = 14 + prand(seed + i * 3 + 2) * 26;
    const col = cols[Math.floor(prand(seed + i * 1.3) * cols.length)];
    const ag = c.createRadialGradient(ax, ay, 0, ax, ay, ar);
    ag.addColorStop(0, col + "b0");
    ag.addColorStop(1, col + "00");
    c.fillStyle = ag;
    c.beginPath(); c.arc(ax, ay, ar, 0, 6.2832); c.fill();
  }
}

function plantTop(c, x, y) {
  // potted plant seen from above: terracotta pot with a leaf canopy
  c.fillStyle = "rgba(0,0,0,.30)";
  c.beginPath(); c.ellipse(x + 4, y + 8, 46, 36, 0, 0, 6.2832); c.fill();
  c.fillStyle = "#8a4a30";
  c.beginPath(); c.arc(x, y, 30, 0, 6.2832); c.fill();
  c.fillStyle = "#6e3a24";
  c.beginPath(); c.arc(x, y, 22, 0, 6.2832); c.fill();
  c.fillStyle = "#2e1f16";
  c.beginPath(); c.arc(x, y, 18, 0, 6.2832); c.fill();
  const greens = ["#2f7d4f", "#3aa05c", "#276b42", "#46b46a"];
  for (let k = 0; k < 9; k++) {
    const a = (k / 9) * 6.2832 + prand(x + k * 7.7) * 0.7;
    const rad = 6 + prand(x * 1.3 + k * 3.1) * 12;
    c.fillStyle = greens[k % greens.length];
    c.beginPath();
    c.arc(x + Math.cos(a) * rad, y + Math.sin(a) * rad, 10 + prand(k * 5.9 + y) * 6, 0, 6.2832);
    c.fill();
  }
  c.fillStyle = "rgba(255,255,255,.10)";
  c.beginPath(); c.arc(x - 7, y - 8, 9, 0, 6.2832); c.fill();
}

function buildRoomStatic() {
  const c = roomStatic.getContext("2d");
  c.scale(2, 2);
  const W = WORLD.w, H = WORLD.h;

  // wooden plank floor fills the whole world, with per-plank tone variation
  const plankN = 9, plankH = (H - WALL_H) / plankN;
  for (let i = 0; i < plankN; i++) {
    const y0 = WALL_H + i * plankH;
    const l = 21 + prand(i * 1.7) * 7;
    c.fillStyle = `hsl(${26 + prand(i * 3.1) * 6},${30 + prand(i * 5.3) * 8}%,${l}%)`;
    c.fillRect(0, y0, W, plankH);
    c.fillStyle = "rgba(0,0,0,.45)";
    c.fillRect(0, y0, W, 2);
    c.fillStyle = "rgba(255,220,170,.07)";
    c.fillRect(0, y0 + 2, W, 1.5);
    c.fillStyle = "rgba(0,0,0,.32)";
    for (let k = 0; k < 2; k++) {
      const sx = (prand(i * 13.7 + k * 71.3) * W) | 0;
      c.fillRect(sx, y0 + 2, 1.5, plankH - 2);
    }
  }
  // floor sheen
  let g = c.createLinearGradient(0, WALL_H, 0, H);
  g.addColorStop(0, "rgba(255,220,160,.06)");
  g.addColorStop(0.5, "rgba(255,220,160,0)");
  g.addColorStop(1, "rgba(0,0,0,.16)");
  c.fillStyle = g;
  c.fillRect(0, WALL_H, W, H - WALL_H);

  // rug with patterned double border, seen from above
  const rx = 500, ry = 400, rrX = 300, rrY = 195;
  c.fillStyle = "#472b33";
  c.beginPath(); c.ellipse(rx, ry, rrX, rrY, 0, 0, 6.2832); c.fill();
  c.lineWidth = 7; c.strokeStyle = "#2a1a20";
  c.beginPath(); c.ellipse(rx, ry, rrX, rrY, 0, 0, 6.2832); c.stroke();
  c.lineWidth = 4.5; c.strokeStyle = "#c08a4e";
  c.beginPath(); c.ellipse(rx, ry, rrX - 26, rrY - 22, 0, 0, 6.2832); c.stroke();
  c.lineWidth = 1.5; c.strokeStyle = "rgba(192,138,78,.4)";
  c.beginPath(); c.ellipse(rx, ry, rrX - 40, rrY - 32, 0, 0, 6.2832); c.stroke();
  c.fillStyle = "rgba(216,164,100,.85)";
  for (let i = 0; i < 36; i++) {
    const a = (i / 36) * 6.2832;
    c.beginPath();
    c.arc(rx + Math.cos(a) * (rrX - 26), ry + Math.sin(a) * (rrY - 22), 2.4, 0, 6.2832);
    c.fill();
  }
  c.save();
  c.translate(rx, ry); c.rotate(Math.PI / 4);
  c.lineWidth = 2; c.strokeStyle = "rgba(216,164,100,.5)";
  c.strokeRect(-26, -26, 52, 52);
  c.restore();

  // coffee table seen from above
  const tx = 500, ty = 400;
  c.fillStyle = "rgba(0,0,0,.35)";
  c.beginPath(); c.ellipse(tx, ty + 10, 122, 76, 0, 0, 6.2832); c.fill();
  const tg = c.createLinearGradient(0, ty - 66, 0, ty + 66);
  tg.addColorStop(0, "#7a5330");
  tg.addColorStop(1, "#5a3d24");
  c.fillStyle = tg;
  rr(c, tx - 105, ty - 66, 210, 132, 18); c.fill();
  c.strokeStyle = "rgba(0,0,0,.35)";
  c.lineWidth = 2;
  rr(c, tx - 105, ty - 66, 210, 132, 18); c.stroke();
  c.fillStyle = "rgba(255,225,180,.22)";
  rr(c, tx - 97, ty - 60, 194, 5, 2.5); c.fill();
  c.strokeStyle = "rgba(255,220,170,.16)";
  c.lineWidth = 2;
  rr(c, tx - 90, ty - 51, 180, 102, 12); c.stroke();
  // books (top-down)
  c.fillStyle = "#7a4a5e";
  rr(c, tx - 78, ty - 34, 66, 46, 3); c.fill();
  c.fillStyle = "#47617e";
  rr(c, tx - 72, ty - 28, 54, 34, 3); c.fill();
  c.fillStyle = "rgba(255,255,255,.28)";
  c.fillRect(tx - 72, ty - 28, 4, 34);
  // mug (top-down)
  c.fillStyle = "#c9d4e2";
  c.beginPath(); c.arc(tx + 62, ty - 18, 13, 0, 6.2832); c.fill();
  c.fillStyle = "#4a2e1c";
  c.beginPath(); c.arc(tx + 62, ty - 18, 8.5, 0, 6.2832); c.fill();
  c.strokeStyle = "#c9d4e2";
  c.lineWidth = 3;
  c.beginPath(); c.arc(tx + 76, ty - 18, 7, -1.2, 1.2); c.stroke();
  // tiny succulent (top-down)
  c.fillStyle = "#8a4a30";
  c.beginPath(); c.arc(tx + 30, ty + 38, 11, 0, 6.2832); c.fill();
  c.fillStyle = "#2e1f16";
  c.beginPath(); c.arc(tx + 30, ty + 38, 7, 0, 6.2832); c.fill();
  c.fillStyle = "#3aa05c";
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * 6.2832;
    c.beginPath(); c.arc(tx + 30 + Math.cos(a) * 5, ty + 38 + Math.sin(a) * 5, 3.2, 0, 6.2832); c.fill();
  }

  // corner plants, seen from above
  plantTop(c, 80, 122);
  plantTop(c, 920, 122);
  plantTop(c, 80, 548);
  plantTop(c, 920, 548);

  // warm light pools baked into the floor (live flicker drawn on top)
  for (const lx of LAMPS) {
    const pg = c.createRadialGradient(lx, POOL_Y, 10, lx, POOL_Y, 200);
    pg.addColorStop(0, "rgba(255,196,110,.12)");
    pg.addColorStop(1, "rgba(255,196,110,0)");
    c.fillStyle = pg;
    c.beginPath(); c.arc(lx, POOL_Y, 200, 0, 6.2832); c.fill();
  }

  // thin wall strip along the top edge: warm wall, small art, chair rail.
  // Agents never walk above y=100, so nothing living touches this strip.
  g = c.createLinearGradient(0, 0, 0, WALL_H);
  g.addColorStop(0, "#2e2840");
  g.addColorStop(1, "#221c2c");
  c.fillStyle = g;
  c.fillRect(0, 0, W, WALL_H);
  pictureFrame(c, 200, 10, 104, 40, 11);
  pictureFrame(c, 700, 14, 88, 36, 47);
  c.fillStyle = "#54402c";
  c.fillRect(0, WALL_H - 8, W, 8);
  c.fillStyle = "rgba(255,225,180,.22)";
  c.fillRect(0, WALL_H - 8, W, 2);
  // soft shadow where the wall meets the floor
  g = c.createLinearGradient(0, WALL_H, 0, WALL_H + 26);
  g.addColorStop(0, "rgba(0,0,0,.28)");
  g.addColorStop(1, "rgba(0,0,0,0)");
  c.fillStyle = g;
  c.fillRect(0, WALL_H, W, 26);
}
buildRoomStatic();

// warm glow sprite reused for live lamp flicker (tinted by globalAlpha)
const glowSprite = (() => {
  const s = document.createElement("canvas");
  s.width = s.height = 256;
  const c = s.getContext("2d");
  const g = c.createRadialGradient(128, 128, 0, 128, 128, 128);
  g.addColorStop(0, "rgba(255,214,150,.9)");
  g.addColorStop(0.4, "rgba(255,190,120,.35)");
  g.addColorStop(1, "rgba(255,180,110,0)");
  c.fillStyle = g;
  c.fillRect(0, 0, 256, 256);
  return s;
})();

// dust motes drifting in the lamplight (precomputed, animated live)
const MOTES = [];
for (let i = 0; i < 44; i++) {
  const cx = (i % 2 === 0) ? LAMPS[0] : LAMPS[1];
  MOTES.push({
    bx: cx + (prand(i * 3 + 1) - 0.5) * 360,
    by: POOL_Y + (prand(i * 3 + 2) - 0.5) * 380,
    r: 0.8 + prand(i * 3 + 3) * 1.7,
    ph: prand(i * 7 + 0.5) * 6.2832,
    sp: 0.00010 + prand(i * 11 + 0.3) * 0.00022,
    amp: 12 + prand(i * 13 + 0.7) * 26,
  });
}

const sortScratch = [];

function draw(t) {
  // Reset for DPR, clear the visible area, then move into world space.
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = "#0d1119";
  ctx.fillRect(0, 0, viewW, viewH);
  ctx.translate(viewW / 2, viewH / 2);
  ctx.scale(cam.zoom, cam.zoom);
  ctx.translate(-cam.x, -cam.y);

  // static room: one cached drawImage
  ctx.drawImage(roomStatic, 0, 0, WORLD.w, WORLD.h);

  // subtle room bounds so the world edge reads at any zoom
  ctx.strokeStyle = "rgba(255,255,255,.05)";
  ctx.lineWidth = 2 / cam.zoom;
  ctx.strokeRect(0, 0, WORLD.w, WORLD.h);

  // lamp light: warm pools breathing on the floor, very subtle
  for (const lx of LAMPS) {
    const fl = 0.9 + 0.06 * Math.sin(t / 640 + lx * 0.13) + 0.04 * Math.sin(t / 173 + lx);
    ctx.globalAlpha = 0.30 * fl;
    ctx.drawImage(glowSprite, lx - 115, POOL_Y - 115, 230, 230);
    ctx.globalAlpha = 0.20 * fl;
    ctx.drawImage(glowSprite, lx - 175, POOL_Y - 95, 350, 190);
  }
  ctx.globalAlpha = 1;

  // dust motes
  ctx.fillStyle = "#ffe9c4";
  for (const m of MOTES) {
    const mx = m.bx + Math.sin(t * m.sp * 6.2832 + m.ph) * m.amp;
    const my = m.by + Math.cos(t * m.sp * 4.1 + m.ph * 1.7) * m.amp * 0.55;
    ctx.globalAlpha = 0.04 + 0.07 * (0.5 + 0.5 * Math.sin(t * 0.0011 + m.ph * 2.3));
    ctx.beginPath();
    ctx.arc(mx, my, m.r, 0, 6.2832);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // avatars sorted by y so lower ones overlap correctly (scratch array: no alloc)
  sortScratch.length = 0;
  for (const a of agents) sortScratch.push(a);
  sortScratch.sort((p, q) => p.y - q.y);
  const seenBubbles = new Set();
  for (const a of sortScratch) {
    drawAgent(a, t);
    if (a.bubble) seenBubbles.add(a.id || a.name);
  }
  for (const k of bubbleState.keys()) {
    if (!seenBubbles.has(k)) bubbleState.delete(k);
  }

  // soft vignette in screen space
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (vignetteGrad) {
    ctx.fillStyle = vignetteGrad;
    ctx.fillRect(0, 0, viewW, viewH);
  }
}

// per-color soft glow sprite, cached
const glowCache = new Map();
function agentGlow(color) {
  let s = glowCache.get(color);
  if (!s) {
    s = document.createElement("canvas");
    s.width = s.height = 128;
    const c = s.getContext("2d");
    const g = c.createRadialGradient(64, 64, 6, 64, 64, 64);
    g.addColorStop(0, hexA(color, 0.55));
    g.addColorStop(0.55, hexA(color, 0.20));
    g.addColorStop(1, hexA(color, 0));
    c.fillStyle = g;
    c.fillRect(0, 0, 128, 128);
    glowCache.set(color, s);
  }
  return s;
}

// name pill metrics cached per (verified, name)
const labelCache = new Map();
const PILL_FONT = "600 12px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";

function drawNamePill(a, x, cy) {
  // screen-space pill: crisp and readable at any zoom
  const sx = (x - cam.x) * cam.zoom + viewW / 2;
  const sy = (cy + 36 - cam.y) * cam.zoom + viewH / 2;
  if (sx < -80 || sx > viewW + 80 || sy < -30 || sy > viewH + 30) return;
  const verified = a.verified === "verified";
  const key = (verified ? "1" : "0") + ":" + a.name;
  let L = labelCache.get(key);
  if (!L) {
    ctx.font = PILL_FONT;
    const nameW = ctx.measureText(a.name).width;
    const checkW = verified ? ctx.measureText("✓ ").width : 0;
    L = { w: nameW + checkW, checkW };
    labelCache.set(key, L);
  }
  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.font = PILL_FONT;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  const pw = L.w + 20, ph = 22;
  const px = sx - pw / 2, py = sy - ph / 2;
  ctx.fillStyle = "rgba(9,12,21,.80)";
  rr(ctx, px, py, pw, ph, 11); ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,.14)";
  ctx.lineWidth = 1;
  rr(ctx, px + 0.5, py + 0.5, pw - 1, ph - 1, 10.5); ctx.stroke();
  let tx = px + 10;
  if (verified) {
    ctx.fillStyle = "#34d399";
    ctx.fillText("✓ ", tx, sy + 0.5);
    tx += L.checkW;
  }
  ctx.fillStyle = "#f2f5fb";
  ctx.fillText(a.name, tx, sy + 0.5);
  ctx.restore();
}

function drawAgent(a, t) {
  const { x, y } = a;
  ctx.fillStyle = "rgba(0,0,0,.38)";
  ctx.beginPath(); ctx.ellipse(x, y + 27, 26, 9, 0, 0, 6.2832); ctx.fill();

  // gentle bob
  const bob = Math.sin(t / 500 + x) * 2;
  const cy = y + bob;

  // soft outer glow in the agent's color
  const gs = agentGlow(a.color || "#a78bfa");
  ctx.globalAlpha = 0.8;
  ctx.drawImage(gs, x - 44, cy - 44, 88, 88);
  ctx.globalAlpha = 1;

  // portrait: real avatar image when available, emoji fallback otherwise
  const img = getAvatarImage(a.image);
  ctx.fillStyle = a.color || "#a78bfa";
  ctx.beginPath(); ctx.arc(x, cy, 24, 0, 6.2832); ctx.fill();
  if (img) {
    ctx.save();
    ctx.beginPath(); ctx.arc(x, cy, 21, 0, 6.2832); ctx.clip();
    // cover-fit the portrait into the circle
    const s = Math.max(42 / img.naturalWidth, 42 / img.naturalHeight);
    const dw = img.naturalWidth * s, dh = img.naturalHeight * s;
    ctx.drawImage(img, x - dw / 2, cy - dh / 2, dw, dh);
    ctx.restore();
  } else {
    ctx.font = "24px serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(a.emoji || "🙂", x, cy + 1);
  }
  // thin light ring, green while talking
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = a.talking ? "#34d399" : "rgba(240,244,255,.85)";
  ctx.beginPath(); ctx.arc(x, cy, 24, 0, 6.2832); ctx.stroke();

  if (a.talking) {
    // soft expanding pulse
    const pr = ((t / 1100) + x * 0.013) % 1;
    ctx.globalAlpha = (1 - pr) * 0.5;
    ctx.lineWidth = 2;
    ctx.strokeStyle = "#34d399";
    ctx.beginPath(); ctx.arc(x, cy, 27 + pr * 16, 0, 6.2832); ctx.stroke();
    ctx.globalAlpha = 1;
    const n = 1 + ((t / 400) | 0) % 3;
    ctx.font = "13px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#34d399";
    ctx.fillText("●".repeat(n), x, cy - 38);
  }

  drawNamePill(a, x, cy);
  if (a.bubble) drawBubble(a, cy, t);
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

// bubble appear animation state: agentKey -> { text, t0 }
const bubbleState = new Map();

function drawBubble(a, cy, t) {
  const key = a.id || a.name;
  const txt = String(a.bubble);
  let st = bubbleState.get(key);
  if (!st || st.text !== txt) {
    st = { text: txt, t0: t };
    bubbleState.set(key, st);
  }
  const age = t - st.t0;
  const k = Math.min(1, age / 220);
  const e = 1 - Math.pow(1 - k, 3); // easeOutCubic
  const yOff = (1 - e) * 14;

  ctx.save();
  ctx.globalAlpha = 0.15 + 0.85 * e;
  ctx.font = "13px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
  const maxW = 200;
  const words = txt.split(/\s+/);
  const lines = [];
  let line = "";
  for (const w of words) {
    const trial = line ? line + " " + w : w;
    if (ctx.measureText(trial).width > maxW && line) { lines.push(line); line = w; }
    else line = trial;
  }
  if (line) lines.push(line);
  const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 28;
  const h = lines.length * 19 + 20;
  const bx = Math.min(990 - w, Math.max(10, a.x - w / 2));
  const by = cy - 60 - h + yOff;

  // soft drop shadow on the body
  ctx.shadowColor = "rgba(0,0,0,.5)";
  ctx.shadowBlur = 16;
  ctx.shadowOffsetY = 5;
  ctx.fillStyle = "rgba(13,17,29,.96)";
  rr(ctx, bx, by, w, h, 13); ctx.fill();
  ctx.shadowColor = "transparent";
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;
  // smooth curved tail
  ctx.beginPath();
  ctx.moveTo(a.x - 9, by + h - 3);
  ctx.quadraticCurveTo(a.x, by + h + 11, a.x + 9, by + h - 3);
  ctx.closePath(); ctx.fill();

  ctx.strokeStyle = "rgba(255,255,255,.16)";
  ctx.lineWidth = 1;
  rr(ctx, bx + 0.5, by + 0.5, w - 1, h - 1, 12.5); ctx.stroke();

  ctx.fillStyle = "#f2f5fb";
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  lines.forEach((l, i) => ctx.fillText(l, bx + 14, by + 10 + i * 19));
  ctx.restore();
}

// start the render loop (defined above in the camera section)
requestAnimationFrame(frame);
