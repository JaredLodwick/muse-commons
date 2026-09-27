const canvas = document.getElementById("room");
const ctx = canvas.getContext("2d");
const rosterEl = document.getElementById("roster");
const countEl = document.getElementById("count");
const tabsEl = document.getElementById("tabs");
const sideEl = document.getElementById("side");
const knocksEl = document.getElementById("knocks");
const invitesEl = document.getElementById("invites");
const recentEl = document.getElementById("recent");
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
let transcriptEvents = [];

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
    draw(m.t);
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
  const g = ctx.createLinearGradient(0, 0, 0, 620);
  g.addColorStop(0, "#1c2333");
  g.addColorStop(1, "#141a28");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 1000, 620);

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
